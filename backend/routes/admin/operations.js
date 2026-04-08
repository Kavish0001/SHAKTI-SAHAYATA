import { Router } from 'express';
import pool from '../../config/database.js';
import { authenticateAdminToken } from '../../middleware/admin/authenticateAdminToken.js';
import {
  requireAdminPermission,
  requireAdminRole,
  requireRecentAdminAuth,
} from '../../middleware/admin/authorizeAdmin.js';
import { logAdminAction } from '../../services/admin/adminAudit.service.js';
import { fetchActiveAdminAlerts, acknowledgeAdminAlert } from '../../services/admin/adminAlerts.service.js';
import { exportActivityRows } from '../../services/admin/adminActivity.service.js';
import {
  appendWatermarkColumns,
  buildCsv,
  buildExportWatermark,
  createCsvFilename,
  fetchAdminExportHistory,
  sendCsv,
} from '../../services/admin/adminExport.service.js';
import { exportAdminCases, exportAdminFiles } from '../../services/admin/adminGovernance.service.js';
import { buildAdminSystemHealthSnapshot, runAdminSystemSelfCheck } from '../../services/admin/adminSystem.service.js';

const router = Router();

router.use(authenticateAdminToken);
router.use(requireAdminRole('it_admin', 'it_auditor'));

const joinAssignedOfficers = (assignedOfficers) =>
  Array.isArray(assignedOfficers)
    ? assignedOfficers
      .map((officer) => [officer?.fullName || officer?.full_name, officer?.buckleId || officer?.buckle_id, officer?.role].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' | ')
    : '';

const toAdminSecurityProfile = async (adminId) => {
  const result = await pool.query(
    `
      SELECT
        role,
        COALESCE(totp_enabled, FALSE) AS totp_enabled,
        CASE WHEN totp_secret IS NOT NULL AND TRIM(totp_secret) <> '' THEN TRUE ELSE FALSE END AS totp_secret_configured
      FROM admin_accounts
      WHERE id = $1
      LIMIT 1
    `,
    [adminId]
  );

  const admin = result.rows[0] || {};
  return {
    role: admin.role || null,
    totpEnabled: Boolean(admin.totp_enabled),
    totpSecretConfigured: Boolean(admin.totp_secret_configured),
  };
};

const buildOverviewExportRows = async () => {
  const [metricsResult, accountStateResult] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM sessions WHERE ended_at IS NULL) AS active_officer_sessions,
        (SELECT COUNT(*)::int FROM admin_sessions WHERE ended_at IS NULL) AS active_admin_sessions,
        (SELECT COUNT(*)::int FROM cases WHERE status IN ('open', 'active')) AS open_cases,
        (SELECT COUNT(*)::int FROM cases WHERE is_evidence_locked = TRUE) AS evidence_locked_cases,
        (SELECT COUNT(*)::int FROM uploaded_files WHERE uploaded_at >= CURRENT_DATE) AS uploads_today,
        (SELECT COUNT(*)::int FROM audit_logs WHERE action = 'FILE_DELETE' AND created_at >= CURRENT_DATE) AS file_deletions_today,
        (SELECT COUNT(*)::int FROM admin_action_logs WHERE created_at >= NOW() - INTERVAL '24 hours') AS recent_admin_actions
    `),
    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE locked_until > NOW()) AS locked_officer_accounts,
        (SELECT COUNT(*)::int FROM admin_accounts WHERE locked_until > NOW()) AS locked_admin_accounts,
        (SELECT COUNT(*)::int FROM ingestion_jobs WHERE status IN ('failed', 'partial_success')) AS failed_ingestion_jobs
    `),
  ]);

  const metrics = metricsResult.rows[0] || {};
  const accountState = accountStateResult.rows[0] || {};

  return [
    { section: 'overview', metric: 'active_officer_sessions', value: metrics.active_officer_sessions || 0, detail: 'Currently active officer sessions' },
    { section: 'overview', metric: 'active_admin_sessions', value: metrics.active_admin_sessions || 0, detail: 'Currently active admin sessions' },
    { section: 'overview', metric: 'open_cases', value: metrics.open_cases || 0, detail: 'Cases in open or active status' },
    { section: 'overview', metric: 'evidence_locked_cases', value: metrics.evidence_locked_cases || 0, detail: 'Cases with evidence lock enabled' },
    { section: 'overview', metric: 'uploads_today', value: metrics.uploads_today || 0, detail: 'Files uploaded today' },
    { section: 'overview', metric: 'file_deletions_today', value: metrics.file_deletions_today || 0, detail: 'File deletion events recorded today' },
    { section: 'overview', metric: 'recent_admin_actions', value: metrics.recent_admin_actions || 0, detail: 'Admin actions in the last 24 hours' },
    { section: 'attention', metric: 'locked_officer_accounts', value: accountState.locked_officer_accounts || 0, detail: 'Officer accounts currently locked' },
    { section: 'attention', metric: 'locked_admin_accounts', value: accountState.locked_admin_accounts || 0, detail: 'Admin accounts currently locked' },
    { section: 'attention', metric: 'failed_ingestion_jobs', value: accountState.failed_ingestion_jobs || 0, detail: 'Failed or partially successful ingestion jobs' },
  ];
};

const logStructuredExport = async ({
  req,
  action,
  scope,
  filters,
  reason,
  watermark,
  exportedCount,
  result,
  error,
}) => {
  await logAdminAction({
    adminAccountId: req.admin.adminId,
    sessionId: req.admin.sessionId,
    action,
    resourceType: 'export',
    resourceId: scope,
    ipAddress: req.ip,
    details: {
      scope,
      filters,
      reason,
      watermark,
      exportedCount,
      result,
      error: error || null,
    },
  });
};

router.get('/system/health', requireAdminPermission('view_system'), async (req, res) => {
  try {
    const admin = await toAdminSecurityProfile(req.admin.adminId);
    const snapshot = await buildAdminSystemHealthSnapshot({
      admin,
      networkRequestState: req.adminNetworkRestriction || null,
    });
    res.json(snapshot);
  } catch (error) {
    console.error('[ADMIN] System health error:', error);
    res.status(500).json({ error: 'Failed to load system health snapshot' });
  }
});

router.post('/system/self-check', requireAdminRole('it_admin'), requireAdminPermission('run_self_check'), async (req, res) => {
  try {
    const admin = await toAdminSecurityProfile(req.admin.adminId);
    const result = await runAdminSystemSelfCheck({
      admin,
      networkRequestState: req.adminNetworkRestriction || null,
    });

    await logAdminAction({
      adminAccountId: req.admin.adminId,
      sessionId: req.admin.sessionId,
      action: 'RUN_SYSTEM_SELF_CHECK',
      resourceType: 'system',
      resourceId: 'self-check',
      ipAddress: req.ip,
      details: {
        status: result.status,
        durationMs: result.durationMs,
        failedChecks: result.failedChecks,
        degradedChecks: result.degradedChecks,
      },
    });

    res.status(result.status === 'fail' ? 503 : 200).json(result);
  } catch (error) {
    console.error('[ADMIN] System self-check error:', error);
    await logAdminAction({
      adminAccountId: req.admin.adminId,
      sessionId: req.admin.sessionId,
      action: 'RUN_SYSTEM_SELF_CHECK',
      resourceType: 'system',
      resourceId: 'self-check',
      ipAddress: req.ip,
      details: {
        status: 'fail',
        failedChecks: ['selfCheckRequest'],
        degradedChecks: [],
        error: error?.message || 'Self-check failed',
      },
    });
    res.status(500).json({ error: 'Failed to run system self-check' });
  }
});

router.get('/alerts', requireAdminPermission('view_alerts'), async (_req, res) => {
  try {
    const payload = await fetchActiveAdminAlerts();
    res.json(payload);
  } catch (error) {
    console.error('[ADMIN] Alerts error:', error);
    res.status(500).json({ error: 'Failed to load admin alerts' });
  }
});

router.post(
  '/alerts/:alertId/acknowledge',
  requireAdminRole('it_admin'),
  requireAdminPermission('acknowledge_alerts'),
  requireRecentAdminAuth(),
  async (req, res) => {
    const alertId = String(req.params.alertId || '').trim();
    const note = String(req.body?.note || '').trim();

    if (!alertId) {
      return res.status(400).json({ error: 'Alert id is required' });
    }

    try {
      const acknowledgement = await acknowledgeAdminAlert({
        alertId,
        adminAccountId: req.admin.adminId,
        note,
      });

      await logAdminAction({
        adminAccountId: req.admin.adminId,
        sessionId: req.admin.sessionId,
        action: 'ACKNOWLEDGE_ADMIN_ALERT',
        resourceType: 'alert',
        resourceId: alertId,
        ipAddress: req.ip,
        details: { note },
      });

      return res.json({ acknowledged: true, alertId, acknowledgement });
    } catch (error) {
      console.error('[ADMIN] Alert acknowledgement error:', error);
      return res.status(500).json({ error: 'Failed to acknowledge alert' });
    }
  }
);

router.get('/exports/history', requireAdminPermission('view_export_history'), async (req, res) => {
  try {
    const history = await fetchAdminExportHistory(req.query.limit);
    res.json({ items: history });
  } catch (error) {
    console.error('[ADMIN] Export history error:', error);
    res.status(500).json({ error: 'Failed to load export history' });
  }
});

router.get('/exports/overview', requireAdminPermission('export_overview'), requireRecentAdminAuth(), async (req, res) => {
  const reason = String(req.query.reason || '').trim();
  const watermark = buildExportWatermark({ admin: req.admin, scope: 'overview' });

  try {
    const rows = await buildOverviewExportRows();
    const csv = buildCsv(
      appendWatermarkColumns(
        [
          { label: 'Section', value: (row) => row.section },
          { label: 'Metric', value: (row) => row.metric },
          { label: 'Value', value: (row) => row.value },
          { label: 'Detail', value: (row) => row.detail },
        ],
        watermark
      ),
      rows
    );

    await logStructuredExport({
      req,
      action: 'EXPORT_OVERVIEW',
      scope: 'overview',
      filters: {},
      reason,
      watermark,
      exportedCount: rows.length,
      result: 'success',
    });

    return sendCsv(res, createCsvFilename('admin-overview'), csv);
  } catch (error) {
    console.error('[ADMIN] Overview export error:', error);
    await logStructuredExport({
      req,
      action: 'EXPORT_OVERVIEW',
      scope: 'overview',
      filters: {},
      reason,
      watermark,
      exportedCount: 0,
      result: 'failed',
      error: error?.message || 'Overview export failed',
    });
    return res.status(500).json({ error: 'Failed to export overview snapshot' });
  }
});

router.get('/exports/activity', requireAdminPermission('export_activity'), requireRecentAdminAuth(), async (req, res) => {
  const filters = { ...req.query };
  const reason = String(req.query.reason || '').trim();
  const watermark = buildExportWatermark({ admin: req.admin, scope: 'activity' });

  try {
    const rows = await exportActivityRows(filters);
    const csv = buildCsv(
      appendWatermarkColumns(
        [
          { label: 'Source', value: (row) => row.source },
          { label: 'Created At', value: (row) => row.created_at },
          { label: 'Actor Type', value: (row) => row.actor_type },
          { label: 'Actor Name', value: (row) => row.actor_name },
          { label: 'Actor Email', value: (row) => row.actor_email },
          { label: 'Actor Role', value: (row) => row.actor_role },
          { label: 'Action', value: (row) => row.action },
          { label: 'Resource Type', value: (row) => row.resource_type },
          { label: 'Resource ID', value: (row) => row.resource_id },
          { label: 'Session ID', value: (row) => row.session_id },
          { label: 'IP Address', value: (row) => row.ip_address },
          { label: 'Details', value: (row) => row.details },
        ],
        watermark
      ),
      rows
    );

    await logStructuredExport({
      req,
      action: 'EXPORT_ACTIVITY',
      scope: 'activity',
      filters,
      reason,
      watermark,
      exportedCount: rows.length,
      result: 'success',
    });

    return sendCsv(res, createCsvFilename('admin-activity'), csv);
  } catch (error) {
    console.error('[ADMIN] Activity export error:', error);
    await logStructuredExport({
      req,
      action: 'EXPORT_ACTIVITY',
      scope: 'activity',
      filters,
      reason,
      watermark,
      exportedCount: 0,
      result: 'failed',
      error: error?.message || 'Activity export failed',
    });
    return res.status(500).json({ error: 'Failed to export activity feed' });
  }
});

router.get('/exports/cases', requireAdminPermission('export_cases'), requireRecentAdminAuth(), async (req, res) => {
  const filters = { ...req.query };
  const reason = String(req.query.reason || '').trim();
  const watermark = buildExportWatermark({ admin: req.admin, scope: 'cases' });

  try {
    const rows = await exportAdminCases(filters);
    const csv = buildCsv(
      appendWatermarkColumns(
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
        watermark
      ),
      rows
    );

    await logStructuredExport({
      req,
      action: 'EXPORT_CASES',
      scope: 'cases',
      filters,
      reason,
      watermark,
      exportedCount: rows.length,
      result: 'success',
    });

    return sendCsv(res, createCsvFilename('admin-cases'), csv);
  } catch (error) {
    console.error('[ADMIN] Cases export error:', error);
    await logStructuredExport({
      req,
      action: 'EXPORT_CASES',
      scope: 'cases',
      filters,
      reason,
      watermark,
      exportedCount: 0,
      result: 'failed',
      error: error?.message || 'Cases export failed',
    });
    return res.status(500).json({ error: 'Failed to export case view' });
  }
});

router.get('/exports/files', requireAdminPermission('export_files'), requireRecentAdminAuth(), async (req, res) => {
  const filters = { ...req.query };
  const reason = String(req.query.reason || '').trim();
  const watermark = buildExportWatermark({ admin: req.admin, scope: 'files' });

  try {
    const rows = await exportAdminFiles(filters);
    const csv = buildCsv(
      appendWatermarkColumns(
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
        watermark
      ),
      rows
    );

    await logStructuredExport({
      req,
      action: 'EXPORT_FILES',
      scope: 'files',
      filters,
      reason,
      watermark,
      exportedCount: rows.length,
      result: 'success',
    });

    return sendCsv(res, createCsvFilename('admin-files'), csv);
  } catch (error) {
    console.error('[ADMIN] Files export error:', error);
    await logStructuredExport({
      req,
      action: 'EXPORT_FILES',
      scope: 'files',
      filters,
      reason,
      watermark,
      exportedCount: 0,
      result: 'failed',
      error: error?.message || 'Files export failed',
    });
    return res.status(500).json({ error: 'Failed to export files view' });
  }
});

export default router;
