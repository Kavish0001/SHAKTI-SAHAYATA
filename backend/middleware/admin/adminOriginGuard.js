import { ADMIN_ALLOWED_ORIGINS } from '../../config/adminAuth.js';

export function adminOriginGuard(req, res, next) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin || ADMIN_ALLOWED_ORIGINS.length === 0) {
    return next();
  }

  if (!ADMIN_ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Origin is not allowed for admin access' });
  }

  return next();
}
