import pool from '../../config/database.js';

export const DEFAULT_ACTIVITY_LIMIT = 25;
export const MAX_ACTIVITY_LIMIT = 100;

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const ADMIN_ACTIVITY_CTE = `
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

export const buildActivityWhereClause = (query = {}) => {
  const clauses = [];
  const params = [];

  const addClause = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };

  if (query.source) addClause('source = ?', String(query.source).trim().toLowerCase());
  if (query.actorType) addClause('actor_type = ?', String(query.actorType).trim().toLowerCase());
  if (query.actor) {
    const actor = `%${String(query.actor).trim()}%`;
    params.push(actor);
    const index = `$${params.length}`;
    clauses.push(`(
      COALESCE(actor_name, '') ILIKE ${index}
      OR COALESCE(actor_email, '') ILIKE ${index}
      OR COALESCE(actor_id, '') ILIKE ${index}
    )`);
  }
  if (query.action) addClause('action = ?', String(query.action).trim());
  if (query.resourceType) addClause('resource_type = ?', String(query.resourceType).trim());
  if (query.resourceId) addClause('resource_id = ?', String(query.resourceId).trim());
  if (query.caseId) {
    params.push(String(query.caseId).trim());
    const index = `$${params.length}`;
    clauses.push(`(
      (resource_type = 'case' AND resource_id = ${index})
      OR COALESCE(details->>'caseId', '') = ${index}
    )`);
  }
  if (query.sessionId) addClause('session_id = ?', String(query.sessionId).trim());
  if (query.ipAddress) addClause("COALESCE(ip_address, '') ILIKE ?", `%${String(query.ipAddress).trim()}%`);
  if (query.dateFrom) addClause('created_at >= ?::timestamptz', String(query.dateFrom).trim());
  if (query.dateTo) addClause('created_at <= ?::timestamptz', String(query.dateTo).trim());
  if (query.q) {
    const q = `%${String(query.q).trim()}%`;
    params.push(q);
    const index = `$${params.length}`;
    clauses.push(`(
      COALESCE(actor_name, '') ILIKE ${index}
      OR COALESCE(actor_email, '') ILIKE ${index}
      OR COALESCE(action, '') ILIKE ${index}
      OR COALESCE(resource_type, '') ILIKE ${index}
      OR COALESCE(resource_id, '') ILIKE ${index}
      OR CAST(COALESCE(details, '{}'::jsonb) AS text) ILIKE ${index}
    )`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
};

export const fetchActivity = async ({ query = {}, limit = DEFAULT_ACTIVITY_LIMIT, page = 1 } = {}) => {
  const pageSize = Math.min(Math.max(limit, 1), MAX_ACTIVITY_LIMIT);
  const offset = (Math.max(page, 1) - 1) * pageSize;
  const { whereSql, params } = buildActivityWhereClause(query);

  const itemsResult = await pool.query(
    `
      ${ADMIN_ACTIVITY_CTE}
      SELECT *
      FROM unified_activity
      ${whereSql}
      ORDER BY created_at DESC, source ASC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `,
    [...params, pageSize, offset]
  );

  const countResult = await pool.query(
    `
      ${ADMIN_ACTIVITY_CTE}
      SELECT COUNT(*)::int AS total
      FROM unified_activity
      ${whereSql}
    `,
    params
  );

  return {
    items: itemsResult.rows,
    pagination: {
      page: Math.max(page, 1),
      pageSize,
      total: countResult.rows[0]?.total || 0,
    },
  };
};

export const exportActivityRows = async (query = {}) => {
  const limit = Math.min(parsePositiveInt(query.limit, 1000), 10000);
  const { whereSql, params } = buildActivityWhereClause(query);
  const result = await pool.query(
    `
      ${ADMIN_ACTIVITY_CTE}
      SELECT *
      FROM unified_activity
      ${whereSql}
      ORDER BY created_at DESC, source ASC, id DESC
      LIMIT $${params.length + 1}
    `,
    [...params, limit]
  );

  return result.rows;
};
