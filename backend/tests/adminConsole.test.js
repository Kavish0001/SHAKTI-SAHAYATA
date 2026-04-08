import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const activityRows = [
  {
    source: 'audit',
    id: 'evt-1',
    created_at: '2026-04-08T10:00:00.000Z',
    actor_type: 'officer',
    actor_id: '7',
    actor_name: 'Inspector Kavish',
    actor_email: 'kavish@police.gov.in',
    actor_role: 'investigating_officer',
    action: 'CASE_CREATE',
    resource_type: 'case',
    resource_id: 'CASE-101',
    session_id: 'sess-off-1',
    ip_address: '10.0.0.8',
    details: { caseName: 'Missing Person Lead' },
  },
  {
    source: 'admin',
    id: 'evt-2',
    created_at: '2026-04-08T09:50:00.000Z',
    actor_type: 'admin',
    actor_id: '101',
    actor_name: 'IT Admin',
    actor_email: 'it.admin@police.gov.in',
    actor_role: 'it_admin',
    action: 'FORCE_LOGOUT_OFFICER_SESSION',
    resource_type: 'session',
    resource_id: 'sess-off-1',
    session_id: 'sess-admin-1',
    ip_address: '10.0.0.2',
    details: { sessionType: 'officer' },
  },
];

const queryMock = vi.fn(async (sql, params = []) => {
  const text = String(sql);

  if (text.includes('active_officer_sessions') && text.includes('recent_admin_actions')) {
    return {
      rows: [
        {
          active_officer_sessions: 4,
          active_admin_sessions: 2,
          open_cases: 17,
          evidence_locked_cases: 3,
          uploads_today: 9,
          file_deletions_today: 1,
          failed_officer_logins: 2,
          failed_admin_logins: 1,
          recent_admin_actions: 6,
        },
      ],
      rowCount: 1,
    };
  }

  if (text.includes('locked_officer_accounts') && text.includes('failed_ingestion_jobs')) {
    return {
      rows: [
        {
          locked_officer_accounts: 1,
          locked_admin_accounts: 0,
          failed_ingestion_jobs: 2,
        },
      ],
      rowCount: 1,
    };
  }

  if (text.includes('LIMIT 8')) {
    return { rows: activityRows.slice(0, 1), rowCount: 1 };
  }

  if (text.includes('SELECT NOW() AS server_time')) {
    return {
      rows: [{ server_time: '2026-04-08T10:05:00.000Z' }],
      rowCount: 1,
    };
  }

  if (text.includes('FROM unified_activity') && text.includes('COUNT(*)::int AS total')) {
    return {
      rows: [{ total: activityRows.length }],
      rowCount: 1,
    };
  }

  if (text.includes('FROM unified_activity') && text.includes('ORDER BY created_at DESC') && text.includes('LIMIT $')) {
    return {
      rows: activityRows,
      rowCount: activityRows.length,
    };
  }

  if (text.includes('FROM users u') && text.includes('LEFT JOIN officers o')) {
    return {
      rows: [
        {
          id: 7,
          buckle_id: 'BK-4782',
          email: 'kavish@police.gov.in',
          full_name: 'Inspector Kavish',
          role: 'investigating_officer',
          is_active: true,
          last_login: '2026-04-08T08:15:00.000Z',
          login_count: 22,
          position: 'Inspector',
          department: 'Cyber Cell',
          station: 'HQ',
          active_sessions: 1,
          total_cases: 12,
          open_cases: 5,
          recent_actions_7d: 18,
        },
      ],
      rowCount: 1,
    };
  }

  if (text.includes('FROM admin_accounts aa') && text.includes('LEFT JOIN (')) {
    return {
      rows: [
        {
          id: 101,
          email: 'it.admin@police.gov.in',
          full_name: 'IT Admin',
          role: 'it_admin',
          permissions: ['console_access'],
          is_active: true,
          last_login: '2026-04-08T09:45:00.000Z',
          active_sessions: 1,
          recent_actions_7d: 11,
        },
      ],
      rowCount: 1,
    };
  }

  if (text.includes("UPDATE sessions") && text.includes("RETURNING id, user_id")) {
    return {
      rows: [{ id: params[0], user_id: 7 }],
      rowCount: 1,
    };
  }

  if (text.includes('UPDATE refresh_tokens')) {
    return { rows: [], rowCount: 2 };
  }

  if (text.includes('INSERT INTO admin_action_logs')) {
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
});

vi.mock('../config/database.js', () => ({
  default: {
    query: queryMock,
    on: vi.fn(),
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
  getLiveHealth: () => ({ status: 'alive', timestamp: '2026-04-08T10:05:00.000Z', service: 'shakti-backend' }),
  getReadyHealth: () => ({
    status: 'ready',
    timestamp: '2026-04-08T10:05:00.000Z',
    service: 'shakti-backend',
    checks: {
      database: { status: 'pass', detail: 'Database OK' },
    },
    summary: { failed: [], degraded: [] },
  }),
  getStartupStatus: () => ({
    status: 'degraded',
    timestamp: '2026-04-08T10:04:00.000Z',
    service: 'shakti-backend',
    checks: {
      backups: {
        status: 'degraded',
        detail: 'No backup status file found yet.',
      },
    },
    summary: { failed: [], degraded: ['backups'] },
  }),
  runStartupSelfChecks: vi.fn(),
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

const createAdminToken = (role = 'it_admin') =>
  jwt.sign(
    {
      adminId: 101,
      email: 'it.admin@police.gov.in',
      fullName: 'IT Admin',
      role,
      permissions: ['console_access'],
      accountType: 'it_admin',
    },
    process.env.JWT_ADMIN_SECRET,
    { audience: 'admin-console', expiresIn: '10m', subject: '101' }
  );

describe('admin console endpoints', () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  it('returns overview metrics, health, and attention data for admin users', async () => {
    const response = await request(app)
      .get('/api/admin/overview')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.metrics.activeOfficerSessions).toBe(4);
    expect(response.body.metrics.failedAdminLogins).toBe(1);
    expect(response.body.health.databaseConnected).toBe(true);
    expect(response.body.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'locked-officers', count: 1 }),
        expect.objectContaining({ id: 'failed-ingestion', count: 2 }),
      ])
    );
    expect(response.body.recentActivity).toHaveLength(1);
  });

  it('supports actor, session, and IP filters on the activity feed', async () => {
    const response = await request(app)
      .get('/api/admin/activity')
      .query({
        actor: 'Inspector',
        sessionId: 'sess-off-1',
        ipAddress: '10.0.0.8',
      })
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.pagination.total).toBe(2);

    const itemsQueryCall = queryMock.mock.calls.find(
      ([sql]) =>
        String(sql).includes('FROM unified_activity')
        && String(sql).includes('ORDER BY created_at DESC')
        && String(sql).includes('LIMIT $')
    );

    expect(itemsQueryCall).toBeTruthy();
    expect(String(itemsQueryCall[0])).toContain("COALESCE(actor_name, '') ILIKE");
    expect(String(itemsQueryCall[0])).toContain('session_id =');
    expect(String(itemsQueryCall[0])).toContain("COALESCE(ip_address, '') ILIKE");
    expect(itemsQueryCall[1]).toEqual(expect.arrayContaining(['%Inspector%', 'sess-off-1', '%10.0.0.8%']));
  });

  it('broadens case filters to include events linked through details.caseId', async () => {
    const response = await request(app)
      .get('/api/admin/activity')
      .query({ caseId: '101' })
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);

    const itemsQueryCall = queryMock.mock.calls.find(
      ([sql]) =>
        String(sql).includes('FROM unified_activity')
        && String(sql).includes("COALESCE(details->>'caseId', '') =")
    );

    expect(itemsQueryCall).toBeTruthy();
    expect(String(itemsQueryCall[0])).toContain("resource_type = 'case'");
    expect(itemsQueryCall[1]).toEqual(expect.arrayContaining(['101']));
  });

  it('returns officers/admins summary data for the users view', async () => {
    const response = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.officers[0].full_name).toBe('Inspector Kavish');
    expect(response.body.admins[0].full_name).toBe('IT Admin');
    expect(response.body.summary.activeOfficerSessions).toBe(1);
    expect(response.body.summary.activeAdminSessions).toBe(1);
  });

  it('forces logout for officer sessions and records the action', async () => {
    const response = await request(app)
      .post('/api/admin/sessions/sess-off-1/force-logout')
      .set('Authorization', `Bearer ${createAdminToken('it_admin')}`)
      .send({ sessionType: 'officer', reason: 'Suspicious session' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      forced: true,
      sessionType: 'officer',
      sessionId: 'sess-off-1',
    });

    expect(
      queryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE refresh_tokens'))
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO admin_action_logs'))
    ).toBe(true);
  });
});
