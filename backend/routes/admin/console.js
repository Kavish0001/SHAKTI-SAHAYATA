import { Router } from 'express';
import pool from '../../config/database.js';
import { authenticateAdminToken } from '../../middleware/admin/authenticateAdminToken.js';
import { requireAdminPermission, requireAdminRole, requireRecentAdminAuth } from '../../middleware/admin/authorizeAdmin.js';
import { getLiveHealth, getReadyHealth, getStartupStatus } from '../../services/runtimeStatus.service.js';
import { logAdminAction } from '../../services/admin/adminAudit.service.js';
import {
  fetchAdminDatabaseRows,
  fetchAdminDatabaseSchema,
  fetchAdminDatabaseTable,
} from '../../services/admin/adminDatabase.service.js';
import {
  exportAdminCases,
  exportAdminFileDeletions,
  exportAdminFiles,
  fetchAdminAnalysis,
  fetchAdminCaseDetail,
  fetchAdminCases,
  fetchAdminFileDeletions,
  fetchAdminFiles,
} from '../../services/admin/adminGovernance.service.js';

const router = Router();

router.use(authenticateAdminToken);
router.use(requireAdminRole('it_admin', 'it_auditor'));

const DEFAULT_ACTIVITY_LIMIT = 25;
const MAX_ACTIVITY_LIMIT = 100;

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const buildCsvValue = (value) => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
};

const buildCsv = (columns, rows) => {
  const header = columns.map((column) => buildCsvValue(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => buildCsvValue(column.value(row))).join(','));
  return [header, ...body].join('\r\n');
};

const createCsvFilename = (prefix) =>
  `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_')}.csv`;

const sendCsv = (res, filename, csv) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(csv);
};

const joinAssignedOfficers = (assignedOfficers) =>
  Array.isArray(assignedOfficers)
    ? assignedOfficers
      .map((officer) => [officer?.fullName, officer?.buckleId, officer?.role].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' | ')
    : '';

const buildActivityWhereClause = (query = {}) => {
  const clauses = [];
  const params = [];

  const addClause = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };

  if (query.source) addClause('source = ?', String(query.source).trim().toLowerCase());
  if (query.actorType) addClause('actor_type = ?', String(query.actorType).trim().toLowerCase());
  if (query.actor) {
    const actor = `%${String(query.actor).trim()}%`;
    params.push(actor);
    const index = `$${params.length}`;
    clauses.push(`(
      COALESCE(actor_name, '') ILIKE ${index}
      OR COALESCE(actor_email, '') ILIKE ${index}
      OR COALESCE(actor_id, '') ILIKE ${index}
    )`);
  }
  if (query.action) addClause('action = ?', String(query.action).trim());
  if (query.resourceType) addClause('resource_type = ?', String(query.resourceType).trim());
  if (query.resourceId) addClause('resource_id = ?', String(query.resourceId).trim());
  if (query.caseId) {
    params.push(String(query.caseId).trim());
    const index = `$${params.length}`;
    clauses.push(`(
      (resource_type = 'case' AND resource_id = ${index})
      OR COALESCE(details->>'caseId', '') = ${index}
    )`);
  }
  if (query.sessionId) addClause('session_id = ?', String(query.sessionId).trim());
  if (query.ipAddress) addClause("COALESCE(ip_address, '') ILIKE ?", `%${String(query.ipAddress).trim()}%`);
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
        databaseConnected: ready.checks?.database?.status !== 'fail',
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

router.get('/cases', async (req, res) => {
  try {
    const payload = await fetchAdminCases(req.query);
    res.json(payload);
  } catch (error) {
    console.error('[ADMIN] Cases error:', error);
    res.status(500).json({ error: 'Failed to load admin cases view' });
  }
});

router.get('/cases/export', requireAdminPermission('export_cases'), requireRecentAdminAuth(), async (req, res) => {
  try {
    const rows = await exportAdminCases(req.query);
    await logAdminAction({
      adminAccountId: req.admin.adminId,
      sessionId: req.admin.sessionId,
      action: 'EXPORT_CASE_GOVERNANCE',
      resourceType: 'export',
      resourceId: 'cases',
      ipAddress: req.ip,
      details: {
        scope: 'cases',
        filters: req.query,
        reason: String(req.query.reason || '').trim() || null,
        exportedCount: rows.length,
        result: 'success',
      },
    });

    const csv = buildCsv(
      [
        { label: 'Case ID', value: (row) => row.id },
        { label: 'Case Name', value: (row) => row.case_name },
        { label: 'Case Number', value: (row) => row.case_number },
        { label: 'FIR Number', value: (row) => row.fir_number },
        { label: 'Operator', value: (row) => row.operator },
        { label: 'Status', value: (row) => row.status },
        { label: 'Priority', value: (row) => row.priority },
        { label: 'Evidence Locked', value: (row) => row.is_evidence_locked },
        { label: 'Owner', value: (row) => row.owner_name },
        { label: 'Owner Buckle ID', value: (row) => row.owner_buckle_id },
        { label: 'Assignments', value: (row) => row.assignment_count },
        { label: 'Assigned Officers', value: (row) => joinAssignedOfficers(row.assigned_officers) },
        { label: 'File Count', value: (row) => row.file_count },
        { label: 'Failed Parse Files', value: (row) => row.failed_parse_files },
        { label: 'Pending Files', value: (row) => row.pending_files },
        { label: 'Recent Activity', value: (row) => row.recent_activity_count },
        { label: 'Last Activity At', value: (row) => row.last_activity_at },
        { label: 'Updated At', value: (row) => row.updated_at },
      ],
      rows
    );

    return sendCsv(res, createCsvFilename('admin-case-governance'), csv);
  } catch (error) {
    console.error('[ADMIN] Cases export error:', error);
    return res.status(500).json({ error: 'Failed to export case governance view' });
  }
});

router.get('/cases/:caseId', async (req, res) => {
  try {
    const payload = await fetchAdminCaseDetail(req.params.caseId);
    if (!payload) {
      return res.status(404).json({ error: 'Case not found' });
    }
    return res.json(payload);
  } catch (error) {
    console.error('[ADMIN] Case detail error:', error);
    return res.status(500).json({ error: 'Failed to load admin case detail' });
  }
});

router.get('/files', async (req, res) => {
  try {
    const payload = await fetchAdminFiles(req.query);
    res.json(payload);
  } catch (error) {
    console.error('[ADMIN] Files error:', error);
    res.status(500).json({ error: 'Failed to load admin files view' });
  }
});

router.get('/files/export', requireAdminPermission('export_files'), requireRecentAdminAuth(), async (req, res) => {
  try {
    const rows = await exportAdminFiles(req.query);
    await logAdminAction({
      adminAccountId: req.admin.adminId,
      sessionId: req.admin.sessionId,
      action: 'EXPORT_FILE_GOVERNANCE',
      resourceType: 'export',
      resourceId: 'files',
      ipAddress: req.ip,
      details: {
        scope: 'files',
        filters: req.query,
        reason: String(req.query.reason || '').trim() || null,
        exportedCount: rows.length,
        result: 'success',
      },
    });

    const csv = buildCsv(
      [
        { label: 'File ID', value: (row) => row.id },
        { label: 'Original Name', value: (row) => row.original_name },
        { label: 'Stored Name', value: (row) => row.file_name },
        { label: 'Case ID', value: (row) => row.case_id },
        { label: 'Case Name', value: (row) => row.case_name },
        { label: 'Case Number', value: (row) => row.case_number },
        { label: 'Case Status', value: (row) => row.case_status },
        { label: 'Case Priority', value: (row) => row.case_priority },
        { label: 'Evidence Locked', value: (row) => row.is_evidence_locked },
        { label: 'Telecom Module', value: (row) => row.telecom_module },
        { label: 'Parse Status', value: (row) => row.parse_status },
        { label: 'Classification Result', value: (row) => row.classification_result },
        { label: 'Record Count', value: (row) => row.record_count },
        { label: 'Uploader', value: (row) => row.uploaded_by_name },
        { label: 'Uploader Buckle ID', value: (row) => row.uploaded_by_buckle_id },
        { label: 'Uploaded At', value: (row) => row.uploaded_at },
        { label: 'Error Message', value: (row) => row.error_message },
      ],
      rows
    );

    return sendCsv(res, createCsvFilename('admin-file-governance'), csv);
  } catch (error) {
    console.error('[ADMIN] Files export error:', error);
    return res.status(500).json({ error: 'Failed to export file governance view' });
  }
});

router.get('/files/deletions', async (req, res) => {
  try {
    const payload = await fetchAdminFileDeletions(req.query);
    res.json(payload);
  } catch (error) {
    console.error('[ADMIN] File deletions error:', error);
    res.status(500).json({ error: 'Failed to load file deletion traceability' });
  }
});

router.get('/files/deletions/export', requireAdminPermission('export_files'), requireRecentAdminAuth(), async (req, res) => {
  try {
    const rows = await exportAdminFileDeletions(req.query);
    await logAdminAction({
      adminAccountId: req.admin.adminId,
      sessionId: req.admin.sessionId,
      action: 'EXPORT_FILE_DELETION_TRACE',
      resourceType: 'export',
      resourceId: 'file-deletions',
      ipAddress: req.ip,
      details: {
        scope: 'file-deletions',
        filters: req.query,
        reason: String(req.query.reason || '').trim() || null,
        exportedCount: rows.length,
        result: 'success',
      },
    });

    const csv = buildCsv(
      [
        { label: 'Audit ID', value: (row) => row.audit_id },
        { label: 'Deleted At', value: (row) => row.created_at },
        { label: 'Actor', value: (row) => row.actor_name },
        { label: 'Actor Email', value: (row) => row.actor_email },
        { label: 'Actor Buckle ID', value: (row) => row.actor_buckle_id },
        { label: 'Case ID', value: (row) => row.case_id },
        { label: 'Case Name', value: (row) => row.case_name },
        { label: 'Case Number', value: (row) => row.case_number },
        { label: 'File Name', value: (row) => row.file_name },
        { label: 'Stored File Name', value: (row) => row.stored_file_name },
        { label: 'Deleted Type', value: (row) => row.deleted_type },
        { label: 'Deleted Records', value: (row) => row.deleted_records },
        { label: 'IP Address', value: (row) => row.ip_address },
      ],
      rows
    );

    return sendCsv(res, createCsvFilename('admin-file-deletions'), csv);
  } catch (error) {
    console.error('[ADMIN] File deletions export error:', error);
    return res.status(500).json({ error: 'Failed to export file deletion traceability' });
  }
});

router.get('/analysis', async (_req, res) => {
  try {
    const payload = await fetchAdminAnalysis();
    res.json(payload);
  } catch (error) {
    console.error('[ADMIN] Analysis error:', error);
    res.status(500).json({ error: 'Failed to load admin analysis view' });
  }
});

router.get('/database/schema', async (req, res) => {
  try {
    const payload = await fetchAdminDatabaseSchema(req.admin.role);
    await logAdminAction({
      adminAccountId: req.admin.adminId,
      sessionId: req.admin.sessionId,
      action: 'VIEW_DATABASE_SCHEMA',
      resourceType: 'database_schema',
      resourceId: null,
      ipAddress: req.ip,
      details: { tableCount: payload.summary.tableCount, relationshipCount: payload.summary.relationshipCount },
    });
    res.json(payload);
  } catch (error) {
    console.error('[ADMIN] Database schema error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load database schema' });
  }
});

router.get('/database/tables/:table', async (req, res) => {
  try {
    const payload = await fetchAdminDatabaseTable(req.params.table, req.admin.role);
    await logAdminAction({
      adminAccountId: req.admin.adminId,
      sessionId: req.admin.sessionId,
      action: 'VIEW_DATABASE_TABLE',
      resourceType: 'database_table',
      resourceId: req.params.table,
      ipAddress: req.ip,
      details: {
        restricted: payload.table.restricted,
        group: payload.table.group,
        canBrowseRows: payload.table.canBrowseRows,
      },
    });
    res.json(payload);
  } catch (error) {
    console.error('[ADMIN] Database table metadata error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load table metadata' });
  }
});

router.get('/database/tables/:table/rows', async (req, res) => {
  try {
    const payload = await fetchAdminDatabaseRows(req.params.table, req.query, req.admin.role);
    await logAdminAction({
      adminAccountId: req.admin.adminId,
      sessionId: req.admin.sessionId,
      action: 'BROWSE_DATABASE_ROWS',
      resourceType: 'database_table',
      resourceId: req.params.table,
      ipAddress: req.ip,
      details: {
        page: payload.pagination.page,
        pageSize: payload.pagination.pageSize,
        sort: payload.sort,
        filter: payload.filter,
      },
    });
    res.json(payload);
  } catch (error) {
    console.error('[ADMIN] Database row browse error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to browse table rows' });
  }
});

router.post(
  '/sessions/:sessionId/force-logout',
  requireAdminRole('it_admin'),
  requireAdminPermission('force_logout'),
  requireRecentAdminAuth(),
  async (req, res) => {
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
        sessionId: req.admin.sessionId,
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
      sessionId: req.admin.sessionId,
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
