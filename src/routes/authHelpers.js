const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function sanitizeUser(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.password_hash;
  try { out.top_categories = JSON.parse(out.top_categories || '[]'); } catch { out.top_categories = []; }
  return out;
}

module.exports = { makeToken, sanitizeUser };
