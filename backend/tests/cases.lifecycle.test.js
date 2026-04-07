import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
let accessAllowed = true;
let lockAllowed = true;

vi.mock('../config/database.js', () => ({
  default: {
    query: (...args) => queryMock(...args),
  },
}));

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = { userId: 7, buckleId: 'BK-9999', role: 'investigator' };
    next();
  },
}));

vi.mock('../middleware/authorize.js', () => ({
  requireRole: () => (_req, _res, next) => next(),
}));

vi.mock('../middleware/caseAccess.js', () => ({
  requireCaseAccess: () => (_req, res, next) => {
    if (!accessAllowed) {
      return res.status(403).json({ error: 'Insufficient case permissions' });
    }
    next();
  },
}));

vi.mock('../middleware/evidenceLock.js', () => ({
  checkEvidenceLock: (_req, res, next) => {
    if (!lockAllowed) {
      return res.status(423).json({ error: 'Case is evidence locked' });
    }
    next();
  },
}));

vi.mock('../services/chatbot/caseContext.service.js', () => ({
  buildCaseKnowledgeContract: vi.fn(),
  getCaseModuleSummary: vi.fn(),
  searchCasesForChat: vi.fn(),
}));

const { default: casesRouter } = await import('../routes/cases.js');

const app = express();
app.use(express.json());
app.use('/api/cases', casesRouter);

describe('case lifecycle routes', () => {
  beforeEach(() => {
    queryMock.mockReset();
    accessAllowed = true;
    lockAllowed = true;
  });

  it('archives a case for owner-level access', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 55, status: 'archived' }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await request(app).post('/api/cases/55/archive').send({});

    expect(response.status).toBe(200);
    expect(response.body.case.status).toBe('archived');
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SET status = 'archived'"),
      [7, '55']
    );
  });

  it('rejects archive when the requester is not an owner/admin', async () => {
    accessAllowed = false;

    const response = await request(app).post('/api/cases/55/archive').send({});

    expect(response.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects archive when the case is evidence locked', async () => {
    lockAllowed = false;

    const response = await request(app).post('/api/cases/55/archive').send({});

    expect(response.status).toBe(423);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('reopens an archived case for owner-level access', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 55, status: 'open' }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await request(app).post('/api/cases/55/reopen').send({});

    expect(response.status).toBe(200);
    expect(response.body.case.status).toBe('open');
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SET status = 'open'"),
      [7, '55']
    );
  });

  it('deletes a case for owner-level access', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 55 }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await request(app).delete('/api/cases/55');

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Case deleted');
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM cases WHERE id = $1 RETURNING id',
      ['55']
    );
  });

  it('rejects delete when the case is evidence locked', async () => {
    lockAllowed = false;

    const response = await request(app).delete('/api/cases/55');

    expect(response.status).toBe(423);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
