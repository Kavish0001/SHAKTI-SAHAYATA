import pool from '../../config/database.js';
import { ADMIN_CONSOLE_CONFIG } from '../../config/adminConsole.js';
import { getReadyHealth } from '../runtimeStatus.service.js';

const buildAlert = ({
  id,
  rule,
  severity,
  title,
  summary,
  href,
  remediation,
  metric,
  threshold,
  evidence = {},
}) => ({
  id,
  rule,
  severity,
  status: 'active',
  title,
  summary,
  href,
  remediation,
  metric,
  threshold,
  evidence,
});

const fetchAcknowledgements = async (alertIds) => {
  if (alertIds.length === 0) return new Map();

  const result = await pool.query(
    `
      SELECT
        aaa.alert_key,
        aaa.acknowledged_at,
        aaa.note,
        COALESCE(aa.full_name, 'Unknown admin') AS acknowledged_by_name,
        aa.email AS acknowledged_by_email
      FROM admin_alert_acknowledgements aaa
      LEFT JOIN admin_accounts aa ON aa.id = aaa.acknowledged_by
      WHERE aaa.alert_key = ANY($1::text[])
    `,
    [alertIds]
  );

  return new Map(
    result.rows.map((row) => [
      row.alert_key,
      {
        acknowledged: true,
        acknowledgedAt: row.acknowledged_at,
        note: row.note,
        acknowledgedBy: row.acknowledged_by_name,
        acknowledgedByEmail: row.acknowledged_by_email,
      },
    ])
  );
};

export const fetchActiveAdminAlerts = async () => {
  const ready = getReadyHealth();
  const now = new Date().toISOString();
  const alerts = [];

  if (ready.status !== 'ready') {
    alerts.push(
      buildAlert({
        id: 'database-degraded',
        rule: 'database_health',
        severity: ready.status === 'not_ready' ? 'critical' : 'warning',
        title: 'Database health is degraded',
        summary: 'Backend readiness reported a degraded or unavailable database dependency.',
        href: '/admin/system',
        remediation: 'Inspect the System page, database connectivity, and recent self-check output.',
        metric: ready.status,
        threshold: 'ready',
        evidence: { failedChecks: ready.summary?.failed || [], degradedChecks: ready.summary?.degraded || [] },
      })
    );
  }

  const [failedLoginsResult, deletionsResult, ingestionResult, sessionsResult, selfCheckResult] = await Promise.all([
    pool.query(
      `
        SELECT
          (
            SELECT COUNT(*)::int
            FROM admin_accounts
            WHERE failed_login_attempts >= $1
          ) +
          (
            SELECT COUNT(*)::int
            FROM users
            WHERE failed_login_attempts >= $1
          ) AS affected_accounts
      `,
      [ADMIN_CONSOLE_CONFIG.alerts.failedLoginThreshold]
    ),
    pool.query(
      `
        SELECT COUNT(*)::int AS total
        FROM audit_logs
        WHERE action = 'FILE_DELETE'
          AND created_at >= NOW() - ($1 || ' minutes')::interval
      `,
      [String(ADMIN_CONSOLE_CONFIG.alerts.fileDeletionWindowMinutes)]
    ),
    pool.query(
      `
        SELECT COUNT(*)::int AS total
        FROM ingestion_jobs
        WHERE status IN ('failed', 'partial_success', 'quarantined', 'mismatched', 'cancelled')
          AND created_at >= NOW() - ($1 || ' minutes')::interval
      `,
      [String(ADMIN_CONSOLE_CONFIG.alerts.ingestionFailureWindowMinutes)]
    ),
    pool.query(
      `
        SELECT COUNT(*)::int AS total
        FROM (
          SELECT id
          FROM sessions
          WHERE ended_at IS NULL
            AND started_at < NOW() - ($1 || ' minutes')::interval
          UNION ALL
          SELECT id
          FROM admin_sessions
          WHERE ended_at IS NULL
            AND started_at < NOW() - ($1 || ' minutes')::interval
        ) stalled
      `,
      [String(ADMIN_CONSOLE_CONFIG.alerts.stalledSessionAgeMinutes)]
    ),
    pool.query(
      `
        SELECT details, created_at
        FROM admin_action_logs
        WHERE action = 'RUN_SYSTEM_SELF_CHECK'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
    ),
  ]);

  const failedLoginCount = Number(failedLoginsResult.rows[0]?.affected_accounts || 0);
  if (failedLoginCount >= ADMIN_CONSOLE_CONFIG.alerts.failedLoginThreshold) {
    alerts.push(
      buildAlert({
        id: 'failed-logins',
        rule: 'failed_logins',
        severity: 'warning',
        title: 'Repeated failed logins detected',
        summary: `${failedLoginCount} account(s) currently exceed the failed-login attention threshold.`,
        href: '/admin/activity',
        remediation: 'Review recent authentication failures and lockout state in Activity and Users.',
        metric: failedLoginCount,
        threshold: ADMIN_CONSOLE_CONFIG.alerts.failedLoginThreshold,
      })
    );
  }

  const fileDeletionCount = Number(deletionsResult.rows[0]?.total || 0);
  if (fileDeletionCount >= ADMIN_CONSOLE_CONFIG.alerts.fileDeletionThreshold) {
    alerts.push(
      buildAlert({
        id: 'repeated-file-deletions',
        rule: 'file_deletions',
        severity: 'warning',
        title: 'Repeated file deletions require review',
        summary: `${fileDeletionCount} file deletion event(s) occurred in the current alert window.`,
        href: '/admin/files',
        remediation: 'Inspect deletion traceability and confirm the deletes were expected.',
        metric: fileDeletionCount,
        threshold: ADMIN_CONSOLE_CONFIG.alerts.fileDeletionThreshold,
      })
    );
  }

  const failedIngestionCount = Number(ingestionResult.rows[0]?.total || 0);
  if (failedIngestionCount >= ADMIN_CONSOLE_CONFIG.alerts.ingestionFailureThreshold) {
    alerts.push(
      buildAlert({
        id: 'failed-ingestion-spike',
        rule: 'ingestion_failures',
        severity: 'critical',
        title: 'Failed ingestion spike detected',
        summary: `${failedIngestionCount} ingestion job(s) failed or degraded inside the current alert window.`,
        href: '/admin/files',
        remediation: 'Inspect file pipeline health, classifier errors, and recent uploads.',
        metric: failedIngestionCount,
        threshold: ADMIN_CONSOLE_CONFIG.alerts.ingestionFailureThreshold,
      })
    );
  }

  const stalledSessionCount = Number(sessionsResult.rows[0]?.total || 0);
  if (stalledSessionCount >= ADMIN_CONSOLE_CONFIG.alerts.stalledSessionCountThreshold) {
    alerts.push(
      buildAlert({
        id: 'stalled-sessions',
        rule: 'stalled_sessions',
        severity: 'warning',
        title: 'Stalled sessions detected',
        summary: `${stalledSessionCount} session(s) have remained active beyond the stale-session threshold.`,
        href: '/admin/users',
        remediation: 'Review the Users & Sessions page and end stale sessions where appropriate.',
        metric: stalledSessionCount,
        threshold: ADMIN_CONSOLE_CONFIG.alerts.stalledSessionCountThreshold,
      })
    );
  }

  const latestSelfCheck = selfCheckResult.rows[0];
  if (latestSelfCheck?.details?.status && latestSelfCheck.details.status !== 'pass') {
    alerts.push(
      buildAlert({
        id: 'self-check-failure',
        rule: 'self_check_failures',
        severity: latestSelfCheck.details.status === 'fail' ? 'critical' : 'warning',
        title: 'Latest self-check reported problems',
        summary: `The most recent system self-check completed with status ${latestSelfCheck.details.status}.`,
        href: '/admin/system',
        remediation: 'Open the System page, review failed checks, and rerun diagnostics after remediation.',
        metric: latestSelfCheck.details.status,
        threshold: 'pass',
        evidence: {
          createdAt: latestSelfCheck.created_at,
          failedChecks: latestSelfCheck.details.failedChecks || [],
          degradedChecks: latestSelfCheck.details.degradedChecks || [],
        },
      })
    );
  }

  const acknowledgements = await fetchAcknowledgements(alerts.map((alert) => alert.id));

  return {
    generatedAt: now,
    summary: {
      total: alerts.length,
      critical: alerts.filter((alert) => alert.severity === 'critical').length,
      warning: alerts.filter((alert) => alert.severity === 'warning').length,
      acknowledged: alerts.filter((alert) => acknowledgements.has(alert.id)).length,
    },
    items: alerts.map((alert) => ({
      ...alert,
      ...(
        acknowledgements.get(alert.id)
        || { acknowledged: false, acknowledgedAt: null, note: null, acknowledgedBy: null, acknowledgedByEmail: null }
      ),
    })),
  };
};

export const acknowledgeAdminAlert = async ({ alertId, adminAccountId, note = '' }) => {
  const result = await pool.query(
    `
      INSERT INTO admin_alert_acknowledgements (alert_key, acknowledged_by, note, acknowledged_at, updated_at)
      VALUES ($1, $2, NULLIF($3, ''), NOW(), NOW())
      ON CONFLICT (alert_key) DO UPDATE
      SET
        acknowledged_by = EXCLUDED.acknowledged_by,
        note = EXCLUDED.note,
        acknowledged_at = NOW(),
        updated_at = NOW()
      RETURNING alert_key, acknowledged_at, note
    `,
    [alertId, adminAccountId, String(note || '').trim()]
  );

  return result.rows[0] || null;
};
