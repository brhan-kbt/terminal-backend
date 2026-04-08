/**
 * RBAC middleware factory.
 * Returns middleware that checks req.user.role matches the required role.
 * Returns 403 if the role does not match.
 *
 * Usage: requireRole('DRIVER'), requireRole('FACILITATOR'), requireRole('ADMIN')
 */
function requireRole(role) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.user.role !== role) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }

    next();
  };
}

module.exports = requireRole;
