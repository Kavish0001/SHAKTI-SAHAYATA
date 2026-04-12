/* ── IPDR Routes (migrated from old project + auth) ── */
import { Router } from 'express';
import pool from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { parseLooseTimestamp } from '../utils/timestamps.js';
import { emitAdminConsoleEvent } from '../services/admin/adminEventStream.service.js';
import { invalidateCaseMemorySnapshots } from '../services/chatbot/caseMemorySnapshot.service.js';
import { queueCaseKnowledgeRefresh } from '../services/chatbot/caseKnowledge.service.js';
import { asText, buildPaginationPayload, parsePaginationParams, toInt } from '../utils/analysisRouteUtils.js';

const router = Router();
const toFloat = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
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
const normalizeIp = (value) => String(value || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
const isPublicIp = (value) => {
  const ip = normalizeIp(value);
  if (!ip) return false;

  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return false;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return false;
    return true;
  }

  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;

  const [a, b] = parts;
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  ) {
    return false;
  }

  return true;
};
const withTimeout = async (url, timeoutMs = 5000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        'user-agent': 'shakti-ipdr-enrichment/1.0',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};
const parseAsLabel = (value) => {
  const label = String(value || '').trim();
  if (!label) return { asn: null, asName: null };
  const match = label.match(/^(AS\d+)\s+(.+)$/i);
  if (!match) return { asn: null, asName: label };
  return { asn: match[1].toUpperCase(), asName: match[2].trim() || null };
};
const fetchIpIntelligence = async (ip) => {
  const normalizedIp = normalizeIp(ip);
  if (!isPublicIp(normalizedIp)) return { skippedPrivate: true, data: null };

  try {
    const response = await withTimeout(
      `http://ip-api.com/json/${encodeURIComponent(normalizedIp)}?fields=status,country,countryCode,continent,continentCode,regionName,city,lat,lon,isp,org,as,query`
    );
    if (!response.ok) return { skippedPrivate: false, data: null };

    const payload = await response.json();
    if (!payload || payload.status !== 'success') return { skippedPrivate: false, data: null };
    const parsedAs = parseAsLabel(payload.as);

    return {
      skippedPrivate: false,
      data: {
        ip: payload.query || normalizedIp,
        type: null,
        continent: payload.continent || null,
        continent_code: payload.continentCode || null,
        country: payload.country || null,
        country_code: payload.countryCode || null,
        region: payload.regionName || null,
        city: payload.city || null,
        latitude: payload.lat ?? null,
        longitude: payload.lon ?? null,
        asn: parsedAs.asn,
        as_name: parsedAs.asName || payload.org || null,
        as_domain: null,
        isp: payload.isp || null,
      },
    };
  } catch {
    return { skippedPrivate: false, data: null };
  }
};
const runWithConcurrency = async (items, limit, worker) => {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
};
const buildIpdrResponseRow = (row) => {
  const raw = normalizeRawData(row.raw_data);
  return {
    ...raw,
    ...row,
    subscriber_msisdn: row.msisdn || raw.subscriber_msisdn || raw.msisdn || null,
    session_start_time: row.start_time || raw.session_start_time || raw.start_time || null,
    session_end_time: row.end_time || raw.session_end_time || raw.end_time || null,
    duration_sec: row.duration ?? raw.duration_sec ?? null,
    data_volume_uplink: row.uplink_volume ?? raw.data_volume_uplink ?? null,
    data_volume_downlink: row.downlink_volume ?? raw.data_volume_downlink ?? null,
    first_cell_id: row.cell_id || raw.first_cell_id || raw.cell_id || raw.cgi || null,
    cgi_lat: raw.cgi_lat ?? null,
    cgi_long: raw.cgi_long ?? null,
    source_ip_info: raw.source_ip_info || null,
    destination_ip_info: raw.destination_ip_info || null,
    translated_ip_info: raw.translated_ip_info || null,
    roaming_circle: raw.roaming_circle || null,
    home_circle: raw.home_circle || null,
  };
};

const buildIpdrWhereClause = (query = {}) => {
  const caseId = toInt(query.caseId);
  const search = asText(query.search || query.q);
  const msisdn = asText(query.msisdn);
  const imei = asText(query.imei);
  const imsi = asText(query.imsi);
  const ip = asText(query.ip);
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
      COALESCE(msisdn, '') ILIKE $${searchIndex}
      OR COALESCE(imsi, '') ILIKE $${searchIndex}
      OR COALESCE(imei, '') ILIKE $${searchIndex}
      OR COALESCE(source_ip, '') ILIKE $${searchIndex}
      OR COALESCE(destination_ip, '') ILIKE $${searchIndex}
      OR COALESCE(public_ip, '') ILIKE $${searchIndex}
      OR COALESCE(private_ip, '') ILIKE $${searchIndex}
    )`);
  }

  if (msisdn) {
    params.push(`%${msisdn}%`);
    clauses.push(`COALESCE(msisdn, '') ILIKE $${params.length}`);
  }

  if (imei) {
    params.push(`%${imei}%`);
    clauses.push(`COALESCE(imei, '') ILIKE $${params.length}`);
  }

  if (imsi) {
    params.push(`%${imsi}%`);
    clauses.push(`COALESCE(imsi, '') ILIKE $${params.length}`);
  }

  if (ip) {
    params.push(`%${ip}%`);
    const ipIndex = params.length;
    clauses.push(`(
      COALESCE(source_ip, '') ILIKE $${ipIndex}
      OR COALESCE(destination_ip, '') ILIKE $${ipIndex}
      OR COALESCE(public_ip, '') ILIKE $${ipIndex}
      OR COALESCE(private_ip, '') ILIKE $${ipIndex}
      OR COALESCE(nat_ip, '') ILIKE $${ipIndex}
    )`);
  }

  return {
    caseId,
    params,
    whereClause: clauses.join(' AND '),
  };
};

const loadIpdrSummary = async (caseId) => {
  const [totalsResult, topMsisdnResult, topPortsResult, trafficByHourResult, roamingResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total_records,
         COUNT(DISTINCT msisdn)::int AS unique_msisdn,
         COUNT(DISTINCT imei)::int AS unique_imei,
         COUNT(DISTINCT imsi)::int AS unique_imsi,
         COUNT(DISTINCT COALESCE(source_ip, destination_ip))::int AS unique_ips,
         COALESCE(SUM(COALESCE(uplink_volume, 0) + COALESCE(downlink_volume, 0)), 0)::bigint AS total_volume_bytes,
         COUNT(*) FILTER (
           WHERE (source_ip IS NOT NULL AND (raw_data->'source_ip_info') IS NULL)
              OR (destination_ip IS NOT NULL AND (raw_data->'destination_ip_info') IS NULL)
         )::int AS rows_missing_ip_info
       FROM ipdr_records
       WHERE case_id = $1`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(msisdn, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM ipdr_records
       WHERE case_id = $1 AND COALESCE(msisdn, '') <> ''
       GROUP BY COALESCE(msisdn, 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(destination_port::text, source_port::text, 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM ipdr_records
       WHERE case_id = $1
       GROUP BY COALESCE(destination_port::text, source_port::text, 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
    pool.query(
      `SELECT
         LPAD(COALESCE(EXTRACT(HOUR FROM start_time)::int, 0)::text, 2, '0') AS label,
         COUNT(*)::int AS value
       FROM ipdr_records
       WHERE case_id = $1
       GROUP BY LPAD(COALESCE(EXTRACT(HOUR FROM start_time)::int, 0)::text, 2, '0')
       ORDER BY label ASC`,
      [caseId]
    ),
    pool.query(
      `SELECT COALESCE(raw_data->>'roaming_circle', raw_data->>'home_circle', 'UNKNOWN') AS label, COUNT(*)::int AS value
       FROM ipdr_records
       WHERE case_id = $1
       GROUP BY COALESCE(raw_data->>'roaming_circle', raw_data->>'home_circle', 'UNKNOWN')
       ORDER BY value DESC, label ASC
       LIMIT 8`,
      [caseId]
    ),
  ]);

  const totals = totalsResult.rows[0] || {};
  return {
    totalRecords: Number(totals.total_records || 0),
    uniqueMsisdn: Number(totals.unique_msisdn || 0),
    uniqueImei: Number(totals.unique_imei || 0),
    uniqueImsi: Number(totals.unique_imsi || 0),
    uniqueIps: Number(totals.unique_ips || 0),
    totalVolumeBytes: Number(totals.total_volume_bytes || 0),
    rowsMissingIpInfo: Number(totals.rows_missing_ip_info || 0),
    topMsisdn: topMsisdnResult.rows,
    topPorts: topPortsResult.rows,
    trafficByHour: trafficByHourResult.rows,
    roamingSummary: roamingResult.rows,
  };
};

router.get('/summary', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });

  try {
    const summary = await loadIpdrSummary(caseId);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/filters', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });

  try {
    const [msisdnResult, imeiResult, imsiResult] = await Promise.all([
      pool.query(
        `SELECT COALESCE(msisdn, '') AS value, COUNT(*)::int AS count
         FROM ipdr_records
         WHERE case_id = $1 AND COALESCE(msisdn, '') <> ''
         GROUP BY COALESCE(msisdn, '')
         ORDER BY count DESC, value ASC
         LIMIT 12`,
        [caseId]
      ),
      pool.query(
        `SELECT COALESCE(imei, '') AS value, COUNT(*)::int AS count
         FROM ipdr_records
         WHERE case_id = $1 AND COALESCE(imei, '') <> ''
         GROUP BY COALESCE(imei, '')
         ORDER BY count DESC, value ASC
         LIMIT 12`,
        [caseId]
      ),
      pool.query(
        `SELECT COALESCE(imsi, '') AS value, COUNT(*)::int AS count
         FROM ipdr_records
         WHERE case_id = $1 AND COALESCE(imsi, '') <> ''
         GROUP BY COALESCE(imsi, '')
         ORDER BY count DESC, value ASC
         LIMIT 12`,
        [caseId]
      ),
    ]);

    res.json({
      topMsisdn: msisdnResult.rows,
      topImei: imeiResult.rows,
      topImsi: imsiResult.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* GET /api/ipdr/records?caseId=... */
router.get('/records', authenticateToken, async (req, res) => {
  const scope = buildIpdrWhereClause(req.query);
  if (scope.error) return res.status(400).json({ error: scope.error });
  const pagination = parsePaginationParams(req.query);
  try {
    if (!pagination.paginated) {
      const result = await pool.query(
        `SELECT * FROM ipdr_records
         WHERE ${scope.whereClause}
         ORDER BY created_at DESC, id DESC`,
        scope.params
      );
      return res.json(result.rows.map(buildIpdrResponseRow));
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ipdr_records WHERE ${scope.whereClause}`,
      scope.params
    );
    const rowsResult = await pool.query(
      `SELECT * FROM ipdr_records
       WHERE ${scope.whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${scope.params.length + 1}
       OFFSET $${scope.params.length + 2}`,
      [...scope.params, pagination.pageSize, pagination.offset]
    );

    res.json({
      data: rowsResult.rows.map(buildIpdrResponseRow),
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

/* GET /api/ipdr/records/count?caseId=... */
router.get('/records/count', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });
  try {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ipdr_records WHERE case_id = $1', [caseId]);
    res.json({ count: result.rows[0]?.count || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* POST /api/ipdr/records — batch insert */
router.post('/records', authenticateToken, async (req, res) => {
  const { caseId, records, fileId } = req.body || {};
  const parsedCaseId = toInt(caseId);
  if (!parsedCaseId) return res.status(400).json({ error: 'caseId is required' });
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records array is required' });
  }

  const batchSize = 300;
  let inserted = 0;
  try {
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const values = [];
      const placeholders = batch.map((r, idx) => {
        const rawData = r.raw_data && typeof r.raw_data === 'object' ? r.raw_data : r;
        const normalizedStartTime =
          parseLooseTimestamp(r.start_time || r.session_start_time || r.event_start_time || r.allocation_start_time)
          || r.start_time
          || r.session_start_time
          || r.event_start_time
          || r.allocation_start_time
          || null;
        const normalizedEndTime =
          parseLooseTimestamp(r.end_time || r.session_end_time || r.allocation_end_time)
          || r.end_time
          || r.session_end_time
          || r.allocation_end_time
          || null;
        values.push(
          parsedCaseId, r.file_id || fileId || null,
          r.source_ip || null, r.destination_ip || null,
          r.source_port || r.source_public_port || r.source_private_port || null, r.destination_port || null,
          r.msisdn || r.subscriber_msisdn || null,
          r.imsi || r.subscriber_imsi || null,
          r.imei || r.subscriber_imei || null,
          r.private_ip || r.source_ip_private_v4 || null, r.public_ip || r.source_ip_public_v4 || r.source_ip_public_v6 || null,
          r.nat_ip || r.translated_ip || null, r.nat_port || r.translated_port || null,
          r.protocol || r.ip_type || null,
          toInt(r.uplink_volume || r.data_volume_uplink),
          toInt(r.downlink_volume || r.data_volume_downlink),
          toInt(r.total_volume || ((toInt(r.uplink_volume || r.data_volume_uplink) || 0) + (toInt(r.downlink_volume || r.data_volume_downlink) || 0))),
          normalizedStartTime,
          normalizedEndTime,
          toInt(r.duration || r.duration_sec),
          r.cell_id || r.first_cell_id || r.cgi || null,
          r.lac || null,
          r.domain_name || null,
          r.url || null,
          r.operator || null,
          JSON.stringify(rawData || {})
        );
        const offset = idx * 26;
        return `(${Array.from({ length: 26 }, (_, j) => `$${offset + j + 1}`).join(', ')})`;
      }).join(', ');

      await pool.query(
        `INSERT INTO ipdr_records (
           case_id, file_id, source_ip, destination_ip,
           source_port, destination_port, msisdn, imsi, imei,
           private_ip, public_ip, nat_ip, nat_port,
           protocol, uplink_volume, downlink_volume, total_volume,
           start_time, end_time, duration,
           cell_id, lac, domain_name, url, operator, raw_data
         ) VALUES ${placeholders}`,
        values
      );
      inserted += batch.length;
    }
    await updateUploadedFileProgress(fileId, inserted);
    await invalidateCaseMemorySnapshots({ caseId: parsedCaseId, module: 'ipdr' });
    void queueCaseKnowledgeRefresh({ caseId: parsedCaseId, modules: ['ipdr'], reason: 'ipdr_records_inserted' });
    emitIngestionCompletionEvents({ caseId: parsedCaseId, fileId: toInt(fileId), inserted, module: 'ipdr' });
    res.json({ inserted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/enrich-case', authenticateToken, async (req, res) => {
  const caseId = toInt(req.body?.caseId);
  const limit = Math.max(1, Math.min(5000, toInt(req.body?.limit) || 1000));

  if (!caseId) return res.status(400).json({ error: 'caseId is required' });

  try {
    const result = await pool.query(
      `SELECT id, source_ip, destination_ip, nat_ip, raw_data
       FROM ipdr_records
       WHERE case_id = $1
       ORDER BY id ASC
       LIMIT $2`,
      [caseId, limit]
    );

    const ipCache = new Map();
    const uniqueIps = new Set();

    for (const row of result.rows) {
      const raw = normalizeRawData(row.raw_data);
      if (row.source_ip && !raw.source_ip_info) uniqueIps.add(normalizeIp(row.source_ip));
      if (row.destination_ip && !raw.destination_ip_info) uniqueIps.add(normalizeIp(row.destination_ip));
      if (row.nat_ip && !raw.translated_ip_info) uniqueIps.add(normalizeIp(row.nat_ip));
    }

    let fetched = 0;
    let enrichedIps = 0;
    let skippedPrivate = 0;

    await runWithConcurrency([...uniqueIps], 6, async (ip) => {
      const normalizedIp = normalizeIp(ip);
      if (!normalizedIp) return;

      const lookup = await fetchIpIntelligence(normalizedIp);
      if (lookup.skippedPrivate) {
        skippedPrivate += 1;
        return;
      }

      fetched += 1;
      if (lookup.data) {
        enrichedIps += 1;
        ipCache.set(normalizedIp, lookup.data);
      }
    });

    let updatedRows = 0;

    for (const row of result.rows) {
      const currentRaw = normalizeRawData(row.raw_data);
      const nextRaw = { ...currentRaw };
      let changed = false;

      const sourceInfo = ipCache.get(normalizeIp(row.source_ip));
      const destinationInfo = ipCache.get(normalizeIp(row.destination_ip));
      const translatedInfo = ipCache.get(normalizeIp(row.nat_ip));

      if (sourceInfo && !nextRaw.source_ip_info) {
        nextRaw.source_ip_info = sourceInfo;
        changed = true;
      }
      if (destinationInfo && !nextRaw.destination_ip_info) {
        nextRaw.destination_ip_info = destinationInfo;
        changed = true;
      }
      if (translatedInfo && !nextRaw.translated_ip_info) {
        nextRaw.translated_ip_info = translatedInfo;
        changed = true;
      }

      if (!changed) continue;

      await pool.query(
        'UPDATE ipdr_records SET raw_data = $1 WHERE id = $2',
        [JSON.stringify(nextRaw), row.id]
      );
      updatedRows += 1;
    }

    res.json({
      caseId: String(caseId),
      processed: result.rows.length,
      fetched,
      enrichedIps,
      updatedRows,
      skippedPrivate,
    });
    void queueCaseKnowledgeRefresh({ caseId, modules: ['ipdr'], reason: 'ipdr_enrichment_completed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
