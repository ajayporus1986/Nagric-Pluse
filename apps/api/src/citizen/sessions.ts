/**
 * Citizen sessions. Same design as staff sessions (iam/sessions.ts) — a
 * random token in an HttpOnly cookie, only its SHA-256 stored, HMAC-derived
 * CSRF token — but a wholly separate cookie, table and type, so a citizen
 * session can never be mistaken for, or escalated into, a staff one.
 */
import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { AppError } from '../core/errors.js';
import { randomToken, safeEqual, sha256 } from '../security/crypto.js';

/** Cookie name. The __Host- prefix forces Secure, Path=/ and no Domain in browsers. */
export function citizenCookieName(secure: boolean): string {
  return secure ? '__Host-np_citizen' : 'np_citizen';
}

/** Everything the request pipeline knows about an authenticated citizen. */
export interface CitizenAuthContext {
  sessionId: string;
  citizenId: string;
  displayName: string | null;
  locale: 'hi' | 'en';
  /** Raw session token from the cookie, kept only in memory to derive the CSRF token. */
  token: string;
}

/** CSRF token for a session token (deterministic, unforgeable without the cookie). */
export function csrfFor(token: string): string {
  return createHmac('sha256', token).update('citizen-csrf').digest('base64url');
}

/** Constant-time CSRF check. */
export function csrfValid(token: string, header: string | undefined): boolean {
  if (!header) return false;
  return safeEqual(Buffer.from(csrfFor(token)), Buffer.from(header));
}

/** Session lifetimes in minutes. */
export interface SessionTimes {
  idleMinutes: number;
  absoluteHours: number;
}

/**
 * Creates a session row and returns the raw token (to put in the cookie).
 * Runs on the caller's transaction so it commits together with the audit entry.
 */
export async function createCitizenSession(
  client: pg.PoolClient,
  citizenId: string,
  opts: SessionTimes & { ip: string | null; userAgent: string | null }
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO citizen.sessions (token_hash, csrf_hash, citizen_id, idle_expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4), now() + make_interval(hours => $5), $6, $7)
     RETURNING id`,
    [sha256(token), sha256(csrfFor(token)), citizenId, opts.idleMinutes, opts.absoluteHours, opts.ip, opts.userAgent?.slice(0, 300) ?? null]
  );
  return { token, sessionId: rows[0]!.id };
}

/** Revokes one session (idempotent). */
export async function revokeCitizenSession(client: pg.PoolClient | pg.Pool, sessionId: string, reason: string): Promise<void> {
  await client.query(`UPDATE citizen.sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason]);
}

/** Row shape for loading a session together with its citizen. */
interface CitizenSessionRow {
  session_id: string;
  citizen_id: string;
  display_name: string | null;
  preferred_locale: 'hi' | 'en';
  status: string;
  revoked_at: Date | null;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  last_seen_at: Date;
}

/**
 * Loads and validates a citizen session from its raw token. Throws:
 *   NP-CIT-0006 expired, NP-CIT-0007 revoked or unknown, NP-CIT-0005 citizen disabled.
 * Touches last_seen/idle expiry at most once a minute to limit write load.
 */
export async function loadCitizenSession(db: pg.Pool, token: string, times: SessionTimes): Promise<CitizenAuthContext> {
  const { rows } = await db.query<CitizenSessionRow>(
    `SELECT s.id AS session_id, c.id AS citizen_id, c.display_name, c.preferred_locale, c.status, s.revoked_at,
            s.idle_expires_at, s.absolute_expires_at, s.last_seen_at
       FROM citizen.sessions s JOIN citizen.citizens c ON c.id = s.citizen_id
      WHERE s.token_hash = $1`,
    [sha256(token)]
  );
  const s = rows[0];
  if (!s || s.revoked_at) throw new AppError('NP-CIT-0007', { found: Boolean(s) });
  const now = Date.now();
  if (s.idle_expires_at.getTime() <= now || s.absolute_expires_at.getTime() <= now) {
    throw new AppError('NP-CIT-0006', { sessionId: s.session_id });
  }
  if (s.status !== 'ACTIVE') throw new AppError('NP-CIT-0005', { citizenId: s.citizen_id });

  if (now - s.last_seen_at.getTime() > 60_000) {
    await db.query(
      `UPDATE citizen.sessions SET last_seen_at = now(),
              idle_expires_at = LEAST(now() + make_interval(mins => $2), absolute_expires_at)
        WHERE id = $1`,
      [s.session_id, times.idleMinutes]
    );
  }

  return { sessionId: s.session_id, citizenId: s.citizen_id, displayName: s.display_name, locale: s.preferred_locale, token };
}
