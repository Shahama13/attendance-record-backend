const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requireRole, enforceCampusScope } = require("../middleware/rbac");
const asyncHandler = require("../utils/asyncHandler");
const { audit } = require("../middleware/auditLog");

const router = express.Router();
router.use(requireAuth);

const MIN_SUPERVISORS = 2;

// GET /api/campuses?siteId=  — list campuses. Supervisors/viewers only
// ever see their own campus regardless of siteId (enforceCampusScope
// compares against req.user.campusId, never a client-supplied value).
router.get(
  "/",
  enforceCampusScope,
  asyncHandler(async (req, res) => {
    const { siteId } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (siteId) { conditions.push(`c.site_id = $${i++}`); values.push(siteId); }
    if (!["admin", "hr"].includes(req.user.role) && req.user.campusId) {
      conditions.push(`c.id = $${i++}`);
      values.push(req.user.campusId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT c.id, c.code, c.name, c.site_id, s.name AS site_name,
              (SELECT COUNT(*)::int FROM employees e WHERE e.campus_id = c.id AND e.status = 'active') AS roster_size,
              (SELECT COUNT(*)::int FROM users u WHERE u.campus_id = c.id AND u.role = 'supervisor' AND u.active) AS supervisor_count
       FROM campuses c JOIN sites s ON s.id = c.site_id
       ${where}
       ORDER BY s.name, c.name`,
      values
    );
    res.json(rows);
  })
);

// GET /api/campuses/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT c.id, c.code, c.name, c.site_id, s.name AS site_name
       FROM campuses c JOIN sites s ON s.id = c.site_id WHERE c.id = $1`,
      [req.params.id]
    );
    const campus = rows[0];
    if (!campus) return res.status(404).json({ error: "Campus not found." });
    if (!["admin", "hr"].includes(req.user.role) && campus.id !== req.user.campusId) {
      return res.status(403).json({ error: "You do not have access to this campus." });
    }
    res.json(campus);
  })
);

// -----------------------------------------------------------------
// POST /api/campuses — admin only. This is the single "finalize" call
// for the whole campus-creation wizard: nothing about the campus,
// employees, signatures, or supervisor assignments exists in the
// database until this succeeds — the wizard's earlier steps (specimen
// upload, OCR extraction, admin review/edits, choosing supervisors) all
// happen client-side against data held in memory. Abandoning the wizard
// before this call means nothing was ever saved.
//
// Body:
// {
//   siteId, code, name,
//   employees: [ { nameEn, nameAr, employeeCode?, referenceSignature? } ],
//   supervisors: { existingUserIds?: number[], newUsers?: [{ username, password, fullName }] }
// }
//
// Runs as one transaction: if anything fails partway (duplicate employee
// code, duplicate username, missing site, etc.) the whole thing rolls
// back — no half-created campus is ever left behind.
// -----------------------------------------------------------------
router.post(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { siteId, code, name, employees, supervisors } = req.body;

    if (!siteId || !code || !name) {
      return res.status(400).json({ error: "siteId, code and name are required." });
    }
    if (!Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ error: "employees[] is required and must have at least one entry." });
    }
    for (const e of employees) {
      // nameAr is optional — the wizard no longer collects it at campus
      // creation; it can be filled in later via PATCH /api/employees/:id.
      if (!e.nameEn) {
        return res.status(400).json({ error: "Every employee needs nameEn (from the reviewed specimen extraction)." });
      }
    }

    const existingUserIds = supervisors?.existingUserIds || [];
    const newUsers = supervisors?.newUsers || [];
    const totalSupervisors = existingUserIds.length + newUsers.length;
    if (totalSupervisors < MIN_SUPERVISORS) {
      return res.status(400).json({
        error: `A campus needs at least ${MIN_SUPERVISORS} supervisors (got ${totalSupervisors}).`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: siteRows } = await client.query(`SELECT id FROM sites WHERE id = $1`, [siteId]);
      if (!siteRows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Site not found." });
      }

      const { rows: campusRows } = await client.query(
        `INSERT INTO campuses (site_id, code, name) VALUES ($1, $2, $3) RETURNING *`,
        [siteId, code, name]
      );
      const campus = campusRows[0];

      const createdEmployees = [];
      for (let idx = 0; idx < employees.length; idx++) {
        const e = employees[idx];
        // Falls back to a generated code when the wizard didn't supply one.
        // Includes campus.id (globally unique, assigned by the INSERT just
        // above) rather than just the human-readable campus `code` — two
        // different sites can each have a "north" campus (code is now only
        // unique per-site, see schema.sql), so `code` alone would generate
        // colliding employee_codes like "NORTH-01" for both.
        const employeeCode = e.employeeCode || `${code.toUpperCase()}${campus.id}-${String(idx + 1).padStart(2, "0")}`;
        const { rows } = await client.query(
          `INSERT INTO employees (employee_code, name_en, name_ar, campus_id, reference_signature)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [employeeCode, e.nameEn, e.nameAr || null, campus.id, e.referenceSignature || null]
        );
        createdEmployees.push(rows[0]);
      }

      // Reassign existing users to this campus as supervisors. This
      // moves them off any campus they were previously scoped to —
      // intentional for now (one supervisor account, one active campus),
      // but worth revisiting if you ever want a supervisor on more than
      // one campus at once.
      const assignedSupervisors = [];
      for (const userId of existingUserIds) {
        const { rows } = await client.query(
          `UPDATE users SET role = 'supervisor', campus_id = $1 WHERE id = $2 RETURNING id, username, full_name`,
          [campus.id, userId]
        );
        if (!rows[0]) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: `User id ${userId} not found.` });
        }
        assignedSupervisors.push(rows[0]);
      }

      for (const nu of newUsers) {
        if (!nu.username || !nu.password || !nu.fullName) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Each new supervisor needs username, password and fullName." });
        }
        const hash = await bcrypt.hash(nu.password, 10);
        const { rows } = await client.query(
          `INSERT INTO users (username, password_hash, full_name, role, campus_id)
           VALUES ($1, $2, $3, 'supervisor', $4) RETURNING id, username, full_name`,
          [nu.username, hash, nu.fullName, campus.id]
        );
        assignedSupervisors.push(rows[0]);
      }

      await client.query("COMMIT");

      await audit(req.user.id, "campus.create", "campus", campus.id, {
        siteId,
        code,
        name,
        employeeCount: createdEmployees.length,
        supervisorCount: assignedSupervisors.length,
      });

      res.status(201).json({ ...campus, employees: createdEmployees, supervisors: assignedSupervisors });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

module.exports = router;