import { Router } from 'express';
import pool from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { upload, handleUploadError } from '../middleware/upload.js';
import XLSX from 'xlsx';

const router = Router();

const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const DEFAULT_TABLE_NAME = 'subscriber_data';

const ensureScopedAccess = async ({ caseId, userId, role }) => {
  if (!caseId) return true;
  if (['super_admin', 'station_admin'].includes(role)) return true;

  const result = await pool.query(
    `
      SELECT c.id
      FROM cases c
      WHERE c.id = $1
        AND (
          c.created_by_user_id = $2
          OR EXISTS (
            SELECT 1
            FROM case_assignments ca
            WHERE ca.case_id = c.id
              AND ca.user_id = $2
              AND ca.is_active = TRUE
          )
        )
      LIMIT 1
    `,
    [caseId, userId]
  );

  return result.rows.length > 0;
};

const normalizeText = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

const mapSdrRow = (row) => {
  const raw = row && typeof row === 'object' ? row : {};
  return {
    subscriber_name: normalizeText(raw.subscriber_name || raw.Name || raw['Name of Subscriber']),
    msisdn: normalizeText(raw.msisdn || raw.telephone_number || raw.TelephoneNumber || raw['Telephone Number']),
    imsi: normalizeText(raw.imsi || raw.IMSI),
    imei: normalizeText(raw.imei || raw.IMEI),
    activation_date: normalizeText(raw.activation_date || raw.date_of_activation || raw['Date Of Activation']),
    address: normalizeText(raw.address || raw.permanent_address || raw['Permanent Address']),
    id_proof_type: normalizeText(raw.id_proof_type || raw.poi_name || raw['POI Name']),
    id_proof_number: normalizeText(raw.id_proof_number || raw.poi_no || raw['POI NO'] || raw.IDCard),
    alternate_number: normalizeText(raw.alternate_number || raw.alternate_phone_no || raw.AlternatePhoneNo),
    email: normalizeText(raw.email || raw.email_id || raw['Email ID']),
    operator: normalizeText(raw.operator || raw.Operator),
    data: raw
  };
};

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

const buildScopeFilter = (caseId, columnName = 'case_id') => {
  if (caseId) {
    return {
      clause: `${columnName} = $1`,
      params: [caseId]
    };
  }

  return {
    clause: `${columnName} IS NULL`,
    params: []
  };
};

const rowsToSheetData = (rows) => rows.map((row) => ({
  id: row.id,
  subscriber_name: row.subscriber_name,
  msisdn: row.msisdn,
  imsi: row.imsi,
  imei: row.imei,
  activation_date: row.activation_date,
  address: row.address,
  id_proof_type: row.id_proof_type,
  id_proof_number: row.id_proof_number,
  alternate_number: row.alternate_number,
  email: row.email,
  operator: row.operator,
  source_file: row.raw_data?.file_name || row.data?.file_name || null,
  created_at: row.created_at,
  data: row.data || row.raw_data || null
}));

/* GET /api/sdr/records?caseId=... */
router.get('/records', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });
  try {
    const hasAccess = await ensureScopedAccess({ caseId, userId: req.user.userId, role: req.user.role });
    if (!hasAccess) return res.status(403).json({ error: 'No access to this case' });

    const result = await pool.query(
      'SELECT * FROM sdr_records WHERE case_id = $1 ORDER BY created_at DESC, id DESC',
      [caseId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* GET /api/sdr/records/count?caseId=... */
router.get('/records/count', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });
  try {
    const hasAccess = await ensureScopedAccess({ caseId, userId: req.user.userId, role: req.user.role });
    if (!hasAccess) return res.status(403).json({ error: 'No access to this case' });

    const result = await pool.query('SELECT COUNT(*)::int AS count FROM sdr_records WHERE case_id = $1', [caseId]);
    res.json({ count: result.rows[0]?.count || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* POST /api/sdr/records — batch insert */
router.post('/records', authenticateToken, async (req, res) => {
  const { caseId, records, fileId } = req.body || {};
  const parsedCaseId = toInt(caseId);
  if (!parsedCaseId) return res.status(400).json({ error: 'caseId is required' });
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records array is required' });
  }

  try {
    const hasAccess = await ensureScopedAccess({ caseId: parsedCaseId, userId: req.user.userId, role: req.user.role });
    if (!hasAccess) return res.status(403).json({ error: 'No access to this case' });

    const batchSize = 500;
    let inserted = 0;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const values = [];
      const placeholders = batch.map((record, idx) => {
        const mapped = mapSdrRow(record);
        values.push(
          parsedCaseId,
          fileId || null,
          mapped.subscriber_name,
          mapped.msisdn,
          mapped.imsi,
          mapped.imei,
          mapped.activation_date,
          mapped.address,
          mapped.id_proof_type,
          mapped.id_proof_number,
          mapped.alternate_number,
          mapped.email,
          mapped.operator,
          JSON.stringify(mapped.data || {}),
          JSON.stringify(mapped.data || {})
        );
        const offset = idx * 15;
        return `(${Array.from({ length: 15 }, (_, j) => `$${offset + j + 1}`).join(', ')})`;
      }).join(', ');

      await pool.query(
        `INSERT INTO sdr_records (
           case_id, file_id, subscriber_name, msisdn, imsi, imei,
           activation_date, address, id_proof_type, id_proof_number,
           alternate_number, email, operator, data, raw_data
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

router.get('/tables', authenticateToken, async (req, res) => {
  try {
    const caseId = toInt(req.query.caseId);
    if (caseId) {
      const hasAccess = await ensureScopedAccess({ caseId, userId: req.user.userId, role: req.user.role });
      if (!hasAccess) return res.status(403).json({ error: 'No access to this case' });
    }

    const scope = buildScopeFilter(caseId);
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM sdr_records WHERE ${scope.clause}`,
      scope.params
    );

    res.json(result.rows[0]?.count > 0 ? [DEFAULT_TABLE_NAME] : []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/table', authenticateToken, async (req, res) => {
  try {
    const caseId = toInt(req.query.caseId);
    if (caseId) {
      const hasAccess = await ensureScopedAccess({ caseId, userId: req.user.userId, role: req.user.role });
      if (!hasAccess) return res.status(403).json({ error: 'No access to this case' });
    }

    const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 250)));
    const scope = buildScopeFilter(caseId);
    const result = await pool.query(
      `SELECT * FROM sdr_records WHERE ${scope.clause} ORDER BY created_at DESC, id DESC LIMIT $${scope.params.length + 1}`,
      [...scope.params, limit]
    );

    res.json(rowsToSheetData(result.rows));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/table/replace', authenticateToken, async (req, res) => {
  try {
    const caseId = toInt(req.body?.caseId);
    if (caseId) {
      const hasAccess = await ensureScopedAccess({ caseId, userId: req.user.userId, role: req.user.role });
      if (!hasAccess) return res.status(403).json({ error: 'No access to this case' });
    }

    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const scope = buildScopeFilter(caseId);

    await pool.query(`DELETE FROM sdr_records WHERE ${scope.clause}`, scope.params);

    if (rows.length === 0) {
      return res.json({ inserted: 0, skipped: 0 });
    }

    const batchSize = 300;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values = [];
      const placeholders = batch.map((record, idx) => {
        const mapped = mapSdrRow(record);
        values.push(
          caseId || null,
          null,
          mapped.subscriber_name,
          mapped.msisdn,
          mapped.imsi,
          mapped.imei,
          mapped.activation_date,
          mapped.address,
          mapped.id_proof_type,
          mapped.id_proof_number,
          mapped.alternate_number,
          mapped.email,
          mapped.operator,
          JSON.stringify(mapped.data || {}),
          JSON.stringify(mapped.data || {})
        );
        const offset = idx * 15;
        return `(${Array.from({ length: 15 }, (_, j) => `$${offset + j + 1}`).join(', ')})`;
      }).join(', ');

      await pool.query(
        `INSERT INTO sdr_records (
           case_id, file_id, subscriber_name, msisdn, imsi, imei,
           activation_date, address, id_proof_type, id_proof_number,
           alternate_number, email, operator, data, raw_data
         ) VALUES ${placeholders}`,
        values
      );
      inserted += batch.length;
    }

    res.json({ inserted, skipped: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/table', authenticateToken, async (req, res) => {
  try {
    const caseId = toInt(req.query.caseId);
    if (caseId) {
      const hasAccess = await ensureScopedAccess({ caseId, userId: req.user.userId, role: req.user.role });
      if (!hasAccess) return res.status(403).json({ error: 'No access to this case' });
    }

    const scope = buildScopeFilter(caseId);
    const result = await pool.query(
      `DELETE FROM sdr_records WHERE ${scope.clause}`,
      scope.params
    );

    res.json({ dropped: result.rowCount || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* GET /api/sdr/search — search subscribers */
router.get('/search', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  const q = String(req.query.q || req.query.query || '').trim();
  const field = String(req.query.field || '').trim();

  if (!q) return res.status(400).json({ error: 'query is required' });

  try {
    if (caseId) {
      const hasAccess = await ensureScopedAccess({ caseId, userId: req.user.userId, role: req.user.role });
      if (!hasAccess) return res.status(403).json({ error: 'No access to this case' });
    }

    const allowed = ['msisdn', 'subscriber_name', 'imsi', 'imei', 'id_proof_number', 'email'];
    const searchField = allowed.includes(field) ? field : null;
    const scope = buildScopeFilter(caseId);
    const params = [...scope.params];
    let where = [`${scope.clause}`];
    if (searchField) {
      params.push(`%${q}%`);
      where.push(`${searchField} ILIKE $${params.length}`);
    } else {
      params.push(`%${q}%`);
      const matcherIndex = params.length;
      where.push(`(
          COALESCE(msisdn, '') ILIKE $${matcherIndex}
          OR COALESCE(subscriber_name, '') ILIKE $${matcherIndex}
          OR COALESCE(imsi, '') ILIKE $${matcherIndex}
          OR COALESCE(imei, '') ILIKE $${matcherIndex}
          OR COALESCE(id_proof_number, '') ILIKE $${matcherIndex}
          OR COALESCE(email, '') ILIKE $${matcherIndex}
          OR CAST(COALESCE(data, raw_data, '{}'::jsonb) AS text) ILIKE $${matcherIndex}
        )`);
    }

    const result = await pool.query(
      `SELECT * FROM sdr_records WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`,
      params
    );

    res.json(rowsToSheetData(result.rows));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/upload', authenticateToken, upload.single('file'), handleUploadError, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const caseId = toInt(req.body?.caseId);
    if (caseId) {
      const hasAccess = await ensureScopedAccess({ caseId, userId: req.user.userId, role: req.user.role });
      if (!hasAccess) return res.status(403).json({ error: 'No access to this case' });
    }

    const workbook = XLSX.readFile(req.file.path, { cellDates: false, raw: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const rows = rawRows.map((row) => ({ ...row, file_name: req.file.originalname }));
    const scope = buildScopeFilter(caseId);

    await pool.query(`DELETE FROM sdr_records WHERE ${scope.clause}`, scope.params);

    if (rows.length === 0) {
      return res.json({ table: DEFAULT_TABLE_NAME, inserted: 0, skipped: 0 });
    }

    const batchSize = 300;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values = [];
      const placeholders = batch.map((record, idx) => {
        const mapped = mapSdrRow(record);
        values.push(
          caseId || null,
          null,
          mapped.subscriber_name,
          mapped.msisdn,
          mapped.imsi,
          mapped.imei,
          mapped.activation_date,
          mapped.address,
          mapped.id_proof_type,
          mapped.id_proof_number,
          mapped.alternate_number,
          mapped.email,
          mapped.operator,
          JSON.stringify(mapped.data || {}),
          JSON.stringify(mapped.data || {})
        );
        const offset = idx * 15;
        return `(${Array.from({ length: 15 }, (_, j) => `$${offset + j + 1}`).join(', ')})`;
      }).join(', ');

      await pool.query(
        `INSERT INTO sdr_records (
           case_id, file_id, subscriber_name, msisdn, imsi, imei,
           activation_date, address, id_proof_type, id_proof_number,
           alternate_number, email, operator, data, raw_data
         ) VALUES ${placeholders}`,
        values
      );
      inserted += batch.length;
    }

    return res.json({ table: DEFAULT_TABLE_NAME, inserted, skipped: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
