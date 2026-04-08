import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { initializeDatabase } from './config/initDb.js';
import { getOllamaRuntimeConfig } from './services/chatbot/config.js';
import { AUTH_CONFIG } from './config/auth.js';
import { createApp, resolveUploadDir } from './app.js';
import { getStartupStatus, runStartupSelfChecks } from './services/runtimeStatus.service.js';
import { runAdminRetentionJob, startAdminRetentionScheduler } from './services/admin/adminRetention.service.js';

const PORT = process.env.BACKEND_PORT || process.env.PORT || 3001;
const __filename = fileURLToPath(import.meta.url);
const app = createApp();

// ──────────────────────────────────────────────
// Start server (with DB initialization)
// ──────────────────────────────────────────────
export const startServer = async () => {
  try {
    await initializeDatabase();
  } catch (err) {
    console.error('[STARTUP] Database initialization failed:', err.message);
    console.error('[STARTUP] Server will start but some features may not work');
  }

  const startupChecks = await runStartupSelfChecks({
    uploadDir: resolveUploadDir(),
    ollamaRequired: false,
  });

  runAdminRetentionJob().catch((error) => {
    console.error('[ADMIN_RETENTION] Initial retention job failed:', error?.message || error);
  });
  startAdminRetentionScheduler();

  if (startupChecks.status === 'fail') {
    console.error('[STARTUP] Critical self-checks failed:', startupChecks.summary.failed.join(', '));
    throw new Error('Startup self-checks failed. Refusing to start server.');
  }

  app.listen(PORT, () => {
    const ollama = getOllamaRuntimeConfig();
    const aiServiceUrl = String(process.env.AI_SERVICE_URL || '').trim();
    const currentStartupStatus = getStartupStatus();
    console.log(`
  =============================================
    SHAKTI Backend v2.0
    Port: ${PORT}
    Mode: ${process.env.NODE_ENV || 'development'}
    Access Token TTL: ${AUTH_CONFIG.accessTokenTtl}
    Refresh Cookie: ${AUTH_CONFIG.refreshCookieName}
    Ollama URL: ${ollama.baseUrl}
    Ollama Source: ${ollama.source}
    Ollama Model: ${ollama.model}
    AI Service URL: ${aiServiceUrl || 'optional / disabled'}
    Startup Status: ${currentStartupStatus.status}
    Startup Failures: ${currentStartupStatus.summary?.failed?.join(', ') || 'none'}
    Startup Degraded: ${currentStartupStatus.summary?.degraded?.join(', ') || 'none'}
    Routes: auth, cases, files, dashboard,
            cdr, ipdr, sdr, tower, ild,
            audit, settings, chatbot, osint, system,
            admin/auth
  =============================================
    `);
  });
};

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  startServer().catch((error) => {
    console.error('[STARTUP] Fatal boot error:', error?.message || error);
    process.exitCode = 1;
  });
}

export default app;
