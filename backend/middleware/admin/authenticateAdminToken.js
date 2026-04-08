import { verifyAdminAccessToken } from '../../config/adminAuth.js';

export function authenticateAdminToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Admin access token required' });
  }

  try {
    const decoded = verifyAdminAccessToken(token);
    if (!decoded || decoded.accountType !== 'it_admin') {
      return res.status(403).json({ error: 'Invalid admin token' });
    }

    req.admin = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Admin token expired, please refresh' });
    }

    return res.status(403).json({ error: 'Invalid admin token' });
  }
}
