import pool from '../../config/database.js';

export const logAdminAction = async ({
  adminAccountId = null,
  sessionId = null,
  action,
  resourceType = null,
  resourceId = null,
  details = null,
  ipAddress = null
}) => {
  if (!action) return;

  try {
    await pool.query(
      `
        INSERT INTO admin_action_logs (
          admin_account_id,
          session_id,
          action,
          resource_type,
          resource_id,
          details,
          ip_address
        )
        VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')::inet)
      `,
      [
        adminAccountId,
        sessionId,
        action,
        resourceType,
        resourceId,
        details ? JSON.stringify(details) : null,
        String(ipAddress || '').replace(/^::ffff:/, '')
      ]
    );
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[adminAudit] Failed to write admin action log:', error?.message);
    }
  }
};
