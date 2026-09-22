// requireRole('admin', 'hr') -> 403s anyone whose role isn't in the list.
// Must run after requireAuth.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated." });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: `Role '${req.user.role}' is not permitted to perform this action.` });
    }
    next();
  };
}

// Supervisors and viewers may only read/write data for the campus they're
// scoped to. Admin/HR pass through untouched (they see everything).
// Expects the target campus id to be resolvable from req.params.campusId,
// req.query.campusId, or req.body.campusId — whichever the route uses.
//
// Deliberately reads from req.user.campusId, never from a client-supplied
// value, for the comparison itself — a supervisor passing a different
// campus id still gets compared against their own token's campusId, not
// whatever they asked for.
//
// Note: this does NOT resolve a `campus` (or `site`) filter given as a
// human-readable code/name — codes are no longer globally unique across
// sites (see schema.sql), so a code can't be turned into a single id here
// without an async DB lookup this sync middleware doesn't do. Routes that
// only accept a `campus` code fall through to next() below and rely on
// their own query re-scoping to req.user.campusId directly (never trusting
// client input) for the actual enforcement — see attendance.routes.js and
// employees.routes.js. Prefer `campusId` (numeric) wherever a caller needs
// this middleware's own 403 check to fire.
function enforceCampusScope(req, res, next) {
  if (["admin", "hr"].includes(req.user.role)) return next();

  const requestedCampusId = Number(req.params.campusId || req.query.campusId || req.body.campusId);
  if (!requestedCampusId) return next(); // route will 400 on its own validation, or re-scopes itself (see note above)

  if (requestedCampusId !== req.user.campusId) {
    return res.status(403).json({ error: "You do not have access to this campus's data." });
  }
  next();
}

module.exports = { requireRole, enforceCampusScope };