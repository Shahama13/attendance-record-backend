const pool = require("../db/pool");

// Call this after any create/update/verify/delete so there's a durable
// trail of who changed what. Never throws — a failed audit write should
// not fail the user's request, but it does get logged to stderr.
async function audit(userId, action, entityType, entityId, details = {}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, action, entityType, entityId, JSON.stringify(details)]
    );
  } catch (err) {
    console.error("Failed to write audit log:", err.message);
  }
}

module.exports = { audit };
