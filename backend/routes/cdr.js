/* ── CDR Routes (migrated from old project + auth) ── */
import { Router } from 'express';
import pool from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { combineDateAndTime, normalizeDateString, normalizeTimeString } from '../utils/timestamps.js';
import { emitAdminConsoleEvent } from '../services/admin/adminEventStream.service.js';
import { invalidateCaseMemorySnapshots } from '../services/chatbot/caseMemorySnapshot.service.js';
import { queueCaseKnowledgeRefresh } from '../services/chatbot/caseKnowledge.service.js';
import { asText, buildPaginationPayload, parseCsvIntList, parsePaginationParams, toInt } from '../utils/analysisRouteUtils.js';

const router = Router();

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

const normalizeRawData = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const buildCdrResponseRow = (row) => {
  const raw = normalizeRawData(row.raw_data);
  return {
    ...raw,
    ...row,
    a_party: row.calling_number || raw.a_party || '',
    b_party: row.called_number || raw.b_party || '',
    call_start_time: row.call_time || raw.call_start_time || raw.call_time || null,
    duration_sec: row.duration_sec ?? row.duration ?? raw.duration_sec ?? 0,
    imei: row.imei_a || raw.imei || raw.imei_a || null,
    imsi: raw.imsi || null,
    first_cell_id: row.first_cell_id || raw.first_cell_id || raw.cell_id_a || null,
    last_cell_id: row.last_cell_id || raw.last_cell_id || raw.cell_id_b || null,
    first_cell_desc: raw.first_cell_desc || raw.first_cell_address || null,
    last_cell_desc: raw.last_cell_desc || raw.last_cell_address || null,
    first_cell_lat: row.lat ?? raw.first_cell_lat ?? null,
    first_cell_long: row.long ?? raw.first_cell_long ?? null,
    last_cell_lat: raw.last_cell_lat ?? row.lat ?? null,
    last_cell_long: raw.last_cell_long ?? row.long ?? null,
    roaming_circle: row.roaming || raw.roaming_circle || null,
    service_type: raw.service_type || null,
    smsc_number: raw.smsc_number || null,
    operator: row.operator || raw.operator || null,
  };
};

const buildCdrWhereClause = (query = {}) => {
  const caseId = toInt(query.caseId);
  const search = asText(query.search || query.q);
  const callType = asText(query.callType);
  const dateFrom = asText(query.dateFrom);
  const dateTo = asText(query.dateTo);
  const durationMin = toInt(query.durationMin);
  const durationMax = toInt(query.durationMax);
  const fileIds = parseCsvIntList(query.fileIds);
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
      COALESCE(calling_number, '') ILIKE $${searchIndex}
      OR COALESCE(called_number, '') ILIKE $${searchIndex}
      OR COALESCE(call_type, '') ILIKE $${searchIndex}
      OR COALESCE(imei_a, '') ILIKE $${searchIndex}
      OR COALESCE(imei_b, '') ILIKE $${searchIndex}
      OR COALESCE(first_cell_id, '') ILIKE $${searchIndex}
      OR COALESCE(last_cell_id, '') ILIKE $${searchIndex}
    )`);
  }

  if (callType) {
    params.push(callType);
    clauses.push(`LOWER(COALESCE(call_type, '')) = LOWER($${params.length})`);
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

  if (fileIds.length > 0) {
    params.push(fileIds);
    clauses.push(`file_id = ANY($${params.length}::int[])`);
  }

  return {
    caseId,
    params,
    whereClause: clauses.join(' AND '),
  };
};

const loadCdrSummary = async (caseId) => {
  const [totalsResult, callTypeResult, topContactsResult, hourlyResult, topCellsResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total_records,
         COUNT(DISTINCT calling_number)::int AS unique_a_parties,
         COUNT(DISTINCT called_number)::int AS unique_b_parties,
         COALESCE(SUM(duration_sec), 0)::bigint AS total_duration_sec
       FROM cdr_records
       WHERE case_id = $1`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(call_type, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM cdr_records
       WHERE case_id = $1
       GROUP BY COALESCE(call_type, 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(called_number, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM cdr_records
       WHERE case_id = $1 AND COALESCE(called_number, '') <> ''
       GROUP BY COALESCE(called_number, 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
    pool.query(
      `SELECT
         LPAD(COALESCE(EXTRACT(HOUR FROM date_time)::int, 0)::text, 2, '0') AS label,
         COUNT(*)::int AS value
       FROM cdr_records
       WHERE case_id = $1
       GROUP BY LPAD(COALESCE(EXTRACT(HOUR FROM date_time)::int, 0)::text, 2, '0')
       ORDER BY label ASC`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(first_cell_id, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM cdr_records
       WHERE case_id = $1 AND COALESCE(first_cell_id, '') <> ''
       GROUP BY COALESCE(first_cell_id, 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
  ]);

  const totals = totalsResult.rows[0] || {};
  return {
    totalRecords: Number(totals.total_records || 0),
    uniqueAParties: Number(totals.unique_a_parties || 0),
    uniqueBParties: Number(totals.unique_b_parties || 0),
    totalDurationSec: Number(totals.total_duration_sec || 0),
    callTypes: callTypeResult.rows,
    topContacts: topContactsResult.rows,
    hourlyActivity: hourlyResult.rows,
    topCells: topCellsResult.rows,
  };
};

router.get('/summary', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });

  try {
    const summary = await loadCdrSummary(caseId);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/filters', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });

  try {
    const [callTypesResult] = await Promise.all([
      pool.query(
        `SELECT DISTINCT COALESCE(call_type, 'UNKNOWN') AS value
         FROM cdr_records
         WHERE case_id = $1
         ORDER BY value ASC`,
        [caseId]
      ),
    ]);

    res.json({
      callTypes: callTypesResult.rows
        .map((row) => row.value)
        .filter((value) => typeof value === 'string' && value.trim() !== ''),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* GET /api/cdr/records?caseId=...
   Returns columns aliased for backward compat with frontend analysis components */
router.get('/records', authenticateToken, async (req, res) => {
  const scope = buildCdrWhereClause(req.query);
  if (scope.error) return res.status(400).json({ error: scope.error });

  const pagination = parsePaginationParams(req.query);
  try {
    if (!pagination.paginated) {
      const result = await pool.query(
        `SELECT *, calling_number AS a_party, called_number AS b_party
         FROM cdr_records
         WHERE ${scope.whereClause}
         ORDER BY created_at DESC, id DESC`,
        scope.params
      );
      return res.json(result.rows.map(buildCdrResponseRow));
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM cdr_records WHERE ${scope.whereClause}`,
      scope.params
    );
    const rowsResult = await pool.query(
      `SELECT *, calling_number AS a_party, called_number AS b_party
       FROM cdr_records
       WHERE ${scope.whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${scope.params.length + 1}
       OFFSET $${scope.params.length + 2}`,
      [...scope.params, pagination.pageSize, pagination.offset]
    );

    res.json({
      data: rowsResult.rows.map(buildCdrResponseRow),
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

/* GET /api/cdr/records/count?caseId=... */
router.get('/records/count', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });
  try {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM cdr_records WHERE case_id = $1', [caseId]);
    res.json({ count: result.rows[0]?.count || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* GET /api/cdr/records/unique-a?caseId=... */
router.get('/records/unique-a', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });
  try {
    const result = await pool.query(
      `SELECT DISTINCT calling_number AS a_party FROM cdr_records
       WHERE case_id = $1 AND calling_number IS NOT NULL AND calling_number <> ''
       ORDER BY calling_number`,
      [caseId]
    );
    res.json(result.rows.map(r => r.a_party));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* POST /api/cdr/records — batch insert
   Accepts both old format (a_party/b_party) and new format (calling_number/called_number) */
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
      const placeholders = batch.map((record, index) => {
        const durationSec = record.duration_sec || record.duration ? parseInt(String(record.duration_sec || record.duration), 10) || 0 : 0;
        const recordFileId = record.file_id || fileId || null;
        const rawData = record.raw_data && typeof record.raw_data === 'object' ? record.raw_data : record;
        const normalizedCallDate = normalizeDateString(record.call_date);
        const normalizedCallTime = normalizeTimeString(record.call_time || record.call_start_time || record.toc) || record.call_time || record.call_start_time || record.toc || null;
        const normalizedDateTime = combineDateAndTime(record.call_date, record.call_time || record.call_start_time || record.toc);
        const latitude = record.lat != null ? parseFloat(record.lat) : (record.first_cell_lat != null ? parseFloat(record.first_cell_lat) : null);
        const longitude = record.long != null ? parseFloat(record.long) : (record.first_cell_long != null ? parseFloat(record.first_cell_long) : null);
        values.push(
          parsedCaseId, recordFileId,
          record.calling_number || record.a_party || '',
          record.called_number || record.b_party || null,
          record.call_type || null, normalizedCallTime,
          normalizedCallDate, normalizedDateTime, durationSec,
          record.first_cell_id || null, record.last_cell_id || null,
          record.imei_a || record.imei || null,
          record.imei_b || null,
          record.cell_id_a || null, record.cell_id_b || null,
          record.roaming || null,
          record.operator || 'UNKNOWN',
          latitude,
          longitude,
          JSON.stringify(rawData || {})
        );
        const offset = index * 20;
        return `(${Array.from({ length: 20 }, (_, j) => `$${offset + j + 1}`).join(', ')})`;
      }).join(', ');

      await pool.query(
        `INSERT INTO cdr_records (
           case_id, file_id, calling_number, called_number,
           call_type, call_time, call_date, date_time, duration_sec,
           first_cell_id, last_cell_id, imei_a, imei_b,
           cell_id_a, cell_id_b, roaming, operator, lat, long, raw_data
         ) VALUES ${placeholders}`,
        values
      );
      inserted += batch.length;
    }
    await updateUploadedFileProgress(fileId, inserted);
    await invalidateCaseMemorySnapshots({ caseId: parsedCaseId, module: 'cdr' });
    void queueCaseKnowledgeRefresh({ caseId: parsedCaseId, modules: ['cdr'], reason: 'cdr_records_inserted' });
    emitIngestionCompletionEvents({ caseId: parsedCaseId, fileId: toInt(fileId), inserted, module: 'cdr' });
    res.json({ inserted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
