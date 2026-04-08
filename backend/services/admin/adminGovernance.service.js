import pool from '../../config/database.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNonNegativeInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parseOptionalBoolean = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return null;
};

const buildWhereState = () => {
  const clauses = [];
  const params = [];

  return {
    clauses,
    params,
    addClause(sql, value) {
      params.push(value);
      clauses.push(sql.replace('?', `$${params.length}`));
    },
    addRaw(sql) {
      clauses.push(sql);
    },
    get whereSql() {
      return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    },
  };
};

const UNIFIED_ACTIVITY_CTE = `
  WITH unified_activity AS (
    SELECT
      'audit'::text AS source,
      al.id::text AS id,
      al.created_at,
      'officer'::text AS actor_type,
      al.user_id::text AS actor_id,
      COALESCE(u.full_name, al.officer_name, 'Unknown officer') AS actor_name,
      u.email AS actor_email,
      u.role AS actor_role,
      al.action,
      al.resource_type,
      al.resource_id,
      al.session_id,
      COALESCE(HOST(al.ip_address), NULL) AS ip_address,
      COALESCE(al.details, '{}'::jsonb) AS details
    FROM audit_logs al
    LEFT JOIN users u ON al.user_id = u.id

    UNION ALL

    SELECT
      'admin'::text AS source,
      aal.id::text AS id,
      aal.created_at,
      'admin'::text AS actor_type,
      aal.admin_account_id::text AS actor_id,
      COALESCE(aa.full_name, 'Unknown admin') AS actor_name,
      aa.email AS actor_email,
      aa.role AS actor_role,
      aal.action,
      aal.resource_type,
      aal.resource_id,
      aal.session_id,
      COALESCE(HOST(aal.ip_address), NULL) AS ip_address,
      COALESCE(aal.details, '{}'::jsonb) AS details
    FROM admin_action_logs aal
    LEFT JOIN admin_accounts aa ON aal.admin_account_id = aa.id
  )
`;

const ADMIN_CASE_SCOPE_CTE = `
  WITH admin_case_scope AS (
    SELECT
      c.id,
      c.case_name,
      c.case_number,
      c.case_type,
      c.fir_number,
      c.operator,
      c.status,
      c.priority,
      c.description,
      c.investigation_details,
      c.start_date,
      c.end_date,
      c.created_at,
      c.updated_at,
      c.is_evidence_locked,
      c.locked_at,
      c.lock_reason,
      creator.id AS created_by_user_id,
      creator.full_name AS created_by_name,
      creator.buckle_id AS created_by_buckle_id,
      COALESCE(owner_summary.owner_id, creator.id) AS owner_id,
      COALESCE(owner_summary.owner_name, creator.full_name) AS owner_name,
      COALESCE(owner_summary.owner_buckle_id, creator.buckle_id) AS owner_buckle_id,
      COALESCE(assignment_summary.assignment_count, 0) AS assignment_count,
      COALESCE(assignment_summary.assigned_officers, '[]'::jsonb) AS assigned_officers,
      COALESCE(assignment_summary.assignment_search, '') AS assignment_search,
      COALESCE(file_summary.file_count, 0) AS file_count,
      COALESCE(file_summary.failed_parse_files, 0) AS failed_parse_files,
      COALESCE(file_summary.completed_files, 0) AS completed_files,
      COALESCE(file_summary.pending_files, 0) AS pending_files,
      COALESCE(activity_summary.recent_activity_count, 0) AS recent_activity_count,
      activity_summary.last_activity_at
    FROM cases c
    LEFT JOIN users creator ON creator.id = c.created_by_user_id
    LEFT JOIN LATERAL (
      SELECT
        owner_user.id AS owner_id,
        owner_user.full_name AS owner_name,
        owner_user.buckle_id AS owner_buckle_id
      FROM case_assignments owner_assignment
      JOIN users owner_user ON owner_user.id = owner_assignment.user_id
      WHERE owner_assignment.case_id = c.id
        AND owner_assignment.role = 'owner'
        AND owner_assignment.is_active = TRUE
      ORDER BY owner_assignment.assigned_at DESC
      LIMIT 1
    ) owner_summary ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS assignment_count,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'userId', u.id,
              'fullName', u.full_name,
              'buckleId', u.buckle_id,
              'role', ca.role
            )
            ORDER BY ca.assigned_at DESC
          ) FILTER (WHERE u.id IS NOT NULL),
          '[]'::jsonb
        ) AS assigned_officers,
        COALESCE(
          STRING_AGG(DISTINCT CONCAT_WS(' ', u.full_name, u.buckle_id), ' '),
          ''
        ) AS assignment_search
      FROM case_assignments ca
      JOIN users u ON u.id = ca.user_id
      WHERE ca.case_id = c.id
        AND ca.is_active = TRUE
    ) assignment_summary ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS file_count,
        COUNT(*) FILTER (WHERE uf.parse_status = 'failed')::int AS failed_parse_files,
        COUNT(*) FILTER (WHERE uf.parse_status = 'completed')::int AS completed_files,
        COUNT(*) FILTER (WHERE uf.parse_status IN ('pending', 'processing'))::int AS pending_files
      FROM uploaded_files uf
      WHERE uf.case_id = c.id
    ) file_summary ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE al.created_at >= NOW() - INTERVAL '7 days')::int AS recent_activity_count,
        MAX(al.created_at) AS last_activity_at
      FROM audit_logs al
      WHERE (al.resource_type = 'case' AND al.resource_id = c.id::text)
        OR COALESCE(al.details->>'caseId', '') = c.id::text
    ) activity_summary ON TRUE
  )
`;

const ADMIN_FILE_SCOPE_CTE = `
  WITH admin_file_scope AS (
    SELECT
      uf.id,
      uf.case_id,
      c.case_name,
      c.case_number,
      c.status AS case_status,
      c.priority AS case_priority,
      c.is_evidence_locked,
      uf.file_name,
      uf.original_name,
      uf.file_type,
      uf.file_size,
      uf.mime_type,
      uf.parse_status,
      uf.record_count,
      uf.uploaded_by,
      uploader.full_name AS uploaded_by_name,
      uploader.buckle_id AS uploaded_by_buckle_id,
      uf.uploaded_at,
      fc.expected_type,
      fc.detected_type,
      fc.confidence,
      fc.classification_result,
      fc.error_message,
      COALESCE(fc.detected_type, fc.expected_type, uf.file_type, 'unknown') AS telecom_module
    FROM uploaded_files uf
    LEFT JOIN cases c ON c.id = uf.case_id
    LEFT JOIN users uploader ON uploader.id = uf.uploaded_by
    LEFT JOIN file_classifications fc ON fc.file_id = uf.id
  )
`;

const ADMIN_FILE_DELETION_SCOPE_CTE = `
  WITH admin_file_deletion_scope AS (
    SELECT
      al.id::text AS audit_id,
      al.created_at,
      al.user_id AS actor_id,
      COALESCE(u.full_name, al.officer_name, 'Unknown officer') AS actor_name,
      u.email AS actor_email,
      COALESCE(u.buckle_id, al.officer_buckle_id) AS actor_buckle_id,
      CASE
        WHEN COALESCE(al.details->>'caseId', '') ~ '^[0-9]+$'
        THEN (al.details->>'caseId')::int
        ELSE NULL
      END AS case_id,
      c.case_name,
      c.case_number,
      COALESCE(al.details->>'fileName', al.details->>'storedFileName', al.resource_id) AS file_name,
      al.details->>'storedFileName' AS stored_file_name,
      COALESCE(al.details->>'deletedType', 'unknown') AS deleted_type,
      CASE
        WHEN COALESCE(al.details->>'deletedRecords', '') ~ '^[0-9]+$'
        THEN (al.details->>'deletedRecords')::int
        ELSE 0
      END AS deleted_records,
      al.resource_id AS file_id,
      COALESCE(HOST(al.ip_address), NULL) AS ip_address,
      COALESCE(al.details, '{}'::jsonb) AS details
    FROM audit_logs al
    LEFT JOIN users u ON u.id = al.user_id
    LEFT JOIN cases c ON c.id = CASE
      WHEN COALESCE(al.details->>'caseId', '') ~ '^[0-9]+$'
      THEN (al.details->>'caseId')::int
      ELSE NULL
    END
    WHERE al.action = 'FILE_DELETE'
  )
`;

const buildCaseWhereClause = (query = {}) => {
  const state = buildWhereState();

  if (query.status) state.addClause('status = ?', String(query.status).trim().toLowerCase());
  if (query.priority) state.addClause('priority = ?', String(query.priority).trim().toLowerCase());

  const evidenceLocked = parseOptionalBoolean(query.evidenceLocked);
  if (evidenceLocked !== null) state.addClause('is_evidence_locked = ?', evidenceLocked);

  if (query.owner) {
    const owner = `%${String(query.owner).trim()}%`;
    state.params.push(owner);
    const index = `$${state.params.length}`;
    state.addRaw(`(COALESCE(owner_name, '') ILIKE ${index} OR COALESCE(owner_buckle_id, '') ILIKE ${index})`);
  }

  if (query.assignedOfficer) {
    const assignedOfficer = `%${String(query.assignedOfficer).trim()}%`;
    state.params.push(assignedOfficer);
    const index = `$${state.params.length}`;
    state.addRaw(`COALESCE(assignment_search, '') ILIKE ${index}`);
  }

  if (query.updatedFrom) state.addClause('updated_at >= ?::timestamptz', String(query.updatedFrom).trim());
  if (query.updatedTo) state.addClause('updated_at <= ?::timestamptz', String(query.updatedTo).trim());
  const minRecentActivity = parseNonNegativeInt(query.minRecentActivity);
  if (minRecentActivity !== null) state.addClause('recent_activity_count >= ?::int', minRecentActivity);

  if (query.q) {
    const q = `%${String(query.q).trim()}%`;
    state.params.push(q);
    const index = `$${state.params.length}`;
    state.addRaw(`(
      COALESCE(case_name, '') ILIKE ${index}
      OR COALESCE(case_number, '') ILIKE ${index}
      OR COALESCE(fir_number, '') ILIKE ${index}
      OR COALESCE(operator, '') ILIKE ${index}
      OR COALESCE(owner_name, '') ILIKE ${index}
      OR COALESCE(owner_buckle_id, '') ILIKE ${index}
      OR COALESCE(assignment_search, '') ILIKE ${index}
    )`);
  }

  return state;
};

const buildFileWhereClause = (query = {}) => {
  const state = buildWhereState();

  if (query.caseId) state.addClause('case_id = ?::int', String(query.caseId).trim());
  if (query.parseStatus) state.addClause('parse_status = ?', String(query.parseStatus).trim().toLowerCase());
  if (query.fileType) state.addClause('telecom_module = ?', String(query.fileType).trim().toLowerCase());
  if (query.classificationResult) state.addClause('classification_result = ?', String(query.classificationResult).trim().toUpperCase());

  if (query.uploader) {
    const uploader = `%${String(query.uploader).trim()}%`;
    state.params.push(uploader);
    const index = `$${state.params.length}`;
    state.addRaw(`(
      COALESCE(uploaded_by_name, '') ILIKE ${index}
      OR COALESCE(uploaded_by_buckle_id, '') ILIKE ${index}
    )`);
  }

  if (query.dateFrom) state.addClause('uploaded_at >= ?::timestamptz', String(query.dateFrom).trim());
  if (query.dateTo) state.addClause('uploaded_at <= ?::timestamptz', String(query.dateTo).trim());

  if (query.q) {
    const q = `%${String(query.q).trim()}%`;
    state.params.push(q);
    const index = `$${state.params.length}`;
    state.addRaw(`(
      COALESCE(original_name, '') ILIKE ${index}
      OR COALESCE(file_name, '') ILIKE ${index}
      OR COALESCE(case_name, '') ILIKE ${index}
      OR COALESCE(case_number, '') ILIKE ${index}
      OR COALESCE(uploaded_by_name, '') ILIKE ${index}
      OR COALESCE(telecom_module, '') ILIKE ${index}
    )`);
  }

  return state;
};

const buildFileDeletionWhereClause = (query = {}) => {
  const state = buildWhereState();

  if (query.caseId) state.addClause('case_id = ?::int', String(query.caseId).trim());
  if (query.deletedType) state.addClause('deleted_type = ?', String(query.deletedType).trim().toLowerCase());

  if (query.actor) {
    const actor = `%${String(query.actor).trim()}%`;
    state.params.push(actor);
    const index = `$${state.params.length}`;
    state.addRaw(`(
      COALESCE(actor_name, '') ILIKE ${index}
      OR COALESCE(actor_buckle_id, '') ILIKE ${index}
      OR COALESCE(actor_email, '') ILIKE ${index}
    )`);
  }

  if (query.dateFrom) state.addClause('created_at >= ?::timestamptz', String(query.dateFrom).trim());
  if (query.dateTo) state.addClause('created_at <= ?::timestamptz', String(query.dateTo).trim());

  if (query.q) {
    const q = `%${String(query.q).trim()}%`;
    state.params.push(q);
    const index = `$${state.params.length}`;
    state.addRaw(`(
      COALESCE(file_name, '') ILIKE ${index}
      OR COALESCE(case_name, '') ILIKE ${index}
      OR COALESCE(case_number, '') ILIKE ${index}
      OR COALESCE(actor_name, '') ILIKE ${index}
      OR COALESCE(deleted_type, '') ILIKE ${index}
    )`);
  }

  return state;
};

export const fetchAdminCases = async (query = {}) => {
  const page = parsePositiveInt(query.page, 1);
  const pageSize = Math.min(parsePositiveInt(query.limit, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const { whereSql, params } = buildCaseWhereClause(query);

  const [itemsResult, summaryResult] = await Promise.all([
    pool.query(
      `
        ${ADMIN_CASE_SCOPE_CTE}
        SELECT *
        FROM admin_case_scope
        ${whereSql}
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
    pool.query(
      `
        ${ADMIN_CASE_SCOPE_CTE}
        SELECT
          COUNT(*)::int AS total_cases,
          COUNT(*) FILTER (WHERE is_evidence_locked)::int AS locked_cases,
          COUNT(*) FILTER (WHERE priority IN ('high', 'critical'))::int AS high_priority_cases,
          COALESCE(SUM(file_count), 0)::int AS total_files
        FROM admin_case_scope
        ${whereSql}
      `,
      params
    ),
  ]);

  const summary = summaryResult.rows[0] || {};

  return {
    items: itemsResult.rows,
    pagination: {
      page,
      pageSize,
      total: summary.total_cases || 0,
    },
    summary: {
      totalCases: summary.total_cases || 0,
      lockedCases: summary.locked_cases || 0,
      highPriorityCases: summary.high_priority_cases || 0,
      totalFiles: summary.total_files || 0,
    },
  };
};

export const exportAdminCases = async (query = {}) => {
  const exportLimit = Math.min(parsePositiveInt(query.limit, 5000), 10000);
  const { whereSql, params } = buildCaseWhereClause(query);

  const result = await pool.query(
    `
      ${ADMIN_CASE_SCOPE_CTE}
      SELECT *
      FROM admin_case_scope
      ${whereSql}
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT $${params.length + 1}
    `,
    [...params, exportLimit]
  );

  return result.rows;
};

export const fetchAdminCaseDetail = async (caseId) => {
  const caseIdText = String(caseId).trim();

  const [
    caseResult,
    assignmentsResult,
    recentFilesResult,
    recentActivityResult,
    fileBreakdownResult,
    timelineSummaryResult,
  ] = await Promise.all([
    pool.query(
      `
        ${ADMIN_CASE_SCOPE_CTE}
        SELECT *
        FROM admin_case_scope
        WHERE id = $1::int
        LIMIT 1
      `,
      [caseIdText]
    ),
    pool.query(
      `
        SELECT
          ca.id,
          ca.role,
          ca.assigned_at,
          ca.assigned_by,
          u.id AS user_id,
          u.full_name,
          u.email,
          u.buckle_id
        FROM case_assignments ca
        JOIN users u ON u.id = ca.user_id
        WHERE ca.case_id = $1::int
          AND ca.is_active = TRUE
        ORDER BY
          CASE WHEN ca.role = 'owner' THEN 0 ELSE 1 END,
          ca.assigned_at DESC
      `,
      [caseIdText]
    ),
    pool.query(
      `
        ${ADMIN_FILE_SCOPE_CTE}
        SELECT *
        FROM admin_file_scope
        WHERE case_id = $1::int
        ORDER BY uploaded_at DESC, id DESC
        LIMIT 8
      `,
      [caseIdText]
    ),
    pool.query(
      `
        ${UNIFIED_ACTIVITY_CTE}
        SELECT *
        FROM unified_activity
        WHERE (resource_type = 'case' AND resource_id = $1)
          OR COALESCE(details->>'caseId', '') = $1
        ORDER BY created_at DESC, source ASC, id DESC
        LIMIT 12
      `,
      [caseIdText]
    ),
    pool.query(
      `
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'module', telecom_module,
              'totalFiles', total_files,
              'failedFiles', failed_files,
              'records', records
            )
            ORDER BY telecom_module
          ),
          '[]'::jsonb
        ) AS breakdown
        FROM (
          SELECT
            COALESCE(fc.detected_type, fc.expected_type, uf.file_type, 'unknown') AS telecom_module,
            COUNT(*)::int AS total_files,
            COUNT(*) FILTER (WHERE uf.parse_status = 'failed')::int AS failed_files,
            COALESCE(SUM(uf.record_count), 0)::int AS records
        FROM uploaded_files uf
        LEFT JOIN file_classifications fc ON fc.file_id = uf.id
        WHERE uf.case_id = $1::int
        GROUP BY 1
        ) module_breakdown
      `,
      [caseIdText]
    ),
    pool.query(
      `
        ${UNIFIED_ACTIVITY_CTE},
        case_activity AS (
          SELECT source, action, created_at
          FROM unified_activity
          WHERE (resource_type = 'case' AND resource_id = $1)
            OR COALESCE(details->>'caseId', '') = $1
        )
        SELECT
          COUNT(*)::int AS total_events,
          MIN(created_at) AS first_event_at,
          MAX(created_at) AS last_event_at,
          COUNT(*) FILTER (WHERE source = 'admin')::int AS admin_events,
          COUNT(*) FILTER (
            WHERE action IN (
              'FILE_DELETE',
              'DELETE_CASE',
              'ARCHIVE_CASE',
              'LOCK_CASE',
              'UNLOCK_CASE',
              'FORCE_LOGOUT_OFFICER_SESSION',
              'FORCE_LOGOUT_ADMIN_SESSION'
            )
          )::int AS high_risk_events,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object('action', grouped.action, 'count', grouped.event_count)
                ORDER BY grouped.event_count DESC, grouped.action ASC
              )
              FROM (
                SELECT action, COUNT(*)::int AS event_count
                FROM case_activity
                GROUP BY action
                ORDER BY event_count DESC, action ASC
                LIMIT 5
              ) grouped
            ),
            '[]'::jsonb
          ) AS top_actions
        FROM case_activity
      `,
      [caseIdText]
    ),
  ]);

  if (caseResult.rows.length === 0) {
    return null;
  }

  const caseRow = caseResult.rows[0];
  const timelineSummary = timelineSummaryResult.rows[0] || {};

  return {
    case: caseRow,
    assignments: assignmentsResult.rows,
    stats: {
      fileCount: caseRow.file_count || 0,
      failedParseFiles: caseRow.failed_parse_files || 0,
      completedFiles: caseRow.completed_files || 0,
      pendingFiles: caseRow.pending_files || 0,
      recentActivityCount: caseRow.recent_activity_count || 0,
      assignmentCount: caseRow.assignment_count || 0,
    },
    timelineSummary: {
      totalEvents: timelineSummary.total_events || 0,
      firstEventAt: timelineSummary.first_event_at || null,
      lastEventAt: timelineSummary.last_event_at || null,
      adminEvents: timelineSummary.admin_events || 0,
      highRiskEvents: timelineSummary.high_risk_events || 0,
      topActions: timelineSummary.top_actions || [],
    },
    fileBreakdown: fileBreakdownResult.rows[0]?.breakdown || [],
    recentFiles: recentFilesResult.rows,
    recentActivity: recentActivityResult.rows,
  };
};

export const fetchAdminFiles = async (query = {}) => {
  const page = parsePositiveInt(query.page, 1);
  const pageSize = Math.min(parsePositiveInt(query.limit, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const { whereSql, params } = buildFileWhereClause(query);

  const [itemsResult, summaryResult] = await Promise.all([
    pool.query(
      `
        ${ADMIN_FILE_SCOPE_CTE}
        SELECT *
        FROM admin_file_scope
        ${whereSql}
        ORDER BY uploaded_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
    pool.query(
      `
        ${ADMIN_FILE_SCOPE_CTE}
        SELECT
          COUNT(*)::int AS total_files,
          COUNT(*) FILTER (WHERE parse_status = 'failed')::int AS failed_parse_files,
          COUNT(*) FILTER (WHERE parse_status = 'completed')::int AS completed_files,
          COUNT(*) FILTER (WHERE parse_status IN ('pending', 'processing'))::int AS pending_files,
          COUNT(*) FILTER (WHERE uploaded_at >= CURRENT_DATE)::int AS uploads_today,
          COUNT(*) FILTER (WHERE is_evidence_locked)::int AS locked_case_files
        FROM admin_file_scope
        ${whereSql}
      `,
      params
    ),
  ]);

  const summary = summaryResult.rows[0] || {};

  return {
    items: itemsResult.rows,
    pagination: {
      page,
      pageSize,
      total: summary.total_files || 0,
    },
    summary: {
      totalFiles: summary.total_files || 0,
      failedParseFiles: summary.failed_parse_files || 0,
      completedFiles: summary.completed_files || 0,
      pendingFiles: summary.pending_files || 0,
      uploadsToday: summary.uploads_today || 0,
      lockedCaseFiles: summary.locked_case_files || 0,
    },
  };
};

export const exportAdminFiles = async (query = {}) => {
  const exportLimit = Math.min(parsePositiveInt(query.limit, 5000), 10000);
  const { whereSql, params } = buildFileWhereClause(query);

  const result = await pool.query(
    `
      ${ADMIN_FILE_SCOPE_CTE}
      SELECT *
      FROM admin_file_scope
      ${whereSql}
      ORDER BY uploaded_at DESC, id DESC
      LIMIT $${params.length + 1}
    `,
    [...params, exportLimit]
  );

  return result.rows;
};

export const fetchAdminFileDeletions = async (query = {}) => {
  const page = parsePositiveInt(query.page, 1);
  const pageSize = Math.min(parsePositiveInt(query.limit, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const { whereSql, params } = buildFileDeletionWhereClause(query);

  const [itemsResult, summaryResult] = await Promise.all([
    pool.query(
      `
        ${ADMIN_FILE_DELETION_SCOPE_CTE}
        SELECT *
        FROM admin_file_deletion_scope
        ${whereSql}
        ORDER BY created_at DESC, audit_id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
    pool.query(
      `
        ${ADMIN_FILE_DELETION_SCOPE_CTE}
        SELECT
          COUNT(*)::int AS total_deletions,
          COALESCE(SUM(deleted_records), 0)::int AS total_deleted_records,
          COUNT(DISTINCT case_id)::int AS impacted_cases
        FROM admin_file_deletion_scope
        ${whereSql}
      `,
      params
    ),
  ]);

  const summary = summaryResult.rows[0] || {};

  return {
    items: itemsResult.rows,
    pagination: {
      page,
      pageSize,
      total: summary.total_deletions || 0,
    },
    summary: {
      totalDeletions: summary.total_deletions || 0,
      totalDeletedRecords: summary.total_deleted_records || 0,
      impactedCases: summary.impacted_cases || 0,
    },
  };
};

export const exportAdminFileDeletions = async (query = {}) => {
  const exportLimit = Math.min(parsePositiveInt(query.limit, 5000), 10000);
  const { whereSql, params } = buildFileDeletionWhereClause(query);

  const result = await pool.query(
    `
      ${ADMIN_FILE_DELETION_SCOPE_CTE}
      SELECT *
      FROM admin_file_deletion_scope
      ${whereSql}
      ORDER BY created_at DESC, audit_id DESC
      LIMIT $${params.length + 1}
    `,
    [...params, exportLimit]
  );

  return result.rows;
};

export const fetchAdminAnalysis = async () => {
  const [jobMetricsResult, moduleBreakdownResult, fileMetricsResult, chatMetricsResult] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*)::int AS total_jobs,
          COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_jobs,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_jobs,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
          COUNT(*) FILTER (WHERE status IN ('failed', 'quarantined', 'mismatched', 'cancelled'))::int AS failed_jobs
        FROM ingestion_jobs
      `
    ),
    pool.query(
      `
        SELECT
          expected_type AS module,
          COUNT(*)::int AS total_jobs,
          COUNT(*) FILTER (WHERE status IN ('failed', 'quarantined', 'mismatched', 'cancelled'))::int AS problematic_jobs,
          COALESCE(SUM(total_rows), 0)::int AS total_rows
        FROM ingestion_jobs
        GROUP BY expected_type
        ORDER BY expected_type ASC
      `
    ),
    pool.query(
      `
        SELECT
          COUNT(*)::int AS total_files,
          COUNT(*) FILTER (WHERE parse_status = 'failed')::int AS failed_parse_files,
          COUNT(*) FILTER (WHERE uploaded_at >= CURRENT_DATE)::int AS uploads_today
        FROM uploaded_files
      `
    ),
    pool.query(
      `
        SELECT COUNT(*)::int AS chatbot_messages_24h
        FROM chat_history
        WHERE created_at >= NOW() - INTERVAL '24 hours'
      `
    ),
  ]);

  return {
    metrics: {
      ...(jobMetricsResult.rows[0] || {}),
      ...(fileMetricsResult.rows[0] || {}),
      ...(chatMetricsResult.rows[0] || {}),
    },
    modules: moduleBreakdownResult.rows,
  };
};
