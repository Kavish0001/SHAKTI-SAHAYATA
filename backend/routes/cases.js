/* ── Cases Routes — Hardened (§14, §40) ── */
import { Router } from 'express';
import pool from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/authorize.js';
import { requireCaseAccess } from '../middleware/caseAccess.js';
import { checkEvidenceLock } from '../middleware/evidenceLock.js';
import {
  buildCaseKnowledgeContract,
  getCaseModuleSummary,
  searchCasesForChat
} from '../services/chatbot/caseContext.service.js';

const router = Router();

/* ── Generate auto case number (§14.2) ── */
function generateCaseNumber(caseName) {
  const prefix = caseName
    .split(' ')
    .map(w => w[0]?.toUpperCase())
    .filter(Boolean)
    .join('')
    .slice(0, 3);
  const year = new Date().getFullYear();
  const random = String(Math.floor(Math.random() * 9999)).padStart(4, '0');
  return `${prefix || 'CSE'}-${year}-${random}`;
}

const isBlank = (value) => String(value ?? '').trim() === '';

/* ── GET /api/cases — list officer's cases ── */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const pageSize = Math.min(parseInt(limit), 100);
    const offset = (parseInt(page) - 1) * pageSize;
    const userId = req.user.userId;
    const userRole = req.user.role;

    const params = [];
    const whereParts = [];
    const wherePartsForCases = [];
    const isAdmin = ['super_admin', 'station_admin'].includes(userRole);

    if (!isAdmin) {
      params.push(userId);
      whereParts.push(`(c.created_by_user_id = $${params.length} OR c.id IN (SELECT case_id FROM case_assignments WHERE user_id = $${params.length} AND is_active = TRUE))`);
      wherePartsForCases.push(`(created_by_user_id = $${params.length} OR id IN (SELECT case_id FROM case_assignments WHERE user_id = $${params.length} AND is_active = TRUE))`);
    }

    if (status) {
      params.push(status);
      whereParts.push(`c.status = $${params.length}`);
      wherePartsForCases.push(`status = $${params.length}`);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const countWhereClause = wherePartsForCases.length ? `WHERE ${wherePartsForCases.join(' AND ')}` : '';
    const limitIndex = params.length + 1;
    const offsetIndex = params.length + 2;
    const lifecyclePermissionSql = isAdmin
      ? `TRUE AS "canArchive", TRUE AS "canDelete"`
      : `
          (
            c.created_by_user_id = $1
            OR EXISTS (
              SELECT 1
              FROM case_assignments owner_assignment
              WHERE owner_assignment.case_id = c.id
                AND owner_assignment.user_id = $1
                AND owner_assignment.role = 'owner'
                AND owner_assignment.is_active = TRUE
            )
          ) AS "canArchive",
          (
            c.created_by_user_id = $1
            OR EXISTS (
              SELECT 1
              FROM case_assignments owner_assignment
              WHERE owner_assignment.case_id = c.id
                AND owner_assignment.user_id = $1
                AND owner_assignment.role = 'owner'
                AND owner_assignment.is_active = TRUE
            )
          ) AS "canDelete"
        `;

    const query = `
      SELECT c.*, u.full_name as created_by_name,
             (SELECT COUNT(*) FROM uploaded_files WHERE case_id = c.id) as file_count,
             ${lifecyclePermissionSql}
      FROM cases c
      LEFT JOIN users u ON c.created_by_user_id = u.id
      ${whereClause}
      ORDER BY c.updated_at DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `;
    const countQuery = `SELECT COUNT(*) FROM cases ${countWhereClause}`;
    const queryParams = [...params, pageSize, offset];

    const [cases, total] = await Promise.all([
      pool.query(query, queryParams),
      pool.query(countQuery, params)
    ]);

    res.json({
      data: cases.rows,
      pagination: { page: parseInt(page), pageSize, total: parseInt(total.rows[0].count) }
    });
  } catch (err) {
    console.error('List cases error:', err);
    res.status(500).json({ error: 'Failed to list cases' });
  }
});

/* ── GET /api/cases/stats — compatibility stats endpoint ── */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const isAdmin = ['super_admin', 'station_admin'].includes(req.user.role);
    const params = [];
    const scopeSql = isAdmin
      ? ''
      : `
          WHERE (
            c.created_by_user_id = $1
            OR EXISTS (
              SELECT 1
              FROM case_assignments ca
              WHERE ca.case_id = c.id
                AND ca.user_id = $1
                AND ca.is_active = TRUE
            )
          )
        `;

    if (!isAdmin) params.push(userId);

    const result = await pool.query(
      `
        SELECT
          COUNT(*)::int AS total_cases,
          COUNT(*) FILTER (WHERE c.status IN ('open', 'active'))::int AS active_cases,
          COUNT(*) FILTER (WHERE c.priority IN ('high', 'critical'))::int AS high_priority_cases
        FROM cases c
        ${scopeSql}
      `,
      params
    );

    res.json(result.rows[0] || {
      total_cases: 0,
      active_cases: 0,
      high_priority_cases: 0
    });
  } catch (err) {
    console.error('Case stats error:', err);
    res.status(500).json({ error: 'Failed to fetch case stats' });
  }
});

/* ── GET /api/cases/search — searchable active-case suggestions for chat ── */
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const q = String(req.query.q || req.query.query || '').trim();
    const limit = Math.max(1, Math.min(20, Number(req.query.limit || 8)));
    const data = await searchCasesForChat({ user: req.user, query: q, limit });
    res.json({ data, query: q, limit });
  } catch (err) {
    console.error('Case search error:', err);
    res.status(500).json({ error: 'Failed to search cases' });
  }
});

/* ── GET /api/cases/:id/knowledge — unified case knowledge contract for chat/UI ── */
router.get('/:id/knowledge', authenticateToken, requireCaseAccess('viewer'), async (req, res) => {
  try {
    const knowledge = await buildCaseKnowledgeContract(req.params.id, { user: req.user });
    if (!knowledge) {
      return res.status(404).json({ error: 'Case not found' });
    }
    res.json(knowledge);
  } catch (err) {
    console.error('Case knowledge error:', err);
    res.status(500).json({ error: 'Failed to build case knowledge' });
  }
});

/* ── GET /api/cases/:id/summary/:module — targeted deterministic case summaries ── */
router.get('/:id/summary/:module', authenticateToken, requireCaseAccess('viewer'), async (req, res) => {
  try {
    const module = String(req.params.module || '').trim().toLowerCase();
    const allowed = new Set(['overview', 'files', 'cdr', 'ipdr', 'sdr', 'tower', 'ild', 'timeline']);
    if (!allowed.has(module)) {
      return res.status(400).json({ error: 'Unsupported summary module' });
    }

    const summary = await getCaseModuleSummary(req.params.id, module, { user: req.user });
    if (!summary) {
      return res.status(404).json({ error: 'Case or summary not found' });
    }

    res.json({ module, summary });
  } catch (err) {
    console.error('Case summary error:', err);
    res.status(500).json({ error: 'Failed to build case summary' });
  }
});

/* ── GET /api/cases/:id — get case details ── */
router.get('/:id', authenticateToken, requireCaseAccess('viewer'), async (req, res) => {
  try {
    const isAdmin = ['super_admin', 'station_admin'].includes(req.user.role);
    const result = await pool.query(
      `SELECT c.*, u.full_name as created_by_name,
         (SELECT COUNT(*) FROM uploaded_files WHERE case_id = c.id) as file_count,
         (SELECT json_agg(json_build_object(
           'id', ca.id, 'userId', ca.user_id, 'role', ca.role,
           'userName', usr.full_name, 'buckleId', usr.buckle_id
         )) FROM case_assignments ca JOIN users usr ON ca.user_id = usr.id
         WHERE ca.case_id = c.id AND ca.is_active = TRUE) as assignments
       FROM cases c
       LEFT JOIN users u ON c.created_by_user_id = u.id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Case not found' });
    }

    const caseRow = result.rows[0];
    const assignments = Array.isArray(caseRow.assignments) ? caseRow.assignments : [];
    const hasOwnerAssignment = assignments.some(
      (assignment) =>
        Number(assignment?.userId) === Number(req.user.userId) &&
        String(assignment?.role || '').toLowerCase() === 'owner'
    );
    const canManageLifecycle = isAdmin
      || Number(caseRow.created_by_user_id) === Number(req.user.userId)
      || hasOwnerAssignment;

    res.json({
      ...caseRow,
      canArchive: canManageLifecycle,
      canDelete: canManageLifecycle,
    });
  } catch (err) {
    console.error('Get case error:', err);
    res.status(500).json({ error: 'Failed to get case' });
  }
});

/* ── GET /api/cases/:id/timeline — unified investigation timeline ── */
router.get('/:id/timeline', authenticateToken, requireCaseAccess('viewer'), async (req, res) => {
  try {
    const limit = Math.max(50, Math.min(1000, Number(req.query.limit || 300)));
    const caseId = Number(req.params.id);

    const result = await pool.query(
      `
        WITH timeline AS (
          SELECT
            'cdr'::text AS source,
            cdr.id::text AS source_id,
            cdr.date_time AS event_time,
            cdr.calling_number AS primary_value,
            cdr.called_number AS secondary_value,
            cdr.call_type AS event_type,
            cdr.imei_a AS device_id,
            cdr.first_cell_id AS location_ref,
            jsonb_build_object(
              'duration_sec', COALESCE(cdr.duration_sec, cdr.duration),
              'operator', cdr.operator,
              'file_id', cdr.file_id
            ) AS details
          FROM cdr_records cdr
          WHERE cdr.case_id = $1

          UNION ALL

          SELECT
            'ipdr'::text AS source,
            ipdr.id::text AS source_id,
            NULL::timestamp AS event_time,
            ipdr.msisdn AS primary_value,
            ipdr.source_ip AS secondary_value,
            COALESCE(ipdr.protocol, ipdr.domain_name, 'session') AS event_type,
            ipdr.imei AS device_id,
            ipdr.cell_id AS location_ref,
            jsonb_build_object(
              'destination_ip', ipdr.destination_ip,
              'start_time', ipdr.start_time,
              'operator', ipdr.operator,
              'file_id', ipdr.file_id
            ) AS details
          FROM ipdr_records ipdr
          WHERE ipdr.case_id = $1

          UNION ALL

          SELECT
            'ild'::text AS source,
            ild.id::text AS source_id,
            ild.date_time AS event_time,
            COALESCE(ild.calling_number, ild.calling_party) AS primary_value,
            COALESCE(ild.called_number, ild.called_party) AS secondary_value,
            COALESCE(ild.call_direction, ild.call_type, 'ild') AS event_type,
            ild.imei AS device_id,
            ild.cell_id AS location_ref,
            jsonb_build_object(
              'country_code', ild.country_code,
              'destination_country', ild.destination_country,
              'operator', ild.operator,
              'file_id', ild.file_id
            ) AS details
          FROM ild_records ild
          WHERE ild.case_id = $1

          UNION ALL

          SELECT
            'sdr'::text AS source,
            sdr.id::text AS source_id,
            NULL::timestamp AS event_time,
            sdr.msisdn AS primary_value,
            sdr.subscriber_name AS secondary_value,
            'subscriber_profile'::text AS event_type,
            sdr.imei AS device_id,
            NULL::text AS location_ref,
            jsonb_build_object(
              'id_proof_number', sdr.id_proof_number,
              'operator', sdr.operator,
              'file_id', sdr.file_id
            ) AS details
          FROM sdr_records sdr
          WHERE sdr.case_id = $1

          UNION ALL

          SELECT
            'tower'::text AS source,
            tower.id::text AS source_id,
            tower.start_time AS event_time,
            tower.a_party AS primary_value,
            tower.b_party AS secondary_value,
            COALESCE(tower.call_type, 'tower_activity') AS event_type,
            tower.imei AS device_id,
            COALESCE(tower.cell_id, tower.first_cell_id) AS location_ref,
            jsonb_build_object(
              'imsi', tower.imsi,
              'operator', tower.operator,
              'file_id', tower.file_id
            ) AS details
          FROM tower_dump_records tower
          WHERE tower.case_id = $1
        )
        SELECT *
        FROM timeline
        ORDER BY event_time DESC NULLS LAST, source ASC, source_id DESC
        LIMIT $2
      `,
      [caseId, limit]
    );

    res.json({ events: result.rows, limit });
  } catch (err) {
    console.error('Case timeline error:', err);
    res.status(500).json({ error: 'Failed to fetch case timeline' });
  }
});

/* ── POST /api/cases — create new case ── */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      caseName,
      caseNumber,
      operator,
      investigationDetails,
      startDate,
      endDate,
      priority,
      caseType,
      firNumber
    } = req.body;

    if (isBlank(caseName)) return res.status(400).json({ error: 'Case name is required.' });
    if (isBlank(caseNumber)) return res.status(400).json({ error: 'Case number is required.' });
    if (isBlank(operator)) return res.status(400).json({ error: 'Telecom operator is required.' });
    if (isBlank(caseType)) return res.status(400).json({ error: 'Case type is required.' });
    if (isBlank(priority)) return res.status(400).json({ error: 'Priority is required.' });
    if (isBlank(firNumber)) return res.status(400).json({ error: 'FIR number is required.' });
    if (isBlank(investigationDetails)) return res.status(400).json({ error: 'Investigation details are required.' });
    if (isBlank(startDate)) return res.status(400).json({ error: 'Start date is required.' });
    if (isBlank(endDate)) return res.status(400).json({ error: 'End date is required.' });

    const parsedStartDate = new Date(startDate);
    const parsedEndDate = new Date(endDate);
    if (Number.isNaN(parsedStartDate.getTime()) || Number.isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({ error: 'Valid start and end dates are required.' });
    }
    if (parsedEndDate < parsedStartDate) {
      return res.status(400).json({ error: 'End date cannot be earlier than start date.' });
    }

    const userId = req.user.userId;

    const result = await pool.query(
      `INSERT INTO cases (case_name, case_number, case_type, fir_number, operator,
         investigation_details, start_date, end_date, priority, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [String(caseName).trim(), String(caseNumber).trim(), String(caseType).trim(), String(firNumber).trim(), String(operator).trim(),
       String(investigationDetails).trim(), startDate, endDate, String(priority).trim(), userId]
    );

    const newCase = result.rows[0];

    // Auto-assign creator as owner
    await pool.query(
      `INSERT INTO case_assignments (case_id, user_id, role, assigned_by) VALUES ($1, $2, 'owner', $2)`,
      [newCase.id, userId]
    );

    // Audit log
    await pool.query(
      'INSERT INTO audit_logs (user_id, officer_buckle_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)',
      [userId, req.user.buckleId, 'CREATE_CASE', 'case', String(newCase.id)]
    );

    res.status(201).json(newCase);
  } catch (err) {
    console.error('Create case error:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Case number conflict, try again' });
    res.status(500).json({ error: 'Failed to create case' });
  }
});

/* ── PUT /api/cases/:id — update case ── */
router.put('/:id', authenticateToken, requireCaseAccess('investigator'), checkEvidenceLock, async (req, res) => {
  try {
    const { caseName, operator, investigationDetails, startDate, endDate, priority, status } = req.body;
    const userId = req.user.userId;

    const result = await pool.query(
      `UPDATE cases SET
        case_name = COALESCE($1, case_name),
        operator = COALESCE($2, operator),
        investigation_details = COALESCE($3, investigation_details),
        start_date = COALESCE($4, start_date),
        end_date = COALESCE($5, end_date),
        priority = COALESCE($6, priority),
        status = COALESCE($7, status),
        updated_by_user_id = $8,
        updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [caseName, operator, investigationDetails, startDate, endDate, priority, status, userId, req.params.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Case not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update case error:', err);
    res.status(500).json({ error: 'Failed to update case' });
  }
});

/* ── POST /api/cases/:id/archive ── */
router.post('/:id/archive', authenticateToken, requireCaseAccess('owner'), checkEvidenceLock, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE cases
       SET status = 'archived',
           updated_by_user_id = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.user.userId, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Case not found' });
    }

    await pool.query(
      'INSERT INTO audit_logs (user_id, officer_buckle_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)',
      [req.user.userId, req.user.buckleId, 'ARCHIVE_CASE', 'case', req.params.id]
    );

    res.json({ message: 'Case archived', case: result.rows[0] });
  } catch (err) {
    console.error('Archive case error:', err);
    res.status(500).json({ error: 'Failed to archive case' });
  }
});

/* ── POST /api/cases/:id/reopen ── */
router.post('/:id/reopen', authenticateToken, requireCaseAccess('owner'), checkEvidenceLock, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE cases
       SET status = 'open',
           updated_by_user_id = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.user.userId, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Case not found' });
    }

    await pool.query(
      'INSERT INTO audit_logs (user_id, officer_buckle_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)',
      [req.user.userId, req.user.buckleId, 'REOPEN_CASE', 'case', req.params.id]
    );

    res.json({ message: 'Case reopened', case: result.rows[0] });
  } catch (err) {
    console.error('Reopen case error:', err);
    res.status(500).json({ error: 'Failed to reopen case' });
  }
});

/* ── DELETE /api/cases/:id ── */
router.delete('/:id', authenticateToken, requireCaseAccess('owner'), checkEvidenceLock, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM cases WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Case not found' });

    await pool.query(
      'INSERT INTO audit_logs (user_id, officer_buckle_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)',
      [req.user.userId, req.user.buckleId, 'DELETE_CASE', 'case', req.params.id]
    );
    res.json({ message: 'Case deleted' });
  } catch (err) {
    console.error('Delete case error:', err);
    res.status(500).json({ error: 'Failed to delete case' });
  }
});

/* ── POST /api/cases/:id/lock — evidence lock ── */
router.post('/:id/lock', authenticateToken, requireRole('super_admin', 'station_admin'), async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await pool.query(
      `UPDATE cases SET is_evidence_locked = TRUE, locked_at = NOW(), locked_by = $1, lock_reason = $2
       WHERE id = $3 RETURNING *`,
      [req.user.userId, reason || 'Legal proceedings', req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Case not found' });
    res.json({ message: 'Case evidence-locked', case: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to lock case' });
  }
});

/* ── POST /api/cases/:id/unlock — remove evidence lock ── */
router.post('/:id/unlock', authenticateToken, requireRole('super_admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE cases SET is_evidence_locked = FALSE, locked_at = NULL, locked_by = NULL, lock_reason = NULL
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Case not found' });
    res.json({ message: 'Case unlocked', case: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unlock case' });
  }
});

/* ── POST /api/cases/:id/assignments — assign officer ── */
router.post('/:id/assignments', authenticateToken, requireCaseAccess('owner'), async (req, res) => {
  try {
    const { userId: targetUserId, role } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'userId is required' });

    const result = await pool.query(
      `INSERT INTO case_assignments (case_id, user_id, role, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (case_id, user_id) DO UPDATE SET role = $3, is_active = TRUE, revoked_at = NULL
       RETURNING *`,
      [req.params.id, targetUserId, role || 'investigator', req.user.userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Assign officer error:', err);
    res.status(500).json({ error: 'Failed to assign officer' });
  }
});

/* ── GET /api/cases/:id/assignments — list assignments ── */
router.get('/:id/assignments', authenticateToken, requireCaseAccess('viewer'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ca.*, u.full_name, u.buckle_id, u.email
       FROM case_assignments ca
       JOIN users u ON ca.user_id = u.id
       WHERE ca.case_id = $1 AND ca.is_active = TRUE`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list assignments' });
  }
});

export default router;
