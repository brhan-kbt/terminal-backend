const jwt = require('jsonwebtoken');

/**
 * JWT verification middleware.
 * Reads Bearer token from Authorization header, verifies with JWT_SECRET,
 * and attaches req.user = { id, role, terminalId, adminRole }.
 * Returns 401 if token is missing or invalid.
 */
function auth(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: payload.id,
      role: payload.role,
      terminalId: payload.terminalId || null,
      adminRole: payload.adminRole || null,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = auth;
