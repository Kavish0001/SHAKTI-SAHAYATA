import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import pool from '../config/database.js';
import {
  buildSupabaseStoragePath,
  getSupabaseAdminClient,
  getSupabaseBucket,
  isSupabaseStorageEnabled,
} from '../config/supabase.js';
import { authenticateToken } from '../middleware/auth.js';
import { handleUploadError, upload } from '../middleware/upload.js';
import { emitAdminConsoleEvent } from '../services/admin/adminEventStream.service.js';
import { classifyFile, extractHeadersFromFile } from '../services/fileClassifier.js';
import { invalidateCaseMemorySnapshots } from '../services/chatbot/caseMemorySnapshot.service.js';
import { queueCaseKnowledgeRefresh } from '../services/chatbot/caseKnowledge.service.js';

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || './uploads');
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 52428800);
const uploadTempRoot = path.join(os.tmpdir(), 'shakti-supabase-upload-');

router.use(authenticateToken);

const normalizeExpectedType = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/^tower$/, 'tower_dump');

const resolveExpectedType = (req) =>
  normalizeExpectedType(req.body?.expectedType || req.body?.fileType || req.params?.type || '');

const buildFileResponse = (file, classification) => ({
  ...file,
  detected_type: classification?.detectedType || null,
  confidence: classification?.confidence ?? null,
  classification_result: classification?.result || null,
});

const normalizeFileType = (value = '') => {
  const normalized = normalizeExpectedType(value);
  if (normalized === 'tower_dump') return 'tower';
  return normalized;
};

const createChecksum = (buffer) =>
  crypto.createHash('sha256').update(buffer).digest('hex');

const ensureCaseAccess = async ({ caseId, userId, role }) => {
  if (!caseId || !userId) return false;
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
    [caseId, userId],
  );

  return result.rows.length > 0;
};

const removeUploadedFile = (filePath) => {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
};

const insertAuditLog = async ({ user, fileId, action = 'FILE_UPLOAD', details }) => {
  await pool.query(
    `
      INSERT INTO audit_logs (user_id, officer_buckle_id, officer_name, action, resource_type, resource_id, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      user.userId,
      user.buckleId,
      user.fullName,
      action,
      'file',
      String(fileId),
      JSON.stringify(details),
    ],
  );
};

const emitFileLifecycleEvents = (eventPayload = {}) => {
  emitAdminConsoleEvent('dashboard.summary.changed', eventPayload);
  emitAdminConsoleEvent('ingestion.queue.changed', eventPayload);
  emitAdminConsoleEvent('storage.changed', eventPayload);
  emitAdminConsoleEvent('logs.changed', eventPayload);
};

const listFilesForCase = async (caseId) => {
  const result = await pool.query(
    `
      SELECT uf.*, fc.detected_type, fc.confidence, fc.classification_result
      FROM uploaded_files uf
      LEFT JOIN file_classifications fc ON fc.file_id = uf.id
      WHERE uf.case_id = $1
      ORDER BY uf.uploaded_at DESC, uf.id DESC
    `,
    [caseId],
  );

  return result.rows;
};

const getFileById = async (fileId) => {
  const result = await pool.query(
    `
      SELECT
        uf.*,
        fc.expected_type,
        fc.detected_type,
        fc.confidence,
        fc.classification_result
      FROM uploaded_files uf
      LEFT JOIN file_classifications fc ON fc.file_id = uf.id
      WHERE uf.id = $1
      LIMIT 1
    `,
    [fileId],
  );

  return result.rows[0] || null;
};

const validateUploadRequest = async ({ caseId, expectedType, user }) => {
  if (!caseId || Number.isNaN(caseId)) {
    return { ok: false, status: 400, error: 'caseId is required' };
  }

  if (!expectedType) {
    return { ok: false, status: 400, error: 'expectedType or fileType is required' };
  }

  const canAccess = await ensureCaseAccess({
    caseId,
    userId: user.userId,
    role: user.role,
  });

  if (!canAccess) {
    return { ok: false, status: 403, error: 'No access to this case' };
  }

  return { ok: true };
};

const persistClassification = async ({ fileId, expectedType, classification }) => {
  await pool.query(
    `
      INSERT INTO file_classifications (
        file_id,
        expected_type,
        detected_type,
        confidence,
        all_scores,
        matched_columns,
        total_columns,
        classification_result,
        error_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      fileId,
      expectedType,
      classification.detectedType || null,
      classification.confidence || null,
      JSON.stringify(classification.scores || {}),
      classification.matchedColumns || null,
      classification.totalColumns || null,
      classification.result,
      classification.message || null,
    ],
  );
};

const insertIngestionJob = async ({
  caseId,
  fileId,
  userId,
  originalFilename,
  storagePath,
  storageBucket,
  fileSizeBytes,
  fileChecksum,
  mimeType,
  expectedType,
  detectedType,
  classification,
}) => {
  await pool.query(
    `
      INSERT INTO ingestion_jobs (
        case_id,
        file_id,
        user_id,
        original_filename,
        storage_path,
        storage_bucket,
        storage_object_path,
        storage_provider,
        storage_uploaded_at,
        file_size_bytes,
        file_checksum,
        mime_type,
        expected_type,
        detected_type,
        confidence_score,
        classification_meta,
        status
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'supabase', NOW(),
        $8, $9, $10, $11, $12, $13, $14, 'queued'
      )
      ON CONFLICT (case_id, file_checksum) DO UPDATE
      SET
        file_id = EXCLUDED.file_id,
        original_filename = EXCLUDED.original_filename,
        storage_path = EXCLUDED.storage_path,
        storage_bucket = EXCLUDED.storage_bucket,
        storage_object_path = EXCLUDED.storage_object_path,
        storage_provider = EXCLUDED.storage_provider,
        storage_uploaded_at = EXCLUDED.storage_uploaded_at,
        mime_type = EXCLUDED.mime_type,
        expected_type = EXCLUDED.expected_type,
        detected_type = EXCLUDED.detected_type,
        confidence_score = EXCLUDED.confidence_score,
        classification_meta = EXCLUDED.classification_meta,
        status = EXCLUDED.status
    `,
    [
      caseId,
      fileId,
      userId,
      originalFilename,
      storagePath,
      storageBucket,
      storagePath,
      fileSizeBytes,
      fileChecksum,
      mimeType,
      expectedType,
      detectedType || null,
      classification.confidence || null,
      JSON.stringify({
        result: classification.result,
        message: classification.message || null,
        scores: classification.scores || {},
      }),
    ],
  );
};

const createTempFileFromBuffer = async ({ originalName, buffer }) => {
  const ext = path.extname(originalName || '').toLowerCase() || '.tmp';
  const tempDir = await fsPromises.mkdtemp(uploadTempRoot);
  const tempFilePath = path.join(tempDir, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  await fsPromises.writeFile(tempFilePath, buffer);
  return { tempDir, tempFilePath };
};

const cleanupTempFile = async (tempDir) => {
  if (!tempDir) return;
  try {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup issues
  }
};

const downloadSupabaseObject = async ({ bucket, objectPath }) => {
  const supabaseAdmin = getSupabaseAdminClient();
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(objectPath);
  if (error || !data) {
    throw new Error(error?.message || 'Uploaded object could not be verified');
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  return buffer;
};

const removeSupabaseObject = async ({ bucket, objectPath }) => {
  if (!bucket || !objectPath) return;
  try {
    const supabaseAdmin = getSupabaseAdminClient();
    await supabaseAdmin.storage.from(bucket).remove([objectPath]);
  } catch {
    // best effort cleanup
  }
};

const buildUploadSessionResponse = ({ bucket, objectPath, upload }) => ({
  provider: 'supabase',
  bucket,
  objectPath,
  token: upload?.token || null,
  signedUrl: upload?.signedUrl || null,
  path: upload?.path || objectPath,
});

router.post('/upload-session', async (req, res) => {
  const caseId = Number(req.body?.caseId || 0);
  const expectedType = normalizeExpectedType(req.body?.expectedType || req.body?.fileType || '');
  const originalName = String(req.body?.fileName || req.body?.originalName || '').trim();
  const mimeType = String(req.body?.mimeType || 'application/octet-stream').trim();
  const fileSize = Number(req.body?.fileSize || 0);

  try {
    if (!isSupabaseStorageEnabled) {
      return res.status(503).json({ error: 'Supabase storage is not configured' });
    }

    const validation = await validateUploadRequest({ caseId, expectedType, user: req.user });
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.error });
    }

    if (!originalName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    if (!fileSize || Number.isNaN(fileSize) || fileSize > MAX_FILE_SIZE) {
      return res.status(413).json({
        error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB.`,
        code: 'FILE_TOO_LARGE',
      });
    }

    const bucket = getSupabaseBucket('evidence');
    const objectPath = buildSupabaseStoragePath({
      caseId,
      module: expectedType,
      originalName,
    });

    const supabaseAdmin = getSupabaseAdminClient();
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUploadUrl(objectPath);

    if (error) {
      throw error;
    }

    return res.status(201).json({
      upload: buildUploadSessionResponse({ bucket, objectPath, upload: data }),
      file: {
        caseId,
        expectedType,
        originalName,
        mimeType,
        fileSize,
      },
    });
  } catch (error) {
    console.error('[FILES] Upload session error:', error.message);
    return res.status(500).json({ error: 'Failed to create upload session' });
  }
});

router.post('/complete-upload', async (req, res) => {
  const caseId = Number(req.body?.caseId || 0);
  const expectedType = normalizeExpectedType(req.body?.expectedType || req.body?.fileType || '');
  const originalName = String(req.body?.originalName || req.body?.fileName || '').trim();
  const mimeType = String(req.body?.mimeType || 'application/octet-stream').trim();
  const fileSize = Number(req.body?.fileSize || 0);
  const storageBucket = String(req.body?.storageBucket || getSupabaseBucket('evidence')).trim();
  const storageObjectPath = String(req.body?.storageObjectPath || req.body?.objectPath || '').trim();

  let tempDir = null;

  try {
    if (!isSupabaseStorageEnabled) {
      return res.status(503).json({ error: 'Supabase storage is not configured' });
    }

    const validation = await validateUploadRequest({ caseId, expectedType, user: req.user });
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.error });
    }

    if (!storageObjectPath) {
      return res.status(400).json({ error: 'storageObjectPath is required' });
    }

    const fileBuffer = await downloadSupabaseObject({
      bucket: storageBucket,
      objectPath: storageObjectPath,
    });

    const tempFile = await createTempFileFromBuffer({
      originalName,
      buffer: fileBuffer,
    });
    tempDir = tempFile.tempDir;

    const headers = extractHeadersFromFile(tempFile.tempFilePath, expectedType);
    const classification = classifyFile(headers, expectedType);

    if (classification.result !== 'ACCEPTED') {
      await removeSupabaseObject({ bucket: storageBucket, objectPath: storageObjectPath });
      return res.status(400).json({
        error: classification.message,
        headers,
        classification,
      });
    }

    const fileResult = await pool.query(
      `
        INSERT INTO uploaded_files (
          case_id,
          file_name,
          original_name,
          file_type,
          file_size,
          mime_type,
          parse_status,
          uploaded_by,
          storage_provider,
          storage_bucket,
          storage_object_path,
          storage_uploaded_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'supabase', $9, $10, NOW())
        RETURNING *
      `,
      [
        caseId,
        path.basename(storageObjectPath),
        originalName,
        classification.detectedType || expectedType,
        fileSize || fileBuffer.length,
        mimeType,
        'pending',
        req.user.userId,
        storageBucket,
        storageObjectPath,
      ],
    );

    const fileRecord = fileResult.rows[0];
    await persistClassification({
      fileId: fileRecord.id,
      expectedType,
      classification,
    });

    await insertIngestionJob({
      caseId,
      fileId: fileRecord.id,
      userId: req.user.userId,
      originalFilename: originalName,
      storagePath: storageObjectPath,
      storageBucket,
      fileSizeBytes: fileSize || fileBuffer.length,
      fileChecksum: createChecksum(fileBuffer),
      mimeType,
      expectedType,
      detectedType: classification.detectedType || expectedType,
      classification,
    });

    await insertAuditLog({
      user: req.user,
      fileId: fileRecord.id,
      action: 'FILE_UPLOAD',
      details: {
        caseId,
        fileName: originalName,
        expectedType,
        detectedType: classification.detectedType,
        result: classification.result,
        confidence: classification.confidence,
        headers,
        storageProvider: 'supabase',
        storageBucket,
        storageObjectPath,
      },
    });

    const payload = buildFileResponse(fileRecord, classification);
    await invalidateCaseMemorySnapshots({ caseId });
    void queueCaseKnowledgeRefresh({ caseId, modules: ['cdr', 'ipdr', 'sdr', 'tower', 'ild'], reason: 'file_completed_upload' });
    emitFileLifecycleEvents({
      fileId: fileRecord.id,
      caseId,
      action: 'uploaded',
      classificationResult: classification.result,
      storageProvider: 'supabase',
    });

    return res.status(201).json({
      ...payload,
      file: payload,
      headers,
      classification,
    });
  } catch (error) {
    console.error('[FILES] Complete upload error:', error.message);
    return res.status(500).json({ error: 'Failed to finalize file upload' });
  } finally {
    await cleanupTempFile(tempDir);
  }
});

router.post('/upload/:type?', upload.single('file'), handleUploadError, async (req, res) => {
  const expectedType = resolveExpectedType(req);
  const caseId = Number(req.body?.caseId || 0);

  try {
    const validation = await validateUploadRequest({ caseId, expectedType, user: req.user });
    if (!validation.ok) {
      removeUploadedFile(req.file?.path);
      return res.status(validation.status).json({ error: validation.error });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const headers = extractHeadersFromFile(req.file.path, expectedType);
    const classification = classifyFile(headers, expectedType);

    if (classification.result !== 'ACCEPTED') {
      removeUploadedFile(req.file?.path);
      return res.status(400).json({
        error: classification.message,
        headers,
        classification,
      });
    }

    const fileResult = await pool.query(
      `
        INSERT INTO uploaded_files (
          case_id,
          file_name,
          original_name,
          file_type,
          file_size,
          mime_type,
          parse_status,
          uploaded_by,
          storage_provider
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'local')
        RETURNING *
      `,
      [
        caseId,
        req.file.filename,
        req.file.originalname,
        classification.detectedType || expectedType,
        req.file.size,
        req.file.mimetype,
        'pending',
        req.user.userId,
      ],
    );

    const fileRecord = fileResult.rows[0];
    await persistClassification({
      fileId: fileRecord.id,
      expectedType,
      classification,
    });

    await insertAuditLog({
      user: req.user,
      fileId: fileRecord.id,
      details: {
        caseId,
        fileName: req.file.originalname,
        expectedType,
        detectedType: classification.detectedType,
        result: classification.result,
        confidence: classification.confidence,
        headers,
      },
    });

    const payload = buildFileResponse(fileRecord, classification);
    await invalidateCaseMemorySnapshots({ caseId });
    void queueCaseKnowledgeRefresh({ caseId, modules: ['cdr', 'ipdr', 'sdr', 'tower', 'ild'], reason: 'file_uploaded_local' });
    emitFileLifecycleEvents({
      fileId: fileRecord.id,
      caseId,
      action: 'uploaded',
      classificationResult: classification.result,
      storageProvider: 'local',
    });

    return res.status(201).json({
      ...payload,
      file: payload,
      headers,
      classification,
    });
  } catch (error) {
    console.error('[FILES] Upload error:', error.message);
    removeUploadedFile(req.file?.path);
    return res.status(500).json({ error: 'File upload failed' });
  }
});

router.get('/', async (req, res) => {
  const caseId = Number(req.query.caseId || 0);

  try {
    if (!caseId || Number.isNaN(caseId)) {
      return res.status(400).json({ error: 'caseId is required' });
    }

    const canAccess = await ensureCaseAccess({
      caseId,
      userId: req.user.userId,
      role: req.user.role,
    });

    if (!canAccess) {
      return res.status(403).json({ error: 'No access to this case' });
    }

    const rows = await listFilesForCase(caseId);
    return res.json(rows);
  } catch (error) {
    console.error('[FILES] List error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch files' });
  }
});

router.delete('/:fileId', async (req, res) => {
  const fileId = Number(req.params.fileId || 0);

  try {
    if (!fileId || Number.isNaN(fileId)) {
      return res.status(400).json({ error: 'fileId is required' });
    }

    const fileRecord = await getFileById(fileId);
    if (!fileRecord) {
      return res.status(404).json({ error: 'File not found' });
    }

    const canAccess = await ensureCaseAccess({
      caseId: fileRecord.case_id,
      userId: req.user.userId,
      role: req.user.role,
    });

    if (!canAccess) {
      return res.status(403).json({ error: 'No access to this case' });
    }

    const caseLockResult = await pool.query(
      'SELECT is_evidence_locked, lock_reason FROM cases WHERE id = $1 LIMIT 1',
      [fileRecord.case_id],
    );

    if (caseLockResult.rows[0]?.is_evidence_locked) {
      return res.status(423).json({
        error: 'Case is evidence-locked for legal proceedings',
        reason: caseLockResult.rows[0].lock_reason,
        message: 'Contact Super Admin to unlock',
      });
    }

    const db = await pool.connect();
    let deletedRecords = 0;

    try {
      await db.query('BEGIN');

      const telecomTables = [
        'cdr_records',
        'ipdr_records',
        'sdr_records',
        'tower_dump_records',
        'ild_records',
      ];

      for (const tableName of telecomTables) {
        const deletion = await db.query(`DELETE FROM ${tableName} WHERE file_id = $1 RETURNING id`, [fileId]);
        deletedRecords += deletion.rowCount || 0;
      }

      await db.query('DELETE FROM file_classifications WHERE file_id = $1', [fileId]);

      const deletedFile = await db.query(
        'DELETE FROM uploaded_files WHERE id = $1 RETURNING id',
        [fileId],
      );

      if ((deletedFile.rowCount || 0) === 0) {
        throw new Error('Uploaded file could not be deleted');
      }

      await db.query(
        `
          INSERT INTO audit_logs (user_id, officer_buckle_id, officer_name, action, resource_type, resource_id, details)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          req.user.userId,
          req.user.buckleId,
          req.user.fullName,
          'FILE_DELETE',
          'file',
          String(fileId),
          JSON.stringify({
            caseId: fileRecord.case_id,
            fileName: fileRecord.original_name,
            storedFileName: fileRecord.file_name,
            deletedRecords,
            deletedType: normalizeFileType(
              fileRecord.detected_type || fileRecord.expected_type || fileRecord.file_type,
            ),
            storageProvider: fileRecord.storage_provider || 'local',
            storageBucket: fileRecord.storage_bucket || null,
            storageObjectPath: fileRecord.storage_object_path || null,
          }),
        ],
      );

      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }

    if (fileRecord.storage_provider === 'supabase' && fileRecord.storage_bucket && fileRecord.storage_object_path) {
      await removeSupabaseObject({
        bucket: fileRecord.storage_bucket,
        objectPath: fileRecord.storage_object_path,
      });
    } else {
      removeUploadedFile(path.join(uploadDir, fileRecord.file_name));
    }

    await invalidateCaseMemorySnapshots({ caseId: fileRecord.case_id });
    void queueCaseKnowledgeRefresh({ caseId: fileRecord.case_id, modules: ['cdr', 'ipdr', 'sdr', 'tower', 'ild'], reason: 'file_deleted' });

    emitFileLifecycleEvents({
      fileId,
      caseId: fileRecord.case_id,
      action: 'deleted',
      storageProvider: fileRecord.storage_provider || 'local',
    });

    return res.json({
      fileId,
      deleted: true,
      deletedRecords,
      deletedType: normalizeFileType(
        fileRecord.detected_type || fileRecord.expected_type || fileRecord.file_type,
      ),
    });
  } catch (error) {
    console.error('[FILES] Delete error:', error.message);
    return res.status(500).json({ error: 'Failed to delete file' });
  }
});

router.get('/download-url', async (req, res) => {
  const relativePath = String(req.query.path || '').trim();
  if (!relativePath) return res.status(400).json({ error: 'path is required' });

  const safePath = path.basename(relativePath);
  return res.json({ url: `/uploads/${safePath}` });
});

router.get('/:fileId/download-url', async (req, res) => {
  const fileId = Number(req.params.fileId || 0);

  try {
    if (!fileId || Number.isNaN(fileId)) {
      return res.status(400).json({ error: 'fileId is required' });
    }

    const fileRecord = await getFileById(fileId);
    if (!fileRecord) {
      return res.status(404).json({ error: 'File not found' });
    }

    const canAccess = await ensureCaseAccess({
      caseId: fileRecord.case_id,
      userId: req.user.userId,
      role: req.user.role,
    });

    if (!canAccess) {
      return res.status(403).json({ error: 'No access to this case' });
    }

    if (fileRecord.storage_provider === 'supabase' && fileRecord.storage_bucket && fileRecord.storage_object_path) {
      const supabaseAdmin = getSupabaseAdminClient();
      const { data, error } = await supabaseAdmin.storage
        .from(fileRecord.storage_bucket)
        .createSignedUrl(fileRecord.storage_object_path, 60);

      if (error || !data?.signedUrl) {
        throw new Error(error?.message || 'Failed to generate signed download URL');
      }

      return res.json({
        url: data.signedUrl,
        provider: 'supabase',
      });
    }

    return res.json({
      url: `/uploads/${path.basename(fileRecord.file_name)}`,
      provider: 'local',
    });
  } catch (error) {
    console.error('[FILES] Download URL error:', error.message);
    return res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

router.get('/:caseId', async (req, res) => {
  const caseId = Number(req.params.caseId || 0);

  try {
    if (!caseId || Number.isNaN(caseId)) {
      return res.status(400).json({ error: 'caseId is required' });
    }

    const canAccess = await ensureCaseAccess({
      caseId,
      userId: req.user.userId,
      role: req.user.role,
    });

    if (!canAccess) {
      return res.status(403).json({ error: 'No access to this case' });
    }

    const rows = await listFilesForCase(caseId);
    return res.json({ files: rows });
  } catch (error) {
    console.error('[FILES] List error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch files' });
  }
});

export default router;
