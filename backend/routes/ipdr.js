/* ── IPDR Routes (migrated from old project + auth) ── */
import { Router } from 'express';
import pool from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
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

/* GET /api/ipdr/records?caseId=... */
router.get('/records', authenticateToken, async (req, res) => {
  const caseId = toInt(req.query.caseId);
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });
  try {
    const result = await pool.query(
      'SELECT * FROM ipdr_records WHERE case_id = $1 ORDER BY created_at DESC, id DESC',
      [caseId]
    );
    res.json(result.rows.map(buildIpdrResponseRow));
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
          r.start_time || r.session_start_time || r.event_start_time || r.allocation_start_time || null,
          r.end_time || r.session_end_time || r.allocation_end_time || null,
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
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
