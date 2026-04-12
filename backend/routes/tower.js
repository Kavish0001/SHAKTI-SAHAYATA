/* ── Tower Dump Routes (migrated + auth) ── */
import { Router } from 'express';
import pool from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { combineDateAndTime, normalizeDateString, normalizeTimeString, parseLooseTimestamp } from '../utils/timestamps.js';
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
const buildTowerResponseRow = (row) => {
  const raw = normalizeRawData(row.raw_data);
  return {
    ...raw,
    ...row,
    call_start_time: row.start_time || row.call_time || raw.call_start_time || null,
    first_cell_desc: row.site_address || row.site_name || raw.first_cell_desc || raw.site_address || null,
    last_cell_desc: raw.last_cell_desc || null,
    first_cell_lat: row.lat ?? raw.first_cell_lat ?? null,
    first_cell_long: row.long ?? raw.first_cell_long ?? null,
    last_cell_lat: raw.last_cell_lat ?? row.lat ?? null,
    last_cell_long: raw.last_cell_long ?? row.long ?? null,
    roaming_circle: raw.roaming_circle || null,
    source_file: raw.source_file || null,
  };
};

const buildTowerWhereClause = (query = {}) => {
  const caseId = toInt(query.caseId);
  const search = asText(query.search || query.q);
  const callType = asText(query.callType);
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
      COALESCE(a_party, '') ILIKE $${searchIndex}
      OR COALESCE(b_party, '') ILIKE $${searchIndex}
      OR COALESCE(first_cell_id, '') ILIKE $${searchIndex}
      OR COALESCE(last_cell_id, '') ILIKE $${searchIndex}
      OR COALESCE(imei, '') ILIKE $${searchIndex}
      OR COALESCE(imsi, '') ILIKE $${searchIndex}
      OR COALESCE(call_type, '') ILIKE $${searchIndex}
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

  return {
    caseId,
    params,
    whereClause: clauses.join(' AND '),
  };
};

const loadTowerSummary = async (caseId) => {
  const [totalsResult, callTypeResult, topCellsResult, topPartiesResult, hourlyResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total_records,
         COUNT(DISTINCT a_party)::int AS unique_a_parties,
         COUNT(DISTINCT b_party)::int AS unique_b_parties,
         COALESCE(AVG(COALESCE(duration_sec, 0)), 0)::float AS avg_duration_sec
       FROM tower_dump_records
       WHERE case_id = $1`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(call_type, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM tower_dump_records
       WHERE case_id = $1
       GROUP BY COALESCE(call_type, 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(first_cell_id, cell_id, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM tower_dump_records
       WHERE case_id = $1
       GROUP BY COALESCE(first_cell_id, cell_id, 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(a_party, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM tower_dump_records
       WHERE case_id = $1 AND COALESCE(a_party, '') <> ''
       GROUP BY COALESCE(a_party, 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
    pool.query(
      `SELECT
         LPAD(COALESCE(EXTRACT(HOUR FROM start_time)::int, 0)::text, 2, '0') AS label,
         COUNT(*)::int AS value
       FROM tower_dump_records
       WHERE case_id = $1
       GROUP BY LPAD(COALESCE(EXTRACT(HOUR FROM start_time)::int, 0)::text, 2, '0')
       ORDER BY label ASC`,
      [caseId]
    ),
  ]);

  const totals = totalsResult.rows[0] || {};
  return {
    totalRecords: Number(totals.total_records || 0),
    uniqueAParties: Number(totals.unique_a_parties || 0),
    uniqueBParties: Number(totals.unique_b_parties || 0),
    avgDurationSec: Number(totals.avg_duration_sec || 0),
    callTypes: callTypeResult.rows,
    topCells: topCellsResult.rows,
    topParties: topPartiesResult.rows,
    hourlyActivity: hourlyResult.rows,
  };
};

router.get('/summary', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });

  try {
    const summary = await loadTowerSummary(caseId);
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
         FROM tower_dump_records
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

/* GET /api/tower/records?caseId=... */
router.get('/records', authenticateToken, async (req, res) => {
  const scope = buildTowerWhereClause(req.query);
  if (scope.error) return res.status(400).json({ error: scope.error });
  const pagination = parsePaginationParams(req.query);
  try {
    if (!pagination.paginated) {
      const result = await pool.query(
        `SELECT * FROM tower_dump_records
         WHERE ${scope.whereClause}
         ORDER BY created_at DESC, id DESC`,
        scope.params
      );
      return res.json(result.rows.map(buildTowerResponseRow));
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM tower_dump_records WHERE ${scope.whereClause}`,
      scope.params
    );
    const rowsResult = await pool.query(
      `SELECT * FROM tower_dump_records
       WHERE ${scope.whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${scope.params.length + 1}
       OFFSET $${scope.params.length + 2}`,
      [...scope.params, pagination.pageSize, pagination.offset]
    );

    res.json({
      data: rowsResult.rows.map(buildTowerResponseRow),
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

/* GET /api/tower/records/count?caseId=... */
router.get('/records/count', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });
  try {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM tower_dump_records WHERE case_id = $1', [caseId]);
    res.json({ count: result.rows[0]?.count || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* POST /api/tower/records — batch insert */
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
        const normalizedCallTime = normalizeTimeString(r.call_time || r.call_start_time) || r.call_time || r.call_start_time || null;
        const normalizedStartTime =
          parseLooseTimestamp(r.start_time)
          || combineDateAndTime(r.call_date, r.call_time || r.call_start_time);
        values.push(
          parsedCaseId, r.file_id || fileId || null,
          r.a_party || null, r.b_party || null,
          normalizedCallDate, normalizedCallTime,
          normalizedStartTime,
          r.call_type || null,
          r.duration_sec ? parseInt(String(r.duration_sec), 10) || 0 : 0,
          r.imei || null, r.imsi || null,
          r.first_cell_id || r.cell_id || null,
          r.last_cell_id || null,
          r.cell_id || null, r.lac || null,
          r.lat != null ? parseFloat(r.lat) : (r.first_cell_lat != null ? parseFloat(r.first_cell_lat) : null),
          r.long != null ? parseFloat(r.long) : (r.first_cell_long != null ? parseFloat(r.first_cell_long) : null),
          r.azimuth || null,
          r.site_name || r.first_cell_desc || null, r.site_address || r.first_cell_desc || null,
          r.operator || null,
          JSON.stringify(rawData || {})
        );
        const offset = idx * 22;
        return `(${Array.from({ length: 22 }, (_, j) => `$${offset + j + 1}`).join(', ')})`;
      }).join(', ');

      await pool.query(
        `INSERT INTO tower_dump_records (
           case_id, file_id, a_party, b_party,
           call_date, call_time, start_time, call_type, duration_sec,
           imei, imsi, first_cell_id, last_cell_id,
           cell_id, lac, lat, long, azimuth,
           site_name, site_address, operator, raw_data
         ) VALUES ${placeholders}`,
        values
      );
      inserted += batch.length;
    }
    await updateUploadedFileProgress(fileId, inserted);
    await invalidateCaseMemorySnapshots({ caseId: parsedCaseId, module: 'tower' });
    void queueCaseKnowledgeRefresh({ caseId: parsedCaseId, modules: ['tower'], reason: 'tower_records_inserted' });
    emitIngestionCompletionEvents({ caseId: parsedCaseId, fileId: toInt(fileId), inserted, module: 'tower_dump' });
    res.json({ inserted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
