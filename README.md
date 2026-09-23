# Attendance API — v2 (Site → Campus hierarchy)

This is a schema-and-API-level restructure of the original backend, adding a
parent "site" level above campuses, an atomic campus-creation flow, and a few
related fixes. **This is a breaking change** — see below for exactly what
needs updating in the frontend portal, mobile app, and OCR microservice.

## What changed and why

### 1. New hierarchy: sites → campuses
The old flat `sites` table (North/South Campus) is renamed to `campuses`, and
a new `sites` table sits above it (e.g. "UTAS Nizwa"). Every foreign key that
used to be `site_id` is now `campus_id` — in `employees`, `users`,
`attendance_sheets`, the JWT payload, and every route/query.

**This is not additive** — `src/db/schema.sql` is a fresh schema, not a
migration. Run it against a new database, or write your own migration if you
have production data to carry forward (rename table, rename columns, backfill
a `sites` row, point every `campus_id` FK at it).

### 2. Atomic campus-creation wizard — `POST /api/campuses`
One transactional endpoint creates a campus, its employee roster (from a
reviewed OCR specimen extraction), and its supervisor assignments all at
once. Nothing is written to the database until this call succeeds — the
wizard's earlier steps (uploading a specimen, OCR extraction, admin review,
choosing supervisors) all happen client-side first. See the route's own
comments in `src/routes/campuses.routes.js` for the exact request shape.

Requires **at least 2 supervisors** (existing users, new users, or a mix) —
the request is rejected with `400` otherwise.

### 3. `employees.reference_signature`
New nullable column. Populated by the campus wizard from each employee's
signature crop off the specimen sheet — same storage caveat as `image_url`
already had (stored inline as text/base64 for now; no object storage wired
in yet).

### 4. `POST /api/ocr/scan-specimen` — now implemented end-to-end
Both sides exist now: the Flask OCR service has a new `/extract-specimen`
endpoint (bootstrap mode — no roster to match against, since the campus
doesn't exist yet), and this Node route forwards to it. It requires a
`rows` field (how many employees the specimen sheet lists) since, unlike
the daily scan, there's no roster length to infer that from.

**Real limitation carried over from the OCR service as given to me:** it
only ever runs Tesseract's English model — there is no Arabic OCR pass
anywhere in `extract_sheet.py`, despite the backend README's original
claim. So `/extract-specimen` returns each row's best-guess English name
only; an admin must type in the Arabic name manually during the wizard's
review step before confirming with `POST /api/campuses`.

### 5. Signature matching — implemented, but read this caveat before trusting it
`employees.reference_signature` is captured by the campus wizard (from
each row's signature crop during specimen extraction). The daily
`/scan` route now sends each employee's reference along with the
roster, and the OCR service returns a `signatureMatchScore` (0.0-1.0)
per row when a reference exists to compare against.

**This is a basic OpenCV ORB feature-matching heuristic, not a trained
signature-verification model.** See `compare_signatures()` in
`ocr-service/extract_sheet.py` for the full caveat, but the short
version: handwritten signatures vary day to day even for the same
person, and ORB matching is sensitive to crop alignment/scale/rotation.
Expect real false-positive and false-negative rates. `signatureMatchScore`
is stored per attendance record and is meant purely as an advisory
"maybe worth a second look" flag for a human reviewer — nothing in this
system auto-rejects or blocks a submission based on it, and nothing
should. Swapping in a proper trained model later (e.g. a Siamese network)
would mean replacing just that one function; the contract (crop in,
0.0-1.0 score out) wouldn't need to change.

### 6. `GET /api/attendance` — added pagination
Response shape changed from a bare array to:
```json
{ "total": 143, "limit": 20, "offset": 0, "sheets": [ ... ] }
```
Sheets accumulate forever with no archiving, so this was unbounded before —
the mobile app's history screen and portal's Logs tab both need to read
`.sheets` instead of treating the response as the array directly, and should
pass `limit`/`offset` (or `from`/`to`) rather than expecting everything at
once.

### 7. Campus history stays campus-scoped, not submitter-scoped
`GET /attendance` still filters by `campus_id`, not `submitted_by` — a
supervisor sees every sheet ever submitted for their campus, including ones
from before they were assigned there or submitted by a co-supervisor. This
was a deliberate choice (shared campus record, not a personal log), not an
oversight — flagging it here since it came up as an open question earlier.

## Breaking changes checklist for other repos

- **Frontend portal**: `useApi` calls to `/sites` now return parent sites,
  not campuses — switch campus-listing calls to `/campuses`. `GET
  /attendance` responses need `.sheets` unwrapped. Any `siteId`/`site` field
  read from `/auth/me` or the login response is now `campusId`/`campus_code`.
- **Mobile app**: same `campusId` rename throughout — `Capture` screen's
  `POST /ocr/scan` form field is now `campusId` not `siteId`; `POST
  /attendance` body field is `campusId`; stored user profile from login/
  `/auth/me` has `campusId` instead of `siteId`.
- **OCR microservice**: this zip includes the updated `ocr-service/` with
  both `/extract-specimen` and signature matching built in — no separate
  update needed there, it's already part of this delivery.

## Running it

Same as before:
```bash
docker compose up --build
docker compose exec api npm run migrate
docker compose exec api npm run seed
```

Seeded logins are unchanged in spirit but now include **two** supervisors per
campus (min-2 rule): `sup.north` / `sup.north2` / `sup.south` / `sup.south2`,
plus `admin` / `hr` — all password `123456`.

**Note on `ocr-service/Dockerfile`:** the original Dockerfile for this
service wasn't included in what was uploaded to me, so the one in this zip
is a fresh, standard Python+Tesseract build (installs `tesseract-ocr` via
apt, then the `requirements.txt` deps, runs via gunicorn). If your real
one differs — a different base image, extra system packages, a language
pack install, etc. — replace this file with your actual one before
building; nothing else in `ocr-service/` depends on the Dockerfile's
specifics.
