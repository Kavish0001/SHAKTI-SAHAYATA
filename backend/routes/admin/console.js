import { Router } from 'express';
import pool from '../../config/database.js';
import { authenticateAdminToken } from '../../middleware/admin/authenticateAdminToken.js';
import { requireAdminRole } from '../../middleware/admin/authorizeAdmin.js';
import { getLiveHealth, getReadyHealth, getStartupStatus } from '../../services/runtimeStatus.service.js';
import { logAdminAction } from '../../services/admin/adminAudit.service.js';

const router = Router();

router.use(authenticateAdminToken);
router.use(requireAdminRole('it_admin', 'it_auditor'));

const DEFAULT_ACTIVITY_LIMIT = 25;
const MAX_ACTIVITY_LIMIT = 100;

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const buildActivityWhereClause = (query = {}) => {
  const clauses = [];
  const params = [];

  const addClause = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };

  if (query.source) addClause('source = ?', String(query.source).trim().toLowerCase());
  if (query.actorType) addClause('actor_type = ?', String(query.actorType).trim().toLowerCase());
  if (query.action) addClause('action = ?', String(query.action).trim());
  if (query.resourceType) addClause('resource_type = ?', String(query.resourceType).trim());
  if (query.caseId) addClause("resource_id = ? AND resource_type = 'case'", String(query.caseId).trim());
  if (query.dateFrom) addClause('created_at >= ?::timestamptz', String(query.dateFrom).trim());
  if (query.dateTo) addClause('created_at <= ?::timestamptz', String(query.dateTo).trim());
  if (query.q) {
    const q = `%${String(query.q).trim()}%`;
    params.push(q);
    const index = `$${params.length}`;
    clauses.push(`(
      COALESCE(actor_name, '') ILIKE ${index}
      OR COALESCE(actor_email, '') ILIKE ${index}
      OR COALESCE(action, '') ILIKE ${index}
      OR COALESCE(resource_type, '') ILIKE ${index}
      OR COALESCE(resource_id, '') ILIKE ${index}
      OR CAST(COALESCE(details, '{}'::jsonb) AS text) ILIKE ${index}
    )`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
};

const ACTIVITY_CTE = `
  WITH unified_activity AS (
    SELECT
      'audit'::text AS source,
      al.id::text AS id,
      al.created_at,
      'officer'::text AS actor_type,
      al.user_id::text AS actor_id,
      COALESCE(u.full_name, al.officer_name, 'Unknown officer') AS actor_name,
      u.email AS actor_email,
      u.role AS actor_role,
      al.action,
      al.resource_type,
      al.resource_id,
      al.session_id,
      COALESCE(HOST(al.ip_address), NULL) AS ip_address,
      COALESCE(al.details, '{}'::jsonb) AS details
    FROM audit_logs al
    LEFT JOIN users u ON al.user_id = u.id

    UNION ALL

    SELECT
      'admin'::text AS source,
      aal.id::text AS id,
      aal.created_at,
      'admin'::text AS actor_type,
      aal.admin_account_id::text AS actor_id,
      COALESCE(aa.full_name, 'Unknown admin') AS actor_name,
      aa.email AS actor_email,
      aa.role AS actor_role,
      aal.action,
      aal.resource_type,
      aal.resource_id,
      aal.session_id,
      COALESCE(HOST(aal.ip_address), NULL) AS ip_address,
      COALESCE(aal.details, '{}'::jsonb) AS details
    FROM admin_action_logs aal
    LEFT JOIN admin_accounts aa ON aal.admin_account_id = aa.id
  )
`;

const fetchActivity = async ({ query = {}, limit = DEFAULT_ACTIVITY_LIMIT, page = 1 } = {}) => {
  const pageSize = Math.min(Math.max(limit, 1), MAX_ACTIVITY_LIMIT);
  const offset = (Math.max(page, 1) - 1) * pageSize;
  const { whereSql, params } = buildActivityWhereClause(query);

  const itemsResult = await pool.query(
    `
      ${ACTIVITY_CTE}
      SELECT *
      FROM unified_activity
      ${whereSql}
      ORDER BY created_at DESC, source ASC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `,
    [...params, pageSize, offset]
  );

  const countResult = await pool.query(
    `
      ${ACTIVITY_CTE}
      SELECT COUNT(*)::int AS total
      FROM unified_activity
      ${whereSql}
    `,
    params
  );

  return {
    items: itemsResult.rows,
    pagination: {
      page: Math.max(page, 1),
      pageSize,
      total: countResult.rows[0]?.total || 0,
    },
  };
};

router.get('/overview', async (req, res) => {
  try {
    const [metricsResult, accountStateResult, recentAdminActivityResult, dbHealthResult] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM sessions WHERE ended_at IS NULL) AS active_officer_sessions,
          (SELECT COUNT(*)::int FROM admin_sessions WHERE ended_at IS NULL) AS active_admin_sessions,
          (SELECT COUNT(*)::int FROM cases WHERE status IN ('open', 'active')) AS open_cases,
          (SELECT COUNT(*)::int FROM cases WHERE is_evidence_locked = TRUE) AS evidence_locked_cases,
          (SELECT COUNT(*)::int FROM uploaded_files WHERE uploaded_at >= CURRENT_DATE) AS uploads_today,
          (SELECT COUNT(*)::int FROM audit_logs WHERE action = 'FILE_DELETE' AND created_at >= CURRENT_DATE) AS file_deletions_today,
          (SELECT COUNT(*)::int FROM users WHERE failed_login_attempts > 0) AS failed_officer_logins,
          (SELECT COUNT(*)::int FROM admin_accounts WHERE failed_login_attempts > 0) AS failed_admin_logins,
          (SELECT COUNT(*)::int FROM admin_action_logs WHERE created_at >= NOW() - INTERVAL '24 hours') AS recent_admin_actions
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users WHERE locked_until > NOW()) AS locked_officer_accounts,
          (SELECT COUNT(*)::int FROM admin_accounts WHERE locked_until > NOW()) AS locked_admin_accounts,
          (SELECT COUNT(*)::int FROM ingestion_jobs WHERE status IN ('failed', 'partial_success')) AS failed_ingestion_jobs
      `),
      pool.query(`
        ${ACTIVITY_CTE}
        SELECT *
        FROM unified_activity
        ORDER BY created_at DESC, source ASC, id DESC
        LIMIT 8
      `),
      pool.query('SELECT NOW() AS server_time')
    ]);

    const metrics = metricsResult.rows[0] || {};
    const accountState = accountStateResult.rows[0] || {};
    const ready = getReadyHealth();
    const startup = getStartupStatus();
    const live = getLiveHealth();

    const attention = [
      accountState.locked_officer_accounts > 0
        ? {
            id: 'locked-officers',
            severity: 'warning',
            title: 'Locked officer accounts',
            description: `${accountState.locked_officer_accounts} officer account(s) are currently locked.`,
            href: '/admin/users',
            count: accountState.locked_officer_accounts,
          }
        : null,
      accountState.locked_admin_accounts > 0
        ? {
            id: 'locked-admins',
            severity: 'critical',
            title: 'Locked admin accounts',
            description: `${accountState.locked_admin_accounts} admin account(s) are currently locked.`,
            href: '/admin/users',
            count: accountState.locked_admin_accounts,
          }
        : null,
      accountState.failed_ingestion_jobs > 0
        ? {
            id: 'failed-ingestion',
            severity: 'warning',
            title: 'Failed ingestion jobs',
            description: `${accountState.failed_ingestion_jobs} ingestion job(s) need review.`,
            href: '/admin/files',
            count: accountState.failed_ingestion_jobs,
          }
        : null,
      ready.status !== 'ready'
        ? {
            id: 'readiness',
            severity: 'critical',
            title: 'Backend readiness degraded',
            description: 'The backend readiness checks are not fully passing.',
            href: '/admin/system',
            count: 1,
          }
        : null,
      startup.status !== 'ready'
        ? {
            id: 'startup',
            severity: 'warning',
            title: 'Startup checks degraded',
            description: 'Startup self-checks reported degraded or failed components.',
            href: '/admin/system',
            count: 1,
          }
        : null,
    ].filter(Boolean);

    res.json({
      metrics: {
        activeOfficerSessions: metrics.active_officer_sessions || 0,
        activeAdminSessions: metrics.active_admin_sessions || 0,
        openCases: metrics.open_cases || 0,
        evidenceLockedCases: metrics.evidence_locked_cases || 0,
        uploadsToday: metrics.uploads_today || 0,
        fileDeletionsToday: metrics.file_deletions_today || 0,
        failedOfficerLogins: metrics.failed_officer_logins || 0,
        failedAdminLogins: metrics.failed_admin_logins || 0,
        recentAdminActions: metrics.recent_admin_actions || 0,
      },
      health: {
        databaseConnected: true,
        serverTime: dbHealthResult.rows[0]?.server_time || null,
        live,
        ready,
        startup,
      },
      attention,
      recentActivity: recentAdminActivityResult.rows,
    });
  } catch (error) {
    console.error('[ADMIN] Overview error:', error);
    res.status(500).json({ error: 'Failed to load admin overview' });
  }
});

router.get('/activity', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, DEFAULT_ACTIVITY_LIMIT);
    const payload = await fetchActivity({ query: req.query, limit, page });
    res.json(payload);
  } catch (error) {
    console.error('[ADMIN] Activity error:', error);
    res.status(500).json({ error: 'Failed to load admin activity' });
  }
});

router.get('/users', async (_req, res) => {
  try {
    const [officersResult, adminsResult] = await Promise.all([
      pool.query(`
        SELECT
          u.id,
          u.buckle_id,
          u.email,
          u.full_name,
          u.role,
          u.is_active,
          u.last_login,
          u.login_count,
          o.position,
          o.department,
          o.station,
          COALESCE(session_summary.active_sessions, 0) AS active_sessions,
          COALESCE(case_summary.total_cases, 0) AS total_cases,
          COALESCE(case_summary.open_cases, 0) AS open_cases,
          COALESCE(activity_summary.recent_actions_7d, 0) AS recent_actions_7d
        FROM users u
        LEFT JOIN officers o ON u.buckle_id = o.buckle_id
        LEFT JOIN (
          SELECT user_id, COUNT(*)::int AS active_sessions
          FROM sessions
          WHERE ended_at IS NULL
          GROUP BY user_id
        ) session_summary ON session_summary.user_id = u.id
        LEFT JOIN (
          SELECT
            principal.user_id,
            COUNT(DISTINCT principal.case_id)::int AS total_cases,
            COUNT(DISTINCT principal.case_id) FILTER (WHERE principal.case_status IN ('open', 'active'))::int AS open_cases
          FROM (
            SELECT c.created_by_user_id AS user_id, c.id AS case_id, c.status AS case_status
            FROM cases c
            UNION ALL
            SELECT ca.user_id, c.id, c.status
            FROM case_assignments ca
            JOIN cases c ON c.id = ca.case_id
            WHERE ca.is_active = TRUE
          ) principal
          GROUP BY principal.user_id
        ) case_summary ON case_summary.user_id = u.id
        LEFT JOIN (
          SELECT user_id, COUNT(*)::int AS recent_actions_7d
          FROM audit_logs
          WHERE created_at >= NOW() - INTERVAL '7 days'
          GROUP BY user_id
        ) activity_summary ON activity_summary.user_id = u.id
        ORDER BY u.full_name ASC
      `),
      pool.query(`
        SELECT
          aa.id,
          aa.email,
          aa.full_name,
          aa.role,
          aa.permissions,
          aa.is_active,
          aa.last_login,
          COALESCE(session_summary.active_sessions, 0) AS active_sessions,
          COALESCE(activity_summary.recent_actions_7d, 0) AS recent_actions_7d
        FROM admin_accounts aa
        LEFT JOIN (
          SELECT admin_account_id, COUNT(*)::int AS active_sessions
          FROM admin_sessions
          WHERE ended_at IS NULL
          GROUP BY admin_account_id
        ) session_summary ON session_summary.admin_account_id = aa.id
        LEFT JOIN (
          SELECT admin_account_id, COUNT(*)::int AS recent_actions_7d
          FROM admin_action_logs
          WHERE created_at >= NOW() - INTERVAL '7 days'
          GROUP BY admin_account_id
        ) activity_summary ON activity_summary.admin_account_id = aa.id
        ORDER BY aa.full_name ASC
      `),
    ]);

    res.json({
      officers: officersResult.rows,
      admins: adminsResult.rows,
      summary: {
        totalOfficers: officersResult.rows.length,
        totalAdmins: adminsResult.rows.length,
        activeOfficerSessions: officersResult.rows.reduce((sum, row) => sum + Number(row.active_sessions || 0), 0),
        activeAdminSessions: adminsResult.rows.reduce((sum, row) => sum + Number(row.active_sessions || 0), 0),
      },
    });
  } catch (error) {
    console.error('[ADMIN] Users error:', error);
    res.status(500).json({ error: 'Failed to load admin users view' });
  }
});

router.get('/sessions', async (req, res) => {
  try {
    const activeOnly = String(req.query.activeOnly || 'true').trim().toLowerCase() !== 'false';
    const officerWhere = activeOnly ? 'WHERE s.ended_at IS NULL' : '';
    const adminWhere = activeOnly ? 'WHERE s.ended_at IS NULL' : '';

    const [officerSessionsResult, adminSessionsResult] = await Promise.all([
      pool.query(`
        SELECT
          s.id,
          'officer'::text AS session_type,
          s.user_id AS actor_id,
          u.full_name AS actor_name,
          u.email AS actor_email,
          u.role AS actor_role,
          u.buckle_id AS actor_badge,
          s.started_at,
          s.ended_at,
          s.logout_reason,
          COALESCE(HOST(s.ip_address), NULL) AS ip_address,
          s.user_agent,
          EXTRACT(EPOCH FROM (NOW() - s.started_at))::int AS session_age_seconds
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        ${officerWhere}
        ORDER BY s.started_at DESC
        LIMIT 100
      `),
      pool.query(`
        SELECT
          s.id,
          'admin'::text AS session_type,
          s.admin_account_id AS actor_id,
          aa.full_name AS actor_name,
          aa.email AS actor_email,
          aa.role AS actor_role,
          NULL::text AS actor_badge,
          s.started_at,
          s.ended_at,
          s.logout_reason,
          COALESCE(HOST(s.ip_address), NULL) AS ip_address,
          s.user_agent,
          EXTRACT(EPOCH FROM (NOW() - s.started_at))::int AS session_age_seconds
        FROM admin_sessions s
        JOIN admin_accounts aa ON aa.id = s.admin_account_id
        ${adminWhere}
        ORDER BY s.started_at DESC
        LIMIT 100
      `),
    ]);

    res.json({
      officerSessions: officerSessionsResult.rows,
      adminSessions: adminSessionsResult.rows,
      summary: {
        activeOnly,
        officerCount: officerSessionsResult.rows.length,
        adminCount: adminSessionsResult.rows.length,
      },
    });
  } catch (error) {
    console.error('[ADMIN] Sessions error:', error);
    res.status(500).json({ error: 'Failed to load admin sessions view' });
  }
});

router.post('/sessions/:sessionId/force-logout', requireAdminRole('it_admin'), async (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  const sessionType = String(req.body?.sessionType || '').trim().toLowerCase();
  const reason = String(req.body?.reason || 'admin_forced').trim();

  if (!sessionId || !sessionType || !['officer', 'admin'].includes(sessionType)) {
    return res.status(400).json({ error: 'sessionType of officer or admin is required' });
  }

  try {
    if (sessionType === 'officer') {
      const result = await pool.query(
        `
          UPDATE sessions
          SET ended_at = NOW(), logout_reason = 'admin_forced'
          WHERE id = $1 AND ended_at IS NULL
          RETURNING id, user_id
        `,
        [sessionId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Officer session not found or already closed' });
      }

      const session = result.rows[0];
      await pool.query(
        `
          UPDATE refresh_tokens
          SET is_revoked = TRUE
          WHERE user_id = $1 AND is_revoked = FALSE
        `,
        [session.user_id]
      );

      await logAdminAction({
        adminAccountId: req.admin.adminId,
        action: 'FORCE_LOGOUT_OFFICER_SESSION',
        resourceType: 'session',
        resourceId: sessionId,
        ipAddress: req.ip,
        details: { sessionType, reason, targetUserId: session.user_id }
      });

      return res.json({ forced: true, sessionType, sessionId });
    }

    const result = await pool.query(
      `
        UPDATE admin_sessions
        SET ended_at = NOW(), logout_reason = 'admin_forced'
        WHERE id = $1 AND ended_at IS NULL
        RETURNING id, admin_account_id
      `,
      [sessionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin session not found or already closed' });
    }

    const session = result.rows[0];
    await pool.query(
      `
        UPDATE admin_refresh_tokens
        SET is_revoked = TRUE
        WHERE admin_account_id = $1 AND is_revoked = FALSE
      `,
      [session.admin_account_id]
    );

    await logAdminAction({
      adminAccountId: req.admin.adminId,
      action: 'FORCE_LOGOUT_ADMIN_SESSION',
      resourceType: 'admin_session',
      resourceId: sessionId,
      ipAddress: req.ip,
      details: { sessionType, reason, targetAdminAccountId: session.admin_account_id }
    });

    return res.json({ forced: true, sessionType, sessionId });
  } catch (error) {
    console.error('[ADMIN] Force logout error:', error);
    return res.status(500).json({ error: 'Failed to force logout session' });
  }
});

export default router;
