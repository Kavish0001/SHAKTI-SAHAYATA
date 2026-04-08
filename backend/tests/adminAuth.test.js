import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminAccount = {
  id: 101,
  email: 'it.admin@police.gov.in',
  password_hash: '$2a$12$QarFNbW.z.vtz2vywPNWjuF7WUJjpf0q0C26Vcw72oy16s5nZANFG',
  full_name: 'IT Department Admin',
  role: 'it_admin',
  permissions: ['console_access'],
  failed_login_attempts: 0,
  locked_until: null,
  is_active: true,
  last_login: null,
  created_at: '2026-04-08T00:00:00.000Z',
};

const queryMock = vi.fn(async (sql, params = []) => {
  const text = String(sql);

  if (text.includes('SELECT *') && text.includes('FROM admin_accounts')) {
    const email = params[0];
    return { rows: email === adminAccount.email ? [{ ...adminAccount }] : [] };
  }

  if (text.includes('UPDATE admin_accounts') && text.includes('failed_login_attempts = 0')) {
    return { rows: [], rowCount: 1 };
  }

  if (text.includes('INSERT INTO admin_sessions')) {
    return { rows: [{ id: 'session-1', started_at: '2026-04-08T01:00:00.000Z' }], rowCount: 1 };
  }

  if (text.includes('UPDATE admin_accounts') && text.includes('SET last_login = NOW()')) {
    return { rows: [], rowCount: 1 };
  }

  if (text.includes('INSERT INTO admin_refresh_tokens')) {
    return {
      rows: [{ id: 'refresh-1', family_id: params[2], expires_at: '2026-04-15T01:00:00.000Z' }],
      rowCount: 1
    };
  }

  if (text.includes('INSERT INTO admin_action_logs')) {
    return { rows: [], rowCount: 1 };
  }

  if (text.includes('SELECT id, email, full_name, role, permissions, is_active, last_login, created_at')) {
    return { rows: [{ ...adminAccount }], rowCount: 1 };
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
  getLiveHealth: () => ({ status: 'alive', service: 'shakti-backend' }),
  getReadyHealth: () => ({ status: 'ready', service: 'shakti-backend', checks: {} }),
  getStartupStatus: () => ({ status: 'ready', service: 'shakti-backend', checks: {} }),
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

describe('admin auth endpoints', () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  it('logs in an admin with a separate admin session payload', async () => {
    const response = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: adminAccount.email, password: 'Shakti@123' });

    expect(response.status).toBe(200);
    expect(response.body.admin.email).toBe(adminAccount.email);
    expect(response.body.admin.role).toBe('it_admin');
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.session.id).toBe('session-1');
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('returns unauthenticated bootstrap when no admin refresh cookie exists', async () => {
    const response = await request(app).get('/api/admin/auth/bootstrap');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authenticated: false });
  });

  it('rejects admin me without an admin token', async () => {
    const response = await request(app).get('/api/admin/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Admin access token required');
  });

  it('rejects officer-shaped tokens on admin endpoints', async () => {
    const officerToken = jwt.sign(
      {
        userId: 7,
        email: 'officer@police.gov.in',
        role: 'super_admin',
      },
      process.env.JWT_ADMIN_SECRET,
      { audience: 'admin-console', expiresIn: '10m' }
    );

    const response = await request(app)
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${officerToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Invalid admin token');
  });
});
