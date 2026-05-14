const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'apexium-secret-key-change-in-production';

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided' });
  }
  const token = auth.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

module.exports = { authMiddleware, JWT_SECRET };