/**
 * Sign-in flow for staff:
 *
 *   POST /auth/login                 username + password → partial session
 *   POST /auth/password              change password (forced on first sign-in)
 *   POST /auth/mfa/enroll/start      create authenticator secret, return QR
 *   POST /auth/mfa/enroll/confirm    confirm first code → full session
 *   POST /auth/mfa/verify            code → full session (new token)
 *   GET  /auth/session               who am I, next step, CSRF token
 *   POST /auth/logout                revoke this session
 *   GET  /auth/sessions              my active sessions
 *   DELETE /auth/sessions/:id        revoke one of my sessions
 *
 * Every success and failure is audited in iam.audit_outbox.
 */
import QRCode from 'qrcode';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../core/errors.js';
import { withTx, query } from '../db/pools.js';
import { writeAudit } from '../audit/outbox.js';
import type { App, AppDeps } from '../http/app.js';
import { authOf } from '../http/app.js';
import { decryptField, encryptField, getDummyHash, hashPassword, passwordProblems, verifyPassword } from '../security/crypto.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../security/totp.js';
import { bucketKey, dbRateLimit, resetRateLimit } from './rate-limit.js';
import { createSession, csrfFor, nextStep, revokeSession, revokeUserSessions, sessionCookieName } from './sessions.js';

/** Failed sign-ins before the account locks, and for how long. */
const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;

/** AAD for the TOTP secret column, binding ciphertext to its user. */
const totpAad = (userId: string) => `iam.users.totp_secret:${userId}`;

const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }).strict();
const codeBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const passwordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }).strict();

export function registerAuthRoutes(app: App, deps: AppDeps): void {
  const { cfg, pools, ring } = deps;
  const cookieName = sessionCookieName(cfg.COOKIE_SECURE);
  const times = { idleMinutes: cfg.SESSION_IDLE_MINUTES, absoluteHours: cfg.SESSION_ABSOLUTE_HOURS };

  /** Sets the session cookie with all hardening flags. */
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      secure: cfg.COOKIE_SECURE,
      sameSite: 'strict',
      path: '/',
      maxAge: cfg.SESSION_ABSOLUTE_HOURS * 3600
    });

  /** User-agent string truncated for storage. */
  const ua = (req: FastifyRequest) => (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null);

  // ---- POST /auth/login ---------------------------------------------------
  app.post('/api/v1/auth/login', { config: { access: { kind: 'public' } }, schema: { body: loginBody } }, async (req, reply) => {
    const { username, password } = req.body;
    // Two independent limits: per source IP and per account name.
    await dbRateLimit(pools.iam, bucketKey('login-ip', req.ip), 30, 900);
    await dbRateLimit(pools.iam, bucketKey('login-user', username), 10, 900);

    const { rows } = await query<{
      id: string; password_hash: string; status: string; locked_until: Date | null; failed_logins: number;
      must_change_password: boolean; totp_enrolled_at: Date | null;
    }>(pools.iam, `SELECT id, password_hash, status, locked_until, failed_logins, must_change_password, totp_enrolled_at
                     FROM iam.users WHERE username = $1`, [username]);
    const user = rows[0];

    // Always run a full scrypt verification so response time does not reveal whether the user exists.
    const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));

    if (!user || !ok) {
      await withTx(pools.iam, async (c) => {
        if (user) {
          // Count the failure and lock the account after LOCK_AFTER consecutive failures.
          await c.query(
            `UPDATE iam.users SET failed_logins = failed_logins + 1,
                    locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
              WHERE id = $1`,
            [user.id, LOCK_AFTER, LOCK_MINUTES]
          );
        }
        await writeAudit(c, 'iam', {
          action: 'iam.login.failure', actorId: user?.id ?? null, ip: req.ip,
          detail: { reason: user ? 'bad_password' : 'unknown_user', username }
        });
      });
      throw new AppError('NP-AUTH-0002', { knownUser: Boolean(user) });
    }
    if (user.status !== 'ACTIVE') {
      await withTx(pools.iam, (c) => writeAudit(c, 'iam', { action: 'iam.login.refused', actorId: user.id, ip: req.ip, detail: { reason: 'disabled' } }));
      throw new AppError('NP-AUTH-0004', { userId: user.id });
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      await withTx(pools.iam, (c) => writeAudit(c, 'iam', { action: 'iam.login.refused', actorId: user.id, ip: req.ip, detail: { reason: 'locked' } }));
      throw new AppError('NP-AUTH-0003', { userId: user.id, lockedUntil: user.locked_until.toISOString() });
    }

    // Password accepted: reset counters, open a session that still needs the second factor.
    const { token } = await withTx(pools.iam, async (c) => {
      await c.query('UPDATE iam.users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
      const s = await createSession(c, user.id, { ...times, mfaVerified: false, ip: req.ip, userAgent: ua(req) });
      await writeAudit(c, 'iam', { action: 'iam.login.password_ok', actorId: user.id, ip: req.ip, targetType: 'session', targetId: s.sessionId });
      return s;
    });
    await resetRateLimit(pools.iam, bucketKey('login-user', username));
    setCookie(reply, token);
    return {
      csrfToken: csrfFor(token),
      next: nextStep({ mustChangePassword: user.must_change_password, totpEnrolled: user.totp_enrolled_at !== null, mfaVerified: false })
    };
  });

  // ---- POST /auth/password ------------------------------------------------
  app.post(
    '/api/v1/auth/password',
    { config: { access: { kind: 'session', allowIncomplete: true } }, schema: { body: passwordBody } },
    async (req) => {
      const auth = authOf(req);
      // Until the second factor is passed, only the forced first-password change is allowed here.
      if (!auth.mustChangePassword && !auth.mfaVerified) throw new AppError('NP-MFA-0001');
      await dbRateLimit(pools.iam, bucketKey('pw-change', auth.userId), 10, 900);
      const { currentPassword, newPassword } = req.body;
      const { rows } = await query<{ password_hash: string }>(pools.iam, 'SELECT password_hash FROM iam.users WHERE id = $1', [auth.userId]);
      if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
        await withTx(pools.iam, (c) => writeAudit(c, 'iam', { action: 'iam.password.change_failed', actorId: auth.userId, ip: req.ip, detail: { reason: 'bad_current' } }));
        throw new AppError('NP-AUTH-0007');
      }
      const problems = passwordProblems(newPassword, auth.username);
      if (newPassword === currentPassword) problems.push('must differ from the current password');
      if (problems.length > 0) {
        throw new AppError('NP-AUTH-0006', {}, { fields: problems.map((p) => ({ path: 'newPassword', message: p })) });
      }
      const hash = await hashPassword(newPassword);
      const revoked = await withTx(pools.iam, async (c) => {
        await c.query('UPDATE iam.users SET password_hash = $2, password_changed_at = now(), must_change_password = false WHERE id = $1', [auth.userId, hash]);
        // Changing a password signs out every other device.
        const n = await revokeUserSessions(c, auth.userId, 'password_changed', auth.sessionId);
        await writeAudit(c, 'iam', { action: 'iam.password.changed', actorId: auth.userId, ip: req.ip, detail: { otherSessionsRevoked: n } });
        return n;
      });
      return { next: nextStep({ ...auth, mustChangePassword: false }), otherSessionsRevoked: revoked };
    }
  );

  // ---- POST /auth/mfa/enroll/start ----------------------------------------
  app.post('/api/v1/auth/mfa/enroll/start', { config: { access: { kind: 'session', allowIncomplete: true } } }, async (req) => {
    const auth = authOf(req);
    if (auth.mustChangePassword) throw new AppError('NP-AUTH-0005');
    if (auth.totpEnrolled) throw new AppError('NP-MFA-0004', { userId: auth.userId });
    const secret = generateTotpSecret();
    await withTx(pools.iam, async (c) => {
      // Store the pending secret encrypted; it only becomes active after a correct code.
      await c.query('UPDATE iam.users SET totp_secret_enc = $2, totp_enrolled_at = NULL, totp_last_step = NULL WHERE id = $1', [
        auth.userId,
        encryptField(ring, secret, totpAad(auth.userId))
      ]);
      await writeAudit(c, 'iam', { action: 'iam.mfa.enroll_started', actorId: auth.userId, ip: req.ip });
    });
    const otpauthUrl = otpauthUri(secret, auth.username);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    // The secret is returned once, for manual entry; it is never logged (redacted) or shown again.
    return { secret, otpauthUrl, qrDataUrl };
  });

  /**
   * Shared code check for enrolment and verification. On success upgrades the
   * session: issues a new token with mfa_verified set and revokes the old one.
   */
  async function acceptCode(req: FastifyRequest, reply: FastifyReply, code: string, enrolling: boolean) {
    const auth = authOf(req);
    if (auth.mustChangePassword) throw new AppError('NP-AUTH-0005');
    await dbRateLimit(pools.iam, bucketKey('mfa', auth.userId), 5, 300);
    const { rows } = await query<{ totp_secret_enc: string | null; totp_enrolled_at: Date | null; totp_last_step: string | null }>(
      pools.iam, 'SELECT totp_secret_enc, totp_enrolled_at, totp_last_step FROM iam.users WHERE id = $1', [auth.userId]
    );
    const u = rows[0];
    if (!u?.totp_secret_enc) throw new AppError('NP-MFA-0005');
    if (enrolling && u.totp_enrolled_at) throw new AppError('NP-MFA-0004');
    if (!enrolling && !u.totp_enrolled_at) throw new AppError('NP-MFA-0002');

    const secret = decryptField(ring, u.totp_secret_enc, totpAad(auth.userId));
    const step = verifyTotp(secret, code, Date.now(), u.totp_last_step === null ? null : Number(u.totp_last_step));
    if (step === null) {
      await withTx(pools.iam, (c) => writeAudit(c, 'iam', { action: enrolling ? 'iam.mfa.enroll_failed' : 'iam.mfa.verify_failed', actorId: auth.userId, ip: req.ip }));
      throw new AppError('NP-MFA-0003', { userId: auth.userId });
    }

    const { token } = await withTx(pools.iam, async (c) => {
      // Conditional update guards against a parallel request using the same code (replay race).
      const upd = await c.query(
        `UPDATE iam.users SET totp_last_step = $2, totp_enrolled_at = COALESCE(totp_enrolled_at, now())
          WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
        [auth.userId, step]
      );
      if (upd.rowCount !== 1) throw new AppError('NP-MFA-0003', { reason: 'replay' });
      await revokeSession(c, auth.sessionId, 'mfa_upgrade');
      const s = await createSession(c, auth.userId, { ...times, mfaVerified: true, ip: req.ip, userAgent: ua(req) });
      await writeAudit(c, 'iam', { action: enrolling ? 'iam.mfa.enrolled' : 'iam.mfa.verified', actorId: auth.userId, ip: req.ip, targetType: 'session', targetId: s.sessionId });
      return s;
    });
    await resetRateLimit(pools.iam, bucketKey('mfa', auth.userId));
    setCookie(reply, token);
    return { csrfToken: csrfFor(token), next: 'READY' as const };
  }

  app.post(
    '/api/v1/auth/mfa/enroll/confirm',
    { config: { access: { kind: 'session', allowIncomplete: true } }, schema: { body: codeBody } },
    (req, reply) => acceptCode(req, reply, req.body.code, true)
  );

  app.post(
    '/api/v1/auth/mfa/verify',
    { config: { access: { kind: 'session', allowIncomplete: true } }, schema: { body: codeBody } },
    (req, reply) => acceptCode(req, reply, req.body.code, false)
  );

  // ---- GET /auth/session --------------------------------------------------
  app.get('/api/v1/auth/session', { config: { access: { kind: 'session', allowIncomplete: true } } }, async (req) => {
    const auth = authOf(req);
    const state = deps.policy.current();
    return {
      user: { id: auth.userId, username: auth.username, displayName: auth.displayName, locale: auth.locale },
      next: nextStep(auth),
      csrfToken: csrfFor(auth.token),
      // Assignments are only revealed once sign-in is complete.
      assignments:
        nextStep(auth) === 'READY'
          ? auth.assignments.map((a) => {
              const n = state.nodes.get(a.nodeId);
              return { role: a.role, nodeId: a.nodeId, nodeNameEn: n?.nameEn ?? a.nodeId, nodeNameHi: n?.nameHi ?? a.nodeId, level: n?.level };
            })
          : []
    };
  });

  // ---- POST /auth/logout --------------------------------------------------
  app.post('/api/v1/auth/logout', { config: { access: { kind: 'session', allowIncomplete: true } } }, async (req, reply) => {
    const auth = authOf(req);
    await withTx(pools.iam, async (c) => {
      await revokeSession(c, auth.sessionId, 'logout');
      await writeAudit(c, 'iam', { action: 'iam.logout', actorId: auth.userId, ip: req.ip, targetType: 'session', targetId: auth.sessionId });
    });
    void reply.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  });

  // ---- PUT /auth/locale ---------------------------------------------------
  app.put(
    '/api/v1/auth/locale',
    { config: { access: { kind: 'session', allowIncomplete: true } }, schema: { body: z.object({ locale: z.enum(['hi', 'en']) }).strict() } },
    async (req) => {
      const auth = authOf(req);
      await query(pools.iam, 'UPDATE iam.users SET preferred_locale = $2 WHERE id = $1', [auth.userId, req.body.locale]);
      return { locale: req.body.locale };
    }
  );

  // ---- GET /auth/sessions -------------------------------------------------
  app.get('/api/v1/auth/sessions', { config: { access: { kind: 'session' } } }, async (req) => {
    const auth = authOf(req);
    const { rows } = await query<{ id: string; created_at: Date; last_seen_at: Date; ip: string | null; user_agent: string | null }>(
      pools.iam,
      `SELECT id, created_at, last_seen_at, host(ip) AS ip, user_agent FROM iam.sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now() AND idle_expires_at > now()
        ORDER BY last_seen_at DESC`,
      [auth.userId]
    );
    return { sessions: rows.map((r) => ({ ...r, current: r.id === auth.sessionId })) };
  });

  // ---- DELETE /auth/sessions/:id -----------------------------------------
  app.delete(
    '/api/v1/auth/sessions/:id',
    { config: { access: { kind: 'session' } }, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = authOf(req);
      const n = await withTx(pools.iam, async (c) => {
        // Users may revoke only their own sessions.
        const r = await c.query(`UPDATE iam.sessions SET revoked_at = now(), revoke_reason = 'user_revoked' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [
          req.params.id,
          auth.userId
        ]);
        if (r.rowCount) await writeAudit(c, 'iam', { action: 'iam.session.revoked', actorId: auth.userId, ip: req.ip, targetType: 'session', targetId: req.params.id });
        return r.rowCount ?? 0;
      });
      if (n === 0) throw new AppError('NP-HTTP-0001', { sessionId: req.params.id });
      return { ok: true };
    }
  );
}
