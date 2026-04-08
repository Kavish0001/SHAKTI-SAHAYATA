import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn(async (sql, params = []) => {
  const text = String(sql);

  if (text.includes('SELECT') && text.includes('totp_secret_configured') && text.includes('FROM admin_accounts')) {
    return {
      rows: [{ role: 'it_admin', totp_enabled: false, totp_secret_configured: false }],
      rowCount: 1,
    };
  }

  if (text.includes('SELECT NOW() AS server_time') && text.includes('total_cases')) {
    return {
      rows: [{ total_cases: 14, total_files: 31, failed_ingestion_jobs: 2, active_admin_sessions: 1 }],
      rowCount: 1,
    };
  }

  if (text.includes('SELECT NOW() AS server_time')) {
    return {
      rows: [{ server_time: '2026-04-08T12:00:00.000Z' }],
      rowCount: 1,
    };
  }

  if (text.includes("WHERE aal.action = 'RUN_SYSTEM_SELF_CHECK'") && text.includes('LIMIT 5')) {
    return {
      rows: [
        {
          id: 88,
          created_at: '2026-04-08T11:30:00.000Z',
          details: { status: 'degraded', failedChecks: [], degradedChecks: ['backups'], durationMs: 84 },
          actor_name: 'IT Admin',
          actor_email: 'it.admin@police.gov.in',
        },
      ],
      rowCount: 1,
    };
  }

  if (text.includes('INSERT INTO admin_action_logs')) {
    return { rows: [], rowCount: 1 };
  }

  if (text.includes('SELECT') && text.includes('affected_accounts')) {
    return { rows: [{ affected_accounts: 4 }], rowCount: 1 };
  }

  if (text.includes("WHERE action = 'FILE_DELETE'")) {
    return { rows: [{ total: 5 }], rowCount: 1 };
  }

  if (text.includes('FROM ingestion_jobs') && text.includes("status IN ('failed', 'partial_success', 'quarantined', 'mismatched', 'cancelled')")) {
    return { rows: [{ total: 6 }], rowCount: 1 };
  }

  if (text.includes('FROM (\n          SELECT id\n          FROM sessions')) {
    return { rows: [{ total: 3 }], rowCount: 1 };
  }

  if (text.includes("WHERE action = 'RUN_SYSTEM_SELF_CHECK'") && text.includes('LIMIT 1')) {
    return {
      rows: [{ details: { status: 'fail', failedChecks: ['database'], degradedChecks: [] }, created_at: '2026-04-08T11:45:00.000Z' }],
      rowCount: 1,
    };
  }

  if (text.includes('FROM admin_alert_acknowledgements')) {
    return { rows: [], rowCount: 0 };
  }

  if (text.includes('INSERT INTO admin_alert_acknowledgements')) {
    return {
      rows: [{ alert_key: params[0], acknowledged_at: '2026-04-08T12:05:00.000Z', note: params[2] || null }],
      rowCount: 1,
    };
  }

  if (text.includes('FROM admin_action_logs aal') && text.includes("WHERE aal.action = ANY")) {
    return {
      rows: [
        {
          id: 901,
          action: 'EXPORT_OVERVIEW',
          resource_type: 'export',
          resource_id: 'overview',
          details: { scope: 'overview', reason: 'Daily ops snapshot', exportedCount: 10, result: 'success' },
          created_at: '2026-04-08T12:10:00.000Z',
          actor_name: 'IT Admin',
          actor_email: 'it.admin@police.gov.in',
          actor_role: 'it_admin',
        },
      ],
      rowCount: 1,
    };
  }

  if (text.includes('active_officer_sessions') && text.includes('recent_admin_actions')) {
    return {
      rows: [
        {
          active_officer_sessions: 3,
          active_admin_sessions: 1,
          open_cases: 14,
          evidence_locked_cases: 2,
          uploads_today: 7,
          file_deletions_today: 1,
          recent_admin_actions: 5,
        },
      ],
      rowCount: 1,
    };
  }

  if (text.includes('locked_officer_accounts') && text.includes('failed_ingestion_jobs')) {
    return {
      rows: [{ locked_officer_accounts: 1, locked_admin_accounts: 0, failed_ingestion_jobs: 2 }],
      rowCount: 1,
    };
  }

  if (text.includes('FROM admin_accounts') && text.includes('totp_enabled')) {
    return {
      rows: [
        {
          id: 101,
          email: 'it.admin@police.gov.in',
          full_name: 'IT Admin',
          role: 'it_admin',
          permissions: ['console_access'],
          is_active: true,
          last_login: '2026-04-08T10:00:00.000Z',
          created_at: '2026-04-08T08:00:00.000Z',
          totp_enabled: false,
          totp_secret_configured: false,
        },
      ],
      rowCount: 1,
    };
  }

  return { rows: [], rowCount: 0 };
});

vi.mock('../config/database.js', () => ({
  default: {
    query: queryMock,
    on: vi.fn(),
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
  },
}));

vi.mock('../middleware/rateLimit.js', () => ({
  rateLimit: (_req, _res, next) => next(),
  authRateLimit: (_req, _res, next) => next(),
  adminAuthRateLimit: (_req, _res, next) => next(),
}));

vi.mock('../middleware/auditLogger.js', () => ({
  auditLogger: (_req, _res, next) => next(),
}));

vi.mock('../services/runtimeStatus.service.js', () => ({
  getLiveHealth: () => ({ status: 'alive', timestamp: '2026-04-08T12:00:00.000Z', service: 'shakti-backend' }),
  getReadyHealth: () => ({
    status: 'degraded',
    timestamp: '2026-04-08T12:00:00.000Z',
    service: 'shakti-backend',
    checks: {
      database: { status: 'pass', detail: 'Database OK' },
    },
    summary: { failed: [], degraded: ['backups'] },
  }),
  getStartupStatus: () => ({
    status: 'degraded',
    timestamp: '2026-04-08T11:58:00.000Z',
    service: 'shakti-backend',
    checks: {
      backups: {
        status: 'degraded',
        detail: 'No backup status file found yet.',
      },
    },
    summary: { failed: [], degraded: ['backups'] },
  }),
  runStartupSelfChecks: vi.fn(async () => ({
    status: 'degraded',
    summary: { failed: [], degraded: ['backups'] },
    checks: {
      backups: { status: 'degraded', detail: 'No backup status file found yet.' },
    },
  })),
}));

vi.mock('../services/chatbot/ollama.service.js', () => ({
  isOllamaAvailable: vi.fn(async () => true),
}));

vi.mock('../services/chatbot/config.js', () => ({
  CHATBOT_MAX_MESSAGE_LENGTH: 2000,
  OLLAMA_MODEL: 'phi3.5',
  getOllamaRuntimeConfig: () => ({ baseUrl: 'http://localhost:11434', model: 'phi3.5', source: 'test' }),
}));

const { createApp } = await import('../app.js');
const app = createApp();

const createAdminToken = ({ role = 'it_admin', recentAuthAt } = {}) =>
  jwt.sign(
    {
      adminId: 101,
      email: 'it.admin@police.gov.in',
      fullName: 'IT Admin',
      role,
      permissions: ['console_access'],
      accountType: 'it_admin',
      sessionId: 'sess-admin-1',
      recentAuthAt: recentAuthAt || Math.floor(Date.now() / 1000),
    },
    process.env.JWT_ADMIN_SECRET,
    { audience: 'admin-console', expiresIn: '10m', subject: '101' }
  );

describe('admin system operations', () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  it('returns the consolidated system health snapshot', async () => {
    const response = await request(app)
      .get('/api/admin/system/health')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.overallStatus).toBeDefined();
    expect(response.body.database.connected).toBe(true);
    expect(response.body.security.networkRestriction.mode).toBe('disabled');
    expect(response.body.selfChecks).toHaveLength(1);
  });

  it('runs and logs an admin-triggered self-check', async () => {
    const response = await request(app)
      .post('/api/admin/system/self-check')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('degraded');
    expect(
      queryMock.mock.calls.some(
        ([sql, params]) => String(sql).includes('INSERT INTO admin_action_logs') && params?.includes('RUN_SYSTEM_SELF_CHECK')
      )
    ).toBe(true);
  });

  it('returns active alert aggregation with severity and acknowledgement state', async () => {
    const response = await request(app)
      .get('/api/admin/alerts')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.summary.total).toBeGreaterThan(0);
    expect(response.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'database-degraded', severity: expect.any(String), acknowledged: false }),
        expect.objectContaining({ id: 'failed-logins' }),
      ])
    );
  });

  it('exports the overview snapshot as a logged CSV action', async () => {
    const response = await request(app)
      .get('/api/admin/exports/overview')
      .query({ reason: 'Daily ops snapshot' })
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('Section');
    expect(
      queryMock.mock.calls.some(
        ([sql, params]) => String(sql).includes('INSERT INTO admin_action_logs') && params?.includes('EXPORT_OVERVIEW')
      )
    ).toBe(true);
  });

  it('blocks sensitive file exports for auditors without export_files permission', async () => {
    const response = await request(app)
      .get('/api/admin/exports/files')
      .query({ reason: 'Auditor attempt' })
      .set('Authorization', `Bearer ${createAdminToken({ role: 'it_auditor' })}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Insufficient admin permissions');
  });
});
