import { ADMIN_CONSOLE_CONFIG } from '../../config/adminConsole.js';

const normalizeIp = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '::1') return '127.0.0.1';
  return text.replace(/^::ffff:/, '');
};

const parseIpv4 = (value) => {
  const normalized = normalizeIp(value);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) return null;

  const parts = normalized.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
};

const ipv4ToNumber = (value) => {
  const parts = parseIpv4(value);
  if (!parts) return null;
  return parts.reduce((acc, part) => ((acc << 8) | part) >>> 0, 0);
};

const matchesCidr = (ip, cidr) => {
  const [range, prefixText] = String(cidr || '').split('/');
  const prefix = Number.parseInt(prefixText, 10);
  const ipNumber = ipv4ToNumber(ip);
  const rangeNumber = ipv4ToNumber(range);

  if (ipNumber === null || rangeNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return (ipNumber & mask) === (rangeNumber & mask);
};

const resolveForwardedClientIp = (req) => {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((entry) => normalizeIp(entry))
    .find(Boolean);

  return normalizeIp(forwarded || '');
};

const resolveDirectClientIp = (req) => {
  // In allowlist mode we trust only the actual socket peer, not any forwarded headers.
  return normalizeIp(req.socket?.remoteAddress || req.ip || '');
};

const buildState = (req, matched, detail, clientIp) => {
  req.adminNetworkRestriction = {
    enforced: ADMIN_CONSOLE_CONFIG.network.mode !== 'disabled',
    mode: ADMIN_CONSOLE_CONFIG.network.mode,
    matched,
    clientIp,
    detail,
  };
};

export function adminNetworkGuard(req, res, next) {
  const { mode, allowlist, proxyHeader, proxyValue } = ADMIN_CONSOLE_CONFIG.network;
  const directClientIp = resolveDirectClientIp(req);

  if (mode === 'disabled') {
    buildState(req, true, 'Admin network restrictions are disabled.', directClientIp);
    return next();
  }

  if (mode === 'proxy') {
    const headerValue = String(req.headers[proxyHeader] || '').trim();
    const matched = Boolean(headerValue) && headerValue === proxyValue;
    const forwardedClientIp = resolveForwardedClientIp(req);
    buildState(
      req,
      matched,
      matched
        ? `Trusted admin proxy header ${proxyHeader} matched.${forwardedClientIp ? ` Forwarded client IP ${forwardedClientIp} observed.` : ''}`
        : `Missing or invalid trusted admin proxy header ${proxyHeader}.`,
      forwardedClientIp || directClientIp
    );

    if (!matched) {
      return res.status(403).json({ error: 'Admin access is restricted to the internal proxy', code: 'ADMIN_NETWORK_RESTRICTED' });
    }

    return next();
  }

  const clientIp = directClientIp;
  const matched = allowlist.some((entry) => {
    const candidate = normalizeIp(entry);
    if (!candidate) return false;
    if (candidate.includes('/')) return matchesCidr(clientIp, candidate);
    return candidate === clientIp;
  });

  buildState(
    req,
    matched,
    matched
      ? `Admin client IP ${clientIp} matched the configured allowlist.`
      : `Admin client IP ${clientIp || 'unknown'} is not in the configured allowlist.`,
    clientIp
  );

  if (!matched) {
    return res.status(403).json({ error: 'Admin access is restricted to the allowlisted network', code: 'ADMIN_NETWORK_RESTRICTED' });
  }

  return next();
}
