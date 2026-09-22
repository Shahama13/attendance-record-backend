const express = require("express");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requireRole, enforceCampusScope } = require("../middleware/rbac");
const asyncHandler = require("../utils/asyncHandler");
const { audit } = require("../middleware/auditLog");
const { emitSheetSubmitted, emitSheetVerified } = require("../websocket");
const { todayInOman } = require("../utils/date");

const router = express.Router();
router.use(requireAuth);

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

async function loadFullSheet(sheetId) {
  const { rows: sheetRows } = await pool.query(
    `SELECT sh.*, c.code AS campus_code, c.name AS campus_name
     FROM attendance_sheets sh JOIN campuses c ON c.id = sh.campus_id
     WHERE sh.id = $1`,
    [sheetId]
  );
  const sheet = sheetRows[0];
  if (!sheet) return null;

  const { rows: records } = await pool.query(
    `SELECT r.employee_id, e.employee_code, e.name_en, e.name_ar,
            r.present, r.clock_in, r.clock_out, r.signature_detected, r.signature_match_score
     FROM attendance_records r JOIN employees e ON e.id = r.employee_id
     WHERE r.sheet_id = $1
     ORDER BY e.employee_code`,
    [sheetId]
  );
  return { ...sheet, records };
}

// -----------------------------------------------------------------
// POST /api/attendance
// Supervisor submits a day's sheet. Body:
// { campusId, date, imageUrl?, records: [{ employeeId, present, clockIn, clockOut, signatureDetected }] }
// Enforces: one sheet per campus per day (DB unique constraint backs this up),
// and any employee on the campus's roster NOT included in `records` is
// recorded as absent automatically.
// -----------------------------------------------------------------
router.post(
  "/",
  requireRole("supervisor", "admin"),
  enforceCampusScope,
  asyncHandler(async (req, res) => {
    const { campusId, date, imageUrl, records } = req.body;
    if (!campusId || !date || !Array.isArray(records)) {
      return res.status(400).json({ error: "campusId, date and records[] are required." });
    }

    // Hard gate, per spec: this system only accepts a sheet dated today.
    // Uses the server's own clock, not whatever `date` the client sent —
    // so a phone with a wrong clock, or a client that skipped the OCR
    // date check entirely, still can't submit a sheet for any day but
    // today. POST /api/ocr/scan surfaces this earlier during review, but
    // this is the check that actually matters, since it's the one
    // standing directly in front of the database.
    const today = todayInOman();
    if (date !== today) {
      return res.status(422).json({
        error: `This sheet is dated ${date}, but today is ${today}. Only same-day sheets can be submitted.`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const totalPresent = records.filter((r) => r.present).length;

      const { rows: existing } = await client.query(
        `SELECT id FROM attendance_sheets WHERE campus_id = $1 AND sheet_date = $2`,
        [campusId, date]
      );
      if (existing[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "A sheet for this campus and date has already been submitted.", sheetId: existing[0].id });
      }

      const { rows: sheetRows } = await client.query(
        `INSERT INTO attendance_sheets (campus_id, sheet_date, total_present, image_url, submitted_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [campusId, date, totalPresent, imageUrl || null, req.user.id]
      );
      const sheet = sheetRows[0];

      // Everyone on the active roster gets a row — absent by default —
      // then the submitted records overwrite presence/times.
      const { rows: roster } = await client.query(
        `SELECT id FROM employees WHERE campus_id = $1 AND status = 'active'`,
        [campusId]
      );
      const submitted = new Map(records.map((r) => [Number(r.employeeId), r]));

      for (const emp of roster) {
        const r = submitted.get(emp.id);
        await client.query(
          `INSERT INTO attendance_records (sheet_id, employee_id, present, clock_in, clock_out, signature_detected, signature_match_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [sheet.id, emp.id, !!r?.present, r?.clockIn || null, r?.clockOut || null, !!r?.signatureDetected, r?.signatureMatchScore ?? null]
        );
      }

      await client.query("COMMIT");

      await audit(req.user.id, "attendance.submit", "attendance_sheet", sheet.id, { campusId, date, totalPresent });

      const full = await loadFullSheet(sheet.id);
      emitSheetSubmitted(full);
      res.status(201).json(full);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

// -----------------------------------------------------------------
// GET /api/attendance?campusId=&campus=&site=&from=&to=&status=&limit=&offset=
//
// Sheets accumulate forever (no archiving), so this now defaults to a
// bounded, most-recent-first page instead of returning the whole
// history every time — the mobile app's "recent submissions" list uses
// this default; pass from/to for a specific date range instead.
//
// Scoping is by campus, not by submitter: a supervisor sees every sheet
// ever submitted for their campus, not only the ones they personally
// uploaded — this is a shared campus record, not a personal log.
//
// campusId (numeric, preferred) unambiguously picks one campus. `campus`
// (the code, e.g. "north") is kept for backward compatibility, but since
// codes are only unique per-site now (see schema.sql), pass `site` (the
// parent site id) alongside it when more than one site could have a
// campus with that code — otherwise it'll match campuses across every
// site sharing that code.
// -----------------------------------------------------------------
router.get(
  "/",
  enforceCampusScope,
  asyncHandler(async (req, res) => {
    const { campus, campusId, site, from, to, status } = req.query;
    const limit = Math.min(Number(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = Number(req.query.offset) || 0;

    const conditions = [];
    const values = [];
    let i = 1;

    if (campusId) {
      conditions.push(`sh.campus_id = $${i++}`);
      values.push(Number(campusId));
    } else if (campus) {
      conditions.push(`c.code = $${i++}`);
      values.push(campus);
      if (site) { conditions.push(`c.site_id = $${i++}`); values.push(Number(site)); }
    }
    if (from) { conditions.push(`sh.sheet_date >= $${i++}`); values.push(from); }
    if (to) { conditions.push(`sh.sheet_date <= $${i++}`); values.push(to); }
    if (status) { conditions.push(`sh.status = $${i++}`); values.push(status); }
    if (!["admin", "hr"].includes(req.user.role) && req.user.campusId) {
      conditions.push(`sh.campus_id = $${i++}`);
      values.push(req.user.campusId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM attendance_sheets sh JOIN campuses c ON c.id = sh.campus_id ${where}`,
      values
    );

    values.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT sh.id, sh.sheet_date, sh.total_present, sh.status, sh.submitted_at, sh.verified_at,
              c.code AS campus_code, c.name AS campus_name,
              u1.full_name AS submitted_by_name, u2.full_name AS verified_by_name
       FROM attendance_sheets sh
       JOIN campuses c ON c.id = sh.campus_id
       LEFT JOIN users u1 ON u1.id = sh.submitted_by
       LEFT JOIN users u2 ON u2.id = sh.verified_by
       ${where}
       ORDER BY sh.sheet_date DESC, c.name
       LIMIT $${i++} OFFSET $${i++}`,
      values
    );

    res.json({ total: countRows[0].total, limit, offset, sheets: rows });
  })
);

// GET /api/attendance/today-summary — dashboard cards
router.get(
  "/today-summary",
  asyncHandler(async (req, res) => {
    const { rows: campuses } = await pool.query(
      `SELECT c.id, c.code, c.name, c.site_id, s.name AS site_name
       FROM campuses c JOIN sites s ON s.id = c.site_id
       ORDER BY s.name, c.name`
    );
    const { rows: sheets } = await pool.query(
      `SELECT sh.*, c.code AS campus_code FROM attendance_sheets sh
       JOIN campuses c ON c.id = sh.campus_id WHERE sh.sheet_date = CURRENT_DATE`
    );
    const { rows: rosterCounts } = await pool.query(
      `SELECT campus_id, COUNT(*)::int AS total FROM employees WHERE status = 'active' GROUP BY campus_id`
    );

    const summary = campuses.map((campus) => {
      const sheet = sheets.find((s) => s.campus_id === campus.id);
      const roster = rosterCounts.find((r) => r.campus_id === campus.id)?.total || 0;
      return {
        campusId: campus.id,
        campus: campus.code,
        campusName: campus.name,
        siteId: campus.site_id,
        siteName: campus.site_name,
        rosterSize: roster,
        submitted: !!sheet,
        totalPresent: sheet?.total_present ?? null,
        status: sheet?.status ?? "not_submitted",
      };
    });

    res.json({
      date: new Date().toISOString().slice(0, 10),
      totalPresent: summary.reduce((a, s) => a + (s.totalPresent || 0), 0),
      totalRoster: summary.reduce((a, s) => a + s.rosterSize, 0),
      campuses: summary,
    });
  })
);

// GET /api/attendance/:id — full sheet with per-employee rows
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const full = await loadFullSheet(req.params.id);
    if (!full) return res.status(404).json({ error: "Sheet not found." });
    if (!["admin", "hr"].includes(req.user.role) && full.campus_id !== req.user.campusId) {
      return res.status(403).json({ error: "You do not have access to this sheet." });
    }
    res.json(full);
  })
);

// PATCH /api/attendance/:id/verify — admin/HR only
router.patch(
  "/:id/verify",
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE attendance_sheets
       SET status = 'verified', verified_by = $1, verified_at = now()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Sheet not found or already verified." });

    await audit(req.user.id, "attendance.verify", "attendance_sheet", rows[0].id, {});
    const full = await loadFullSheet(rows[0].id);
    emitSheetVerified(full);
    res.json(full);
  })
);

module.exports = router;