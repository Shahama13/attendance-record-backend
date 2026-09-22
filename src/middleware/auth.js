const { verifyToken } = require("../utils/jwt");

// Reads "Authorization: Bearer <token>", verifies it, and attaches
// req.user = { id, username, role, campusId }. Everything downstream
// (RBAC, campus-scoping, audit logging) relies on req.user being set here.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, username: payload.username, role: payload.role, campusId: payload.campusId };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

module.exports = { requireAuth };
