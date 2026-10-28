/** Unit tests for password hashing, field encryption and TOTP. */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildKeyRing, decryptField, encryptField, hashPassword, passwordProblems, verifyPassword } from './crypto.js';
import { base32Decode, base32Encode, totpAt, verifyTotp } from './totp.js';

const key = () => randomBytes(32).toString('base64');

describe('passwords', () => {
  it('hashes and verifies, rejects wrong passwords and malformed hashes', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('correct horse battery stapler', h)).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
  });
  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });
  it('applies the password policy', () => {
    expect(passwordProblems('short', 'ajay')).toContain('at least 12 characters');
    expect(passwordProblems('ajay-is-my-password', 'ajay')).toContain('must not contain the username');
    expect(passwordProblems('aaaaaaaaaaaaaaa', 'x')).toContain('too few distinct characters');
    expect(passwordProblems('a long passphrase 2026', 'ajay')).toEqual([]);
  });
});

describe('field encryption', () => {
  it('round-trips Hindi text and binds to context', () => {
    const ring = buildKeyRing([`v1:${key()}`], 'v1');
    const ct = encryptField(ring, 'गौतम बुद्ध नगर', 'ctx:1');
    expect(decryptField(ring, ct, 'ctx:1')).toBe('गौतम बुद्ध नगर');
    expect(() => decryptField(ring, ct, 'ctx:2')).toThrow();
  });
  it('detects tampering', () => {
    const ring = buildKeyRing([`v1:${key()}`], 'v1');
    const parts = encryptField(ring, 'secret', 'a').split(':');
    parts[3] = Buffer.from('xxxxxx').toString('base64url');
    expect(() => decryptField(ring, parts.join(':'), 'a')).toThrow();
  });
  it('rotates keys: old values still decrypt, new values use the active key', () => {
    const k1 = key();
    const old = encryptField(buildKeyRing([`v1:${k1}`], 'v1'), 'x', 'a');
    const ring2 = buildKeyRing([`v1:${k1}`, `v2:${key()}`], 'v2');
    expect(decryptField(ring2, old, 'a')).toBe('x');
    expect(encryptField(ring2, 'x', 'a').startsWith('v2:')).toBe(true);
  });
  it('rejects bad keys', () => {
    expect(() => buildKeyRing(['v1:c2hvcnQ='], 'v1')).toThrow();
    expect(() => buildKeyRing([`v1:${key()}`], 'v9')).toThrow();
  });
});

describe('TOTP', () => {
  // RFC 6238 Appendix B test secret ("12345678901234567890"), SHA-1.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC 6238 test vectors (last 6 digits)', () => {
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(totpAt(secret, 1_111_111_109_000)).toBe('081804');
    expect(totpAt(secret, 1_234_567_890_000)).toBe('005924');
  });
  it('base32 round-trips', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it('accepts one step of drift, rejects replays and malformed codes', () => {
    const now = 1_800_000_000_000;
    const code = totpAt(secret, now - 30_000);
    const step = verifyTotp(secret, code, now, null);
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now, null)).toBeNull();
    expect(verifyTotp(secret, '12345', now, null)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now, null)).toBeNull();
  });
});
