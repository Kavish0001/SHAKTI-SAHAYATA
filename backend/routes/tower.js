/* ── Tower Dump Routes (migrated + auth) ── */
import { Router } from 'express';
import pool from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
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

/* GET /api/tower/records?caseId=... */
router.get('/records', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });
  try {
    const result = await pool.query(
      'SELECT * FROM tower_dump_records WHERE case_id = $1 ORDER BY created_at DESC, id DESC',
      [caseId]
    );
    res.json(result.rows.map(buildTowerResponseRow));
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
        values.push(
          parsedCaseId, r.file_id || fileId || null,
          r.a_party || null, r.b_party || null,
          r.call_date || null, r.call_time || r.call_start_time || null,
          r.start_time || r.call_start_time || r.call_time || null,
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
    res.json({ inserted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
