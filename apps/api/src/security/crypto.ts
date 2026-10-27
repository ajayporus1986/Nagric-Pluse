/**
 * Cryptographic primitives used by the API. Only Node's built-in crypto is
 * used: no hand-rolled ciphers, no third-party crypto dependencies.
 *
 *   - Passwords: scrypt (memory-hard), per-user random salt, parameters stored
 *     with the hash so they can be raised later without breaking old hashes.
 *   - Field encryption: AES-256-GCM (authenticated), random 96-bit IV, key id
 *     prefix so keys can be rotated: "v1:<iv>:<tag>:<ciphertext>" (base64url).
 *   - Tokens: 256-bit random values; only their SHA-256 is stored.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../core/errors.js';

// ---------------------------------------------------------------------------
// Random tokens and hashing
// ---------------------------------------------------------------------------

/** 256-bit random token, base64url encoded (43 chars). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 digest of a string as a Buffer (used to store session/CSRF tokens). */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison of two buffers of possibly different length. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual throws on length mismatch; compare lengths first (length is not secret).
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

/** scrypt cost parameters. N=2^15, r=8 → ~32 MiB memory per hash. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** Promise wrapper around crypto.scrypt with explicit parameters. */
function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hashes a password. Output format: scrypt$N$r$p$<salt b64url>$<hash b64url>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Verifies a password against a stored hash in constant time. Malformed hashes never verify. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64url'), Number(n), Number(r), Number(p), expected.length);
  return safeEqual(key, expected);
}

/**
 * A valid hash of a random password, computed once. Used when the username
 * does not exist so that "unknown user" and "wrong password" take the same time.
 */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomToken());
  return dummyHash;
}

/**
 * Password policy (NIST SP 800-63B style): length matters more than
 * composition rules. Returns a list of problems (empty = acceptable).
 */
export function passwordProblems(password: string, username: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('at least 12 characters');
  if (password.length > 128) problems.push('at most 128 characters');
  if (password.toLowerCase().includes(username.toLowerCase())) problems.push('must not contain the username');
  // Reject trivially repetitive passwords such as "aaaaaaaaaaaa".
  if (new Set(password).size < 5) problems.push('too few distinct characters');
  return problems;
}

/** Generates a one-time password for new accounts: 20 chars from an unambiguous alphabet. */
export function generateOneTimePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  // randomInt uses rejection sampling, so every character is equally likely
  // (no modulo bias). 20 chars from 57 symbols ≈ 117 bits of entropy.
  for (let i = 0; i < 20; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// ---------------------------------------------------------------------------
// Field encryption (AES-256-GCM with key ring)
// ---------------------------------------------------------------------------

/** Key ring: key id → 32-byte key, plus the id used for new encryptions. */
export interface KeyRing {
  keys: Map<string, Buffer>;
  active: string;
}

/**
 * Builds a key ring from "id:base64" entries. Throws NP-CFG-0002 if any key
 * is not exactly 32 bytes or the active id is missing.
 */
export function buildKeyRing(entries: string[], active: string): KeyRing {
  const keys = new Map<string, Buffer>();
  for (const entry of entries) {
    const idx = entry.indexOf(':');
    const id = entry.slice(0, idx);
    const key = Buffer.from(entry.slice(idx + 1), 'base64');
    if (idx < 1 || key.length !== 32) throw new AppError('NP-CFG-0002', { keyId: id || '(empty)', reason: 'key must be 32 bytes base64' });
    keys.set(id, key);
  }
  if (!keys.has(active)) throw new AppError('NP-CFG-0002', { reason: 'active key id not in key ring' });
  return { keys, active };
}

/**
 * Encrypts a UTF-8 string. `aad` (additional authenticated data) binds the
 * ciphertext to its context, e.g. "iam.users.totp:<userId>", so a value copied
 * into another row or column fails to decrypt.
 */
export function encryptField(ring: KeyRing, plaintext: string, aad: string): string {
  const key = ring.keys.get(ring.active)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ring.active, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

/** Decrypts a value produced by encryptField. Throws NP-CFG-0002 on unknown key, Error on tampering. */
export function decryptField(ring: KeyRing, value: string, aad: string): string {
  const [keyId, ivB64, tagB64, ctB64] = value.split(':');
  const key = keyId ? ring.keys.get(keyId) : undefined;
  if (!key || !ivB64 || !tagB64 || ctB64 === undefined) throw new AppError('NP-CFG-0002', { reason: 'unknown key id or malformed ciphertext', keyId });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  // final() throws if the tag does not verify (tampered or wrong AAD).
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}
