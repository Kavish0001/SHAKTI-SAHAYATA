import expressRateLimit from 'express-rate-limit';

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'); // 15 minutes
const MAX_REQUESTS = parseInt(
  process.env.GENERAL_RATE_LIMIT_MAX_REQUESTS || process.env.RATE_LIMIT_MAX_REQUESTS || '500'
);
const AUTH_MAX_REQUESTS = parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS || '10');
const ADMIN_AUTH_MAX_REQUESTS = parseInt(process.env.ADMIN_AUTH_RATE_LIMIT_MAX_REQUESTS || '10');

const createLimiter = ({
  max,
  message,
  windowMs = WINDOW_MS,
  skip,
}) =>
  expressRateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message,
    skip,
  });

export const rateLimit = createLimiter({
  max: MAX_REQUESTS,
  message: {
    error: 'Too many requests. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: Math.ceil(WINDOW_MS / 1000),
  },
  skip: (req) => req.path === '/api/health',
});

// Stricter rate limit for auth endpoints
export const authRateLimit = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: AUTH_MAX_REQUESTS,
  message: {
    error: 'Too many authentication attempts. Please wait 15 minutes.',
    code: 'AUTH_RATE_LIMIT',
  },
});

export const adminAuthRateLimit = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: ADMIN_AUTH_MAX_REQUESTS,
  message: {
    error: 'Too many admin authentication attempts. Please wait 15 minutes.',
    code: 'ADMIN_AUTH_RATE_LIMIT',
  },
});
