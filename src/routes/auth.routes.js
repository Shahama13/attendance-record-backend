const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const { signToken } = require("../utils/jwt");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../utils/asyncHandler");
const { audit } = require("../middleware/auditLog");

const router = express.Router();

// POST /api/auth/login  { username, password }
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required." });
    }

    const { rows } = await pool.query(
      `SELECT id, username, password_hash, full_name, role, campus_id, active
       FROM users WHERE username = $1`,
      [username]
    );
    const user = rows[0];

    if (!user || !user.active) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const token = signToken(user);
    await audit(user.id, "auth.login", "user", user.id, {});

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        campusId: user.campus_id,
      },
    });
  })
);

// GET /api/auth/me
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.campus_id, c.code AS campus_code, c.name AS campus_name
       FROM users u LEFT JOIN campuses c ON c.id = u.campus_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found." });
    res.json(rows[0]);
  })
);

// PATCH /api/auth/change-password  { currentPassword, newPassword }
//
// Self-service password change — any authenticated user can change their
// own password here (unlike PATCH /api/users/:id, which is admin-only and
// meant for an admin resetting someone else's forgotten password). Proving
// the current password is what makes this safe without going through an
// admin at all.
router.patch(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "currentPassword and newPassword are required." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters." });
    }

    const { rows } = await pool.query(`SELECT id, password_hash FROM users WHERE id = $1`, [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "User not found." });

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    // 400, not 401 — the frontend's useApi treats every 401 as "session
    // expired" and force-logs-out, which is wrong here: the session is
    // fine, the person just mistyped their current password.
    if (!ok) return res.status(400).json({ error: "Current password is incorrect." });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [hash, user.id]);
    await audit(req.user.id, "auth.change_password", "user", user.id, {});
    res.json({ ok: true });
  })
);

module.exports = router;