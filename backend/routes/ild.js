/* ── ILD Routes (migrated + auth) ── */
import { Router } from 'express';
import pool from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { combineDateAndTime, normalizeDateString, normalizeTimeString } from '../utils/timestamps.js';
import { emitAdminConsoleEvent } from '../services/admin/adminEventStream.service.js';
import { invalidateCaseMemorySnapshots } from '../services/chatbot/caseMemorySnapshot.service.js';
import { queueCaseKnowledgeRefresh } from '../services/chatbot/caseKnowledge.service.js';
import { asText, buildPaginationPayload, parsePaginationParams, toInt } from '../utils/analysisRouteUtils.js';

const router = Router();
const normalizeRawData = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const updateUploadedFileProgress = async (fileId, inserted) => {
  const parsedFileId = toInt(fileId);
  if (!parsedFileId || !Number.isFinite(inserted) || inserted <= 0) return;

  await pool.query(
    `UPDATE uploaded_files
     SET parse_status = 'completed',
         record_count = COALESCE(record_count, 0) + $2
     WHERE id = $1`,
    [parsedFileId, inserted]
  );
};
const emitIngestionCompletionEvents = (payload = {}) => {
  emitAdminConsoleEvent('dashboard.summary.changed', payload);
  emitAdminConsoleEvent('ingestion.queue.changed', payload);
  emitAdminConsoleEvent('normalization.queue.changed', payload);
  emitAdminConsoleEvent('storage.changed', payload);
};
const buildIldResponseRow = (row) => {
  const raw = normalizeRawData(row.raw_data);
  return {
    ...raw,
    ...row,
    calling_party_number: row.calling_party || row.calling_number || raw.calling_party_number || null,
    called_party_number: row.called_party || row.called_number || raw.called_party_number || null,
    call_duration_sec: row.duration_sec ?? row.duration ?? raw.call_duration_sec ?? null,
    first_cell_id: row.cell_id || raw.first_cell_id || null,
    last_cell_id: raw.last_cell_id || null,
    circle: row.roaming_circle || raw.circle || null,
    carrier: raw.carrier || null,
    operator_name: raw.operator_name || null,
    orig_carr_name: raw.orig_carr_name || null,
    term_carr_name: raw.term_carr_name || null,
  };
};

const buildIldWhereClause = (query = {}) => {
  const caseId = toInt(query.caseId);
  const search = asText(query.search || query.q);
  const callType = asText(query.callType);
  const direction = asText(query.direction);
  const dateFrom = asText(query.dateFrom);
  const dateTo = asText(query.dateTo);
  const durationMin = toInt(query.durationMin);
  const durationMax = toInt(query.durationMax);
  const params = [];
  const clauses = [];

  if (!caseId) {
    return { error: 'caseId is required' };
  }

  params.push(caseId);
  clauses.push(`case_id = $${params.length}`);

  if (search) {
    params.push(`%${search}%`);
    const searchIndex = params.length;
    clauses.push(`(
      COALESCE(calling_party, '') ILIKE $${searchIndex}
      OR COALESCE(called_party, '') ILIKE $${searchIndex}
      OR COALESCE(destination_country, '') ILIKE $${searchIndex}
      OR COALESCE(operator, '') ILIKE $${searchIndex}
      OR COALESCE(cell_id, '') ILIKE $${searchIndex}
    )`);
  }

  if (callType) {
    params.push(callType);
    clauses.push(`LOWER(COALESCE(call_type, '')) LIKE LOWER($${params.length})`);
    params[params.length - 1] = `%${callType}%`;
  }

  if (direction) {
    params.push(`%${direction}%`);
    clauses.push(`(
      LOWER(COALESCE(call_direction, '')) LIKE LOWER($${params.length})
      OR LOWER(COALESCE(call_type, '')) LIKE LOWER($${params.length})
    )`);
  }

  if (dateFrom) {
    params.push(dateFrom);
    clauses.push(`call_date >= $${params.length}`);
  }

  if (dateTo) {
    params.push(dateTo);
    clauses.push(`call_date <= $${params.length}`);
  }

  if (durationMin !== null) {
    params.push(durationMin);
    clauses.push(`COALESCE(duration_sec, 0) >= $${params.length}`);
  }

  if (durationMax !== null) {
    params.push(durationMax);
    clauses.push(`COALESCE(duration_sec, 0) <= $${params.length}`);
  }

  return {
    caseId,
    params,
    whereClause: clauses.join(' AND '),
  };
};

const loadIldSummary = async (caseId) => {
  const [totalsResult, directionResult, countryResult, topContactsResult, dailyResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total_records,
         COUNT(DISTINCT calling_party)::int AS unique_calling_numbers,
         COUNT(DISTINCT called_party)::int AS unique_called_numbers,
         COALESCE(SUM(duration_sec), 0)::bigint AS total_duration_sec
       FROM ild_records
       WHERE case_id = $1`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(call_direction, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM ild_records
       WHERE case_id = $1
       GROUP BY COALESCE(call_direction, 'UNKNOWN')
       ORDER BY value DESC, label ASC`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(destination_country, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM ild_records
       WHERE case_id = $1
       GROUP BY COALESCE(destination_country, 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(called_party, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM ild_records
       WHERE case_id = $1 AND COALESCE(called_party, '') <> ''
       GROUP BY COALESCE(called_party, 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(call_date, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM ild_records
       WHERE case_id = $1
       GROUP BY COALESCE(call_date, 'UNKNOWN')
       ORDER BY label ASC
       LIMIT 14`,
      [caseId]
    ),
  ]);

  const totals = totalsResult.rows[0] || {};
  return {
    totalRecords: Number(totals.total_records || 0),
    uniqueCallingNumbers: Number(totals.unique_calling_numbers || 0),
    uniqueCalledNumbers: Number(totals.unique_called_numbers || 0),
    totalDurationSec: Number(totals.total_duration_sec || 0),
    directionBreakdown: directionResult.rows,
    topCountries: countryResult.rows,
    topContacts: topContactsResult.rows,
    dailyActivity: dailyResult.rows,
  };
};

router.get('/summary', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });

  try {
    const summary = await loadIldSummary(caseId);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/filters', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });

  try {
    const [callTypesResult, directionsResult] = await Promise.all([
      pool.query(
        `SELECT DISTINCT COALESCE(call_type, 'UNKNOWN') AS value
         FROM ild_records
         WHERE case_id = $1
         ORDER BY value ASC`,
        [caseId]
      ),
      pool.query(
        `SELECT DISTINCT COALESCE(call_direction, 'UNKNOWN') AS value
         FROM ild_records
         WHERE case_id = $1
         ORDER BY value ASC`,
        [caseId]
      ),
    ]);

    res.json({
      callTypes: callTypesResult.rows
        .map((row) => row.value)
        .filter((value) => typeof value === 'string' && value.trim() !== ''),
      directions: directionsResult.rows
        .map((row) => row.value)
        .filter((value) => typeof value === 'string' && value.trim() !== ''),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* GET /api/ild/records?caseId=... */
router.get('/records', authenticateToken, async (req, res) => {
  const scope = buildIldWhereClause(req.query);
  if (scope.error) return res.status(400).json({ error: scope.error });
  const pagination = parsePaginationParams(req.query);
  try {
    if (!pagination.paginated) {
      const result = await pool.query(
        `SELECT * FROM ild_records
         WHERE ${scope.whereClause}
         ORDER BY created_at DESC, id DESC`,
        scope.params
      );
      return res.json(result.rows.map(buildIldResponseRow));
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ild_records WHERE ${scope.whereClause}`,
      scope.params
    );
    const rowsResult = await pool.query(
      `SELECT * FROM ild_records
       WHERE ${scope.whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${scope.params.length + 1}
       OFFSET $${scope.params.length + 2}`,
      [...scope.params, pagination.pageSize, pagination.offset]
    );

    res.json({
      data: rowsResult.rows.map(buildIldResponseRow),
      pagination: buildPaginationPayload({
        page: pagination.page,
        pageSize: pagination.pageSize,
        total: countResult.rows[0]?.total || 0,
      }),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* GET /api/ild/records/count?caseId=... */
router.get('/records/count', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });
  try {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ild_records WHERE case_id = $1', [caseId]);
    res.json({ count: result.rows[0]?.count || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* POST /api/ild/records — batch insert */
router.post('/records', authenticateToken, async (req, res) => {
  const { caseId, records, fileId } = req.body || {};
  const parsedCaseId = toInt(caseId);
  if (!parsedCaseId) return res.status(400).json({ error: 'caseId is required' });
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records array is required' });
  }

  const batchSize = 500;
  let inserted = 0;
  try {
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const values = [];
      const placeholders = batch.map((r, idx) => {
        const rawData = r.raw_data && typeof r.raw_data === 'object' ? r.raw_data : r;
        const normalizedCallDate = normalizeDateString(r.call_date);
        const normalizedCallTime = normalizeTimeString(r.call_time) || r.call_time || null;
        const normalizedDateTime = combineDateAndTime(r.call_date, r.call_time);
        values.push(
          parsedCaseId, r.file_id || fileId || null,
          r.calling_party || r.calling_number || r.calling_party_number || null,
          r.called_party || r.called_number || r.called_party_number || null,
          normalizedCallDate, normalizedCallTime, normalizedDateTime,
          r.call_type || null, r.call_direction || null,
          (r.duration_sec || r.call_duration_sec) ? parseInt(String(r.duration_sec || r.call_duration_sec), 10) || 0 : 0,
          r.international_num || r.called_party_number || null, r.country_code || null,
          r.destination_country || null,
          r.imei || null, r.cell_id || r.first_cell_id || null,
          r.operator || r.carrier || r.operator_name || null, r.roaming_circle || r.circle || null,
          JSON.stringify(rawData || {})
        );
        const offset = idx * 18;
        return `(${Array.from({ length: 18 }, (_, j) => `$${offset + j + 1}`).join(', ')})`;
      }).join(', ');

      await pool.query(
        `INSERT INTO ild_records (
           case_id, file_id, calling_party, called_party,
           call_date, call_time, date_time, call_type, call_direction,
           duration_sec, international_num, country_code,
           destination_country, imei, cell_id,
           operator, roaming_circle, raw_data
         ) VALUES ${placeholders}`,
        values
      );
      inserted += batch.length;
    }
    await updateUploadedFileProgress(fileId, inserted);
    await invalidateCaseMemorySnapshots({ caseId: parsedCaseId, module: 'ild' });
    void queueCaseKnowledgeRefresh({ caseId: parsedCaseId, modules: ['ild'], reason: 'ild_records_inserted' });
    emitIngestionCompletionEvents({ caseId: parsedCaseId, fileId: toInt(fileId), inserted, module: 'ild' });
    res.json({ inserted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
