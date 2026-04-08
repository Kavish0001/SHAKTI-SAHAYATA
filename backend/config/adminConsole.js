import 'dotenv/config';

const parseBoolean = (value, fallback = false) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseList = (value, fallback = []) =>
  String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, index, array) => array.indexOf(entry) === index)
    .reduce((acc, entry) => {
      acc.push(entry);
      return acc;
    }, fallback.length > 0 && String(value ?? '').trim() === '' ? [...fallback] : []);

const normalizeNetworkMode = (value) => {
  const normalized = String(value || 'disabled').trim().toLowerCase();
  if (['allowlist', 'proxy'].includes(normalized)) return normalized;
  return 'disabled';
};

export const ADMIN_CONSOLE_CONFIG = {
  recentAuthWindowMinutes: parsePositiveInt(process.env.ADMIN_RECENT_AUTH_WINDOW_MINUTES, 15),
  totp: {
    enforced: parseBoolean(process.env.ADMIN_REQUIRE_TOTP, process.env.NODE_ENV === 'production'),
    requiredRoles: parseList(process.env.ADMIN_REQUIRE_TOTP_ROLES, ['it_admin']),
    digits: parsePositiveInt(process.env.ADMIN_TOTP_DIGITS, 6),
    stepSeconds: parsePositiveInt(process.env.ADMIN_TOTP_STEP_SECONDS, 30),
    allowedDriftWindows: parsePositiveInt(process.env.ADMIN_TOTP_DRIFT_WINDOWS, 1),
  },
  network: {
    mode: normalizeNetworkMode(process.env.ADMIN_NETWORK_RESTRICTION_MODE),
    allowlist: parseList(process.env.ADMIN_ALLOWED_IPS),
    proxyHeader: String(process.env.ADMIN_PROXY_HEADER || 'x-shakti-admin-proxy').trim().toLowerCase(),
    proxyValue: String(process.env.ADMIN_PROXY_HEADER_VALUE || 'internal').trim(),
  },
  retention: {
    sessionDays: parsePositiveInt(process.env.ADMIN_SESSION_RETENTION_DAYS, 30),
    refreshTokenDays: parsePositiveInt(process.env.ADMIN_REFRESH_TOKEN_RETENTION_DAYS, 30),
    actionLogDays: parsePositiveInt(process.env.ADMIN_ACTION_LOG_RETENTION_DAYS, 180),
    intervalMinutes: parsePositiveInt(process.env.ADMIN_RETENTION_JOB_INTERVAL_MINUTES, 360),
  },
  alerts: {
    failedLoginThreshold: parsePositiveInt(process.env.ADMIN_ALERT_FAILED_LOGIN_THRESHOLD, 3),
    failedLoginWindowMinutes: parsePositiveInt(process.env.ADMIN_ALERT_FAILED_LOGIN_WINDOW_MINUTES, 60),
    fileDeletionThreshold: parsePositiveInt(process.env.ADMIN_ALERT_FILE_DELETION_THRESHOLD, 3),
    fileDeletionWindowMinutes: parsePositiveInt(process.env.ADMIN_ALERT_FILE_DELETION_WINDOW_MINUTES, 60),
    ingestionFailureThreshold: parsePositiveInt(process.env.ADMIN_ALERT_INGESTION_FAILURE_THRESHOLD, 5),
    ingestionFailureWindowMinutes: parsePositiveInt(process.env.ADMIN_ALERT_INGESTION_FAILURE_WINDOW_MINUTES, 60),
    stalledSessionCountThreshold: parsePositiveInt(process.env.ADMIN_ALERT_STALLED_SESSION_THRESHOLD, 2),
    stalledSessionAgeMinutes: parsePositiveInt(process.env.ADMIN_ALERT_STALLED_SESSION_AGE_MINUTES, 720),
  },
  exports: {
    maxRows: parsePositiveInt(process.env.ADMIN_EXPORT_MAX_ROWS, 10000),
    watermarkLabel: String(process.env.ADMIN_EXPORT_WATERMARK_LABEL || 'SHAKTI INTERNAL EXPORT').trim(),
  },
};

export const isAdminTotpRequiredForRole = (role) =>
  ADMIN_CONSOLE_CONFIG.totp.enforced && ADMIN_CONSOLE_CONFIG.totp.requiredRoles.includes(String(role || '').trim());
