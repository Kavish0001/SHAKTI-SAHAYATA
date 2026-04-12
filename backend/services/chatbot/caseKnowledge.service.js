import pool from '../../config/database.js';
import {
  getSupabaseAdminClient,
  getSupabaseBucket,
  isSupabaseStorageEnabled,
} from '../../config/supabase.js';
import { resolveMetricDefinition } from './metricRegistry.service.js';

const KNOWLEDGE_FRESH_TTL_MS = Math.max(
  30_000,
  Math.min(30 * 60 * 1000, Number(process.env.CHATBOT_CASE_KNOWLEDGE_TTL_MS || 5 * 60 * 1000))
);

const MODULES = ['cdr', 'ipdr', 'sdr', 'tower', 'ild'];
const MODULE_LABELS = {
  cdr: 'CDR',
  ipdr: 'IPDR',
  sdr: 'SDR',
  tower: 'Tower Dump',
  ild: 'ILD',
};

const EXACT_FALLBACK_MESSAGE = 'I cannot answer that from the tagged case’s verified data.';

const refreshPromises = new Map();

const toInt = (value) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const toNumeric = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatNumber = (value) => Number(value || 0).toLocaleString('en-IN');

const formatDuration = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hrs, mins, secs].map((part) => String(part).padStart(2, '0')).join(':');
};

const normalizeBucketKey = (value) => String(value || '').trim().toLowerCase();

const buildCaseVersion = () => `casev-${Date.now()}`;

const getArtifactPath = (caseId, module, fileName) =>
  `case/${caseId}/${module}/${fileName}`;

const safeJson = (value) => JSON.stringify(value ?? {}, null, 2);

const writeArtifact = async ({ caseId, module, fileName, content, contentType }) => {
  if (!isSupabaseStorageEnabled) return null;

  try {
    const bucket = getSupabaseBucket('knowledge');
    const objectPath = getArtifactPath(caseId, module, fileName);
    const body = typeof content === 'string' ? content : safeJson(content);
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.storage
      .from(bucket)
      .upload(objectPath, body, {
        contentType,
        upsert: true,
      });

    if (error) throw error;
    return { bucket, objectPath };
  } catch (error) {
    console.error('[CHATBOT][KNOWLEDGE] Artifact upload failed:', error?.message || error);
    return null;
  }
};

const readArtifact = async ({ artifactPath }) => {
  if (!artifactPath || !isSupabaseStorageEnabled) return null;
  const bucket = getSupabaseBucket('knowledge');
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.storage.from(bucket).download(artifactPath);
    if (error || !data) return null;
    return await data.text();
  } catch (error) {
    console.error('[CHATBOT][KNOWLEDGE] Artifact read failed:', error?.message || error);
    return null;
  }
};

const upsertModuleSnapshot = async ({
  caseId,
  module,
  summaryMarkdown,
  snapshotJson,
  sourceRowCount,
  sourceFileCount,
  caseVersion,
}) => {
  await pool.query(
    `
      INSERT INTO case_module_snapshots (
        case_id, module, summary_markdown, snapshot_json, source_row_count, source_file_count, case_version, computed_at, updated_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NOW(), NOW())
      ON CONFLICT (case_id, module)
      DO UPDATE SET
        summary_markdown = EXCLUDED.summary_markdown,
        snapshot_json = EXCLUDED.snapshot_json,
        source_row_count = EXCLUDED.source_row_count,
        source_file_count = EXCLUDED.source_file_count,
        case_version = EXCLUDED.case_version,
        computed_at = NOW(),
        updated_at = NOW()
    `,
    [caseId, module, summaryMarkdown || null, JSON.stringify(snapshotJson || {}), sourceRowCount || 0, sourceFileCount || 0, caseVersion]
  );
};

const replaceMetricFacts = async ({ caseId, module, caseVersion, sourceRowCount, sourceFileCount, facts = {} }) => {
  await pool.query('DELETE FROM case_metric_facts WHERE case_id = $1 AND module = $2', [caseId, module]);
  const entries = Object.entries(facts || {});
  for (const [metricKey, metricValue] of entries) {
    await pool.query(
      `
        INSERT INTO case_metric_facts (
          case_id, module, metric_key, metric_value, source_row_count, source_file_count, case_version, computed_at, updated_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NOW(), NOW())
      `,
      [caseId, module, metricKey, JSON.stringify(metricValue ?? null), sourceRowCount || 0, sourceFileCount || 0, caseVersion]
    );
  }
};

const replaceRankedEntities = async ({
  caseId,
  module,
  caseVersion,
  sourceRowCount,
  sourceFileCount,
  rows = [],
}) => {
  await pool.query('DELETE FROM case_ranked_entities WHERE case_id = $1 AND module = $2', [caseId, module]);
  for (const row of rows) {
    await pool.query(
      `
        INSERT INTO case_ranked_entities (
          case_id, module, entity_type, metric_key, rank, entity_value, count_value, duration_value, extra_json,
          source_row_count, source_file_count, case_version, computed_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, NOW(), NOW())
      `,
      [
        caseId,
        module,
        row.entityType,
        row.metricKey,
        row.rank,
        row.entityValue,
        row.countValue ?? null,
        row.durationValue ?? null,
        JSON.stringify(row.extraJson || {}),
        sourceRowCount || 0,
        sourceFileCount || 0,
        caseVersion,
      ]
    );
  }
};

const replaceTimeSeriesFacts = async ({
  caseId,
  module,
  caseVersion,
  sourceRowCount,
  sourceFileCount,
  rows = [],
}) => {
  await pool.query('DELETE FROM case_time_series_facts WHERE case_id = $1 AND module = $2', [caseId, module]);
  for (const row of rows) {
    await pool.query(
      `
        INSERT INTO case_time_series_facts (
          case_id, module, metric_key, bucket_key, bucket_label, count_value, duration_value, extra_json,
          source_row_count, source_file_count, case_version, computed_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, NOW(), NOW())
      `,
      [
        caseId,
        module,
        row.metricKey,
        row.bucketKey,
        row.bucketLabel,
        row.countValue ?? null,
        row.durationValue ?? null,
        JSON.stringify(row.extraJson || {}),
        sourceRowCount || 0,
        sourceFileCount || 0,
        caseVersion,
      ]
    );
  }
};

const replaceGeoFacts = async ({
  caseId,
  module,
  caseVersion,
  sourceRowCount,
  sourceFileCount,
  rows = [],
}) => {
  await pool.query('DELETE FROM case_geo_facts WHERE case_id = $1 AND module = $2', [caseId, module]);
  for (const row of rows) {
    await pool.query(
      `
        INSERT INTO case_geo_facts (
          case_id, module, dimension_key, rank, label, count_value, duration_value, latitude, longitude, extra_json,
          source_row_count, source_file_count, case_version, computed_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, NOW(), NOW())
      `,
      [
        caseId,
        module,
        row.dimensionKey,
        row.rank ?? 1,
        row.label,
        row.countValue ?? null,
        row.durationValue ?? null,
        row.latitude ?? null,
        row.longitude ?? null,
        JSON.stringify(row.extraJson || {}),
        sourceRowCount || 0,
        sourceFileCount || 0,
        caseVersion,
      ]
    );
  }
};

const createKnowledgeJob = async ({ caseId, requestedModules, reason }) => {
  const result = await pool.query(
    `
      INSERT INTO case_knowledge_jobs (case_id, requested_modules, status, reason, created_at, updated_at)
      VALUES ($1, $2::text[], 'queued', $3, NOW(), NOW())
      RETURNING id
    `,
    [caseId, requestedModules, reason || null]
  );
  return result.rows[0]?.id || null;
};

const markKnowledgeJobRunning = async ({ jobId, caseVersion, artifactBucket }) => {
  if (!jobId) return;
  await pool.query(
    `
      UPDATE case_knowledge_jobs
      SET status = 'running',
          case_version = $2,
          artifact_bucket = $3,
          started_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [jobId, caseVersion, artifactBucket || null]
  );
};

const markKnowledgeJobCompleted = async ({ jobId, artifactManifest, caseVersion }) => {
  if (!jobId) return;
  await pool.query(
    `
      UPDATE case_knowledge_jobs
      SET status = 'completed',
          artifact_manifest = $2::jsonb,
          case_version = COALESCE($3, case_version),
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [jobId, JSON.stringify(artifactManifest || {}), caseVersion || null]
  );
};

const markKnowledgeJobFailed = async ({ jobId, errorText }) => {
  if (!jobId) return;
  await pool.query(
    `
      UPDATE case_knowledge_jobs
      SET status = 'failed',
          error_text = $2,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [jobId, String(errorText || 'Unknown knowledge refresh failure')]
  );
};

const fetchFileCount = async (caseId) => {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM uploaded_files WHERE case_id = $1',
    [caseId]
  );
  return Number(result.rows[0]?.count || 0);
};

const computeCdrFacts = async (caseId) => {
  const [
    statsResult,
    callTypesResult,
    topBResult,
    topAResult,
    topImeiResult,
    hourlyResult,
    dailyResult,
    locationResult,
    nightActivityResult,
    firstLastResult,
    regularCallersResult,
    internationalResult,
  ] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*)::int AS total_records,
          COUNT(DISTINCT NULLIF(calling_number, ''))::int AS unique_a_parties,
          COUNT(DISTINCT NULLIF(called_number, ''))::int AS unique_b_parties,
          ROUND(COALESCE(AVG(COALESCE(duration_sec, duration, 0)), 0))::int AS avg_duration_sec
        FROM cdr_records
        WHERE case_id = $1
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(call_type, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM cdr_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 8
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT
          COALESCE(NULLIF(called_number, ''), 'UNKNOWN') AS label,
          COUNT(*)::int AS count,
          COALESCE(SUM(COALESCE(duration_sec, duration, 0)), 0)::bigint AS duration_sec
        FROM cdr_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY count DESC, duration_sec DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(calling_number, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM cdr_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(imei_a, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM cdr_records
        WHERE case_id = $1 AND COALESCE(imei_a, '') <> ''
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT
          LPAD(COALESCE(EXTRACT(HOUR FROM date_time AT TIME ZONE 'Asia/Kolkata')::int, 0)::text, 2, '0') AS hour_label,
          COUNT(*)::int AS count
        FROM cdr_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(call_date, 'UNKNOWN') AS bucket, COUNT(*)::int AS count
        FROM cdr_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY 1 ASC
        LIMIT 31
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT
          COALESCE(NULLIF(first_cell_id, ''), NULLIF(last_cell_id, ''), 'UNKNOWN') AS label,
          COUNT(*)::int AS count,
          COALESCE(SUM(COALESCE(duration_sec, duration, 0)), 0)::bigint AS duration_sec
        FROM cdr_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY count DESC, duration_sec DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT
          COUNT(*)::int AS total_records,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'hour', hour_bucket,
                'count', bucket_count
              )
              ORDER BY bucket_count DESC, hour_bucket ASC
            ) FILTER (WHERE hour_bucket IS NOT NULL),
            '[]'::jsonb
          ) AS peak_hours
        FROM (
          SELECT
            EXTRACT(HOUR FROM date_time AT TIME ZONE 'Asia/Kolkata')::int AS hour_bucket,
            COUNT(*)::int AS bucket_count
          FROM cdr_records
          WHERE case_id = $1
            AND EXTRACT(HOUR FROM date_time AT TIME ZONE 'Asia/Kolkata')::int IN (22, 23, 0, 1, 2, 3, 4, 5)
          GROUP BY 1
        ) x
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT
          COALESCE(call_date, 'UNKNOWN') AS label,
          MIN(call_time) AS first_call_time,
          MAX(call_time) AS last_call_time
        FROM cdr_records
        WHERE case_id = $1
          AND COALESCE(call_date, '') <> ''
        GROUP BY 1
        ORDER BY 1 ASC
        LIMIT 14
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT
          COALESCE(NULLIF(calling_number, ''), 'UNKNOWN') AS label,
          COUNT(*)::int AS count,
          COUNT(DISTINCT NULLIF(call_date, ''))::int AS days_active
        FROM cdr_records
        WHERE case_id = $1
          AND COALESCE(calling_number, '') <> ''
        GROUP BY 1
        ORDER BY count DESC, days_active DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT
          COALESCE(NULLIF(called_number, ''), 'UNKNOWN') AS label,
          COUNT(*)::int AS count
        FROM cdr_records
        WHERE case_id = $1
          AND (
            COALESCE(called_number, '') LIKE '+%'
            OR COALESCE(called_number, '') LIKE '00%'
          )
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
  ]);

  const stats = statsResult.rows[0] || {};
  const nightActivity = nightActivityResult.rows[0] || {};
  const sourceRowCount = Number(stats.total_records || 0);
  const sourceFileCount = await fetchFileCount(caseId);

  const metricFacts = {
    total_records: Number(stats.total_records || 0),
    unique_a_parties: Number(stats.unique_a_parties || 0),
    unique_b_parties: Number(stats.unique_b_parties || 0),
    avg_duration_sec: Number(stats.avg_duration_sec || 0),
    callTypeDistribution: callTypesResult.rows || [],
    topBParties: topBResult.rows || [],
    topLocations: locationResult.rows || [],
    max_imei_numbers: topImeiResult.rows || [],
    night_activity: {
      total_records: Number(nightActivity.total_records || 0),
      peak_hours: Array.isArray(nightActivity.peak_hours) ? nightActivity.peak_hours : [],
    },
    daily_first_last_call: firstLastResult.rows || [],
    regular_callers: regularCallersResult.rows || [],
    international_calls: internationalResult.rows || [],
  };

  const summaryMarkdown = [
    `CDR summary for case ${caseId}`,
    `Total records: ${formatNumber(metricFacts.total_records)}`,
    `Unique A-parties: ${formatNumber(metricFacts.unique_a_parties)}`,
    `Unique B-parties: ${formatNumber(metricFacts.unique_b_parties)}`,
    `Average duration: ${formatDuration(metricFacts.avg_duration_sec)}`,
    `Top B-parties: ${(metricFacts.topBParties || []).slice(0, 5).map((row) => `${row.label} (${formatNumber(row.count)})`).join(', ') || 'None'}`
  ].join('\n');

  const rankedEntities = [
    ...(topBResult.rows || []).map((row, index) => ({
      entityType: 'b_party',
      metricKey: 'topBParties',
      rank: index + 1,
      entityValue: row.label,
      countValue: Number(row.count || 0),
      durationValue: Number(row.duration_sec || 0),
      extraJson: {},
    })),
    ...(topAResult.rows || []).map((row, index) => ({
      entityType: 'a_party',
      metricKey: 'topAParties',
      rank: index + 1,
      entityValue: row.label,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
    ...(topImeiResult.rows || []).map((row, index) => ({
      entityType: 'imei',
      metricKey: 'max_imei_numbers',
      rank: index + 1,
      entityValue: row.label,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
    ...(regularCallersResult.rows || []).map((row, index) => ({
      entityType: 'regular_caller',
      metricKey: 'regular_callers',
      rank: index + 1,
      entityValue: row.label,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: { days_active: Number(row.days_active || 0) },
    })),
    ...(internationalResult.rows || []).map((row, index) => ({
      entityType: 'international_number',
      metricKey: 'international_calls',
      rank: index + 1,
      entityValue: row.label,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
  ];

  const timeSeries = [
    ...(hourlyResult.rows || []).map((row) => ({
      metricKey: 'hourlyActivity',
      bucketKey: `hour:${row.hour_label}`,
      bucketLabel: `${row.hour_label}:00`,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
    ...(dailyResult.rows || []).map((row) => ({
      metricKey: 'dailyActivity',
      bucketKey: `date:${row.bucket}`,
      bucketLabel: row.bucket,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
  ];

  const geoFacts = (locationResult.rows || []).map((row, index) => ({
    dimensionKey: 'cell_id',
    rank: index + 1,
    label: row.label,
    countValue: Number(row.count || 0),
    durationValue: Number(row.duration_sec || 0),
    latitude: null,
    longitude: null,
    extraJson: {},
  }));

  return {
    module: 'cdr',
    sourceRowCount,
    sourceFileCount,
    summaryMarkdown,
    snapshotJson: {
      module: 'cdr',
      label: MODULE_LABELS.cdr,
      metrics: metricFacts,
      computedAt: new Date().toISOString(),
    },
    metricFacts,
    rankedEntities,
    timeSeries,
    geoFacts,
  };
};

const computeIpdrFacts = async (caseId) => {
  const [
    statsResult,
    topSourceIpResult,
    topMsisdnResult,
    topImeiResult,
    topImsiResult,
    protocolResult,
    ratResult,
    hourlyResult,
  ] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*)::int AS total_records,
          COUNT(DISTINCT NULLIF(msisdn, ''))::int AS unique_msisdn,
          COUNT(DISTINCT NULLIF(imei, ''))::int AS unique_imei,
          COUNT(DISTINCT NULLIF(imsi, ''))::int AS unique_imsi
        FROM ipdr_records
        WHERE case_id = $1
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT label, SUM(count)::bigint AS count
        FROM (
          SELECT COALESCE(NULLIF(source_ip, ''), NULLIF(public_ip, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
          FROM ipdr_records
          WHERE case_id = $1
          GROUP BY 1
        ) x
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(msisdn, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM ipdr_records
        WHERE case_id = $1 AND COALESCE(msisdn, '') <> ''
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(imei, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM ipdr_records
        WHERE case_id = $1 AND COALESCE(imei, '') <> ''
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(imsi, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM ipdr_records
        WHERE case_id = $1 AND COALESCE(imsi, '') <> ''
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(protocol, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM ipdr_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 8
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(rat_type, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM ipdr_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 8
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT
          LPAD(
            COALESCE(
              NULLIF(SPLIT_PART(start_time, ':', 1), ''),
              '00'
            ),
            2,
            '0'
          ) AS hour_label,
          COUNT(*)::int AS count
        FROM ipdr_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      [caseId]
    ),
  ]);

  const stats = statsResult.rows[0] || {};
  const sourceRowCount = Number(stats.total_records || 0);
  const sourceFileCount = await fetchFileCount(caseId);
  const metricFacts = {
    total_records: Number(stats.total_records || 0),
    unique_msisdn: Number(stats.unique_msisdn || 0),
    unique_imei: Number(stats.unique_imei || 0),
    unique_imsi: Number(stats.unique_imsi || 0),
    top_source_ips: topSourceIpResult.rows || [],
    top_msisdn: topMsisdnResult.rows || [],
    max_imei_numbers: topImeiResult.rows || [],
    max_imsi_numbers: topImsiResult.rows || [],
    top_protocols: protocolResult.rows || [],
    top_rat_types: ratResult.rows || [],
  };

  const summaryMarkdown = [
    `IPDR summary for case ${caseId}`,
    `Total records: ${formatNumber(metricFacts.total_records)}`,
    `Unique MSISDN: ${formatNumber(metricFacts.unique_msisdn)}`,
    `Unique IMEI: ${formatNumber(metricFacts.unique_imei)}`,
    `Unique IMSI: ${formatNumber(metricFacts.unique_imsi)}`,
    `Top IPs: ${(metricFacts.top_source_ips || []).slice(0, 5).map((row) => `${row.label} (${formatNumber(row.count)})`).join(', ') || 'None'}`
  ].join('\n');

  const rankedEntities = [
    ...(topSourceIpResult.rows || []).map((row, index) => ({
      entityType: 'source_ip',
      metricKey: 'top_source_ips',
      rank: index + 1,
      entityValue: row.label,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
    ...(topMsisdnResult.rows || []).map((row, index) => ({
      entityType: 'msisdn',
      metricKey: 'top_msisdn',
      rank: index + 1,
      entityValue: row.label,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
    ...(topImeiResult.rows || []).map((row, index) => ({
      entityType: 'imei',
      metricKey: 'max_imei_numbers',
      rank: index + 1,
      entityValue: row.label,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
    ...(topImsiResult.rows || []).map((row, index) => ({
      entityType: 'imsi',
      metricKey: 'max_imsi_numbers',
      rank: index + 1,
      entityValue: row.label,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
  ];

  const timeSeries = (hourlyResult.rows || []).map((row) => ({
    metricKey: 'hourlyActivity',
    bucketKey: `hour:${row.hour_label}`,
    bucketLabel: `${row.hour_label}:00`,
    countValue: Number(row.count || 0),
    durationValue: null,
    extraJson: {},
  }));

  return {
    module: 'ipdr',
    sourceRowCount,
    sourceFileCount,
    summaryMarkdown,
    snapshotJson: {
      module: 'ipdr',
      label: MODULE_LABELS.ipdr,
      metrics: metricFacts,
      computedAt: new Date().toISOString(),
    },
    metricFacts,
    rankedEntities,
    timeSeries,
    geoFacts: [],
  };
};

const computeSdrFacts = async (caseId) => {
  const [statsResult, topNamesResult, topPhoneResult, operatorResult] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*)::int AS total_records,
          COUNT(DISTINCT NULLIF(msisdn, ''))::int AS unique_msisdn,
          COUNT(DISTINCT NULLIF(subscriber_name, ''))::int AS unique_subscribers,
          COUNT(DISTINCT NULLIF(imei, ''))::int AS unique_imei
        FROM sdr_records
        WHERE case_id = $1
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(subscriber_name, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM sdr_records
        WHERE case_id = $1
          AND COALESCE(subscriber_name, '') <> ''
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(msisdn, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM sdr_records
        WHERE case_id = $1
          AND COALESCE(msisdn, '') <> ''
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(operator, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM sdr_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 8
      `,
      [caseId]
    ),
  ]);

  const stats = statsResult.rows[0] || {};
  const sourceRowCount = Number(stats.total_records || 0);
  const sourceFileCount = await fetchFileCount(caseId);
  const metricFacts = {
    total_records: Number(stats.total_records || 0),
    unique_msisdn: Number(stats.unique_msisdn || 0),
    unique_subscribers: Number(stats.unique_subscribers || 0),
    unique_imei: Number(stats.unique_imei || 0),
    topSubscriberNames: topNamesResult.rows || [],
    topPhoneNumbers: topPhoneResult.rows || [],
    operatorBreakdown: operatorResult.rows || [],
  };

  return {
    module: 'sdr',
    sourceRowCount,
    sourceFileCount,
    summaryMarkdown: [
      `SDR summary for case ${caseId}`,
      `Total records: ${formatNumber(metricFacts.total_records)}`,
      `Unique subscribers: ${formatNumber(metricFacts.unique_subscribers)}`,
      `Top subscriber names: ${(metricFacts.topSubscriberNames || []).slice(0, 5).map((row) => `${row.label} (${formatNumber(row.count)})`).join(', ') || 'None'}`
    ].join('\n'),
    snapshotJson: {
      module: 'sdr',
      label: MODULE_LABELS.sdr,
      metrics: metricFacts,
      computedAt: new Date().toISOString(),
    },
    metricFacts,
    rankedEntities: [
      ...(topNamesResult.rows || []).map((row, index) => ({
        entityType: 'subscriber_name',
        metricKey: 'topSubscriberNames',
        rank: index + 1,
        entityValue: row.label,
        countValue: Number(row.count || 0),
        durationValue: null,
        extraJson: {},
      })),
      ...(topPhoneResult.rows || []).map((row, index) => ({
        entityType: 'msisdn',
        metricKey: 'topPhoneNumbers',
        rank: index + 1,
        entityValue: row.label,
        countValue: Number(row.count || 0),
        durationValue: null,
        extraJson: {},
      })),
    ],
    timeSeries: [],
    geoFacts: [],
  };
};

const computeTowerFacts = async (caseId) => {
  const [statsResult, topCellsResult, topPartiesResult, hourlyResult] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*)::int AS total_records,
          COUNT(DISTINCT NULLIF(a_party, ''))::int AS unique_a_parties,
          COUNT(DISTINCT NULLIF(b_party, ''))::int AS unique_b_parties,
          ROUND(COALESCE(AVG(COALESCE(duration_sec, 0)), 0))::int AS avg_duration_sec
        FROM tower_dump_records
        WHERE case_id = $1
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(first_cell_id, ''), NULLIF(cell_id, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM tower_dump_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(a_party, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM tower_dump_records
        WHERE case_id = $1
          AND COALESCE(a_party, '') <> ''
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT
          LPAD(COALESCE(EXTRACT(HOUR FROM start_time AT TIME ZONE 'Asia/Kolkata')::int, 0)::text, 2, '0') AS hour_label,
          COUNT(*)::int AS count
        FROM tower_dump_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      [caseId]
    ),
  ]);

  const stats = statsResult.rows[0] || {};
  const sourceRowCount = Number(stats.total_records || 0);
  const sourceFileCount = await fetchFileCount(caseId);
  const metricFacts = {
    total_records: Number(stats.total_records || 0),
    unique_a_parties: Number(stats.unique_a_parties || 0),
    unique_b_parties: Number(stats.unique_b_parties || 0),
    avg_duration_sec: Number(stats.avg_duration_sec || 0),
    topCells: topCellsResult.rows || [],
    topParties: topPartiesResult.rows || [],
  };

  return {
    module: 'tower',
    sourceRowCount,
    sourceFileCount,
    summaryMarkdown: [
      `Tower Dump summary for case ${caseId}`,
      `Total records: ${formatNumber(metricFacts.total_records)}`,
      `Unique A-parties: ${formatNumber(metricFacts.unique_a_parties)}`,
      `Unique B-parties: ${formatNumber(metricFacts.unique_b_parties)}`,
      `Top cells: ${(metricFacts.topCells || []).slice(0, 5).map((row) => `${row.label} (${formatNumber(row.count)})`).join(', ') || 'None'}`
    ].join('\n'),
    snapshotJson: {
      module: 'tower',
      label: MODULE_LABELS.tower,
      metrics: metricFacts,
      computedAt: new Date().toISOString(),
    },
    metricFacts,
    rankedEntities: [
      ...(topCellsResult.rows || []).map((row, index) => ({
        entityType: 'cell_id',
        metricKey: 'topCells',
        rank: index + 1,
        entityValue: row.label,
        countValue: Number(row.count || 0),
        durationValue: null,
        extraJson: {},
      })),
      ...(topPartiesResult.rows || []).map((row, index) => ({
        entityType: 'party',
        metricKey: 'topParties',
        rank: index + 1,
        entityValue: row.label,
        countValue: Number(row.count || 0),
        durationValue: null,
        extraJson: {},
      })),
    ],
    timeSeries: (hourlyResult.rows || []).map((row) => ({
      metricKey: 'hourlyActivity',
      bucketKey: `hour:${row.hour_label}`,
      bucketLabel: `${row.hour_label}:00`,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
    geoFacts: (topCellsResult.rows || []).map((row, index) => ({
      dimensionKey: 'cell_id',
      rank: index + 1,
      label: row.label,
      countValue: Number(row.count || 0),
      durationValue: null,
      latitude: null,
      longitude: null,
      extraJson: {},
    })),
  };
};

const computeIldFacts = async (caseId) => {
  const [statsResult, topCalledResult, topCountriesResult, dailyResult, directionResult] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*)::int AS total_records,
          COUNT(DISTINCT NULLIF(calling_party, ''))::int AS unique_calling_numbers,
          COUNT(DISTINCT NULLIF(called_party, ''))::int AS unique_called_numbers,
          ROUND(COALESCE(AVG(COALESCE(duration_sec, duration, 0)), 0))::int AS avg_duration_sec
        FROM ild_records
        WHERE case_id = $1
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(called_party, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM ild_records
        WHERE case_id = $1
          AND COALESCE(called_party, '') <> ''
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(destination_country, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM ild_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 10
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(call_date, 'UNKNOWN') AS bucket, COUNT(*)::int AS count
        FROM ild_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY 1 ASC
        LIMIT 31
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(call_direction, ''), 'UNKNOWN') AS label, COUNT(*)::int AS count
        FROM ild_records
        WHERE case_id = $1
        GROUP BY 1
        ORDER BY count DESC, label ASC
        LIMIT 8
      `,
      [caseId]
    ),
  ]);

  const stats = statsResult.rows[0] || {};
  const sourceRowCount = Number(stats.total_records || 0);
  const sourceFileCount = await fetchFileCount(caseId);
  const metricFacts = {
    total_records: Number(stats.total_records || 0),
    unique_calling_numbers: Number(stats.unique_calling_numbers || 0),
    unique_called_numbers: Number(stats.unique_called_numbers || 0),
    avg_duration_sec: Number(stats.avg_duration_sec || 0),
    topCalledParties: topCalledResult.rows || [],
    topCountries: topCountriesResult.rows || [],
    directionBreakdown: directionResult.rows || [],
  };

  return {
    module: 'ild',
    sourceRowCount,
    sourceFileCount,
    summaryMarkdown: [
      `ILD summary for case ${caseId}`,
      `Total records: ${formatNumber(metricFacts.total_records)}`,
      `Unique calling numbers: ${formatNumber(metricFacts.unique_calling_numbers)}`,
      `Unique called numbers: ${formatNumber(metricFacts.unique_called_numbers)}`,
      `Top countries: ${(metricFacts.topCountries || []).slice(0, 5).map((row) => `${row.label} (${formatNumber(row.count)})`).join(', ') || 'None'}`
    ].join('\n'),
    snapshotJson: {
      module: 'ild',
      label: MODULE_LABELS.ild,
      metrics: metricFacts,
      computedAt: new Date().toISOString(),
    },
    metricFacts,
    rankedEntities: [
      ...(topCalledResult.rows || []).map((row, index) => ({
        entityType: 'called_party',
        metricKey: 'topCalledParties',
        rank: index + 1,
        entityValue: row.label,
        countValue: Number(row.count || 0),
        durationValue: null,
        extraJson: {},
      })),
      ...(topCountriesResult.rows || []).map((row, index) => ({
        entityType: 'destination_country',
        metricKey: 'topCountries',
        rank: index + 1,
        entityValue: row.label,
        countValue: Number(row.count || 0),
        durationValue: null,
        extraJson: {},
      })),
    ],
    timeSeries: (dailyResult.rows || []).map((row) => ({
      metricKey: 'dailyActivity',
      bucketKey: `date:${row.bucket}`,
      bucketLabel: row.bucket,
      countValue: Number(row.count || 0),
      durationValue: null,
      extraJson: {},
    })),
    geoFacts: [],
  };
};

const MODULE_COMPUTERS = {
  cdr: computeCdrFacts,
  ipdr: computeIpdrFacts,
  sdr: computeSdrFacts,
  tower: computeTowerFacts,
  ild: computeIldFacts,
};

const buildGlobalCaseArtifact = async (caseId) => {
  const [caseResult, snapshotResult] = await Promise.all([
    pool.query(
      `
        SELECT id, case_name, case_number, fir_number, status, priority, description, operator, updated_at
        FROM cases
        WHERE id = $1
        LIMIT 1
      `,
      [caseId]
    ),
    pool.query(
      `
        SELECT module, snapshot_json, summary_markdown, computed_at
        FROM case_module_snapshots
        WHERE case_id = $1
        ORDER BY module ASC
      `,
      [caseId]
    ),
  ]);

  const caseRow = caseResult.rows[0] || null;
  if (!caseRow) return null;

  const moduleSummaries = Object.fromEntries(
    (snapshotResult.rows || []).map((row) => [normalizeBucketKey(row.module), {
      summary: row.summary_markdown || '',
      snapshot: row.snapshot_json || {},
      computedAt: row.computed_at || null,
    }])
  );

  return {
    caseId: String(caseRow.id),
    caseLabel: caseRow.case_name || caseRow.case_number || `Case ${caseRow.id}`,
    caseNumber: caseRow.case_number || null,
    firNumber: caseRow.fir_number || null,
    status: caseRow.status || null,
    priority: caseRow.priority || null,
    operator: caseRow.operator || null,
    description: caseRow.description || null,
    updatedAt: caseRow.updated_at || null,
    modules: moduleSummaries,
  };
};

export const refreshCaseKnowledge = async ({
  caseId,
  modules = MODULES,
  reason = 'manual',
} = {}) => {
  const normalizedCaseId = toInt(caseId);
  if (!normalizedCaseId) throw new Error('caseId is required to refresh case knowledge');

  const normalizedModules = [...new Set((Array.isArray(modules) ? modules : MODULES).map(normalizeBucketKey))]
    .filter((module) => MODULES.includes(module));
  const requestedModules = normalizedModules.length > 0 ? normalizedModules : MODULES;
  const caseVersion = buildCaseVersion();
  const jobId = await createKnowledgeJob({
    caseId: normalizedCaseId,
    requestedModules,
    reason,
  });
  const artifactManifest = {};

  try {
    await markKnowledgeJobRunning({
      jobId,
      caseVersion,
      artifactBucket: getSupabaseBucket('knowledge'),
    });

    for (const module of requestedModules) {
      const computer = MODULE_COMPUTERS[module];
      if (!computer) continue;

      const computed = await computer(normalizedCaseId);
      await upsertModuleSnapshot({
        caseId: normalizedCaseId,
        module,
        summaryMarkdown: computed.summaryMarkdown,
        snapshotJson: computed.snapshotJson,
        sourceRowCount: computed.sourceRowCount,
        sourceFileCount: computed.sourceFileCount,
        caseVersion,
      });
      await replaceMetricFacts({
        caseId: normalizedCaseId,
        module,
        caseVersion,
        sourceRowCount: computed.sourceRowCount,
        sourceFileCount: computed.sourceFileCount,
        facts: computed.metricFacts,
      });
      await replaceRankedEntities({
        caseId: normalizedCaseId,
        module,
        caseVersion,
        sourceRowCount: computed.sourceRowCount,
        sourceFileCount: computed.sourceFileCount,
        rows: computed.rankedEntities,
      });
      await replaceTimeSeriesFacts({
        caseId: normalizedCaseId,
        module,
        caseVersion,
        sourceRowCount: computed.sourceRowCount,
        sourceFileCount: computed.sourceFileCount,
        rows: computed.timeSeries,
      });
      await replaceGeoFacts({
        caseId: normalizedCaseId,
        module,
        caseVersion,
        sourceRowCount: computed.sourceRowCount,
        sourceFileCount: computed.sourceFileCount,
        rows: computed.geoFacts,
      });

      const summaryArtifact = {
        caseId: String(normalizedCaseId),
        module,
        label: MODULE_LABELS[module],
        computedAt: new Date().toISOString(),
        summaryMarkdown: computed.summaryMarkdown,
        snapshot: computed.snapshotJson,
      };
      const jsonArtifact = await writeArtifact({
        caseId: normalizedCaseId,
        module,
        fileName: 'summary.json',
        content: summaryArtifact,
        contentType: 'application/json',
      });
      const mdArtifact = await writeArtifact({
        caseId: normalizedCaseId,
        module,
        fileName: 'summary.md',
        content: computed.summaryMarkdown,
        contentType: 'text/markdown',
      });
      artifactManifest[module] = {
        summaryJsonPath: jsonArtifact?.objectPath || null,
        summaryMarkdownPath: mdArtifact?.objectPath || null,
      };
    }

    const globalArtifact = await buildGlobalCaseArtifact(normalizedCaseId);
    if (globalArtifact) {
      const globalJson = await writeArtifact({
        caseId: normalizedCaseId,
        module: 'global',
        fileName: 'case-summary.json',
        content: globalArtifact,
        contentType: 'application/json',
      });
      const globalMd = await writeArtifact({
        caseId: normalizedCaseId,
        module: 'global',
        fileName: 'case-brief.md',
        content: [
          `Case: ${globalArtifact.caseLabel}`,
          globalArtifact.caseNumber ? `Case Number: ${globalArtifact.caseNumber}` : null,
          globalArtifact.firNumber ? `FIR Number: ${globalArtifact.firNumber}` : null,
          globalArtifact.status ? `Status: ${globalArtifact.status}` : null,
          globalArtifact.operator ? `Operator: ${globalArtifact.operator}` : null,
          '',
          ...Object.entries(globalArtifact.modules || {}).map(([module, value]) =>
            `## ${MODULE_LABELS[module] || module.toUpperCase()}\n${value.summary || 'No summary available.'}`
          )
        ].filter(Boolean).join('\n'),
        contentType: 'text/markdown',
      });
      artifactManifest.global = {
        summaryJsonPath: globalJson?.objectPath || null,
        summaryMarkdownPath: globalMd?.objectPath || null,
      };
    }

    await markKnowledgeJobCompleted({
      jobId,
      artifactManifest,
      caseVersion,
    });

    return {
      jobId,
      caseVersion,
      artifactManifest,
      modules: requestedModules,
    };
  } catch (error) {
    await markKnowledgeJobFailed({
      jobId,
      errorText: error?.message || String(error),
    });
    throw error;
  }
};

export const queueCaseKnowledgeRefresh = ({
  caseId,
  modules = MODULES,
  reason = 'background_refresh',
} = {}) => {
  const normalizedCaseId = toInt(caseId);
  if (!normalizedCaseId) return null;

  const existing = refreshPromises.get(normalizedCaseId);
  if (existing) return existing;

  const promise = Promise.resolve()
    .then(() => refreshCaseKnowledge({ caseId: normalizedCaseId, modules, reason }))
    .catch((error) => {
      console.error('[CHATBOT][KNOWLEDGE] Background refresh failed:', error?.message || error);
      return null;
    })
    .finally(() => {
      refreshPromises.delete(normalizedCaseId);
    });

  refreshPromises.set(normalizedCaseId, promise);
  return promise;
};

export const getLatestKnowledgeJob = async (caseId) => {
  const normalizedCaseId = toInt(caseId);
  if (!normalizedCaseId) return null;
  const result = await pool.query(
    `
      SELECT *
      FROM case_knowledge_jobs
      WHERE case_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedCaseId]
  );
  return result.rows[0] || null;
};

const fetchModuleSnapshotRows = async (caseId, modules = MODULES) => {
  const result = await pool.query(
    `
      SELECT *
      FROM case_module_snapshots
      WHERE case_id = $1
        AND module = ANY($2::text[])
    `,
    [caseId, modules]
  );
  return result.rows || [];
};

export const ensureCaseKnowledgeFresh = async (caseId, modules = MODULES) => {
  const normalizedCaseId = toInt(caseId);
  if (!normalizedCaseId) throw new Error('caseId is required');
  const normalizedModules = [...new Set((Array.isArray(modules) ? modules : MODULES).map(normalizeBucketKey))]
    .filter((module) => MODULES.includes(module));
  const requestedModules = normalizedModules.length > 0 ? normalizedModules : MODULES;
  const snapshots = await fetchModuleSnapshotRows(normalizedCaseId, requestedModules);
  const now = Date.now();
  const staleModules = requestedModules.filter((module) => {
    const row = snapshots.find((entry) => normalizeBucketKey(entry.module) === module);
    if (!row?.computed_at) return true;
    const ageMs = now - new Date(row.computed_at).getTime();
    return !Number.isFinite(ageMs) || ageMs > KNOWLEDGE_FRESH_TTL_MS;
  });

  if (staleModules.length > 0) {
    const inFlight = refreshPromises.get(normalizedCaseId);
    if (inFlight) {
      await inFlight;
    } else {
      await refreshCaseKnowledge({
        caseId: normalizedCaseId,
        modules: staleModules,
        reason: 'on_demand_query',
      });
    }
  }

  const latestSnapshots = await fetchModuleSnapshotRows(normalizedCaseId, requestedModules);
  const latestJob = await getLatestKnowledgeJob(normalizedCaseId);
  return {
    snapshots: latestSnapshots,
    latestJob,
    stale: staleModules.length > 0 && latestSnapshots.length === 0,
  };
};

const fetchMetricFact = async (caseId, module, metricKey) => {
  const result = await pool.query(
    `
      SELECT *
      FROM case_metric_facts
      WHERE case_id = $1
        AND module = $2
        AND metric_key = $3
      LIMIT 1
    `,
    [caseId, module, metricKey]
  );
  return result.rows[0] || null;
};

const fetchRankedEntities = async (caseId, module, metricKey, entityType, limit = 5) => {
  const result = await pool.query(
    `
      SELECT rank, entity_value, count_value, duration_value, extra_json, computed_at, case_version
      FROM case_ranked_entities
      WHERE case_id = $1
        AND module = $2
        AND metric_key = $3
        AND entity_type = $4
      ORDER BY rank ASC
      LIMIT $5
    `,
    [caseId, module, metricKey, entityType, Math.max(1, Math.min(50, Number(limit || 5)))]
  );
  return result.rows || [];
};

const fetchTimeSeries = async (caseId, module, metricKey) => {
  const result = await pool.query(
    `
      SELECT bucket_key, bucket_label, count_value, duration_value, extra_json, computed_at, case_version
      FROM case_time_series_facts
      WHERE case_id = $1
        AND module = $2
        AND metric_key = $3
      ORDER BY bucket_key ASC
    `,
    [caseId, module, metricKey]
  );
  return result.rows || [];
};

const fetchGeoFacts = async (caseId, module, dimensionKey, limit = 10) => {
  const result = await pool.query(
    `
      SELECT rank, label, count_value, duration_value, latitude, longitude, extra_json, computed_at, case_version
      FROM case_geo_facts
      WHERE case_id = $1
        AND module = $2
        AND dimension_key = $3
      ORDER BY rank ASC
      LIMIT $4
    `,
    [caseId, module, dimensionKey, Math.max(1, Math.min(50, Number(limit || 10)))]
  );
  return result.rows || [];
};

const METRIC_ALIASES = {
  max_b_parties: { module: 'cdr', metricKey: 'topBParties', entityType: 'b_party' },
  topBParties: { module: 'cdr', metricKey: 'topBParties', entityType: 'b_party' },
  max_imei_numbers: { metricKey: 'max_imei_numbers', entityType: 'imei' },
  max_imsi_numbers: { metricKey: 'max_imsi_numbers', entityType: 'imsi' },
  top_source_ips: { module: 'ipdr', metricKey: 'top_source_ips', entityType: 'source_ip' },
  top_msisdn: { module: 'ipdr', metricKey: 'top_msisdn', entityType: 'msisdn' },
  topSubscriberNames: { module: 'sdr', metricKey: 'topSubscriberNames', entityType: 'subscriber_name' },
  topPhoneNumbers: { module: 'sdr', metricKey: 'topPhoneNumbers', entityType: 'msisdn' },
  topCells: { module: 'tower', metricKey: 'topCells', entityType: 'cell_id' },
  topParties: { module: 'tower', metricKey: 'topParties', entityType: 'party' },
  topCalledParties: { module: 'ild', metricKey: 'topCalledParties', entityType: 'called_party' },
  topCountries: { module: 'ild', metricKey: 'topCountries', entityType: 'destination_country' },
  international_calls: { module: 'cdr', metricKey: 'international_calls', entityType: 'international_number' },
  regular_callers: { module: 'cdr', metricKey: 'regular_callers', entityType: 'regular_caller' },
  topLocations: { module: 'cdr', metricKey: 'topLocations', entityType: 'cell_id' },
};

const isSummaryIntent = (message = '') =>
  /\b(summary|summarize|overview|highlights|brief|briefing|what does this show)\b/i.test(String(message || ''));

const extractTopN = (message = '', fallback = 5) => {
  const match = String(message || '').match(/\btop\s+(\d{1,3})\b/i);
  if (!match) return fallback;
  return Math.max(1, Math.min(50, Number(match[1] || fallback)));
};

const buildRefusalPayload = ({ reasonCode, message }) => ({
  version: 'grounded-answer-v1',
  kind: 'refusal',
  title: 'Case-Grounded Chat',
  subtitle: null,
  shortAnswer: message,
  evidence: [],
  actions: [],
  followUps: [],
  emptyState: message,
  debugMeta: {
    reasonCode,
    renderKind: 'refusal',
    queryKind: 'refusal',
  },
});

const buildExactPayload = ({ title, shortAnswer, rows = [], columns = [], provenance, freshness, kind = 'exact' }) => ({
  version: 'grounded-answer-v1',
  kind,
  title,
  subtitle: null,
  shortAnswer,
  evidence: rows.length > 0 ? [{
    type: 'table',
    columns,
    previewRows: rows,
    rows,
    totalCount: rows.length,
  }] : [],
  actions: [],
  followUps: [],
  emptyState: null,
  debugMeta: {
    provenance,
    freshness,
    renderKind: kind,
    queryKind: kind,
  },
});

export const logCaseChatQuery = async ({
  caseId,
  userId = null,
  sessionId = null,
  queryText,
  routeUsed,
  responseMode,
  refusalCode = null,
  latencyMs = null,
  freshness = {},
  metadata = {},
}) => {
  try {
    await pool.query(
      `
        INSERT INTO case_chat_query_log (
          case_id, user_id, session_id, query_text, route_used, response_mode, refusal_code, latency_ms, freshness, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
      `,
      [
        caseId || null,
        userId || null,
        sessionId || null,
        String(queryText || ''),
        routeUsed,
        responseMode,
        refusalCode,
        latencyMs,
        JSON.stringify(freshness || {}),
        JSON.stringify(metadata || {}),
      ]
    );
  } catch (error) {
    console.error('[CHATBOT][KNOWLEDGE] Query log failed:', error?.message || error);
  }
};

export const buildCaseGroundedRefusal = (reasonCode) => {
  const messageMap = {
    CASE_TAG_REQUIRED: 'I can only answer case-grounded questions when exactly one case is tagged.',
    MULTI_CASE_NOT_SUPPORTED: 'I can answer only one tagged case at a time.',
    CASE_NOT_ACCESSIBLE: 'I cannot access the tagged case.',
    QUERY_NOT_GROUNDED: EXACT_FALLBACK_MESSAGE,
    METRIC_NOT_SUPPORTED: EXACT_FALLBACK_MESSAGE,
    NO_CASE_DATA: 'No verified data is available for the tagged case.',
    STALE_CONTEXT_REBUILDING: 'The tagged case is still rebuilding its verified knowledge. Please try again shortly.',
  };
  const shortAnswer = messageMap[reasonCode] || EXACT_FALLBACK_MESSAGE;
  return {
    responseText: shortAnswer,
    answerPayload: buildRefusalPayload({ reasonCode, message: shortAnswer }),
    refusalCode: reasonCode,
    mode: 'refusal',
  };
};

const buildFreshnessMeta = (row = null) => ({
  computedAt: row?.computed_at || null,
  caseVersion: row?.case_version || null,
  stale: false,
});

export const buildCaseSummaryAnswer = async ({ caseId, message }) => {
  await ensureCaseKnowledgeFresh(caseId, MODULES);
  const overview = await readArtifact({
    artifactPath: getArtifactPath(caseId, 'global', 'case-brief.md'),
  });
  if (!overview) return buildCaseGroundedRefusal('NO_CASE_DATA');

  return {
    mode: 'summary',
    responseText: overview.trim(),
    answerPayload: buildExactPayload({
      title: 'Case Summary',
      shortAnswer: overview.trim(),
      rows: [],
      columns: [],
      provenance: { source: 'case-knowledge-artifacts/global/case-brief.md', exact: false },
      freshness: { note: 'summary artifact' },
      kind: 'summary',
    }),
  };
};

export const buildExactCaseAnswer = async ({
  caseId,
  caseLabel,
  message,
  moduleHint = null,
}) => {
  const metricDefinition = resolveMetricDefinition({ message, module: moduleHint });
  if (!metricDefinition) return buildCaseGroundedRefusal('METRIC_NOT_SUPPORTED');

  const metricKey = metricDefinition.key;
  const mapping = METRIC_ALIASES[metricKey] || {};
  const module = mapping.module || moduleHint || (metricDefinition.modules?.length === 1 ? metricDefinition.modules[0] : null);
  if (!module) return buildCaseGroundedRefusal('METRIC_NOT_SUPPORTED');

  await ensureCaseKnowledgeFresh(caseId, [module]);
  const topN = extractTopN(message, 5);

  if (metricDefinition.answerType === 'scalar') {
    const fact = await fetchMetricFact(caseId, module, metricKey);
    if (!fact) return buildCaseGroundedRefusal('NO_CASE_DATA');
    const value = fact.metric_value;
    const scalarValue =
      value && typeof value === 'object' && !Array.isArray(value) && 'value' in value
        ? value.value
        : value;
    const formattedValue = typeof scalarValue === 'number' ? formatNumber(scalarValue) : String(scalarValue ?? '-');
    const responseText = `${metricDefinition.displayLabel} for ${MODULE_LABELS[module]} in case "${caseLabel}": ${formattedValue}`;
    return {
      mode: 'exact',
      responseText,
      answerPayload: buildExactPayload({
        title: metricDefinition.displayLabel,
        shortAnswer: responseText,
        provenance: { source: 'case_metric_facts', exact: true, metricKey, module },
        freshness: buildFreshnessMeta(fact),
      }),
    };
  }

  if (metricKey === 'hourlyActivity') {
    const rows = await fetchTimeSeries(caseId, module, 'hourlyActivity');
    if (!rows.length) return buildCaseGroundedRefusal('NO_CASE_DATA');
    const previewRows = rows.map((row) => ({
      hour: row.bucket_label,
      count: formatNumber(row.count_value || 0),
    }));
    const responseText = [
      `Hourly activity for ${MODULE_LABELS[module]} in case "${caseLabel}":`,
      ...previewRows.map((row, index) => `${index + 1}. ${row.hour} — ${row.count}`)
    ].join('\n');
    return {
      mode: 'exact',
      responseText,
      answerPayload: buildExactPayload({
        title: metricDefinition.displayLabel,
        shortAnswer: responseText,
        rows: previewRows,
        columns: [
          { key: 'hour', label: 'Hour' },
          { key: 'count', label: 'Count' },
        ],
        provenance: { source: 'case_time_series_facts', exact: true, metricKey, module },
        freshness: buildFreshnessMeta(rows[0]),
      }),
    };
  }

  if (metricKey === 'topLocations') {
    const rows = await fetchGeoFacts(caseId, module, 'cell_id', topN);
    if (!rows.length) return buildCaseGroundedRefusal('NO_CASE_DATA');
    const previewRows = rows.map((row) => ({
      rank: String(row.rank),
      label: row.label,
      count: formatNumber(row.count_value || 0),
      duration: formatDuration(row.duration_value || 0),
    }));
    const responseText = [
      `Top ${previewRows.length} locations from ${MODULE_LABELS[module]} for case "${caseLabel}":`,
      ...previewRows.map((row) => `${row.rank}. ${row.label} — ${row.count} events — ${row.duration}`)
    ].join('\n');
    return {
      mode: 'exact',
      responseText,
      answerPayload: buildExactPayload({
        title: metricDefinition.displayLabel,
        shortAnswer: responseText,
        rows: previewRows,
        columns: [
          { key: 'rank', label: '#' },
          { key: 'label', label: 'Location' },
          { key: 'count', label: 'Events' },
          { key: 'duration', label: 'Duration' },
        ],
        provenance: { source: 'case_geo_facts', exact: true, metricKey, module },
        freshness: buildFreshnessMeta(rows[0]),
      }),
    };
  }

  if (metricKey === 'module_summary' || metricKey === 'advanced_summary') {
    return buildCaseSummaryAnswer({ caseId, message });
  }

  if (metricKey === 'night_activity' || metricKey === 'sms_analysis' || metricKey === 'home_and_work' || metricKey === 'daily_first_last_call') {
    const fact = await fetchMetricFact(caseId, module, metricKey);
    if (!fact) return buildCaseGroundedRefusal('NO_CASE_DATA');
    const responseText =
      metricKey === 'daily_first_last_call' && Array.isArray(fact.metric_value)
        ? [
          `${metricDefinition.displayLabel} for ${MODULE_LABELS[module]} in case "${caseLabel}":`,
          ...fact.metric_value.slice(0, topN).map((row, index) => `${index + 1}. ${row.label} — first ${row.first_call_time || '-'} — last ${row.last_call_time || '-'}`)
        ].join('\n')
        : `${metricDefinition.displayLabel} for ${MODULE_LABELS[module]} in case "${caseLabel}": ${typeof fact.metric_value === 'string' ? fact.metric_value : safeJson(fact.metric_value)}`;
    return {
      mode: 'exact',
      responseText,
      answerPayload: buildExactPayload({
        title: metricDefinition.displayLabel,
        shortAnswer: responseText,
        provenance: { source: 'case_metric_facts', exact: true, metricKey, module },
        freshness: buildFreshnessMeta(fact),
      }),
    };
  }

  const entityType = mapping.entityType;
  const metricLookupKey = mapping.metricKey || metricKey;
  if (!entityType) return buildCaseGroundedRefusal('METRIC_NOT_SUPPORTED');
  const rows = await fetchRankedEntities(caseId, module, metricLookupKey, entityType, topN);
  if (!rows.length) return buildCaseGroundedRefusal('NO_CASE_DATA');

  const previewRows = rows.map((row) => ({
    rank: String(row.rank),
    value: row.entity_value,
    count: formatNumber(row.count_value || 0),
    duration: row.duration_value != null ? formatDuration(row.duration_value) : null,
    extra: row.extra_json || {},
  }));
  const title = `${metricDefinition.displayLabel} from ${MODULE_LABELS[module]} for case "${caseLabel}"`;
  const responseLines = previewRows.map((row) => {
    const base = `${row.rank}. ${row.value} — ${row.count}`;
    if (row.duration) return `${base} interactions — ${row.duration}`;
    if (row.extra?.days_active) return `${base} records — ${formatNumber(row.extra.days_active)} active day(s)`;
    return `${base}`;
  });

  return {
    mode: 'exact',
    responseText: [title + ':', ...responseLines].join('\n'),
    answerPayload: buildExactPayload({
      title: metricDefinition.displayLabel,
      shortAnswer: [title + ':', ...responseLines].join('\n'),
      rows: previewRows.map((row) => ({
        rank: row.rank,
        value: row.value,
        count: row.count,
        duration: row.duration || '-',
      })),
      columns: [
        { key: 'rank', label: '#' },
        { key: 'value', label: 'Value' },
        { key: 'count', label: 'Count' },
        { key: 'duration', label: 'Duration' },
      ],
      provenance: { source: 'case_ranked_entities', exact: true, metricKey: metricLookupKey, module, entityType },
      freshness: buildFreshnessMeta(rows[0]),
    }),
  };
};

export const readCaseKnowledgeArtifact = async ({ caseId, module = 'global', artifactKey = 'case-summary.json' }) => {
  await ensureCaseKnowledgeFresh(caseId, module === 'global' ? MODULES : [module]);
  const artifactPath = getArtifactPath(caseId, module, artifactKey);
  return readArtifact({ artifactPath });
};

export const getCaseContextSummary = async ({ caseId, module = null }) => {
  await ensureCaseKnowledgeFresh(caseId, module ? [module] : MODULES);
  if (!module) {
    const artifact = await readCaseKnowledgeArtifact({ caseId, module: 'global', artifactKey: 'case-summary.json' });
    return artifact ? JSON.parse(artifact) : null;
  }

  const result = await pool.query(
    `
      SELECT *
      FROM case_module_snapshots
      WHERE case_id = $1
        AND module = $2
      LIMIT 1
    `,
    [caseId, module]
  );
  return result.rows[0] || null;
};

export const getCaseContextScalar = async ({ caseId, module, metricKey }) => {
  await ensureCaseKnowledgeFresh(caseId, [module]);
  return fetchMetricFact(caseId, module, metricKey);
};

export const getCaseContextTopEntities = async ({ caseId, module, metricKey, entityType, limit = 5 }) => {
  await ensureCaseKnowledgeFresh(caseId, [module]);
  return fetchRankedEntities(caseId, module, metricKey, entityType, limit);
};

export const getCaseContextTimeSeries = async ({ caseId, module, metricKey }) => {
  await ensureCaseKnowledgeFresh(caseId, [module]);
  return fetchTimeSeries(caseId, module, metricKey);
};

export const getCaseContextGeoFacts = async ({ caseId, module, dimensionKey, limit = 10 }) => {
  await ensureCaseKnowledgeFresh(caseId, [module]);
  return fetchGeoFacts(caseId, module, dimensionKey, limit);
};

export const getCrossModuleOverlap = async ({ caseId, entityValue }) => {
  const normalizedCaseId = toInt(caseId);
  if (!normalizedCaseId || !entityValue) return [];
  const value = String(entityValue).trim();
  const result = await pool.query(
    `
      WITH hits AS (
        SELECT 'cdr'::text AS module
        FROM cdr_records
        WHERE case_id = $1
          AND (
            COALESCE(calling_number, '') = $2
            OR COALESCE(called_number, '') = $2
            OR COALESCE(imei_a, '') = $2
          )
        LIMIT 1
        UNION ALL
        SELECT 'ipdr'::text AS module
        FROM ipdr_records
        WHERE case_id = $1
          AND (
            COALESCE(msisdn, '') = $2
            OR COALESCE(imsi, '') = $2
            OR COALESCE(imei, '') = $2
            OR COALESCE(source_ip, '') = $2
            OR COALESCE(destination_ip, '') = $2
          )
        LIMIT 1
        UNION ALL
        SELECT 'sdr'::text AS module
        FROM sdr_records
        WHERE case_id = $1
          AND (
            COALESCE(msisdn, '') = $2
            OR COALESCE(subscriber_name, '') = $2
            OR COALESCE(imei, '') = $2
            OR COALESCE(imsi, '') = $2
          )
        LIMIT 1
        UNION ALL
        SELECT 'tower'::text AS module
        FROM tower_dump_records
        WHERE case_id = $1
          AND (
            COALESCE(a_party, '') = $2
            OR COALESCE(b_party, '') = $2
            OR COALESCE(imei, '') = $2
            OR COALESCE(imsi, '') = $2
            OR COALESCE(first_cell_id, '') = $2
          )
        LIMIT 1
        UNION ALL
        SELECT 'ild'::text AS module
        FROM ild_records
        WHERE case_id = $1
          AND (
            COALESCE(calling_party, '') = $2
            OR COALESCE(called_party, '') = $2
            OR COALESCE(destination_country, '') = $2
            OR COALESCE(imei, '') = $2
          )
        LIMIT 1
      )
      SELECT module
      FROM hits
      ORDER BY module ASC
    `,
    [normalizedCaseId, value]
  );
  return result.rows || [];
};
