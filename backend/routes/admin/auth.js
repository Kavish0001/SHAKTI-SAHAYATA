import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import pool from '../../config/database.js';
import {
  ADMIN_AUTH_CONFIG,
  clearAdminRefreshCookie,
  decodeAdminAccessTokenExpiry,
  setAdminRefreshCookie,
  signAdminAccessToken
} from '../../config/adminAuth.js';
import { authenticateAdminToken } from '../../middleware/admin/authenticateAdminToken.js';
import { logAdminAction } from '../../services/admin/adminAudit.service.js';

const router = Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 30;

const createRefreshToken = () => crypto.randomBytes(40).toString('hex');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const buildAccessTokenPayload = (admin) => {
  const accessToken = signAdminAccessToken(admin);
  return {
    accessToken,
    expiresAt: decodeAdminAccessTokenExpiry(accessToken)
  };
};

const createSessionRecord = async ({ adminAccountId, ipAddress, userAgent }) => {
  const result = await pool.query(
    `
      INSERT INTO admin_sessions (admin_account_id, ip_address, user_agent)
      VALUES ($1, $2, $3)
      RETURNING id, started_at
    `,
    [adminAccountId, ipAddress, userAgent]
  );
  return result.rows[0];
};

const getLatestActiveSession = async (adminAccountId) => {
  const result = await pool.query(
    `
      SELECT id, started_at
      FROM admin_sessions
      WHERE admin_account_id = $1 AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [adminAccountId]
  );
  return result.rows[0] || null;
};

const revokeRefreshFamily = async (familyId) => {
  if (!familyId) return;
  await pool.query(
    `
      UPDATE admin_refresh_tokens
      SET is_revoked = TRUE
      WHERE family_id = $1 AND is_revoked = FALSE
    `,
    [familyId]
  );
};

const storeRefreshToken = async ({ adminAccountId, familyId, rawToken, ipAddress, userAgent }) => {
  const result = await pool.query(
    `
      INSERT INTO admin_refresh_tokens (
        admin_account_id,
        token_hash,
        family_id,
        expires_at,
        ip_address,
        user_agent
      )
      VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval, $5, $6)
      RETURNING id, family_id, expires_at
    `,
    [adminAccountId, hashToken(rawToken), familyId, String(ADMIN_AUTH_CONFIG.refreshTokenTtlDays), ipAddress, userAgent]
  );

  return result.rows[0];
};

const findRefreshTokenRecord = async (rawToken) => {
  if (!rawToken) return null;

  const result = await pool.query(
    `
      SELECT
        rt.id,
        rt.admin_account_id,
        rt.family_id,
        rt.expires_at,
        rt.is_revoked,
        aa.id AS account_id,
        aa.email,
        aa.full_name,
        aa.role,
        aa.permissions,
        aa.is_active
      FROM admin_refresh_tokens rt
      JOIN admin_accounts aa ON aa.id = rt.admin_account_id
      WHERE rt.token_hash = $1
      LIMIT 1
    `,
    [hashToken(rawToken)]
  );

  return result.rows[0] || null;
};

const rotateRefreshToken = async ({ existingToken, ipAddress, userAgent }) => {
  const nextRawToken = createRefreshToken();
  const nextRecord = await storeRefreshToken({
    adminAccountId: existingToken.admin_account_id,
    familyId: existingToken.family_id,
    rawToken: nextRawToken,
    ipAddress,
    userAgent
  });

  await pool.query(
    `
      UPDATE admin_refresh_tokens
      SET is_revoked = TRUE, replaced_by = $1
      WHERE id = $2
    `,
    [nextRecord.id, existingToken.id]
  );

  return { rawToken: nextRawToken, record: nextRecord };
};

const getRefreshTokenFromCookie = (req) => req.cookies?.[ADMIN_AUTH_CONFIG.refreshCookieName] || null;

const buildAdminResponse = async ({ admin, session, res, refreshToken }) => {
  const tokenPayload = buildAccessTokenPayload(admin);

  if (refreshToken) {
    setAdminRefreshCookie(res, refreshToken);
  }

  return {
    admin: {
      id: admin.id,
      email: admin.email,
      fullName: admin.full_name,
      role: admin.role,
      permissions: Array.isArray(admin.permissions) ? admin.permissions : []
    },
    accessToken: tokenPayload.accessToken,
    expiresAt: tokenPayload.expiresAt,
    session: session
      ? {
          id: session.id,
          startedAt: session.started_at
        }
      : null
  };
};

const getAdminByEmail = async (email) => {
  const result = await pool.query(
    `
      SELECT *
      FROM admin_accounts
      WHERE email = $1
      LIMIT 1
    `,
    [email]
  );
  return result.rows[0] || null;
};

const checkAdminLockout = async (email) => {
  const admin = await getAdminByEmail(email);
  if (!admin) return { locked: false, admin: null };

  if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(admin.locked_until) - new Date()) / 60000);
    return { locked: true, minutesLeft, admin };
  }

  if (admin.locked_until && new Date(admin.locked_until) <= new Date()) {
    await pool.query(
      `
        UPDATE admin_accounts
        SET failed_login_attempts = 0, locked_until = NULL
        WHERE id = $1
      `,
      [admin.id]
    );
    admin.failed_login_attempts = 0;
    admin.locked_until = null;
  }

  return { locked: false, admin };
};

const recordFailedLogin = async (adminId) => {
  if (!adminId) return;

  await pool.query(
    `
      UPDATE admin_accounts
      SET failed_login_attempts = failed_login_attempts + 1,
          locked_until = CASE
            WHEN failed_login_attempts + 1 >= $1
            THEN NOW() + INTERVAL '${LOCKOUT_DURATION_MINUTES} minutes'
            ELSE locked_until
          END
      WHERE id = $2
    `,
    [MAX_FAILED_ATTEMPTS, adminId]
  );
};

const resetFailedLogins = async (adminId) => {
  await pool.query(
    `
      UPDATE admin_accounts
      SET failed_login_attempts = 0, locked_until = NULL
      WHERE id = $1
    `,
    [adminId]
  );
};

router.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const lockout = await checkAdminLockout(email);
    if (lockout.locked) {
      await logAdminAction({
        adminAccountId: lockout.admin?.id || null,
        action: 'ADMIN_LOGIN_LOCKED',
        resourceType: 'admin_account',
        resourceId: lockout.admin?.id ? String(lockout.admin.id) : null,
        ipAddress: req.ip,
        details: { email }
      });

      return res.status(423).json({
        error: `Admin account locked. Try again in ${lockout.minutesLeft} minutes.`
      });
    }

    const admin = lockout.admin || await getAdminByEmail(email);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    if (!admin.is_active) {
      return res.status(403).json({ error: 'Admin account disabled' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      await recordFailedLogin(admin.id);
      await logAdminAction({
        adminAccountId: admin.id,
        action: 'ADMIN_LOGIN_FAILED',
        resourceType: 'admin_account',
        resourceId: String(admin.id),
        ipAddress: req.ip,
        details: { email }
      });
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    await resetFailedLogins(admin.id);

    const session = await createSessionRecord({
      adminAccountId: admin.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    await pool.query(
      `
        UPDATE admin_accounts
        SET last_login = NOW()
        WHERE id = $1
      `,
      [admin.id]
    );

    const refreshToken = createRefreshToken();
    const familyId = crypto.randomUUID();

    await storeRefreshToken({
      adminAccountId: admin.id,
      familyId,
      rawToken: refreshToken,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    await logAdminAction({
      adminAccountId: admin.id,
      sessionId: session.id,
      action: 'ADMIN_LOGIN',
      resourceType: 'admin_session',
      resourceId: String(session.id),
      ipAddress: req.ip,
      details: { email }
    });

    return res.json(await buildAdminResponse({ admin, session, res, refreshToken }));
  } catch (error) {
    console.error('[ADMIN_AUTH] Login error:', error);
    return res.status(500).json({ error: 'Admin login failed' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const rawToken = getRefreshTokenFromCookie(req);
    if (!rawToken) {
      clearAdminRefreshCookie(res);
      return res.status(401).json({ error: 'Admin refresh token required' });
    }

    const existingToken = await findRefreshTokenRecord(rawToken);
    if (!existingToken || existingToken.is_revoked || !existingToken.is_active || new Date(existingToken.expires_at) <= new Date()) {
      clearAdminRefreshCookie(res);
      if (existingToken?.family_id) {
        await revokeRefreshFamily(existingToken.family_id);
      }
      return res.status(401).json({ error: 'Admin refresh token is invalid or expired' });
    }

    const rotated = await rotateRefreshToken({
      existingToken,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    const session = await getLatestActiveSession(existingToken.admin_account_id);
    const admin = {
      id: existingToken.account_id,
      email: existingToken.email,
      full_name: existingToken.full_name,
      role: existingToken.role,
      permissions: existingToken.permissions
    };

    return res.json(await buildAdminResponse({ admin, session, res, refreshToken: rotated.rawToken }));
  } catch (error) {
    console.error('[ADMIN_AUTH] Refresh error:', error);
    clearAdminRefreshCookie(res);
    return res.status(500).json({ error: 'Failed to refresh admin session' });
  }
});

router.get('/bootstrap', async (req, res) => {
  try {
    const rawToken = getRefreshTokenFromCookie(req);
    if (!rawToken) {
      return res.json({ authenticated: false });
    }

    const existingToken = await findRefreshTokenRecord(rawToken);
    if (!existingToken || existingToken.is_revoked || !existingToken.is_active || new Date(existingToken.expires_at) <= new Date()) {
      clearAdminRefreshCookie(res);
      if (existingToken?.family_id) {
        await revokeRefreshFamily(existingToken.family_id);
      }
      return res.json({ authenticated: false });
    }

    const session = await getLatestActiveSession(existingToken.admin_account_id);
    const admin = {
      id: existingToken.account_id,
      email: existingToken.email,
      full_name: existingToken.full_name,
      role: existingToken.role,
      permissions: existingToken.permissions
    };

    const payload = await buildAdminResponse({ admin, session, res });
    return res.json({ authenticated: true, ...payload });
  } catch (error) {
    console.error('[ADMIN_AUTH] Bootstrap error:', error);
    clearAdminRefreshCookie(res);
    return res.json({ authenticated: false });
  }
});

router.post('/logout', authenticateAdminToken, async (req, res) => {
  try {
    const rawToken = getRefreshTokenFromCookie(req);
    const existingToken = rawToken ? await findRefreshTokenRecord(rawToken) : null;

    if (existingToken?.family_id) {
      await revokeRefreshFamily(existingToken.family_id);
    }

    await pool.query(
      `
        UPDATE admin_sessions
        SET ended_at = NOW(), logout_reason = 'manual'
        WHERE admin_account_id = $1 AND ended_at IS NULL
      `,
      [req.admin.adminId]
    );

    await logAdminAction({
      adminAccountId: req.admin.adminId,
      action: 'ADMIN_LOGOUT',
      resourceType: 'admin_session',
      ipAddress: req.ip
    });

    clearAdminRefreshCookie(res);
    return res.json({ message: 'Admin logged out successfully' });
  } catch (error) {
    console.error('[ADMIN_AUTH] Logout error:', error);
    clearAdminRefreshCookie(res);
    return res.status(500).json({ error: 'Admin logout failed' });
  }
});

router.get('/me', authenticateAdminToken, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT id, email, full_name, role, permissions, is_active, last_login, created_at
        FROM admin_accounts
        WHERE id = $1
        LIMIT 1
      `,
      [req.admin.adminId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin account not found' });
    }

    const admin = result.rows[0];
    return res.json({
      id: admin.id,
      email: admin.email,
      fullName: admin.full_name,
      role: admin.role,
      permissions: Array.isArray(admin.permissions) ? admin.permissions : [],
      isActive: admin.is_active,
      lastLogin: admin.last_login,
      createdAt: admin.created_at
    });
  } catch (error) {
    console.error('[ADMIN_AUTH] Get admin error:', error);
    return res.status(500).json({ error: 'Failed to get admin account info' });
  }
});

export default router;
