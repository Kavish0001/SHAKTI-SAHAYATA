import 'dotenv/config';
import jwt from 'jsonwebtoken';

const INSECURE_JWT_SECRETS = new Set([
  '',
  'changeme',
  'change-me',
  'secret',
  'dev-secret',
  'localdev',
  'shakti-local-secret-key-change-in-production',
  'shakti-dev-secret-change-in-production-minimum-32-chars'
]);

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseSameSite = (value) => {
  const normalized = String(value || 'strict').trim().toLowerCase();
  if (normalized === 'lax') return 'lax';
  if (normalized === 'none') return 'none';
  return 'strict';
};

const parseOrigins = (value, fallback) =>
  String(value || fallback || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const adminJwtSecret = String(process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET || '').trim();
if (!adminJwtSecret || adminJwtSecret.length < 32 || INSECURE_JWT_SECRETS.has(adminJwtSecret)) {
  throw new Error(
    '[ADMIN_AUTH] JWT_ADMIN_SECRET (or fallback JWT_SECRET) is required, must be at least 32 characters, and cannot use the documented placeholder value.'
  );
}

export const ADMIN_ACCESS_TOKEN_TTL = String(process.env.JWT_ADMIN_ACCESS_EXPIRY || '10m').trim();
export const ADMIN_REFRESH_TOKEN_TTL_DAYS = parsePositiveInt(process.env.JWT_ADMIN_REFRESH_EXPIRY_DAYS, 7);
export const ADMIN_REFRESH_COOKIE_NAME = String(process.env.ADMIN_REFRESH_COOKIE_NAME || 'shakti_admin_refresh').trim();
export const ADMIN_REFRESH_COOKIE_SAME_SITE = parseSameSite(process.env.ADMIN_REFRESH_COOKIE_SAMESITE);
export const ADMIN_REFRESH_COOKIE_SECURE =
  String(process.env.ADMIN_REFRESH_COOKIE_SECURE || '').trim().toLowerCase() === 'true'
  || process.env.NODE_ENV === 'production'
  || ADMIN_REFRESH_COOKIE_SAME_SITE === 'none';
export const ADMIN_ALLOWED_ORIGINS = parseOrigins(
  process.env.ADMIN_ALLOWED_ORIGINS,
  process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000'
);

export const ADMIN_AUTH_CONFIG = {
  jwtSecret: adminJwtSecret,
  accessTokenTtl: ADMIN_ACCESS_TOKEN_TTL,
  refreshTokenTtlDays: ADMIN_REFRESH_TOKEN_TTL_DAYS,
  refreshCookieName: ADMIN_REFRESH_COOKIE_NAME,
  refreshCookieSameSite: ADMIN_REFRESH_COOKIE_SAME_SITE,
  refreshCookieSecure: ADMIN_REFRESH_COOKIE_SECURE,
  allowedOrigins: ADMIN_ALLOWED_ORIGINS
};

export const signAdminAccessToken = (admin, options = {}) =>
  jwt.sign(
    {
      adminId: admin.id,
      email: admin.email,
      fullName: admin.full_name,
      role: admin.role,
      permissions: Array.isArray(admin.permissions) ? admin.permissions : [],
      accountType: 'it_admin',
      sessionId: options.sessionId || null,
      recentAuthAt: options.recentAuthAt || Math.floor(Date.now() / 1000),
    },
    ADMIN_AUTH_CONFIG.jwtSecret,
    { expiresIn: ADMIN_AUTH_CONFIG.accessTokenTtl, audience: 'admin-console', subject: String(admin.id) }
  );

export const decodeAdminAccessTokenExpiry = (token) => {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded !== 'object' || !decoded.exp) return null;
  return new Date(decoded.exp * 1000).toISOString();
};

export const verifyAdminAccessToken = (token) =>
  jwt.verify(token, ADMIN_AUTH_CONFIG.jwtSecret, { audience: 'admin-console' });

export const buildAdminRefreshCookieOptions = () => ({
  httpOnly: true,
  sameSite: ADMIN_AUTH_CONFIG.refreshCookieSameSite,
  secure: ADMIN_AUTH_CONFIG.refreshCookieSecure,
  path: '/api/admin/auth',
  maxAge: ADMIN_AUTH_CONFIG.refreshTokenTtlDays * 24 * 60 * 60 * 1000
});

export const setAdminRefreshCookie = (res, token) => {
  res.cookie(ADMIN_AUTH_CONFIG.refreshCookieName, token, buildAdminRefreshCookieOptions());
};

export const clearAdminRefreshCookie = (res) => {
  res.clearCookie(ADMIN_AUTH_CONFIG.refreshCookieName, {
    ...buildAdminRefreshCookieOptions(),
    maxAge: undefined
  });
};
