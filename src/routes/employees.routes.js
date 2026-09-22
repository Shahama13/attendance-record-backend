const express = require("express");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requireRole, enforceCampusScope } = require("../middleware/rbac");
const asyncHandler = require("../utils/asyncHandler");
const { audit } = require("../middleware/auditLog");

const router = express.Router();
router.use(requireAuth);

// GET /api/employees?campusId=&campus=&site=&siteId=&status=
//
// campusId (numeric, preferred) unambiguously picks one campus. `campus`
// (the code) is kept for backward compatibility — pass `site` alongside
// it if more than one site could have a campus with that code, since
// codes are only unique per-site now (see schema.sql). siteId alone
// (no campusId/campus given) returns every employee across every campus
// under that one site — the "All campuses" state of the admin UI's
// site+campus filter pair.
router.get(
  "/",
  enforceCampusScope,
  asyncHandler(async (req, res) => {
    const { campus, campusId, site, siteId, status } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (campusId) {
      conditions.push(`e.campus_id = $${i++}`);
      values.push(Number(campusId));
    } else if (campus) {
      conditions.push(`c.code = $${i++}`);
      values.push(campus);
      if (site) { conditions.push(`c.site_id = $${i++}`); values.push(Number(site)); }
    } else if (siteId) {
      conditions.push(`c.site_id = $${i++}`);
      values.push(Number(siteId));
    }
    if (status) { conditions.push(`e.status = $${i++}`); values.push(status); }
    // Non-admin/HR are locked to their own campus regardless of the query param.
    if (!["admin", "hr"].includes(req.user.role) && req.user.campusId) {
      conditions.push(`e.campus_id = $${i++}`);
      values.push(req.user.campusId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT e.id, e.employee_code, e.name_en, e.name_ar, e.department, e.status,
              c.id AS campus_id, c.code AS campus_code, c.name AS campus_name,
              s.id AS site_id, s.name AS site_name
       FROM employees e JOIN campuses c ON c.id = e.campus_id JOIN sites s ON s.id = c.site_id
       ${where}
       ORDER BY s.name, c.name, e.employee_code`,
      values
    );
    res.json(rows);
  })
);

// POST /api/employees — admin only (one-off additions after the campus
// already exists; bulk creation from a specimen sheet happens via the
// atomic POST /api/campuses wizard instead).
router.post(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { employeeCode, nameEn, nameAr, campusId, department } = req.body;
    // nameAr is optional (see campuses.routes.js) — can be filled in later via PATCH.
    if (!employeeCode || !nameEn || !campusId) {
      return res.status(400).json({ error: "employeeCode, nameEn and campusId are required." });
    }
    const { rows } = await pool.query(
      `INSERT INTO employees (employee_code, name_en, name_ar, campus_id, department)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [employeeCode, nameEn, nameAr || null, campusId, department || null]
    );
    await audit(req.user.id, "employee.create", "employee", rows[0].id, req.body);
    res.status(201).json(rows[0]);
  })
);

// PATCH /api/employees/:id — admin only (name corrections, status changes, transfers)
router.patch(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { nameEn, nameAr, campusId, department, status } = req.body;

    const sets = [];
    const values = [];
    let i = 1;
    if (nameEn !== undefined) { sets.push(`name_en = $${i++}`); values.push(nameEn); }
    if (nameAr !== undefined) { sets.push(`name_ar = $${i++}`); values.push(nameAr); }
    if (campusId !== undefined) { sets.push(`campus_id = $${i++}`); values.push(campusId); }
    if (department !== undefined) { sets.push(`department = $${i++}`); values.push(department); }
    if (status !== undefined) { sets.push(`status = $${i++}`); values.push(status); }
    if (sets.length === 0) return res.status(400).json({ error: "No fields to update." });

    values.push(id);
    const { rows } = await pool.query(
      `UPDATE employees SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: "Employee not found." });

    await audit(req.user.id, "employee.update", "employee", Number(id), req.body);
    res.json(rows[0]);
  })
);

module.exports = router;