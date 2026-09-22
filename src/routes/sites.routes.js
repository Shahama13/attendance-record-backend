const express = require("express");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");
const asyncHandler = require("../utils/asyncHandler");
const { audit } = require("../middleware/auditLog");

const router = express.Router();
router.use(requireAuth);

// GET /api/sites — everyone authenticated can list the parent sites
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT id, name, created_at FROM sites ORDER BY name`);
    res.json(rows);
  })
);

// GET /api/sites/:id/campuses — campuses under one parent site
router.get(
  "/:id/campuses",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, code, name, created_at FROM campuses WHERE site_id = $1 ORDER BY name`,
      [req.params.id]
    );
    res.json(rows);
  })
);

// POST /api/sites — admin only. Just creates the parent org record;
// campuses are added separately via the atomic wizard in campuses.routes.js.
router.post(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name is required." });

    const { rows } = await pool.query(
      `INSERT INTO sites (name) VALUES ($1) RETURNING id, name, created_at`,
      [name]
    );
    await audit(req.user.id, "site.create", "site", rows[0].id, { name });
    res.status(201).json(rows[0]);
  })
);

module.exports = router;
