import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const caseRows = [
  {
    id: 101,
    case_name: 'Operation Sunrise',
    case_number: 'OPS-101',
    case_type: 'cyber',
    fir_number: 'FIR-55',
    operator: 'Airtel',
    status: 'active',
    priority: 'high',
    description: null,
    investigation_details: 'Lead monitoring in progress',
    start_date: '2026-04-01',
    end_date: '2026-04-15',
    created_at: '2026-04-01T09:00:00.000Z',
    updated_at: '2026-04-08T10:00:00.000Z',
    is_evidence_locked: true,
    locked_at: '2026-04-08T07:00:00.000Z',
    lock_reason: 'Court hold',
    created_by_user_id: 7,
    created_by_name: 'Inspector Kavish',
    created_by_buckle_id: 'BK-4782',
    owner_id: 7,
    owner_name: 'Inspector Kavish',
    owner_buckle_id: 'BK-4782',
    assignment_count: 2,
    assigned_officers: [{ userId: 7, fullName: 'Inspector Kavish', buckleId: 'BK-4782', role: 'owner' }],
    file_count: 4,
    failed_parse_files: 1,
    completed_files: 2,
    pending_files: 1,
    recent_activity_count: 5,
    last_activity_at: '2026-04-08T10:00:00.000Z',
  },
];

const fileRows = [
  {
    id: 51,
    case_id: 101,
    case_name: 'Operation Sunrise',
    case_number: 'OPS-101',
    case_status: 'active',
    case_priority: 'high',
    is_evidence_locked: true,
    file_name: 'stored-cdr.csv',
    original_name: 'cdr.csv',
    file_type: 'cdr',
    file_size: 2048,
    mime_type: 'text/csv',
    parse_status: 'failed',
    record_count: 0,
    uploaded_by: 7,
    uploaded_by_name: 'Inspector Kavish',
    uploaded_by_buckle_id: 'BK-4782',
    uploaded_at: '2026-04-08T08:00:00.000Z',
    expected_type: 'cdr',
    detected_type: 'cdr',
    confidence: 0.98,
    classification_result: 'ACCEPTED',
    error_message: 'Header mismatch',
    telecom_module: 'cdr',
  },
];

const deletionRows = [
  {
    audit_id: '901',
    created_at: '2026-04-08T09:00:00.000Z',
    actor_id: 7,
    actor_name: 'Inspector Kavish',
    actor_email: 'kavish@police.gov.in',
    actor_buckle_id: 'BK-4782',
    case_id: 101,
    case_name: 'Operation Sunrise',
    case_number: 'OPS-101',
    file_name: 'cdr.csv',
    stored_file_name: 'stored-cdr.csv',
    deleted_type: 'cdr',
    deleted_records: 120,
    file_id: '51',
    ip_address: '10.0.0.8',
    details: { caseId: 101, deletedRecords: 120 },
  },
];

const activityRows = [
  {
    source: 'audit',
    id: 'evt-20',
    created_at: '2026-04-08T10:00:00.000Z',
    actor_type: 'officer',
    actor_id: '7',
    actor_name: 'Inspector Kavish',
    actor_email: 'kavish@police.gov.in',
    actor_role: 'investigating_officer',
    action: 'FILE_DELETE',
    resource_type: 'file',
    resource_id: '51',
    session_id: 'sess-off-1',
    ip_address: '10.0.0.8',
    details: { caseId: 101 },
  },
];

const queryMock = vi.fn(async (sql) => {
  const text = String(sql);

  if (text.includes('FROM admin_case_scope') && text.includes('ORDER BY updated_at DESC')) {
    return { rows: caseRows, rowCount: caseRows.length };
  }

  if (text.includes('COUNT(*)::int AS total_cases')) {
    return {
      rows: [{ total_cases: 1, locked_cases: 1, high_priority_cases: 1, total_files: 4 }],
      rowCount: 1,
    };
  }

  if (text.includes('FROM admin_case_scope') && text.includes('WHERE id = $1::int')) {
    return { rows: caseRows, rowCount: 1 };
  }

  if (text.includes('FROM case_assignments ca') && text.includes('WHERE ca.case_id = $1::int')) {
    return {
      rows: [{ id: 1, role: 'owner', assigned_at: '2026-04-01T09:00:00.000Z', user_id: 7, full_name: 'Inspector Kavish', email: 'kavish@police.gov.in', buckle_id: 'BK-4782' }],
      rowCount: 1,
    };
  }

  if (text.includes('FROM admin_file_scope') && text.includes('WHERE case_id = $1::int')) {
    return { rows: fileRows, rowCount: fileRows.length };
  }

  if (text.includes('COUNT(*)::int AS total_events') && text.includes('FROM case_activity')) {
    return {
      rows: [{
        total_events: 3,
        first_event_at: '2026-04-07T08:30:00.000Z',
        last_event_at: '2026-04-08T10:00:00.000Z',
        admin_events: 1,
        high_risk_events: 1,
        top_actions: [
          { action: 'FILE_DELETE', count: 1 },
          { action: 'UPDATE_CASE', count: 1 },
        ],
      }],
      rowCount: 1,
    };
  }

  if (text.includes('FROM unified_activity') && text.includes("COALESCE(details->>'caseId', '') = $1")) {
    return { rows: activityRows, rowCount: activityRows.length };
  }

  if (text.includes('AS breakdown')) {
    return {
      rows: [{ breakdown: [{ module: 'cdr', totalFiles: 1, failedFiles: 1, records: 0 }] }],
      rowCount: 1,
    };
  }

  if (text.includes('FROM admin_file_scope') && text.includes('ORDER BY uploaded_at DESC')) {
    return { rows: fileRows, rowCount: fileRows.length };
  }

  if (text.includes('COUNT(*)::int AS total_files') && text.includes('locked_case_files')) {
    return {
      rows: [{ total_files: 1, failed_parse_files: 1, completed_files: 0, pending_files: 0, uploads_today: 1, locked_case_files: 1 }],
      rowCount: 1,
    };
  }

  if (text.includes('FROM admin_file_deletion_scope') && text.includes('ORDER BY created_at DESC')) {
    return { rows: deletionRows, rowCount: deletionRows.length };
  }

  if (text.includes('COUNT(*)::int AS total_deletions')) {
    return {
      rows: [{ total_deletions: 1, total_deleted_records: 120, impacted_cases: 1 }],
      rowCount: 1,
    };
  }

  if (text.includes('AS total_jobs') && text.includes('queued_jobs')) {
    return {
      rows: [{ total_jobs: 4, queued_jobs: 1, processing_jobs: 1, completed_jobs: 1, failed_jobs: 1 }],
      rowCount: 1,
    };
  }

  if (text.includes('GROUP BY expected_type')) {
    return {
      rows: [{ module: 'cdr', total_jobs: 2, problematic_jobs: 1, total_rows: 500 }],
      rowCount: 1,
    };
  }

  if (text.includes('failed_parse_files') && text.includes('uploads_today')) {
    return {
      rows: [{ total_files: 8, failed_parse_files: 2, uploads_today: 3 }],
      rowCount: 1,
    };
  }

  if (text.includes('chatbot_messages_24h')) {
    return { rows: [{ chatbot_messages_24h: 12 }], rowCount: 1 };
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
  getReadyHealth: () => ({ status: 'ready', timestamp: '2026-04-08T10:05:00.000Z', service: 'shakti-backend', checks: { database: { status: 'pass' } }, summary: { failed: [], degraded: [] } }),
  getStartupStatus: () => ({ status: 'ready', timestamp: '2026-04-08T10:05:00.000Z', service: 'shakti-backend', checks: {}, summary: { failed: [], degraded: [] } }),
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

const createAdminToken = () =>
  jwt.sign(
    {
      adminId: 101,
      email: 'it.admin@police.gov.in',
      fullName: 'IT Admin',
      role: 'it_admin',
      permissions: ['console_access'],
      accountType: 'it_admin',
    },
    process.env.JWT_ADMIN_SECRET,
    { audience: 'admin-console', expiresIn: '10m', subject: '101' }
  );

describe('admin governance endpoints', () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  it('returns case governance data with summary counts', async () => {
    const response = await request(app)
      .get('/api/admin/cases')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.items[0].case_name).toBe('Operation Sunrise');
    expect(response.body.summary.lockedCases).toBe(1);
  });

  it('exports the filtered case governance view as CSV', async () => {
    const response = await request(app)
      .get('/api/admin/cases/export')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('"Case ID","Case Name","Case Number"');
    expect(response.text).toContain('"101","Operation Sunrise","OPS-101"');
  });

  it('returns expanded case detail with assignments, files, and activity', async () => {
    const response = await request(app)
      .get('/api/admin/cases/101')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.case.id).toBe(101);
    expect(response.body.assignments).toHaveLength(1);
    expect(response.body.recentFiles).toHaveLength(1);
    expect(response.body.recentActivity).toHaveLength(1);
    expect(response.body.timelineSummary.totalEvents).toBe(3);
    expect(response.body.timelineSummary.highRiskEvents).toBe(1);
  });

  it('returns file governance rows with parser summary data', async () => {
    const response = await request(app)
      .get('/api/admin/files')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.items[0].telecom_module).toBe('cdr');
    expect(response.body.summary.failedParseFiles).toBe(1);
  });

  it('exports the file governance view as CSV', async () => {
    const response = await request(app)
      .get('/api/admin/files/export')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('"File ID","Original Name","Stored Name"');
    expect(response.text).toContain('"51","cdr.csv","stored-cdr.csv"');
  });

  it('returns file deletion traceability rows', async () => {
    const response = await request(app)
      .get('/api/admin/files/deletions')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.items[0].deleted_type).toBe('cdr');
    expect(response.body.summary.totalDeletedRecords).toBe(120);
  });

  it('exports file deletion traceability as CSV', async () => {
    const response = await request(app)
      .get('/api/admin/files/deletions/export')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('"Audit ID","Deleted At","Actor"');
    expect(response.text).toContain('"901","2026-04-08T09:00:00.000Z","Inspector Kavish"');
  });

  it('returns analysis metrics for ingestion and chatbot usage', async () => {
    const response = await request(app)
      .get('/api/admin/analysis')
      .set('Authorization', `Bearer ${createAdminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.metrics.total_jobs).toBe(4);
    expect(response.body.modules[0].module).toBe('cdr');
  });
});
