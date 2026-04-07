import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();

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
  requireCaseAccess: () => (_req, _res, next) => next(),
}));

vi.mock('../middleware/evidenceLock.js', () => ({
  checkEvidenceLock: (_req, _res, next) => next(),
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

describe('POST /api/cases', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('returns 400 when required fields are missing', async () => {
    const response = await request(app)
      .post('/api/cases')
      .send({ caseName: 'Incomplete Case' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Case number is required.');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 400 when end date is earlier than start date', async () => {
    const response = await request(app)
      .post('/api/cases')
      .send({
        caseName: 'Date Validation Case',
        caseNumber: 'DVC-2026-0001',
        operator: 'Jio',
        caseType: 'Cyber Crime',
        priority: 'medium',
        firNumber: 'FIR/2026/0042',
        investigationDetails: 'Testing invalid date order.',
        startDate: '2026-04-10',
        endDate: '2026-04-08',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('End date cannot be earlier than start date.');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('creates a case when the payload is complete and valid', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 101, case_name: 'Valid Case', case_number: 'VAL-2026-0042' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await request(app)
      .post('/api/cases')
      .send({
        caseName: 'Valid Case',
        caseNumber: 'VAL-2026-0042',
        operator: 'Jio',
        caseType: 'Cyber Crime',
        priority: 'medium',
        firNumber: 'FIR/2026/0042',
        investigationDetails: 'Investigating coordinated telecom fraud.',
        startDate: '2026-04-01',
        endDate: '2026-04-08',
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe(101);
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO cases'),
      ['Valid Case', 'VAL-2026-0042', 'Cyber Crime', 'FIR/2026/0042', 'Jio', 'Investigating coordinated telecom fraud.', '2026-04-01', '2026-04-08', 'medium', 7]
    );
  });
});
