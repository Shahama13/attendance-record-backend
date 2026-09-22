const express = require("express");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requireRole, enforceCampusScope } = require("../middleware/rbac");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();
router.use(requireAuth, requireRole("admin", "hr"));

// Shared query: per-employee totals for a given month (YYYY-MM), scoped
// by an optional campus (by id, or by code + optional parent site id),
// and/or an optional parent site id on its own.
//
// campusId (numeric, preferred) unambiguously picks one campus. campusCode
// (the human code, e.g. "north") is kept for backward compatibility — pass
// siteId alongside it when more than one site could have a campus with
// that code, since codes are only unique per-site now (see schema.sql);
// e.g. site=1&campus=north narrows to one campus within one site, while
// site=1 alone shows every campus under that site.
async function monthlyRows(month, { campusCode, siteId, campusId } = {}) {
  const params = [`${month}-01`];
  const filters = [];

  if (campusId) {
    params.push(campusId);
    filters.push(`c.id = $${params.length}`);
  } else if (campusCode) {
    params.push(campusCode);
    filters.push(`c.code = $${params.length}`);
    if (siteId) {
      params.push(siteId);
      filters.push(`s.id = $${params.length}`);
    }
  } else if (siteId) {
    params.push(siteId);
    filters.push(`s.id = $${params.length}`);
  }
  const extraFilter = filters.length ? `AND ${filters.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `WITH month_sheets AS (
       SELECT sh.id, sh.campus_id
       FROM attendance_sheets sh
       JOIN campuses c ON c.id = sh.campus_id
       JOIN sites s ON s.id = c.site_id
       WHERE date_trunc('month', sh.sheet_date) = date_trunc('month', $1::date)
       ${extraFilter}
     )
     SELECT e.id AS employee_id, e.employee_code, e.name_en,
            c.code AS campus_code, c.name AS campus_name,
            s.id AS site_id, s.name AS site_name,
            COUNT(ms.id)::int AS working_days,
            COUNT(r.id) FILTER (WHERE r.present)::int AS days_present,
            COALESCE(SUM(
              CASE WHEN r.present AND r.clock_in IS NOT NULL AND r.clock_out IS NOT NULL
                   THEN EXTRACT(EPOCH FROM (r.clock_out - r.clock_in)) / 3600.0
                   ELSE 0 END
            ), 0)::numeric(10,2) AS total_clocked_hours
     FROM employees e
     JOIN campuses c ON c.id = e.campus_id
     JOIN sites s ON s.id = c.site_id
     LEFT JOIN month_sheets ms ON ms.campus_id = e.campus_id
     LEFT JOIN attendance_records r ON r.sheet_id = ms.id AND r.employee_id = e.id
     WHERE e.status = 'active' ${extraFilter}
     GROUP BY e.id, e.employee_code, e.name_en, c.code, c.name, s.id, s.name
     ORDER BY s.name, c.name, e.employee_code`,
    params
  );

  return rows.map((r) => ({ ...r, days_absent: r.working_days - r.days_present }));
}

// GET /api/reports/monthly?month=2026-08&campusId=5  (or &campus=north&site=1)
router.get(
  "/monthly",
  enforceCampusScope,
  asyncHandler(async (req, res) => {
    const { month, campus, campusId, site } = req.query;
    if (!/^\d{4}-\d{2}$/.test(month || "")) {
      return res.status(400).json({ error: "month is required, format YYYY-MM." });
    }
    const rows = await monthlyRows(month, { campusCode: campus, siteId: site, campusId });
    res.json({ month, campusId: campusId || null, campus: campus || "all", site: site || "all", rows });
  })
);

// GET /api/reports/monthly/export?month=2026-08&campusId=5  (or &campus=north&site=1)  -> CSV download
router.get(
  "/monthly/export",
  enforceCampusScope,
  asyncHandler(async (req, res) => {
    const { month, campus, campusId, site } = req.query;
    if (!/^\d{4}-\d{2}$/.test(month || "")) {
      return res.status(400).json({ error: "month is required, format YYYY-MM." });
    }
    const rows = await monthlyRows(month, { campusCode: campus, siteId: site, campusId });

    const header = "Site,Campus,Employee Code,Employee Name,Working Days,Days Present,Days Absent,Total Clocked Hours\n";
    const body = rows
      .map((r) => `"${r.site_name}",${r.campus_code},${r.employee_code},"${r.name_en}",${r.working_days},${r.days_present},${r.days_absent},${r.total_clocked_hours}`)
      .join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attendance_report_${month}${campusId ? "_campus" + campusId : ""}${site ? "_site" + site : ""}${campus ? "_" + campus : ""}.csv"`
    );
    res.send(header + body);
  })
);

module.exports = router;