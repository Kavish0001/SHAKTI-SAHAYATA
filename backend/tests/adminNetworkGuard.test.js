import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/adminConsole.js', () => ({
  ADMIN_CONSOLE_CONFIG: {
    network: {
      mode: 'allowlist',
      allowlist: ['10.20.30.40'],
      proxyHeader: 'x-shakti-admin-proxy',
      proxyValue: 'internal',
    },
  },
}));

const { adminNetworkGuard } = await import('../middleware/admin/adminNetworkGuard.js');

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

describe('adminNetworkGuard', () => {
  it('does not trust x-forwarded-for in allowlist mode', () => {
    const req = {
      headers: { 'x-forwarded-for': '10.20.30.40' },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = createResponse();
    const next = vi.fn();

    adminNetworkGuard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(req.adminNetworkRestriction.clientIp).toBe('127.0.0.1');
  });

  it('allows a directly allowlisted socket peer', () => {
    const req = {
      headers: { 'x-forwarded-for': '203.0.113.50' },
      ip: '10.20.30.40',
      socket: { remoteAddress: '10.20.30.40' },
    };
    const res = createResponse();
    const next = vi.fn();

    adminNetworkGuard(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(req.adminNetworkRestriction.clientIp).toBe('10.20.30.40');
  });
});
