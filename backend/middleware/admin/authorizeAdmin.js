import { ADMIN_CONSOLE_CONFIG } from '../../config/adminConsole.js';

const ROLE_PERMISSIONS = {
  it_admin: new Set([
    'console_access',
    'view_system',
    'view_alerts',
    'acknowledge_alerts',
    'run_self_check',
    'force_logout',
    'export_overview',
    'export_activity',
    'export_cases',
    'export_files',
    'view_export_history',
  ]),
  it_auditor: new Set([
    'console_access',
    'view_system',
    'view_alerts',
    'export_overview',
    'export_activity',
    'view_export_history',
  ]),
};

export const adminHasPermission = (admin, permission) => {
  if (!admin || !permission) return false;

  const rolePermissions = ROLE_PERMISSIONS[String(admin.role || '').trim()] || new Set();
  const explicitPermissions = new Set(
    Array.isArray(admin.permissions)
      ? admin.permissions.map((value) => String(value).trim()).filter(Boolean)
      : []
  );

  return rolePermissions.has(permission) || explicitPermissions.has(permission);
};

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

export function requireAdminPermission(...permissions) {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }

    const allowed = permissions.some((permission) => adminHasPermission(req.admin, permission));
    if (!allowed) {
      return res.status(403).json({ error: 'Insufficient admin permissions', code: 'ADMIN_PERMISSION_REQUIRED' });
    }

    next();
  };
}

export function requireRecentAdminAuth(maxAgeMinutes = ADMIN_CONSOLE_CONFIG.recentAuthWindowMinutes) {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }

    const recentAuthSeconds = Number(req.admin.recentAuthAt || req.admin.iat || 0);
    if (!recentAuthSeconds) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }

    const issuedAtMs = recentAuthSeconds * 1000;
    const maxAgeMs = maxAgeMinutes * 60 * 1000;
    const ageMs = Date.now() - issuedAtMs;

    if (ageMs > maxAgeMs) {
      return res.status(401).json({
        error: 'Recent admin authentication required',
        code: 'RECENT_ADMIN_AUTH_REQUIRED',
        recentAuthWindowMinutes: maxAgeMinutes,
      });
    }

    next();
  };
}
