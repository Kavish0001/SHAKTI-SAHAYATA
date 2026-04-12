import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const trim = (value) => String(value || '').trim();

const supabaseUrl = trim(process.env.SUPABASE_URL);
const supabaseAnonKey = trim(process.env.SUPABASE_ANON_KEY);
const supabaseServiceRoleKey = trim(process.env.SUPABASE_SERVICE_ROLE_KEY);
const defaultJwksUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : '';
const supabaseJwksUrl = trim(process.env.SUPABASE_JWKS_URL || defaultJwksUrl);
const supabaseJwtAudience = trim(process.env.SUPABASE_JWT_AUDIENCE || 'authenticated');
const evidenceBucket = trim(process.env.SUPABASE_STORAGE_BUCKET_EVIDENCE || 'case-evidence');
const exportsBucket = trim(process.env.SUPABASE_STORAGE_BUCKET_EXPORTS || 'admin-exports');
const quarantineBucket = trim(process.env.SUPABASE_STORAGE_BUCKET_QUARANTINE || 'legacy-quarantine');
const knowledgeBucket = trim(process.env.SUPABASE_STORAGE_BUCKET_CHAT_KNOWLEDGE || 'case-knowledge-artifacts');

export const SUPABASE_CONFIG = {
  url: supabaseUrl,
  anonKey: supabaseAnonKey,
  serviceRoleKey: supabaseServiceRoleKey,
  jwksUrl: supabaseJwksUrl,
  jwtAudience: supabaseJwtAudience,
  evidenceBucket,
  exportsBucket,
  quarantineBucket,
  knowledgeBucket,
  dbPoolerUrl: trim(process.env.SUPABASE_DB_URL_POOLER),
  dbDirectUrl: trim(process.env.SUPABASE_DB_URL_DIRECT),
  localDev: ['1', 'true', 'yes', 'on'].includes(trim(process.env.SUPABASE_LOCAL_DEV).toLowerCase()),
};

export const isSupabaseConfigured = Boolean(
  SUPABASE_CONFIG.url
  && SUPABASE_CONFIG.anonKey
  && SUPABASE_CONFIG.serviceRoleKey
);

export const isSupabaseAuthEnabled = isSupabaseConfigured;
export const isSupabaseStorageEnabled = isSupabaseConfigured;

let supabaseAdminClient = null;
let supabasePublicClient = null;
let jwks = null;

export const getSupabaseAdminClient = () => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase admin client requested without configuration.');
  }

  if (!supabaseAdminClient) {
    supabaseAdminClient = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return supabaseAdminClient;
};

export const getSupabasePublicClient = () => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase public client requested without configuration.');
  }

  if (!supabasePublicClient) {
    supabasePublicClient = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return supabasePublicClient;
};

const getRemoteJwks = () => {
  if (!SUPABASE_CONFIG.jwksUrl) {
    throw new Error('SUPABASE_JWKS_URL is required when Supabase Auth is enabled.');
  }
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(SUPABASE_CONFIG.jwksUrl));
  }
  return jwks;
};

export const verifySupabaseAccessToken = async (token) => {
  if (!isSupabaseAuthEnabled) {
    throw new Error('Supabase Auth is not configured.');
  }

  const issuer = `${SUPABASE_CONFIG.url}/auth/v1`;
  const { payload } = await jwtVerify(token, getRemoteJwks(), {
    issuer,
    audience: SUPABASE_CONFIG.jwtAudience,
  });

  return payload;
};

export const buildSupabaseStoragePath = ({ caseId, expectedType, module, originalName, objectId }) => {
  const safeOriginal = String(originalName || 'upload.bin')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'upload.bin';

  const normalizedType = String(expectedType || module || 'misc')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/^tower$/, 'tower_dump');
  const normalizedObjectId = String(
    objectId || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  ).trim();

  return `cases/${caseId}/${normalizedType}/${normalizedObjectId || Date.now()}-${safeOriginal}`;
};

export const getSupabaseBucket = (bucket = 'evidence') => {
  if (bucket === 'exports') return SUPABASE_CONFIG.exportsBucket;
  if (bucket === 'quarantine') return SUPABASE_CONFIG.quarantineBucket;
  if (bucket === 'knowledge') return SUPABASE_CONFIG.knowledgeBucket;
  return SUPABASE_CONFIG.evidenceBucket;
};
