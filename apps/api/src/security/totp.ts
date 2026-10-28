/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 s step),
 * compatible with Google Authenticator, Microsoft Authenticator, etc.
 *
 * Replay protection: the caller stores the last accepted time step per user
 * and passes it in; a code at or before that step is rejected.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './crypto.js';

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept one step either side to tolerate small clock drift on phones. */
const WINDOW = 1;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encodes bytes as RFC 4648 base32 without padding. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes RFC 4648 base32 (case-insensitive, padding and spaces ignored). */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** New 160-bit secret, base32 encoded (the format authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP value (RFC 4226) for a counter, zero-padded to 6 digits. */
function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Current time step for a given time in milliseconds. */
export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** Generates the code for a time (used by tests and the e2e helper). */
export function totpAt(secretB32: string, nowMs: number): string {
  return hotp(base32Decode(secretB32), timeStep(nowMs));
}

/**
 * Verifies a code. Returns the matched time step (to be stored as the new
 * "last used step"), or null if the code is wrong, malformed or replayed.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const current = timeStep(nowMs);
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const step = current + delta;
    // Never accept a step that was already used (replay) or an earlier one.
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (safeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** otpauth:// URI for QR enrolment. Label and issuer are URL-encoded. */
export function otpauthUri(secretB32: string, username: string, issuer = 'Nagrik Pulse'): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
