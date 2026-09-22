const express = require("express");
const multer = require("multer");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requireRole, enforceCampusScope } = require("../middleware/rbac");
const asyncHandler = require("../utils/asyncHandler");
const { audit } = require("../middleware/auditLog");
const { todayInOman } = require("../utils/date");

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB, matches the OCR service's own cap
});

const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || "http://localhost:5001";

// -----------------------------------------------------------------
// POST /api/ocr/scan
// multipart/form-data: image (file), campusId (form field)
//
// Daily attendance scan — loads the active roster for that campus,
// forwards the photo + roster to the OCR microservice for fuzzy-match
// extraction, and returns the structured per-employee result for the
// supervisor's review screen before the separate POST /api/attendance
// submit.
//
// Each roster entry now also includes reference_signature (the crop
// captured at campus creation, if any) so the OCR service can run a
// signature comparison alongside the existing name/presence extraction.
// The Python side implements this as a basic ORB feature-match heuristic
// (see compare_signatures() in extract_sheet.py) — NOT a trained
// verification model. Treat signatureMatchScore as an advisory
// "worth a second look" signal only; it never blocks a submission and
// nothing here auto-rejects based on it. A row with no matched employee,
// or a matched employee with no reference on file, comes back with
// signatureMatchScore: null.
// -----------------------------------------------------------------
router.post(
  "/scan",
  requireRole("supervisor", "admin"),
  upload.single("image"),
  enforceCampusScope,
  asyncHandler(async (req, res) => {
    const campusId = Number(req.body.campusId);
    if (!campusId) return res.status(400).json({ error: "campusId is required." });
    if (!req.file) return res.status(400).json({ error: "image file is required." });

    const { rows: roster } = await pool.query(
      `SELECT employee_code, name_en, reference_signature
       FROM employees WHERE campus_id = $1 AND status = 'active' ORDER BY employee_code`,
      [campusId]
    );
    if (roster.length === 0) {
      return res.status(400).json({ error: "No active employees found for this campus." });
    }

    const form = new FormData();
    form.append("image", new Blob([req.file.buffer]), req.file.originalname || "sheet.jpg");
    form.append("roster", JSON.stringify(roster));
    form.append("rows", String(roster.length));
    form.append("expectedDate", todayInOman());

    let ocrResponse;
    try {
      ocrResponse = await fetch(`${OCR_SERVICE_URL}/extract`, { method: "POST", body: form });
    } catch (err) {
      return res.status(502).json({ error: `OCR service unreachable: ${err.message}` });
    }

    const payload = await ocrResponse.json();
    if (!ocrResponse.ok) {
      return res.status(422).json({ error: payload.error || "OCR extraction failed." });
    }

    await audit(req.user.id, "attendance.ocr_scan", "campus", campusId, {
      rowsDetected: payload.rowsDetected,
      totalsMatch: payload.totalsMatch,
      sheetDateMatches: payload.sheetDate?.matches,
      sheetDateRaw: payload.sheetDate?.raw,
      signatureMatchAttempted: payload.records?.some((r) => r.signatureMatchScore != null) || false,
    });

    res.json(payload);
  })
);

// -----------------------------------------------------------------
// POST /api/ocr/scan-specimen
// multipart/form-data: image (file), rows (optional form field)
//
// Bootstrap mode for the campus-creation wizard: no existing roster to
// fuzzy-match against, since the campus doesn't exist yet. Extracts each
// row's best-guess English name and a cropped signature image for the
// admin to review, correct, and (for the Arabic name specifically) fill
// in manually — this OCR pipeline only ever runs Tesseract's English
// model, so there's no automatic Arabic extraction despite what the
// backend README claims.
//
// Row count is normally auto-detected by the OCR service from the
// sheet's own printed ruling — but on a real phone photo (uneven
// lighting, signature ink bridging into faint grid lines, a slight
// angle) that detection can silently undercount, which used to blend
// two or more employees' name/signature ink into one garbled row with
// nothing flagging it. Passing `rows` (the number of employees actually
// listed on the sheet, if the admin knows it) lets the OCR service
// cross-check its own detection against that number and refuse with a
// clear error on a mismatch instead of guessing — see the "Row count
// mismatch" check in extract_sheet.py's find_row_bands(). Omit it to
// fall back to auto-detection alone, same as before.
// -----------------------------------------------------------------
router.post(
  "/scan-specimen",
  requireRole("admin"),
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "image file is required." });

    const form = new FormData();
    form.append("image", new Blob([req.file.buffer]), req.file.originalname || "specimen.jpg");
    if (req.body.rows) form.append("rows", String(req.body.rows));

    let ocrResponse;
    try {
      ocrResponse = await fetch(`${OCR_SERVICE_URL}/extract-specimen`, { method: "POST", body: form });
    } catch (err) {
      return res.status(502).json({ error: `OCR service unreachable: ${err.message}` });
    }

    const payload = await ocrResponse.json();
    if (!ocrResponse.ok) {
      return res.status(422).json({ error: payload.error || "Specimen extraction failed." });
    }

    await audit(req.user.id, "campus.specimen_scan", "campus", null, {
      rowsDetected: payload.rowsDetected,
      rowDetectionMethod: payload.rowDetectionMethod,
    });

    res.json(payload);
  })
);

module.exports = router;