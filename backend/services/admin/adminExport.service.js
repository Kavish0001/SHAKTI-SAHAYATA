import pool from '../../config/database.js';
import { ADMIN_CONSOLE_CONFIG } from '../../config/adminConsole.js';

const buildCsvValue = (value) => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
};

export const buildCsv = (columns, rows) => {
  const header = columns.map((column) => buildCsvValue(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => buildCsvValue(column.value(row))).join(','));
  return [header, ...body].join('\r\n');
};

export const createCsvFilename = (prefix) =>
  `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_')}.csv`;

export const buildExportWatermark = ({ admin, scope }) => ({
  label: ADMIN_CONSOLE_CONFIG.exports.watermarkLabel,
  scope,
  actorEmail: admin?.email || 'unknown-admin',
  actorRole: admin?.role || 'unknown',
  exportedAt: new Date().toISOString(),
});

export const appendWatermarkColumns = (columns, watermark) => [
  ...columns,
  { label: 'Watermark Label', value: () => watermark.label },
  { label: 'Export Scope', value: () => watermark.scope },
  { label: 'Exported By', value: () => watermark.actorEmail },
  { label: 'Exported Role', value: () => watermark.actorRole },
  { label: 'Exported At', value: () => watermark.exportedAt },
];

export const sendCsv = (res, filename, csv) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(csv);
};

const EXPORT_ACTIONS = new Set([
  'EXPORT_OVERVIEW',
  'EXPORT_ACTIVITY',
  'EXPORT_CASES',
  'EXPORT_FILES',
  'EXPORT_CASE_GOVERNANCE',
  'EXPORT_FILE_GOVERNANCE',
  'EXPORT_FILE_DELETION_TRACE',
]);

export const fetchAdminExportHistory = async (limit = 25) => {
  const result = await pool.query(
    `
      SELECT
        aal.id,
        aal.action,
        aal.resource_type,
        aal.resource_id,
        aal.details,
        aal.created_at,
        COALESCE(aa.full_name, 'Unknown admin') AS actor_name,
        aa.email AS actor_email,
        aa.role AS actor_role
      FROM admin_action_logs aal
      LEFT JOIN admin_accounts aa ON aa.id = aal.admin_account_id
      WHERE aal.action = ANY($1::text[])
      ORDER BY aal.created_at DESC, aal.id DESC
      LIMIT $2
    `,
    [[...EXPORT_ACTIONS], Math.min(Math.max(Number(limit) || 25, 1), 100)]
  );

  return result.rows.map((row) => ({
    id: row.id,
    action: row.action,
    createdAt: row.created_at,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    exportScope: row.details?.scope || row.resource_type || null,
    filters: row.details?.filters || {},
    reason: row.details?.reason || null,
    exportedCount: row.details?.exportedCount || 0,
    result: row.details?.result || 'success',
    watermark: row.details?.watermark || null,
  }));
};
