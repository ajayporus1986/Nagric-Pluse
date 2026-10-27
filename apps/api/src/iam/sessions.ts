/**
 * Staff sessions.
 *
 * - The browser holds a 256-bit random token in an HttpOnly cookie. The
 *   database stores only SHA-256(token), so a database leak does not yield
 *   usable sessions.
 * - CSRF token = HMAC-SHA256(key = session token, "csrf"). The server can
 *   recompute it from the cookie on every request without storing it; the
 *   browser can only learn it from a same-origin API response.
 * - Idle timeout slides with activity; absolute timeout never moves.
 * - Any privilege change (second factor passed) issues a NEW token
 *   (prevents session fixation).
 */
import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { AppError } from '../core/errors.js';
import { randomToken, safeEqual, sha256 } from '../security/crypto.js';

/** Cookie name. The __Host- prefix forces Secure, Path=/ and no Domain in browsers. */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-np_session' : 'np_session';
}

/** Role assignment attached to a session (path resolved from the scope tree). */
export interface SessionAssignment {
  role: string;
  nodeId: string;
  /** Node ids from the root down to the assignment node. */
  path: string[];
}

/** Everything the request pipeline knows about an authenticated staff user. */
export interface AuthContext {
  sessionId: string;
  userId: string;
  username: string;
  displayName: string;
  locale: 'hi' | 'en';
  mfaVerified: boolean;
  totpEnrolled: boolean;
  mustChangePassword: boolean;
  assignments: SessionAssignment[];
  /** Raw session token from the cookie, kept only in memory to derive the CSRF token. */
  token: string;
}

/** What the client should do next after signing in. */
export type NextStep = 'CHANGE_PASSWORD' | 'MFA_ENROLL' | 'MFA_VERIFY' | 'READY';

/** Derives the next step from session state. Order: password → enrol → verify. */
export function nextStep(a: Pick<AuthContext, 'mustChangePassword' | 'totpEnrolled' | 'mfaVerified'>): NextStep {
  if (a.mustChangePassword) return 'CHANGE_PASSWORD';
  if (!a.totpEnrolled) return 'MFA_ENROLL';
  if (!a.mfaVerified) return 'MFA_VERIFY';
  return 'READY';
}

/** CSRF token for a session token (deterministic, unforgeable without the cookie). */
export function csrfFor(token: string): string {
  return createHmac('sha256', token).update('csrf').digest('base64url');
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
export async function createSession(
  client: pg.PoolClient,
  userId: string,
  opts: SessionTimes & { mfaVerified: boolean; ip: string | null; userAgent: string | null }
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO iam.sessions (token_hash, csrf_hash, user_id, idle_expires_at, absolute_expires_at, mfa_verified_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4), now() + make_interval(hours => $5),
             CASE WHEN $6 THEN now() END, $7, $8)
     RETURNING id`,
    [sha256(token), sha256(csrfFor(token)), userId, opts.idleMinutes, opts.absoluteHours, opts.mfaVerified, opts.ip, opts.userAgent?.slice(0, 300) ?? null]
  );
  return { token, sessionId: rows[0]!.id };
}

/** Revokes one session (idempotent). */
export async function revokeSession(client: pg.PoolClient | pg.Pool, sessionId: string, reason: string): Promise<void> {
  await client.query(`UPDATE iam.sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason]);
}

/** Revokes every session of a user except, optionally, one. Returns how many were revoked. */
export async function revokeUserSessions(client: pg.PoolClient | pg.Pool, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const r = await client.query(
    `UPDATE iam.sessions SET revoked_at = now(), revoke_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [userId, reason, exceptSessionId ?? null]
  );
  return r.rowCount ?? 0;
}

/** Row shape for loading a session together with its user. */
interface SessionRow {
  session_id: string;
  user_id: string;
  username: string;
  display_name: string;
  preferred_locale: 'hi' | 'en';
  status: string;
  mfa_verified_at: Date | null;
  totp_enrolled_at: Date | null;
  must_change_password: boolean;
  revoked_at: Date | null;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  last_seen_at: Date;
}

/**
 * Loads and validates a session from its raw token. Throws:
 *   NP-SESS-0001 expired, NP-SESS-0002 revoked or unknown, NP-AUTH-0004 user disabled.
 * Touches last_seen/idle expiry at most once a minute to limit write load.
 */
export async function loadSession(db: pg.Pool, token: string, times: SessionTimes): Promise<AuthContext> {
  const { rows } = await db.query<SessionRow>(
    `SELECT s.id AS session_id, u.id AS user_id, u.username, u.display_name, u.preferred_locale, u.status,
            s.mfa_verified_at, u.totp_enrolled_at, u.must_change_password, s.revoked_at,
            s.idle_expires_at, s.absolute_expires_at, s.last_seen_at
       FROM iam.sessions s JOIN iam.users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [sha256(token)]
  );
  const s = rows[0];
  if (!s || s.revoked_at) throw new AppError('NP-SESS-0002', { found: Boolean(s) });
  const now = Date.now();
  if (s.idle_expires_at.getTime() <= now || s.absolute_expires_at.getTime() <= now) {
    throw new AppError('NP-SESS-0001', { sessionId: s.session_id });
  }
  if (s.status !== 'ACTIVE') throw new AppError('NP-AUTH-0004', { userId: s.user_id });

  // Slide the idle timeout, but write at most once per minute per session.
  if (now - s.last_seen_at.getTime() > 60_000) {
    await db.query(
      `UPDATE iam.sessions SET last_seen_at = now(),
              idle_expires_at = LEAST(now() + make_interval(mins => $2), absolute_expires_at)
        WHERE id = $1`,
      [s.session_id, times.idleMinutes]
    );
  }

  // Active role assignments with their scope paths (ltree text "IN.UP.D144").
  const roles = await db.query<{ role: string; node_id: string; path: string }>(
    `SELECT ra.role, ra.node_id, sn.path::text AS path
       FROM iam.role_assignments ra JOIN platform.scope_nodes sn ON sn.id = ra.node_id
      WHERE ra.user_id = $1 AND ra.revoked_at IS NULL AND sn.active`,
    [s.user_id]
  );

  return {
    sessionId: s.session_id,
    userId: s.user_id,
    username: s.username,
    displayName: s.display_name,
    locale: s.preferred_locale,
    mfaVerified: s.mfa_verified_at !== null,
    totpEnrolled: s.totp_enrolled_at !== null,
    mustChangePassword: s.must_change_password,
    assignments: roles.rows.map((r) => ({ role: r.role, nodeId: r.node_id, path: r.path.split('.') })),
    token
  };
}
