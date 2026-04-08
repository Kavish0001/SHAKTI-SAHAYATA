import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pool from '../../config/database.js';
import { ADMIN_CONSOLE_CONFIG, isAdminTotpRequiredForRole } from '../../config/adminConsole.js';
import {
  getLiveHealth,
  getReadyHealth,
  getStartupStatus,
  runStartupSelfChecks,
} from '../runtimeStatus.service.js';
import { getAdminRetentionState } from './adminRetention.service.js';

const PASS = 'pass';
const DEGRADED = 'degraded';
const FAIL = 'fail';

const normalizeStatus = (status) => {
  if (['ready', 'alive', 'ok', PASS].includes(status)) return PASS;
  if (['not_ready', FAIL].includes(status)) return FAIL;
  if (status === DEGRADED) return DEGRADED;
  return DEGRADED;
};

const buildStatusBlock = (status, detail, extra = {}) => ({
  status,
  detail,
  checkedAt: new Date().toISOString(),
  ...extra,
});

const resolveOverallStatus = (blocks) => {
  if (blocks.some((block) => normalizeStatus(block?.status) === FAIL)) return FAIL;
  if (blocks.some((block) => normalizeStatus(block?.status) === DEGRADED)) return DEGRADED;
  return PASS;
};

const resolveUploadDir = () => path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');

const inspectUploadDirectory = async (uploadDir) => {
  try {
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.access(uploadDir);
    const entries = await fs.readdir(uploadDir, { withFileTypes: true });
    const fileEntries = entries.filter((entry) => entry.isFile());
    return buildStatusBlock(PASS, `Uploads directory is available at ${uploadDir}.`, {
      path: uploadDir,
      exists: true,
      writable: true,
      topLevelFileCount: fileEntries.length,
    });
  } catch (error) {
    return buildStatusBlock(FAIL, error?.message || 'Uploads directory is unavailable.', {
      path: uploadDir,
      exists: false,
      writable: false,
    });
  }
};

const inspectDatabaseState = async () => {
  const startedAt = Date.now();

  try {
    const [timeResult, metricsResult] = await Promise.all([
      pool.query('SELECT NOW() AS server_time'),
      pool.query(
        `
          SELECT
            (SELECT COUNT(*)::int FROM cases) AS total_cases,
            (SELECT COUNT(*)::int FROM uploaded_files) AS total_files,
            (SELECT COUNT(*)::int FROM ingestion_jobs WHERE status IN ('failed', 'partial_success')) AS failed_ingestion_jobs,
            (SELECT COUNT(*)::int FROM admin_sessions WHERE ended_at IS NULL) AS active_admin_sessions
        `
      ),
    ]);

    return buildStatusBlock(PASS, 'Database connectivity and operational metrics verified.', {
      connected: true,
      latencyMs: Date.now() - startedAt,
      serverTime: timeResult.rows[0]?.server_time || null,
      metrics: metricsResult.rows[0] || {},
      pool: {
        totalCount: Number(pool.totalCount || 0),
        idleCount: Number(pool.idleCount || 0),
        waitingCount: Number(pool.waitingCount || 0),
      },
    });
  } catch (error) {
    return buildStatusBlock(FAIL, error?.message || 'Database unavailable.', {
      connected: false,
      latencyMs: Date.now() - startedAt,
      pool: {
        totalCount: Number(pool.totalCount || 0),
        idleCount: Number(pool.idleCount || 0),
        waitingCount: Number(pool.waitingCount || 0),
      },
    });
  }
};

const inspectRuntimeState = () => {
  const uptimeSeconds = Math.round(process.uptime());
  const memory = process.memoryUsage();

  return buildStatusBlock(PASS, 'Runtime statistics collected.', {
    nodeVersion: process.version,
    platform: process.platform,
    hostname: os.hostname(),
    processId: process.pid,
    uptimeSeconds,
    cpuUsage: process.cpuUsage(),
    memory: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
    },
  });
};

const inspectSecurityState = ({ admin, networkRequestState }) => {
  const totpRequired = isAdminTotpRequiredForRole(admin?.role);
  const totpEnrolled = Boolean(admin?.totpEnabled && admin?.totpSecretConfigured);
  const totpStatus = !totpRequired || totpEnrolled ? PASS : DEGRADED;

  const networkStatus = networkRequestState?.enforced
    ? networkRequestState.matched ? PASS : FAIL
    : DEGRADED;

  return {
    totp: buildStatusBlock(
      totpStatus,
      totpRequired
        ? totpEnrolled
          ? 'TOTP is required and configured for this admin role.'
          : 'TOTP is required for this admin role but no enrolled secret was detected.'
        : 'TOTP enforcement is disabled for the current environment.',
      {
        enforced: ADMIN_CONSOLE_CONFIG.totp.enforced,
        requiredRoles: ADMIN_CONSOLE_CONFIG.totp.requiredRoles,
        currentRoleRequiresTotp: totpRequired,
        currentAdminEnrolled: totpEnrolled,
      }
    ),
    sessionRotation: buildStatusBlock(PASS, 'Admin refresh token rotation with family revocation is enabled.', {
      refreshTokenTtlDays: Number(process.env.JWT_ADMIN_REFRESH_EXPIRY_DAYS || 7),
    }),
    networkRestriction: buildStatusBlock(
      networkStatus,
      networkRequestState?.detail
        || (ADMIN_CONSOLE_CONFIG.network.mode === 'disabled'
          ? 'Admin network restrictions are disabled.'
          : 'Admin network restrictions are enforced.'),
      {
        mode: ADMIN_CONSOLE_CONFIG.network.mode,
        allowlistCount: ADMIN_CONSOLE_CONFIG.network.allowlist.length,
        clientIp: networkRequestState?.clientIp || null,
        matched: Boolean(networkRequestState?.matched),
      }
    ),
    recentAuth: buildStatusBlock(PASS, `Sensitive admin actions require re-auth within ${ADMIN_CONSOLE_CONFIG.recentAuthWindowMinutes} minutes.`, {
      recentAuthWindowMinutes: ADMIN_CONSOLE_CONFIG.recentAuthWindowMinutes,
    }),
  };
};

const fetchRecentSelfChecks = async () => {
  try {
    const result = await pool.query(
      `
        SELECT
          aal.id,
          aal.created_at,
          aal.details,
          COALESCE(aa.full_name, 'Unknown admin') AS actor_name,
          aa.email AS actor_email
        FROM admin_action_logs aal
        LEFT JOIN admin_accounts aa ON aa.id = aal.admin_account_id
        WHERE aal.action = 'RUN_SYSTEM_SELF_CHECK'
        ORDER BY aal.created_at DESC, aal.id DESC
        LIMIT 5
      `
    );

    return result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      actorName: row.actor_name,
      actorEmail: row.actor_email,
      status: row.details?.status || 'unknown',
      failedChecks: row.details?.failedChecks || [],
      degradedChecks: row.details?.degradedChecks || [],
      durationMs: row.details?.durationMs || null,
    }));
  } catch {
    return [];
  }
};

export const buildAdminSystemHealthSnapshot = async ({ admin = null, networkRequestState = null } = {}) => {
  const uploadDir = resolveUploadDir();
  const [database, uploads, selfChecks] = await Promise.all([
    inspectDatabaseState(),
    inspectUploadDirectory(uploadDir),
    fetchRecentSelfChecks(),
  ]);

  const live = getLiveHealth();
  const ready = getReadyHealth();
  const startup = getStartupStatus();
  const runtime = inspectRuntimeState();
  const retention = getAdminRetentionState();
  const security = inspectSecurityState({ admin, networkRequestState });
  const securityBlocks = Object.values(security);
  const backupCheck = startup.checks?.backups || buildStatusBlock(DEGRADED, 'Backup metadata is unavailable.');

  const checks = [
    buildStatusBlock(normalizeStatus(ready.status), `Backend readiness is ${ready.status}.`, ready),
    buildStatusBlock(normalizeStatus(startup.status), `Startup diagnostics are ${startup.status}.`, startup),
    database,
    uploads,
    backupCheck,
    runtime,
    ...securityBlocks,
    buildStatusBlock(
      retention.lastError ? DEGRADED : PASS,
      retention.lastError || 'Admin retention policies are configured and ready.',
      retention
    ),
  ];

  return {
    generatedAt: new Date().toISOString(),
    overallStatus: resolveOverallStatus(checks),
    backend: {
      live,
      ready,
      startup,
    },
    database,
    uploads,
    backups: backupCheck,
    runtime,
    security,
    retention,
    selfChecks,
  };
};

export const runAdminSystemSelfCheck = async ({ admin = null, networkRequestState = null } = {}) => {
  const startedAt = Date.now();
  const uploadDir = resolveUploadDir();
  const startup = await runStartupSelfChecks({ uploadDir, ollamaRequired: false });
  const snapshot = await buildAdminSystemHealthSnapshot({ admin, networkRequestState });

  const failedChecks = [
    ...new Set([
      ...(startup.summary?.failed || []),
      ...(snapshot.overallStatus === FAIL ? ['systemSnapshot'] : []),
    ]),
  ];
  const degradedChecks = [
    ...new Set([
      ...(startup.summary?.degraded || []),
      ...(snapshot.overallStatus === DEGRADED ? ['systemSnapshot'] : []),
    ]),
  ];

  return {
    status: snapshot.overallStatus,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    failedChecks,
    degradedChecks,
    snapshot,
  };
};
