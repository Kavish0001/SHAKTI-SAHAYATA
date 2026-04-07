/* ── ILD Routes (migrated + auth) ── */
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

/* GET /api/ild/records?caseId=... */
router.get('/records', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });
  try {
    const result = await pool.query(
      'SELECT * FROM ild_records WHERE case_id = $1 ORDER BY created_at DESC, id DESC',
      [caseId]
    );
    res.json(result.rows.map(buildIldResponseRow));
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
        values.push(
          parsedCaseId, r.file_id || fileId || null,
          r.calling_party || r.calling_number || r.calling_party_number || null,
          r.called_party || r.called_number || r.called_party_number || null,
          r.call_date || null, r.call_time || null,
          r.call_type || null, r.call_direction || null,
          (r.duration_sec || r.call_duration_sec) ? parseInt(String(r.duration_sec || r.call_duration_sec), 10) || 0 : 0,
          r.international_num || r.called_party_number || null, r.country_code || null,
          r.destination_country || null,
          r.imei || null, r.cell_id || r.first_cell_id || null,
          r.operator || r.carrier || r.operator_name || null, r.roaming_circle || r.circle || null,
          JSON.stringify(rawData || {})
        );
        const offset = idx * 17;
        return `(${Array.from({ length: 17 }, (_, j) => `$${offset + j + 1}`).join(', ')})`;
      }).join(', ');

      await pool.query(
        `INSERT INTO ild_records (
           case_id, file_id, calling_party, called_party,
           call_date, call_time, call_type, call_direction,
           duration_sec, international_num, country_code,
           destination_country, imei, cell_id,
           operator, roaming_circle, raw_data
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
