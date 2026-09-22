#!/usr/bin/env python3
"""
extract_sheet.py — real OCR extraction for a Daryas attendance sheet photo.

Pipeline:
  1. Tesseract word-level bounding boxes locate the table header
     (S.No / Employee Name / Clock In / Clock Out / Signature) and derive
     column x-ranges from wherever the header actually sits in the image
     (not hardcoded pixels — this is what makes it tolerant of a phone
     photo taken at a slight angle/offset rather than a perfect scan).
  2. The header + the "Total Manpower Present" line locate the table's
     y-span. Row bands within that span are now derived from the sheet's
     own horizontal grid lines (find_horizontal_rows) rather than blindly
     dividing the space evenly by a caller-supplied row count — see
     find_row_bands for why that mattered in practice.
  3. Each cell is cropped from the *original* image and re-OCR'd in
     isolation, which is far more accurate than reading the whole page
     at once (Tesseract does much better on a tight, single-field crop).
  4. Extracted employee names are fuzzy-matched against the site roster
     to resolve an employee_code, so a misread character doesn't break
     the row — this mirrors the "confidence + manual correction" flow
     from the spec.
  5. The signature cell isn't OCR'd as text — it's checked for ink via
     pixel density, since a signature is a mark, not a word.
  6. The handwritten "Date:" field is extracted and compared against an
     expected date (normally "today", supplied by the caller) — sheets
     dated anything else are flagged as not a match, so the API layer
     can refuse to ingest a sheet that belongs to a different day.
  7. If the caller's roster entries include a reference_signature
     (base64 image, captured once at campus setup — see extract_specimen
     below), each row's signature crop is compared against that
     employee's reference and returned as signatureMatchScore. See the
     big caveat on compare_signatures() below before trusting this for
     anything beyond "flag for a human to double-check".

Usage:
  python3 extract_sheet.py <image_path> <roster_json_path> [--rows N] [--expected-date YYYY-MM-DD]

roster_json_path: a JSON array like
  [{"employee_code": "N01", "name_en": "Husam Bin Hilal...", "reference_signature": "<base64>"}, ...]
(this is what GET /api/employees?campus=north returns, joined with each
employee's stored reference_signature)
"""

import re
import json
import base64
import argparse
from datetime import datetime, timezone

import cv2
import numpy as np
import pytesseract
from PIL import Image
from rapidfuzz import fuzz, process

TIME_RE = re.compile(r"\b([01]?\d|2[0-3])[:.]([0-5]\d)\b")
TOTAL_RE = re.compile(r"Total\s+Manpower\s+Present[:\s]*([0-9]{1,3})", re.IGNORECASE)
DATE_RE = re.compile(r"\b([0-3]?\d)[/\-.]([0-1]?\d)[/\-.]([0-9]{2,4})\b")

# Sheets are bilingual and occasionally hand-dated with Eastern Arabic-Indic
# numerals rather than Western digits — translate before matching DATE_RE.
EASTERN_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")


def word_boxes(img, lang="eng"):
    """Run Tesseract and return a list of word boxes with position/confidence."""
    data = pytesseract.image_to_data(img, lang=lang, output_type=pytesseract.Output.DICT)
    boxes = []
    for i in range(len(data["text"])):
        text = data["text"][i].strip()
        if not text:
            continue
        boxes.append({
            "text": text,
            "left": data["left"][i], "top": data["top"][i],
            "width": data["width"][i], "height": data["height"][i],
            "conf": float(data["conf"][i]),
        })
    return boxes


def find_grid_columns(img_cv, y_top=None, y_bottom=None, min_col_gap=45, n_strips=10, track_tol=20):
    """
    Detect the table's actual vertical grid lines, tolerating the kind of
    slight skew a real phone photo has — even a "clean-looking" shot is
    rarely pixel-perfectly square. A real column border on a skewed photo
    is not one straight vertical run of dark pixels top-to-bottom; it can
    drift 10px or more in x from the top of the table to the bottom.

    The previous version looked for a single straight run of ~60+
    contiguous dark pixels at a fixed x, so a border with that much drift
    (or one partly broken by signature ink bleeding across it) simply
    vanished from detection — confirmed on a real sheet where the right
    border drifted from x~987 at the top of the table to x~977 at the
    bottom, enough to make that whole-column check fail even though the
    line is clearly visible to the eye.

    This version instead slices the table into `n_strips` horizontal
    strips and detects short vertical segments independently within each
    one (so a strip only needs a straight run the height of one strip,
    not the whole table). It then links segments across strips into a
    "track" whenever consecutive strips land within `track_tol` px of
    each other in x — this is what lets a track follow a gently sloped
    line across the photo. A real grid line shows up as a track present
    in most of the strips; noise (a stray pen mark, a patch of ink bleed)
    only ever produces a short-lived track and gets discarded.

    y_top/y_bottom restrict the scan to the table's own row band (the
    caller passes header_bottom..total_label_top) so the letterhead/title
    block above the table can't inject false column lines.

    min_col_gap merges any detected lines closer together than a real
    column is ever going to be. Kept well under the narrowest real column
    (S.No) so it never merges two genuine borders together.
    """
    gray = cv2.cvtColor(img_cv, cv2.COLOR_BGR2GRAY)
    h = gray.shape[0]
    y0 = max(0, int(y_top)) if y_top is not None else 0
    y1 = min(h, int(y_bottom)) if y_bottom is not None else h
    region = gray[y0:y1, :] if y1 > y0 else gray
    region_h = region.shape[0]
    if region_h <= 0:
        raise RuntimeError("Could not detect table grid lines in this image.")

    strip_h = max(30, region_h // n_strips)
    _, thresh = cv2.threshold(region, 200, 255, cv2.THRESH_BINARY_INV)
    # Kernel height matched to one strip (minus a little slack), not the
    # whole table — this is the actual fix: each strip only has to show a
    # straight run the length of itself.
    vert_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(15, strip_h - 10)))
    vert = cv2.dilate(cv2.erode(thresh, vert_kernel, iterations=1), vert_kernel, iterations=1)

    strip_peaks = []
    for sy in range(0, region_h, strip_h):
        strip = vert[sy: sy + strip_h, :]
        col_sums = strip.sum(axis=0)
        if col_sums.max() <= 0:
            strip_peaks.append([])
            continue
        xs = np.where(col_sums > col_sums.max() * 0.5)[0]
        peaks, cluster = [], [xs[0]]
        for x in xs[1:]:
            if x - cluster[-1] <= 5:
                cluster.append(x)
            else:
                peaks.append(int(np.mean(cluster)))
                cluster = [x]
        peaks.append(int(np.mean(cluster)))
        strip_peaks.append(peaks)

    # Link peaks across strips into tracks: each track remembers its most
    # recent x and, for every new strip, claims the nearest unclaimed peak
    # within track_tol px of that x (this is how a track "follows" a
    # gently sloped line strip to strip without needing a fixed x).
    tracks = []
    for peaks in strip_peaks:
        used = set()
        for track in tracks:
            best, best_d = None, None
            for x in peaks:
                if x in used:
                    continue
                d = abs(x - track["last_x"])
                if d <= track_tol and (best_d is None or d < best_d):
                    best, best_d = x, d
            if best is not None:
                track["xs"].append(best)
                track["last_x"] = best
                track["hits"] += 1
                used.add(best)
        for x in peaks:
            if x not in used:
                tracks.append({"xs": [x], "last_x": x, "hits": 1})

    # Real grid lines run the length of the table and show up in nearly
    # every strip; a stray mark or ink bleed only flickers in for one or
    # two, so a majority-of-strips threshold cleanly separates the two.
    min_hits = max(2, round(len(strip_peaks) * 0.5))
    good_tracks = [t for t in tracks if t["hits"] >= min_hits]
    lines = sorted(int(np.mean(t["xs"])) for t in good_tracks)

    if not lines:
        raise RuntimeError("Could not detect table grid lines in this image.")

    if min_col_gap:
        merged, cluster = [], [lines[0]]
        for x in lines[1:]:
            if x - cluster[-1] <= min_col_gap:
                cluster.append(x)
            else:
                merged.append(int(sum(cluster) / len(cluster)))
                cluster = [x]
        merged.append(int(sum(cluster) / len(cluster)))
        lines = merged

    return lines


def find_horizontal_rows(img_cv, y_top, y_bottom):
    """
    Detect the table's actual horizontal grid lines within [y_top, y_bottom]
    via morphology — the same technique find_grid_columns uses on the
    x-axis, applied to the y-axis instead.

    This exists because find_row_bands used to just divide the table's
    y-span evenly by whatever `expected_rows` the caller supplied (the
    admin's typed-in row count, or len(roster)). If that number didn't
    match what's actually printed on the sheet — e.g. a 13-row sheet with
    `rows=6` sent by mistake — every crop band silently spanned more than
    one real row, blending two people's name/signature ink together and
    producing garbage OCR with no error raised anywhere. Detecting the
    real row lines lets us catch that mismatch instead of guessing past it.

    Returns the detected row count, or None if grid lines can't be found
    (e.g. a sheet with faint/no ruling) — callers should fall back to
    the caller-supplied count in that case rather than fail outright.
    """
    gray = cv2.cvtColor(img_cv, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    horiz_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (60, 1))
    horiz = cv2.dilate(cv2.erode(thresh, horiz_kernel, iterations=2), horiz_kernel, iterations=2)

    y0, y1 = max(0, int(y_top)), min(img_cv.shape[0], int(y_bottom))
    if y1 <= y0:
        return None
    band = horiz[y0:y1, :]

    row_sums = band.sum(axis=1)
    if row_sums.max() == 0:
        return None
    ys = np.where(row_sums > row_sums.max() * 0.5)[0]
    if len(ys) == 0:
        return None

    lines, cluster = [], [ys[0]]
    for y in ys[1:]:
        if y - cluster[-1] <= 5:
            cluster.append(y)
        else:
            lines.append(int(np.mean(cluster)))
            cluster = [y]
    lines.append(int(np.mean(cluster)))

    # N detected grid lines bound N-1 rows. Fewer than 2 lines means we
    # didn't actually find a ruled grid (noise), so treat it as "unknown".
    if len(lines) < 2:
        return None
    return len(lines) - 1


def find_total_label(boxes, after_y):
    """Locate the "Total Manpower Present" line, which bounds the table's bottom edge."""
    return next((b for b in boxes if b["text"].strip(":").title() == "Total" and b["top"] > after_y), None)


def find_header_columns(boxes, img_cv):
    """Combine detected grid lines with header text to get named column ranges + header y."""
    header_word = next((b for b in boxes if b["text"].upper() in ("EMPLOYEE", "CLOCK", "SIGNATURE")), None)
    if not header_word:
        raise RuntimeError("Could not locate table header text — is this a Daryas attendance sheet?")
    header_text_bottom = header_word["top"] + header_word["height"]

    total_label = find_total_label(boxes, header_text_bottom)
    table_y_bottom = total_label["top"] - 10 if total_label else img_cv.shape[0]

    # Anchor the table's real top on the first actual row content below the
    # header, rather than a fixed pixel offset from the header text. A
    # fixed offset (previously header text bottom + 25) was measured once
    # and didn't hold up on a real phone photo — it overshot into row 1 by
    # ~20px, enough to shift every row's crop down and bleed adjacent
    # employees' name text into each other. Single-character boxes are
    # excluded since those are usually stray marks off the grid ruling
    # itself, not real row content.
    content_candidates = [
        b for b in boxes
        if header_text_bottom < b["top"] < table_y_bottom and len(b["text"]) >= 2
    ]
    table_top = (min(b["top"] for b in content_candidates) - 4) if content_candidates else header_text_bottom + 15

    # Bound grid-line detection to the table's own row band (table_top..
    # Total line) so the letterhead/title block above it can't inject
    # false column lines — see find_grid_columns' docstring for why that
    # mattered.
    grid = find_grid_columns(img_cv, y_top=table_top, y_bottom=table_y_bottom)
    if len(grid) != 6:
        raise RuntimeError(
            f"Expected 6 grid lines (5 columns) in the table region, found {len(grid)} after merging nearby "
            f"detections. The photo may be angled, poorly lit, or have signature ink bridging into the ruling — "
            f"retake the photo straight-on with good lighting and the full table visible."
        )
    left_border, sno_end, name_end, clockin_end, clockout_end, right_border = grid

    return {
        "header_bottom": table_top,
        "sno": (left_border, sno_end),
        "name": (sno_end, name_end),
        "clock_in": (name_end, clockin_end),
        "clock_out": (clockin_end, clockout_end),
        "signature": (clockout_end, right_border),
    }


def find_printed_total(full_text):
    """
    Parse the sheet's own "Total Manpower Present: N" line — filled in by
    whoever compiled the sheet, and printed clearly as one number near the
    bottom of the page. On a real phone photo this is a far more reliable
    row-count signal than find_horizontal_rows: that function has to find
    every one of a dozen-plus faint printed ruling lines, any of which can
    be broken up by lighting, shadow, or signature ink bleeding across
    them (in practice it has under-counted on real photos). One printed
    number is a much easier OCR target. Returns None if not found.
    """
    m = TOTAL_RE.search(full_text)
    return int(m.group(1)) if m else None


def find_row_bands(boxes, header_bottom, expected_rows, img_cv=None):
    """
    Row y-bands, spanning the bottom of the header down to the
    "Total Manpower Present" line.

    Row count resolution, in order of trust:
      1. expected_rows, if the caller supplied one. This now covers the
         daily scan's roster length, an admin's explicit override, AND
         (see extract_specimen) the sheet's own printed "Total Manpower
         Present" figure — trusted directly, spaced evenly, no further
         cross-check.
      2. Grid-line detection (find_horizontal_rows), used only as a last
         resort when no expected_rows was supplied at all. This used to
         be the primary source with expected_rows only as a sanity check
         — inverted here because in practice the grid detector has proven
         to be the less reliable of the two on real phone photos, so
         trusting it over an actually-supplied count did more harm
         (silently blending rows on a bad detection) than good.

    Bands are then spaced evenly within the resolved row count.
    Single-digit S.No OCR is still not used to locate rows — Tesseract's
    page segmentation is unreliable on a narrow numeric column next to
    grid lines.
    """
    total_label = find_total_label(boxes, header_bottom)
    if not total_label:
        raise RuntimeError('Could not locate the "Total Manpower Present" line to bound the table.')

    # header_bottom is now find_header_columns' data-anchored table_top
    # (see its docstring) — a small +2 cushion, not the old fixed +8.
    table_top = header_bottom + 2
    table_bottom = total_label["top"] - 10

    n_rows = expected_rows
    if not n_rows and img_cv is not None:
        n_rows = find_horizontal_rows(img_cv, table_top, table_bottom)
    if not n_rows:
        raise RuntimeError(
            "Could not determine the number of rows on this sheet — no row count was supplied "
            "(and no grid lines could be detected as a fallback)."
        )

    row_height = (table_bottom - table_top) / n_rows
    bands = []
    for i in range(n_rows):
        top = table_top + i * row_height
        bottom = table_top + (i + 1) * row_height
        bands.append((top, bottom))
    return bands


def find_name_line_band(boxes, row_y0, row_y1, name_floor, name_x1, line_gap=14, max_h=20, left_pad=3, tall_center_tol=10):
    """
    Solves two real problems found by testing against an actual Daryas
    specimen photo, both of which live in the Name column specifically:

    1. The grid-detected border between the S.No and Employee Name
       columns is not a safe left edge to crop the Name cell from. On a
       real phone photo the printed ruling line and the first letter of
       the name can sit only 1-2px apart — the line detector's pixel
       pick landed at x=198 on one real sheet while the printed name text
       actually started at x=151, chopping most of the first word off.
       A single FIXED left edge doesn't fully fix this either: the photo
       isn't perfectly flat/square, so the true text-start x drifts by a
       few px from the top row to the bottom row. So this is resolved
       per row, not once globally: within the row, take the leftmost
       word box's own left edge (nudged a few px further right, since
       cropping any closer keeps dragging in a sliver of the ruling line
       that Tesseract then fuses into the leftmost letter as a bogus
       extra character, e.g. "AHMED" -> "JAHMED").

    2. Each Name cell prints two stacked lines — the English name, then
       the Arabic name directly below it — but only the English line is
       what we want to OCR (the `eng` model reads the Arabic line as
       unreliable Latin-lookalike noise: a real sheet's second line
       "أحمد بن خلف..." came back as literal garbage like "sos ils yy
       sas" appended straight onto the correctly-read English name).
       Rather than OCRing the whole row band and hoping the noise
       doesn't leak in, cluster the row's word boxes by vertical
       proximity and use just the topmost cluster — the sheet's fixed
       layout always prints the English line above the Arabic one, so
       "topmost" reliably means "the line we actually want", even when
       the row band's own top/bottom (evenly divided from the printed
       row count) is a few px off from where this particular row's text
       really sits.

    Both problems are solved from the same clustering pass: boxes within
    the row are gathered from name_floor (a generous, reliably-safe left
    bound — callers pass the table's left border plus a margin, not the
    unreliable S.No/Name divider itself) out to name_x1, boxes taller
    than max_h are dropped first (an occasional OCR artifact spans
    nearly the row's full height and, left in, can bridge what should be
    two separate line-clusters into one — silently pulling the Arabic
    line back in via that one tall box), then the topmost cluster's own
    bounding box gives both the tight y-span (problem 2) and, from its
    own leftmost member, the tight per-row left edge (problem 1).

    Returns (left, top, bottom), or None if no content was found in the
    row at all (rare — every row on this sheet has a pre-printed name),
    letting the caller fall back to a fixed crop.

    One more real case found on a real sheet: a word can have an
    oversized bbox (e.g. Tesseract fusing in a sliver of the printed
    ruling line sitting just above it) and get dropped by the max_h
    filter even though it's plainly on this same line — on a real photo
    "HAMZA BIN KHALAF BIN SAID AL-ABRI" lost its first word this way:
    HAMZA's box came back height=30 (vs. ~11 for its neighbors BIN/
    KHALAF/BIN on the same row), so it was excluded from the cluster
    used to find the left edge, and the crop started at "BIN" instead —
    silently chopping the name. A rescue pass below adds back any
    height-filtered box whose vertical center lines up with the surviving
    cluster's own center (within tall_center_tol): a same-line word with
    an inflated box still centers on the line it's actually part of, while
    a genuine two-line-bridging artifact centers roughly halfway between
    the English and Arabic lines instead — well outside that tolerance —
    so it correctly stays excluded.
    """
    in_row = [
        b for b in boxes
        if row_y0 - 4 <= b["top"] <= row_y1 + 4 and name_floor <= b["left"] < name_x1 and b["height"] <= max_h
    ]
    if not in_row:
        return None
    in_row.sort(key=lambda b: b["top"])
    clusters = [[in_row[0]]]
    for b in in_row[1:]:
        if b["top"] - clusters[-1][-1]["top"] <= line_gap:
            clusters[-1].append(b)
        else:
            clusters.append([b])
    first = clusters[0]
    cluster_center = (min(b["top"] for b in first) + max(b["top"] + b["height"] for b in first)) / 2

    rescued = [
        b for b in boxes
        if row_y0 - 4 <= b["top"] <= row_y1 + 4
        and name_floor <= b["left"] < name_x1
        and b["height"] > max_h
        and abs((b["top"] + b["height"] / 2) - cluster_center) <= tall_center_tol
    ]

    left = min(b["left"] for b in first + rescued) - left_pad
    top = min(b["top"] for b in first)
    bottom = max(b["top"] + b["height"] for b in first)
    return left, top, bottom


def build_row_bounds(boxes, bands, name_floor, name_x1, table_bottom, top_margin=6):
    """
    Rebuilds each row's full-width y-span — used for Clock In/Out and
    Signature, columns with no printed text of their own to anchor on —
    from the same real content find_name_line_band already locates for
    the Name column, instead of trusting the raw evenly-divided bands
    find_row_bands returns.

    Those bands are only as accurate as (table height) / (row count),
    which drifts a few px by row on a real, slightly skewed phone photo.
    That drift is harmless for Name (isolated per row via
    find_name_line_band already), but it matters here: verified against
    a real sheet with a couple of oversized, sprawling signatures — a
    signer's stroke sweeping past the printed row line into the next
    cell is a real-paper problem no cropping can fully undo, but the
    extra few px of drift in the raw bands was needlessly making it
    worse by pulling in more of the neighboring row's overflow on top
    of what was already there.

    Row i's top is a few px above this row's own detected name-line
    top; its bottom is that same margin above the NEXT row's detected
    name-line top, so the crop only intentionally reaches as far as
    where the next row visibly starts. The last row's bottom falls back
    to the table's own bottom edge (the "Total Manpower Present" line).
    """
    anchors = []
    for (y0, y1) in bands:
        lb = find_name_line_band(boxes, y0, y1, name_floor, name_x1)
        anchors.append(lb[1] if lb else y0)

    row_bounds = []
    for idx in range(len(bands)):
        top = anchors[idx] - top_margin
        bottom = (anchors[idx + 1] - top_margin) if idx + 1 < len(anchors) else table_bottom
        row_bounds.append((top, bottom))
    return row_bounds


def crop(img_cv, x0, y0, x1, y1, pad=4):
    h, w = img_cv.shape[:2]
    x0, x1 = max(0, int(x0) - pad), min(w, int(x1) + pad)
    y0, y1 = max(0, int(y0) - pad), min(h, int(y1) + pad)
    return img_cv[y0:y1, x0:x1]


def ocr_cell(img_cv, lang="eng", psm=7):
    if img_cv.size == 0:
        return ""
    pil = Image.fromarray(cv2.cvtColor(img_cv, cv2.COLOR_BGR2RGB))
    return pytesseract.image_to_string(pil, lang=lang, config=f"--psm {psm}").strip()


def extract_time(text):
    m = TIME_RE.search(text.replace(" ", ""))
    if not m:
        return None
    h, mi = m.groups()
    h = h.zfill(2)
    return f"{h}:{mi}"


def normalize_date(raw_text):
    """
    Parse a handwritten date in dd/mm/yyyy (or dd-mm-yyyy, dd.mm.yyyy, 2-digit
    year) per the sheet's stated format, and return ISO yyyy-mm-dd, or None
    if nothing date-shaped is found. Eastern Arabic-Indic digits are
    translated to Western first since supervisors may write either.
    """
    if not raw_text:
        return None
    translated = raw_text.translate(EASTERN_ARABIC_DIGITS)
    m = DATE_RE.search(translated)
    if not m:
        return None
    day, month, year = m.groups()
    day, month, year = int(day), int(month), int(year)
    if year < 100:
        year += 2000
    try:
        return datetime(year, month, day).date().isoformat()
    except ValueError:
        return None  # e.g. OCR produced day=35 — not a real date, treat as unread


def find_date_label(boxes):
    return next((b for b in boxes if b["text"].strip().lower().rstrip(":") == "date"), None)


def extract_sheet_date(boxes, img_cv):
    """
    Locate the sheet's handwritten "Date:" field and read it. Two passes:
      1. Look for a date-shaped token already present in the full-page OCR
         pass (cheap, and often already correct — Tesseract reads a clean
         "03/09/2026" fine as part of reading the whole page).
      2. If that fails, crop a strip to the right of the "Date:" label and
         re-OCR just that strip in isolation, the same targeted-crop
         approach used for every other field on the sheet.
    Returns {"raw": <best-effort text>, "parsed": <ISO date or None>}.
    """
    label = find_date_label(boxes)

    candidates = [b for b in boxes if DATE_RE.search(b["text"].translate(EASTERN_ARABIC_DIGITS))]
    if label:
        same_line = [b for b in candidates if abs(b["top"] - label["top"]) < 40 and b["left"] > label["left"]]
        candidates = same_line or candidates

    if candidates:
        best = candidates[0]
        parsed = normalize_date(best["text"])
        if parsed:
            return {"raw": best["text"], "parsed": parsed}

    if label:
        strip = crop(img_cv, label["left"] + label["width"] + 5, label["top"] - 10,
                     label["left"] + label["width"] + 650, label["top"] + label["height"] + 15)
        raw = ocr_cell(strip, lang="eng", psm=7)
        parsed = normalize_date(raw)
        return {"raw": raw, "parsed": parsed}

    return {"raw": "", "parsed": None}


def signature_present(cell_bgr, ink_ratio_threshold=0.025, dark_pixel_value=150):
    """
    A signature is ink, not text — measure the fraction of genuinely dark
    pixels. A fixed intensity threshold is used rather than an adaptive one
    (e.g. Otsu): these sheets alternate white and light-gray row shading
    (gray ≈ 184/255) for readability, and an adaptive threshold splits any
    crop into "dark half / light half" even when nothing is actually
    written — it'll happily call shading "ink". Real ballpoint-pen ink is
    much darker (well under 150/255), so a fixed cutoff tells the two apart.

    ink_ratio_threshold was 0.008, which was too sensitive: measured
    against two real photos of the same sheet, genuinely blank rows came
    back with ink_ratio as high as 0.013 (JPEG noise, a sliver of ruling
    line the row-bounds crop didn't fully clear, faint bleed from a
    neighboring row's oversized signature) — enough to cross that old
    threshold and get marked present when the row was actually blank.
    Every genuinely signed row in the same test measured at least 0.06.
    0.025 sits in the gap between those two clusters with real margin on
    both sides — high enough to reject the observed noise ceiling, low
    enough to clear the smallest real signature by more than 2x.
    """
    if cell_bgr.size == 0:
        return False, 0.0
    gray = cv2.cvtColor(cell_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    m = 20  # clears grid lines and the thicker double-rule at the table's outer border
    inner = gray[m:h - m, m:w - m] if h > 2 * m and w > 2 * m else gray
    dark_mask = inner < dark_pixel_value
    ink_ratio = float(np.count_nonzero(dark_mask)) / dark_mask.size if dark_mask.size else 0.0
    return ink_ratio > ink_ratio_threshold, round(ink_ratio, 4)


def english_line(text):
    """
    Each name cell contains an English line and an Arabic line stacked
    together; a single OCR pass over the whole cell reads both, and the
    Arabic glyphs (misread as Latin-lookalike noise by the `eng` model)
    would otherwise drag down the fuzzy-match score against the roster.
    Keep only the ASCII letters — i.e. the English line — for matching.
    """
    ascii_text = re.sub(r"[^A-Za-z\s\-]", " ", text)
    return re.sub(r"\s+", " ", ascii_text).strip()


def match_employee(name_text, roster, min_score=60):
    if not name_text or not roster:
        return None, 0
    clean = english_line(name_text).lower()
    if not clean:
        return None, 0
    choices = {e["employee_code"]: e["name_en"].lower() for e in roster}
    best = process.extractOne(clean, choices, scorer=fuzz.token_sort_ratio)
    if not best or best[1] < min_score:
        return None, round(best[1], 1) if best else 0
    matched_code = [k for k, v in choices.items() if v == best[0]][0]
    return matched_code, round(best[1], 1)


# ---------------------------------------------------------------------
# Signature crop <-> base64, for storage and for cross-request comparison
# ---------------------------------------------------------------------

def crop_to_base64(cell_bgr):
    """PNG-encode a signature crop and base64 it, for storage as
    employees.reference_signature or for returning in the specimen
    extraction response."""
    if cell_bgr.size == 0:
        return None
    ok, buf = cv2.imencode(".png", cell_bgr)
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode("ascii")


def base64_to_cv(b64_str):
    if not b64_str:
        return None
    try:
        data = base64.b64decode(b64_str)
    except Exception:  # noqa: BLE001 — a corrupt/foreign string just means "no reference"
        return None
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img


def _upscale_for_orb(crop_bgr, target_h=200):
    """
    A signature cell crop is small — typically 50-90px tall on these
    sheets. OpenCV's ORB defaults to edgeThreshold=31 (it discards any
    keypoint within 31px of the image border, on every side), so on a
    crop under ~65px tall there is no interior region left at all and
    ORB silently returns zero keypoints — confirmed directly: a real
    signature crop with plenty of visible ink produced 0 keypoints at
    default settings. That's why every comparison used to come back as
    either 0.0 (no keypoints found, the fallback below) or 1.0 (an
    exact-pixel match against itself) with nothing meaningful in
    between. Upscaling first — before running ORB, not by lowering
    edgeThreshold to chase the crop's original small size — gives ORB
    the working room its default assumptions expect, without having to
    hand-tune per-crop-size thresholds. Verified against two real
    photos of the same sheet: same-person pairs now score roughly
    0.17-0.36, different-person pairs roughly 0.04-0.16 — a real,
    usable gradient instead of a broken binary.
    """
    h, w = crop_bgr.shape[:2]
    if h == 0 or w == 0:
        return crop_bgr
    scale = max(1.0, target_h / h)
    if scale == 1.0:
        return crop_bgr
    return cv2.resize(crop_bgr, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_CUBIC)


def compare_signatures(today_crop_bgr, reference_b64):
    """
    Best-effort similarity between today's signature crop and an
    employee's stored reference, using ORB feature matching (OpenCV,
    no extra ML dependency). Returns a 0.0-1.0 score, or None if there's
    nothing to compare against.

    IMPORTANT CAVEAT: this is a basic keypoint-overlap heuristic, not a
    trained signature-verification model. Handwritten signatures vary
    signature-to-signature even for the same person, and ORB matching is
    sensitive to crop alignment/scale/rotation — expect real
    false-positive and false-negative rates that a purpose-built
    verification model (e.g. a Siamese network trained on genuine/forged
    signature pairs) would do meaningfully better on. Treat the returned
    score as an advisory "maybe worth a second look" signal for a human
    reviewer, never as an identity determination on its own — nothing
    downstream should auto-reject based on this number.
    """
    reference_bgr = base64_to_cv(reference_b64)
    if reference_bgr is None or reference_bgr.size == 0 or today_crop_bgr.size == 0:
        return None

    g1 = cv2.cvtColor(_upscale_for_orb(today_crop_bgr), cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(_upscale_for_orb(reference_bgr), cv2.COLOR_BGR2GRAY)

    orb = cv2.ORB_create(500)
    kp1, des1 = orb.detectAndCompute(g1, None)
    kp2, des2 = orb.detectAndCompute(g2, None)
    if des1 is None or des2 is None or len(kp1) == 0 or len(kp2) == 0:
        return 0.0

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = bf.match(des1, des2)
    good = [m for m in matches if m.distance < 60]
    score = len(good) / max(len(kp1), len(kp2), 1)
    return round(min(score, 1.0), 3)


def extract_sheet(image_path, roster, expected_rows=None, expected_date=None):
    pil_full = Image.open(image_path).convert("RGB")
    img_cv = cv2.cvtColor(np.array(pil_full), cv2.COLOR_RGB2BGR)

    boxes = word_boxes(pil_full, lang="eng")
    full_text = pytesseract.image_to_string(pil_full, lang="eng")

    cols = find_header_columns(boxes, img_cv)
    n_rows = expected_rows or len(roster)
    bands = find_row_bands(boxes, cols["header_bottom"], n_rows, img_cv=img_cv)
    name_floor = cols["sno"][0] + 40  # safely past the S.No digits, well short of real name text

    total_label = find_total_label(boxes, cols["header_bottom"])
    table_bottom = total_label["top"] - 10 if total_label else img_cv.shape[0]
    row_bounds = build_row_bounds(boxes, bands, name_floor, cols["name"][1], table_bottom)

    reference_by_code = {e["employee_code"]: e.get("reference_signature") for e in roster}

    records = []
    for i, (y0, y1) in enumerate(bands):
        line_band = find_name_line_band(boxes, y0, y1, name_floor, cols["name"][1])
        name_x0, name_y0, name_y1 = line_band if line_band else (name_floor, y0, y0 + (y1 - y0) * 0.45)
        name_cell = crop(img_cv, name_x0, name_y0, cols["name"][1], name_y1, pad=3)
        ry0, ry1 = row_bounds[i]
        # pad=1, not the usual default of 4 — right at a boundary where a
        # neighboring row's oversized signature already overflows onto the
        # printed line, a generous margin only invites more of it in.
        sig_cell = crop(img_cv, cols["signature"][0], ry0, cols["signature"][1], ry1, pad=1)

        name_text = ocr_cell(name_cell, lang="eng", psm=7).replace("\n", " ")

        emp_code, name_confidence = match_employee(name_text, roster)
        has_signature, ink_ratio = signature_present(sig_cell)

        # Presence is signature-only now — clock in/out is no longer read
        # off the sheet at all (see the removed clockin_cell/clockout_cell
        # crops above). It was never a reliable presence signal on a real
        # sheet: supervisors write times in inconsistent formats
        # ("7:00", "7.00", "7-.00", "3,'60" — that last one isn't even a
        # valid time), so `extract_time` frequently returned None for a
        # genuinely present, signed employee, and OCR noise on a blank
        # clock cell occasionally produced a false time for an absent
        # one. A signed/not-signed read off the Signature column is a far
        # more direct, unambiguous presence signal on this sheet.
        present = has_signature

        # Only attempt a signature comparison if this row matched a known
        # employee AND that employee has a reference on file — otherwise
        # there's nothing meaningful to compare against.
        reference_b64 = reference_by_code.get(emp_code) if emp_code else None
        signature_match_score = compare_signatures(sig_cell, reference_b64) if reference_b64 else None

        records.append({
            "row": i + 1,
            "employeeCode": emp_code,
            "ocrNameRaw": name_text,
            "nameMatchConfidence": name_confidence,
            "present": present,
            "signatureDetected": has_signature,
            "signatureInkRatio": ink_ratio,
            "signatureMatchScore": signature_match_score,
            "needsReview": (emp_code is None) or (name_confidence < 85),
        })

    total_present_printed = None
    m = TOTAL_RE.search(full_text)
    if m:
        total_present_printed = int(m.group(1))

    computed_present = sum(1 for r in records if r["present"])

    sheet_date = extract_sheet_date(boxes, img_cv)
    date_match = (sheet_date["parsed"] == expected_date) if (sheet_date["parsed"] and expected_date) else None

    return {
        "extractedAt": datetime.now(timezone.utc).isoformat(),
        "rowsDetected": len(records),
        "totalPresentPrinted": total_present_printed,
        "totalPresentComputed": computed_present,
        "totalsMatch": (total_present_printed == computed_present) if total_present_printed is not None else None,
        "sheetDate": {
            "raw": sheet_date["raw"],
            "parsed": sheet_date["parsed"],
            "expected": expected_date,
            "matches": date_match is True,
        },
        "records": records,
    }


# ---------------------------------------------------------------------
# Specimen extraction — bootstrap mode for the campus-creation wizard.
# No roster exists yet, so there's no name-matching and no
# signature-match scoring here — just "read what's on this row" plus a
# stored crop of the signature cell for future reference.
# ---------------------------------------------------------------------

def extract_specimen(image_path, expected_rows=None):
    """
    Returns each row's best-guess English name and a base64 crop of its
    signature cell, for an admin to review and correct — this codebase's
    OCR only ever runs Tesseract's `eng` model, so there is no automatic
    Arabic extraction despite what the backend README claims (Arabic
    names, when wanted, are added later via PATCH /api/employees/:id).

    Row count resolution (see find_row_bands for the full priority order):
    an explicit `expected_rows` (e.g. an admin override) wins if given;
    otherwise this reads the sheet's own printed "Total Manpower Present:
    N" line via find_printed_total — a much more reliable signal on a real
    phone photo than detecting individual ruling lines; grid-line
    detection is only the last-resort fallback if neither is available.
    """
    pil_full = Image.open(image_path).convert("RGB")
    img_cv = cv2.cvtColor(np.array(pil_full), cv2.COLOR_RGB2BGR)
    boxes = word_boxes(pil_full, lang="eng")
    full_text = pytesseract.image_to_string(pil_full, lang="eng")

    cols = find_header_columns(boxes, img_cv)
    printed_total = find_printed_total(full_text)
    resolved_rows = expected_rows or printed_total
    row_count_source = "admin" if expected_rows else ("printed_total" if printed_total else "grid_detection")
    bands = find_row_bands(boxes, cols["header_bottom"], resolved_rows, img_cv=img_cv)
    name_floor = cols["sno"][0] + 40  # safely past the S.No digits, well short of real name text

    total_label = find_total_label(boxes, cols["header_bottom"])
    table_bottom = total_label["top"] - 10 if total_label else img_cv.shape[0]
    row_bounds = build_row_bounds(boxes, bands, name_floor, cols["name"][1], table_bottom)

    records = []
    for i, (y0, y1) in enumerate(bands):
        line_band = find_name_line_band(boxes, y0, y1, name_floor, cols["name"][1])
        name_x0, name_y0, name_y1 = line_band if line_band else (name_floor, y0, y0 + (y1 - y0) * 0.45)
        name_cell = crop(img_cv, name_x0, name_y0, cols["name"][1], name_y1, pad=3)
        ry0, ry1 = row_bounds[i]
        # pad=1, not the usual default of 4 — right at a boundary where a
        # neighboring row's oversized signature already overflows onto the
        # printed line, a generous margin only invites more of it in.
        sig_cell = crop(img_cv, cols["signature"][0], ry0, cols["signature"][1], ry1, pad=1)

        name_text = ocr_cell(name_cell, lang="eng", psm=7).replace("\n", " ")
        has_signature, ink_ratio = signature_present(sig_cell)

        records.append({
            "row": i + 1,
            "nameEnRaw": english_line(name_text),
            "signatureDetected": has_signature,
            "signatureInkRatio": ink_ratio,
            "referenceSignature": crop_to_base64(sig_cell) if has_signature else None,
        })

    return {
        "extractedAt": datetime.now(timezone.utc).isoformat(),
        "rowsDetected": len(records),
        "rowCountSource": row_count_source,
        "records": records,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image_path")
    parser.add_argument("roster_json_path")
    parser.add_argument("--out", default=None)
    parser.add_argument("--rows", type=int, default=None)
    parser.add_argument("--expected-date", default=None, help="ISO yyyy-mm-dd to validate the sheet's date against")
    args = parser.parse_args()

    with open(args.roster_json_path, "r", encoding="utf-8") as f:
        roster = json.load(f)

    result = extract_sheet(args.image_path, roster, expected_rows=args.rows, expected_date=args.expected_date)
    output = json.dumps(result, indent=2, ensure_ascii=False)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(output)
    print(output)


if __name__ == "__main__":
    main()