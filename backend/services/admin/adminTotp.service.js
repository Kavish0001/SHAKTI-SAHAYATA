import crypto from 'node:crypto';
import { ADMIN_CONSOLE_CONFIG, isAdminTotpRequiredForRole } from '../../config/adminConsole.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const normalizeBase32 = (value) =>
  String(value || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/[^A-Z2-7]/g, '');

const decodeBase32 = (value) => {
  const normalized = normalizeBase32(value);
  if (!normalized) return Buffer.alloc(0);

  let bits = '';
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }

  return Buffer.from(bytes);
};

const generateCounterBuffer = (counter) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  return buffer;
};

const generateTotpCode = (secret, timestampMs = Date.now()) => {
  const step = ADMIN_CONSOLE_CONFIG.totp.stepSeconds;
  const counter = Math.floor(timestampMs / 1000 / step);
  const key = decodeBase32(secret);

  if (key.length === 0) return null;

  const digest = crypto.createHmac('sha1', key).update(generateCounterBuffer(counter)).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  );

  return String(binary % (10 ** ADMIN_CONSOLE_CONFIG.totp.digits)).padStart(ADMIN_CONSOLE_CONFIG.totp.digits, '0');
};

export const verifyAdminTotpCode = (secret, code, timestampMs = Date.now()) => {
  const normalizedCode = String(code || '').trim();
  if (!secret || !normalizedCode) return false;

  const driftWindows = ADMIN_CONSOLE_CONFIG.totp.allowedDriftWindows;
  const stepMs = ADMIN_CONSOLE_CONFIG.totp.stepSeconds * 1000;

  for (let offset = -driftWindows; offset <= driftWindows; offset += 1) {
    const candidate = generateTotpCode(secret, timestampMs + offset * stepMs);
    if (!candidate || candidate.length !== normalizedCode.length) continue;
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalizedCode))) {
      return true;
    }
  }

  return false;
};

export const getAdminTotpPolicyState = (admin) => {
  const role = String(admin?.role || '').trim();
  const enrolled = Boolean(admin?.totp_enabled && admin?.totp_secret);
  const required = isAdminTotpRequiredForRole(role);

  return {
    required,
    enrolled,
    enabled: Boolean(admin?.totp_enabled),
  };
};
