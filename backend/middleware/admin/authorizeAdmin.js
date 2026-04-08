export function requireAdminRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }

    if (!allowedRoles.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Insufficient admin permissions' });
    }

    next();
  };
}

export function requireRecentAdminAuth(maxAgeMinutes = 15) {
  return (req, res, next) => {
    if (!req.admin?.iat) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }

    const issuedAtMs = Number(req.admin.iat) * 1000;
    const maxAgeMs = maxAgeMinutes * 60 * 1000;
    const ageMs = Date.now() - issuedAtMs;

    if (ageMs > maxAgeMs) {
      return res.status(401).json({ error: 'Recent admin authentication required' });
    }

    next();
  };
}
