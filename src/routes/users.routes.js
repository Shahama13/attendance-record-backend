const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");
const asyncHandler = require("../utils/asyncHandler");
const { audit } = require("../middleware/auditLog");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

const SAFE_COLUMNS = `id, username, full_name, role, campus_id, active, created_at`;

// GET /api/users?campusId=&siteId=
//
// Admin-only user management, but still filterable by site/campus so a
// growing user list can be narrowed the same way the Employees tab is —
// campusId (unambiguous) takes priority; siteId alone shows every user
// (of any role) assigned to any campus under that site. Non-supervisor
// users (admin/hr/viewer) have no campus_id and so never match either
// filter — only "All sites" shows them.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { campusId, siteId } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (campusId) {
      conditions.push(`u.campus_id = $${i++}`);
      values.push(Number(campusId));
    } else if (siteId) {
      conditions.push(`c.site_id = $${i++}`);
      values.push(Number(siteId));
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.campus_id, u.active, u.created_at,
              c.name AS campus_name, c.site_id, s.name AS site_name
       FROM users u
       LEFT JOIN campuses c ON c.id = u.campus_id
       LEFT JOIN sites s ON s.id = c.site_id
       ${where}
       ORDER BY u.full_name`,
      values
    );
    res.json(rows);
  })
);

// POST /api/users  { username, password, fullName, role, campusId }
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { username, password, fullName, role, campusId } = req.body;
    if (!username || !password || !fullName || !role) {
      return res.status(400).json({ error: "username, password, fullName and role are required." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    if (!["admin", "hr", "supervisor", "viewer"].includes(role)) {
      return res.status(400).json({ error: "Invalid role." });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role, campus_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${SAFE_COLUMNS}`,
      [username, hash, fullName, role, campusId || null]
    );
    await audit(req.user.id, "user.create", "user", rows[0].id, { username, role });
    res.status(201).json(rows[0]);
  })
);

// PATCH /api/users/:id  { fullName?, role?, campusId?, active?, password? }
//
// password here is how an admin resets another user's forgotten
// password — no knowledge of the old one required, unlike the
// self-service PATCH /api/auth/change-password. Works on any user,
// including another admin (deliberately: the recovery path when one
// admin is locked out is simply having a second admin account, so this
// route mustn't block admin-on-admin resets).
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { fullName, role, campusId, active, password } = req.body;

    if (password && password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const sets = [];
    const values = [];
    let i = 1;

    if (fullName !== undefined) { sets.push(`full_name = $${i++}`); values.push(fullName); }
    if (role !== undefined) { sets.push(`role = $${i++}`); values.push(role); }
    if (campusId !== undefined) { sets.push(`campus_id = $${i++}`); values.push(campusId); }
    if (active !== undefined) { sets.push(`active = $${i++}`); values.push(active); }
    if (password) { sets.push(`password_hash = $${i++}`); values.push(await bcrypt.hash(password, 10)); }

    if (sets.length === 0) return res.status(400).json({ error: "No fields to update." });

    values.push(id);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${SAFE_COLUMNS}`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found." });

    await audit(req.user.id, "user.update", "user", Number(id), req.body);
    res.json(rows[0]);
  })
);

module.exports = router;