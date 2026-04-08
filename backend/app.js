import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adminAuthRateLimit, authRateLimit, rateLimit } from './middleware/rateLimit.js';
import { auditLogger } from './middleware/auditLogger.js';
import { globalErrorHandler } from './middleware/errorHandler.js';
import { getLiveHealth, getReadyHealth, getStartupStatus } from './services/runtimeStatus.service.js';

import authRoutes from './routes/auth.js';
import casesRoutes from './routes/cases.js';
import filesRoutes from './routes/files.js';
import dashboardRoutes from './routes/dashboard.js';
import cdrRoutes from './routes/cdr.js';
import ipdrRoutes from './routes/ipdr.js';
import sdrRoutes from './routes/sdr.js';
import towerRoutes from './routes/tower.js';
import ildRoutes from './routes/ild.js';
import auditRoutes from './routes/audit.js';
import settingsRoutes from './routes/settings.js';
import officerRoutes from './routes/officerImport.js';
import chatbotRoutes from './routes/chatbot.js';
import osintRoutes from './routes/osint.js';
import systemRoutes from './routes/system.js';
import adminAuthRoutes from './routes/admin/auth.js';
import adminConsoleRoutes from './routes/admin/console.js';
import adminOperationsRoutes from './routes/admin/operations.js';
import { adminOriginGuard } from './middleware/admin/adminOriginGuard.js';
import { adminNetworkGuard } from './middleware/admin/adminNetworkGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const resolveUploadDir = () => path.resolve(__dirname, process.env.UPLOAD_DIR || './uploads');

export const createApp = () => {
  const app = express();
  const uploadDir = resolveUploadDir();

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }));

  app.use(cors({
    origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
      .split(',')
      .map((s) => s.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(cookieParser());
  app.use(auditLogger);
  app.use('/uploads', express.static(uploadDir));

  app.get('/api/health', (_req, res) => {
    const ready = getReadyHealth();
    const httpStatus = ready.status === 'not_ready' ? 503 : 200;
    res.status(httpStatus).json(ready);
  });

  app.get('/api/health/live', (_req, res) => {
    res.json(getLiveHealth());
  });

  app.get('/api/health/ready', (_req, res) => {
    const ready = getReadyHealth();
    const httpStatus = ready.status === 'not_ready' ? 503 : 200;
    res.status(httpStatus).json(ready);
  });

  app.get('/api/health/startup', (_req, res) => {
    const startup = getStartupStatus();
    const httpStatus = startup.status === 'fail' ? 503 : 200;
    res.status(httpStatus).json(startup);
  });

  app.use('/api/auth/login', authRateLimit);
  app.use('/api/auth/signup', authRateLimit);
  app.use('/api/admin/auth/login', adminAuthRateLimit);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminOriginGuard);
  app.use('/api/admin', adminNetworkGuard);
  app.use('/api/admin/auth', adminAuthRoutes);
  app.use('/api/admin', rateLimit, adminConsoleRoutes);
  app.use('/api/admin', rateLimit, adminOperationsRoutes);
  app.use('/api/cases', rateLimit, casesRoutes);
  app.use('/api/files', rateLimit, filesRoutes);
  app.use('/api/dashboard', rateLimit, dashboardRoutes);
  app.use('/api/cdr', rateLimit, cdrRoutes);
  app.use('/api/ipdr', rateLimit, ipdrRoutes);
  app.use('/api/sdr', rateLimit, sdrRoutes);
  app.use('/api/tower', rateLimit, towerRoutes);
  app.use('/api/ild', rateLimit, ildRoutes);
  app.use('/api/audit', rateLimit, auditRoutes);
  app.use('/api/settings', rateLimit, settingsRoutes);
  app.use('/api/officers', rateLimit, officerRoutes);
  app.use('/api/chatbot', chatbotRoutes);
  app.use('/api/osint', rateLimit, osintRoutes);
  app.use('/api/system', rateLimit, systemRoutes);
  app.post('/api/reset-settings', (_req, res) => {
    res.json({ success: true, message: 'Legacy reset endpoint is available. No destructive reset was performed.' });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Route not found', path: req.originalUrl });
  });

  app.use(globalErrorHandler);

  return app;
};
