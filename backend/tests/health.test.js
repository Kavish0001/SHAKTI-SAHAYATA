import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeState = {
  live: {
    status: 'alive',
    timestamp: '2026-04-06T00:00:00.000Z',
    service: 'shakti-backend',
  },
  ready: {
    status: 'ready',
    timestamp: '2026-04-06T00:00:00.000Z',
    service: 'shakti-backend',
    checks: {
      database: { status: 'pass' },
      uploads: { status: 'pass' },
      auth: { status: 'pass' },
      ollama: { status: 'degraded' },
      seedUsers: { status: 'pass' },
    },
    summary: { failed: [], degraded: ['ollama'] },
  },
  startup: {
    status: 'ready',
    timestamp: '2026-04-06T00:00:00.000Z',
    service: 'shakti-backend',
    checks: {
      database: { status: 'pass' },
      uploads: { status: 'pass' },
    },
    summary: { failed: [], degraded: [] },
  },
};

vi.mock('../services/runtimeStatus.service.js', () => ({
  getLiveHealth: () => runtimeState.live,
  getReadyHealth: () => runtimeState.ready,
  getStartupStatus: () => runtimeState.startup,
  runStartupSelfChecks: vi.fn(),
}));

const queryMock = vi.fn(async () => ({ rows: [{ server_time: new Date().toISOString() }] }));

vi.mock('../config/database.js', () => ({
  default: {
    query: queryMock,
    on: vi.fn(),
  },
}));

vi.mock('../services/chatbot/ollama.service.js', () => ({
  isOllamaAvailable: vi.fn(async () => true),
}));

vi.mock('../services/chatbot/config.js', () => ({
  CHATBOT_MAX_MESSAGE_LENGTH: 2000,
  OLLAMA_MODEL: 'phi3.5',
  getOllamaRuntimeConfig: () => ({ baseUrl: 'http://localhost:11434', model: 'phi3.5', source: 'test' }),
}));

vi.mock('../middleware/rateLimit.js', () => ({
  rateLimit: (_req, _res, next) => next(),
  authRateLimit: (_req, _res, next) => next(),
  adminAuthRateLimit: (_req, _res, next) => next(),
}));

vi.mock('../middleware/auditLogger.js', () => ({
  auditLogger: (_req, _res, next) => next(),
}));

const { createApp } = await import('../app.js');
const app = createApp();

describe('health endpoints', () => {
  beforeEach(() => {
    runtimeState.ready.status = 'ready';
    runtimeState.startup.status = 'ready';
  });

  it('returns liveness without dependency checks', async () => {
    const response = await request(app).get('/api/health/live');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('alive');
    expect(response.body.service).toBe('shakti-backend');
  });

  it('returns readiness payload when ready', async () => {
    const response = await request(app).get('/api/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks.database.status).toBe('pass');
  });

  it('returns 503 when startup checks are not ready', async () => {
    runtimeState.ready.status = 'not_ready';
    runtimeState.ready.summary = { failed: ['database'], degraded: [] };
    runtimeState.ready.checks.database = { status: 'fail', detail: 'Database unavailable' };

    const response = await request(app).get('/api/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.summary.failed).toContain('database');
  });

  it('returns cached startup status', async () => {
    const response = await request(app).get('/api/health/startup');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks.uploads.status).toBe('pass');
  });
});
