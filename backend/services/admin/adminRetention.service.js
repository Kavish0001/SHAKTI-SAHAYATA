import pool from '../../config/database.js';
import { ADMIN_CONSOLE_CONFIG } from '../../config/adminConsole.js';

let retentionState = {
  running: false,
  startedAt: null,
  completedAt: null,
  lastResult: null,
  lastError: null,
  timer: null,
};

const buildRetentionRunResult = ({ deletedSessions, deletedRefreshTokens, deletedActionLogs, startedAt, completedAt }) => ({
  status: 'success',
  startedAt,
  completedAt,
  deletedSessions,
  deletedRefreshTokens,
  deletedActionLogs,
  policies: {
    sessionDays: ADMIN_CONSOLE_CONFIG.retention.sessionDays,
    refreshTokenDays: ADMIN_CONSOLE_CONFIG.retention.refreshTokenDays,
    actionLogDays: ADMIN_CONSOLE_CONFIG.retention.actionLogDays,
  },
});

export const getAdminRetentionState = () => ({
  running: retentionState.running,
  startedAt: retentionState.startedAt,
  completedAt: retentionState.completedAt,
  lastResult: retentionState.lastResult,
  lastError: retentionState.lastError,
  policies: {
    sessionDays: ADMIN_CONSOLE_CONFIG.retention.sessionDays,
    refreshTokenDays: ADMIN_CONSOLE_CONFIG.retention.refreshTokenDays,
    actionLogDays: ADMIN_CONSOLE_CONFIG.retention.actionLogDays,
    intervalMinutes: ADMIN_CONSOLE_CONFIG.retention.intervalMinutes,
  },
});

export const runAdminRetentionJob = async () => {
  if (retentionState.running) {
    return retentionState.lastResult;
  }

  const startedAt = new Date().toISOString();
  retentionState = {
    ...retentionState,
    running: true,
    startedAt,
    lastError: null,
  };

  try {
    const [sessionsResult, refreshTokensResult, actionLogsResult] = await Promise.all([
      pool.query(
        `
          DELETE FROM admin_sessions
          WHERE ended_at IS NOT NULL
            AND COALESCE(ended_at, started_at) < NOW() - ($1 || ' days')::interval
        `,
        [String(ADMIN_CONSOLE_CONFIG.retention.sessionDays)]
      ),
      pool.query(
        `
          DELETE FROM admin_refresh_tokens
          WHERE (is_revoked = TRUE OR expires_at < NOW())
            AND created_at < NOW() - ($1 || ' days')::interval
        `,
        [String(ADMIN_CONSOLE_CONFIG.retention.refreshTokenDays)]
      ),
      pool.query(
        `
          DELETE FROM admin_action_logs
          WHERE created_at < NOW() - ($1 || ' days')::interval
        `,
        [String(ADMIN_CONSOLE_CONFIG.retention.actionLogDays)]
      ),
    ]);

    const completedAt = new Date().toISOString();
    const result = buildRetentionRunResult({
      deletedSessions: sessionsResult.rowCount || 0,
      deletedRefreshTokens: refreshTokensResult.rowCount || 0,
      deletedActionLogs: actionLogsResult.rowCount || 0,
      startedAt,
      completedAt,
    });

    retentionState = {
      ...retentionState,
      running: false,
      completedAt,
      lastResult: result,
      lastError: null,
    };

    return result;
  } catch (error) {
    retentionState = {
      ...retentionState,
      running: false,
      completedAt: new Date().toISOString(),
      lastError: error?.message || 'Retention job failed',
    };
    throw error;
  }
};

export const startAdminRetentionScheduler = () => {
  if (retentionState.timer) return retentionState.timer;

  const intervalMs = ADMIN_CONSOLE_CONFIG.retention.intervalMinutes * 60 * 1000;
  retentionState.timer = setInterval(() => {
    runAdminRetentionJob().catch((error) => {
      retentionState.lastError = error?.message || 'Retention job failed';
    });
  }, intervalMs);

  if (typeof retentionState.timer.unref === 'function') {
    retentionState.timer.unref();
  }

  return retentionState.timer;
};
