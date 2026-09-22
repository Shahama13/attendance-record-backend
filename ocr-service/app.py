"""
OCR microservice — wraps extract_sheet.py behind an HTTP endpoint so the
Node API (or the mobile app directly) can call it without shelling out.

This is the "OCR Service" component from the architecture in the spec
(Section 6), implemented with the open-source Tesseract option rather
than Google Cloud Vision, so it runs anywhere without a billed API key.
Swapping in Cloud Vision later would mean replacing extract_sheet.py's
internals; the HTTP contract here (multipart image + roster in, JSON
records out) wouldn't need to change.
"""

import io
import json
import tempfile
import os

from flask import Flask, request, jsonify

from extract_sheet import extract_sheet, extract_specimen

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 15 * 1024 * 1024  # 15MB — a phone photo comfortably fits


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/extract")
def extract():
    """
    Daily attendance scan. Multipart form fields:
      image        — the sheet photo (required)
      roster       — JSON array of {employee_code, name_en, reference_signature?}
                     for the campus (required). reference_signature is an
                     optional base64 image, captured once at campus setup —
                     when present for a matched row, the response includes
                     a signatureMatchScore for that row (see
                     compare_signatures() in extract_sheet.py for the very
                     real caveats on how much to trust that score).
      rows         — expected row count, defaults to len(roster) (optional)
      expectedDate — ISO yyyy-mm-dd the sheet's handwritten date must match for
                     sheetDate.matches to be true (optional — omit to skip the check)
    """
    if "image" not in request.files:
        return jsonify({"error": "Missing 'image' file field."}), 400
    if "roster" not in request.form:
        return jsonify({"error": "Missing 'roster' form field (JSON array)."}), 400

    try:
        roster = json.loads(request.form["roster"])
    except json.JSONDecodeError:
        return jsonify({"error": "roster must be valid JSON."}), 400

    rows = request.form.get("rows")
    rows = int(rows) if rows else None
    expected_date = request.form.get("expectedDate") or None

    image_file = request.files["image"]
    suffix = os.path.splitext(image_file.filename or "")[1] or ".png"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        image_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        result = extract_sheet(tmp_path, roster, expected_rows=rows, expected_date=expected_date)
        return jsonify(result)
    except Exception as e:  # noqa: BLE001 — surface extraction failures to the caller, not just logs
        return jsonify({"error": f"Extraction failed: {e}"}), 422
    finally:
        os.unlink(tmp_path)


@app.post("/extract-specimen")
def extract_specimen_route():
    """
    Bootstrap mode for the campus-creation wizard: called with a photo of
    a campus's specimen/reference sheet, before that campus's roster
    exists at all. There's no roster to fuzzy-match names against, so
    this only returns each row's best-guess English name and a cropped
    signature image for an admin to review and correct — including
    filling in the Arabic name manually, since this OCR pipeline never
    runs an Arabic-language pass (see the module docstring in
    extract_sheet.py).

    Multipart form fields:
      image — the specimen sheet photo (required)
      rows  — optional manual row-count override. Row count is normally
              auto-detected from the sheet's own row shading (see
              find_row_bands_by_shading in extract_sheet.py) — this only
              needs to be passed if auto-detection fails on a particular
              photo (poor lighting, unusual template, etc).
    """
    if "image" not in request.files:
        return jsonify({"error": "Missing 'image' file field."}), 400

    rows = request.form.get("rows")
    rows = int(rows) if rows else None

    image_file = request.files["image"]
    suffix = os.path.splitext(image_file.filename or "")[1] or ".png"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        image_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        result = extract_specimen(tmp_path, expected_rows=rows)
        return jsonify(result)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"Specimen extraction failed: {e}"}), 422
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5001)))
