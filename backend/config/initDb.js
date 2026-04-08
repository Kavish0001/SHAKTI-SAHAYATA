import pool from './database.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Schema files can be in different locations:
// - Local dev: ../../database/ (from backend/config/)
// - Docker: not present (schema applied via docker-entrypoint-initdb.d)
const findFile = (filename) => {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'database', filename),  // local dev: shakti/database/
    path.resolve(__dirname, '..', 'database', filename),         // if database folder is inside backend/
    path.resolve('/docker-entrypoint-initdb.d', filename),       // Docker fallback
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
};

const REQUIRED_TABLES = ['cases', 'admin_accounts'];

/**
 * Check if core and admin tables exist in the database.
 */
const checkTablesExist = async () => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*)::int AS table_count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `, [REQUIRED_TABLES]);
    return result.rows[0]?.table_count === REQUIRED_TABLES.length;
  } catch (err) {
    console.error('[initDb] Error checking tables:', err.message);
    return false;
  }
};

/**
 * Apply the schema.sql to create all required tables.
 */
const applySchema = async () => {
  const schemaPath = findFile('schema.sql');
  
  if (!schemaPath) {
    console.warn('[initDb] ⚠️  schema.sql not found in any expected location');
    return false;
  }
  console.log('[initDb] Found schema at:', schemaPath);

  try {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schemaSql);
    console.log('[initDb] ✅ Schema applied successfully');
    return true;
  } catch (err) {
    console.error('[initDb] ❌ Schema application failed:', err.message);
    return false;
  }
};

/**
 * Apply seed data (officers, default users, app_settings).
 */
const applySeed = async () => {
  const seedPath = findFile('seed.sql');
  
  if (!seedPath) {
    console.log('[initDb] No seed.sql found, skipping seed data');
    return;
  }

  try {
    const seedSql = fs.readFileSync(seedPath, 'utf8');
    await pool.query(seedSql);
    console.log('[initDb] ✅ Seed data applied');
  } catch (err) {
    // Seed failures are non-fatal (e.g., duplicate key on re-run)
    console.warn('[initDb] ⚠️  Seed data warning:', err.message);
  }
};

/**
 * Ensure the osint_crawls table exists (added in Phase 6).
 */
const ensureOsintTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS osint_crawls (
        id          SERIAL PRIMARY KEY,
        url         TEXT NOT NULL,
        status      TEXT NOT NULL,
        title       TEXT,
        snippet     TEXT,
        source      TEXT,
        error       TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.warn('[initDb] ⚠️  osint_crawls table creation warning:', err.message);
  }
};

/**
 * Initialize the database on backend startup.
 * - If tables are missing, apply schema.sql
 * - Always ensure seed principals and app defaults exist
 * - Always ensure osint_crawls table exists
 */
export const initializeDatabase = async () => {
  console.log('[initDb] Checking database state...');
  
  const tablesExist = await checkTablesExist();

  if (!tablesExist) {
    console.log('[initDb] Tables not found. Applying schema...');
  } else {
    console.log('[initDb] ✅ Core tables already exist; refreshing idempotent schema objects');
  }

  const schemaApplied = await applySchema();
  if (!schemaApplied && !tablesExist) return;

  await applySeed();
  console.log('[initDb] ✅ Seed users and defaults verified');

  // Always ensure OSINT table exists (Phase 6 addition)
  await ensureOsintTable();
};

export default initializeDatabase;
