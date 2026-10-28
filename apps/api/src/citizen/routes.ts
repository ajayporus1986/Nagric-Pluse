/**
 * Citizen identity: mobile-number + OTP self-service sign-in, kept entirely
 * separate from staff identity (see db/migrations/0009_citizen.sql and
 * citizen/sessions.ts for why).
 *
 *   POST /citizen/otp/request   mobile number + node → sends an OTP
 *   POST /citizen/otp/verify    mobile number + node + OTP → citizen session
 *   GET  /citizen/session       who am I, CSRF token
 *   POST /citizen/logout        revoke this session
 *   PUT  /citizen/locale        change preferred language
 *
 * Every route is registered with `access: { kind: 'public' }`: citizens are
 * not staff and have no role in the Lego permission model, so the generic
 * staff session/feature pipeline in http/app.ts does not apply to them.
 * Availability is instead checked directly against the Lego module/feature
 * toggle via PolicyService.featureAvailable('citizen.identity', nodeId) — the
 * same mechanism, read without a principal — so a district can still switch
 * citizen self-service on or off for its own subtree. Authenticated routes
 * (session/logout/locale) load and validate the citizen session cookie by
 * hand, including the CSRF check the generic pipeline would otherwise do.
 *
 * The OTP response is identical whether the mobile number has signed in
 * before or not, so this endpoint cannot be used to probe which numbers are
 * registered.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../core/errors.js';
import { query, withTx } from '../db/pools.js';
import { writeAudit } from '../audit/outbox.js';
import type { App, AppDeps } from '../http/app.js';
import { encryptField, generateNumericOtp, safeEqual, sha256 } from '../security/crypto.js';
import { bucketKey, dbRateLimit, resetRateLimit } from './rate-limit.js';
import { citizenCookieName, createCitizenSession, csrfFor, csrfValid, loadCitizenSession, revokeCitizenSession, type CitizenAuthContext } from './sessions.js';

/** AAD for the mobile-number ciphertext column, binding ciphertext to its citizen row. */
const mobileAad = (citizenId: string) => `citizen.citizens.mobile_number:${citizenId}`;

/**
 * Normalises an Indian mobile number to "+91XXXXXXXXXX". Accepts a bare
 * 10-digit number or one already carrying a "91"/"+91"/"0" prefix. Returns
 * null if it is not a plausible Indian mobile number (starts 6-9, 10 digits).
 */
export function normalizeIndianMobile(raw: string): string | null {
  let digits = raw.replace(/[\s()-]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

const nodeIdField = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const otpRequestBody = z.object({ mobileNumber: z.string().min(1).max(20), nodeId: nodeIdField }).strict();
const otpVerifyBody = z.object({ mobileNumber: z.string().min(1).max(20), nodeId: nodeIdField, otp: z.string().regex(/^\d{4,8}$/) }).strict();
const localeBody = z.object({ locale: z.enum(['hi', 'en']) }).strict();

export function registerCitizenRoutes(app: App, deps: AppDeps): void {
  const { cfg, pools, policy, ring, otpSender } = deps;
  const cookieName = citizenCookieName(cfg.COOKIE_SECURE);
  const times = { idleMinutes: cfg.CITIZEN_SESSION_IDLE_MINUTES, absoluteHours: cfg.CITIZEN_SESSION_ABSOLUTE_HOURS };

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      secure: cfg.COOKIE_SECURE,
      sameSite: 'strict',
      path: '/',
      maxAge: cfg.CITIZEN_SESSION_ABSOLUTE_HOURS * 3600
    });

  const ua = (req: FastifyRequest) => (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null);

  /** Loads the citizen session from the cookie, or throws NP-CIT-0008 if there is none. */
  async function citizenAuthOf(req: FastifyRequest): Promise<CitizenAuthContext> {
    const token = req.cookies[cookieName];
    if (!token) throw new AppError('NP-CIT-0008');
    return loadCitizenSession(pools.citizen, token, times);
  }

  /** CSRF check for citizen-authenticated mutating routes (the generic staff pipeline does not cover this cookie). */
  function requireCsrf(req: FastifyRequest, auth: CitizenAuthContext): void {
    const header = req.headers['x-csrf-token'];
    if (!csrfValid(auth.token, typeof header === 'string' ? header : undefined)) throw new AppError('NP-CSRF-0001', { citizenId: auth.citizenId });
  }

  /** Throws NP-CIT-0001 if citizen self-service is off at this node, NP-SCOPE-0001 if the node is unknown. */
  function requireAvailable(nodeId: string): void {
    if (!policy.featureAvailable('citizen.identity', nodeId)) throw new AppError('NP-CIT-0001', { nodeId });
  }

  // ---- POST /citizen/otp/request ------------------------------------------
  app.post(
    '/api/v1/citizen/otp/request',
    { config: { access: { kind: 'public' } }, schema: { body: otpRequestBody } },
    async (req) => {
      const { nodeId } = req.body;
      requireAvailable(nodeId);
      const mobile = normalizeIndianMobile(req.body.mobileNumber);
      if (!mobile) throw new AppError('NP-CIT-0002');
      const mobileHash = sha256(mobile);

      await dbRateLimit(pools.citizen, bucketKey('cit-otp-req-ip', req.ip), 30, 600);
      await dbRateLimit(pools.citizen, bucketKey('cit-otp-req-mobile', mobile), 5, 600);

      const otp = generateNumericOtp(6);
      await withTx(pools.citizen, async (c) => {
        await c.query(
          `INSERT INTO citizen.otp_challenges (mobile_hash, purpose, otp_hash, node_id, expires_at, ip)
           VALUES ($1, 'LOGIN', $2, $3, now() + make_interval(secs => $4), $5)`,
          [mobileHash, sha256(otp), nodeId, cfg.OTP_TTL_SECONDS, req.ip]
        );
        await writeAudit(c, 'citizen', {
          action: 'citizen.otp.requested',
          scopePath: policy.pathOf(nodeId).join('.'),
          ip: req.ip,
          // Never log the mobile number itself, even hashed to text, in audit detail; the ledger is read by
          // staff with broader access than a single district, and the hash alone is enough for abuse review
          // when cross-referenced with the rate-limit bucket, which already uses the same hash.
          detail: {}
        });
      });
      await otpSender.send(mobile, otp, 'LOGIN');
      return { ok: true, expiresInSeconds: cfg.OTP_TTL_SECONDS };
    }
  );

  // ---- POST /citizen/otp/verify -------------------------------------------
  app.post(
    '/api/v1/citizen/otp/verify',
    { config: { access: { kind: 'public' } }, schema: { body: otpVerifyBody } },
    async (req, reply) => {
      const { nodeId, otp } = req.body;
      requireAvailable(nodeId);
      const mobile = normalizeIndianMobile(req.body.mobileNumber);
      if (!mobile) throw new AppError('NP-CIT-0002');
      const mobileHash = sha256(mobile);

      await dbRateLimit(pools.citizen, bucketKey('cit-otp-verify-ip', req.ip), 60, 600);
      await dbRateLimit(pools.citizen, bucketKey('cit-otp-verify-mobile', mobile), cfg.OTP_MAX_ATTEMPTS * 3, 600);

      // A wrong guess must still COMMIT its attempts-increment and audit entry, so the whole flow
      // below runs as a discriminated result rather than throwing inside the transaction: throwing
      // inside withTx rolls back everything done in that same transaction, including the very
      // bookkeeping (attempts count, failure audit) that a failed guess needs to leave behind.
      type Outcome =
        | { kind: 'NO_CHALLENGE' }
        | { kind: 'TOO_MANY' }
        | { kind: 'WRONG' }
        | { kind: 'DISABLED'; citizenId: string }
        | { kind: 'OK'; token: string; citizenId: string };

      const outcome = await withTx(pools.citizen, async (c): Promise<Outcome> => {
        const ch = await c.query<{ id: string; otp_hash: Buffer; attempts: number }>(
          `SELECT id, otp_hash, attempts FROM citizen.otp_challenges
            WHERE mobile_hash = $1 AND purpose = 'LOGIN' AND consumed_at IS NULL AND expires_at > now()
            ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [mobileHash]
        );
        const challenge = ch.rows[0];
        if (!challenge) {
          await writeAudit(c, 'citizen', { action: 'citizen.otp.verify_failed', ip: req.ip, detail: { reason: 'no_active_challenge' } });
          return { kind: 'NO_CHALLENGE' };
        }
        if (challenge.attempts >= cfg.OTP_MAX_ATTEMPTS) {
          await writeAudit(c, 'citizen', { action: 'citizen.otp.verify_failed', ip: req.ip, detail: { reason: 'too_many_attempts' } });
          return { kind: 'TOO_MANY' };
        }
        if (!safeEqual(sha256(otp), challenge.otp_hash)) {
          await c.query('UPDATE citizen.otp_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
          await writeAudit(c, 'citizen', { action: 'citizen.otp.verify_failed', ip: req.ip, detail: { reason: 'wrong_code' } });
          return { kind: 'WRONG' };
        }
        // Conditional on consumed_at IS NULL: guards against a parallel request re-using the same challenge.
        const consumed = await c.query('UPDATE citizen.otp_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL', [challenge.id]);
        if (consumed.rowCount !== 1) return { kind: 'WRONG' };

        const existing = await c.query<{ id: string; status: string }>('SELECT id, status FROM citizen.citizens WHERE mobile_hash = $1', [mobileHash]);
        let citizenRow = existing.rows[0];
        if (!citizenRow) {
          const newId = randomUUID();
          await c.query(
            `INSERT INTO citizen.citizens (id, mobile_hash, mobile_number_enc, registered_node_id) VALUES ($1, $2, $3, $4)`,
            [newId, mobileHash, encryptField(ring, mobile, mobileAad(newId)), nodeId]
          );
          citizenRow = { id: newId, status: 'ACTIVE' };
          await writeAudit(c, 'citizen', { action: 'citizen.registered', actorId: newId, targetType: 'citizen', targetId: newId, scopePath: policy.pathOf(nodeId).join('.'), ip: req.ip });
        }
        if (citizenRow.status !== 'ACTIVE') return { kind: 'DISABLED', citizenId: citizenRow.id };

        await c.query('UPDATE citizen.citizens SET last_login_at = now() WHERE id = $1', [citizenRow.id]);
        const s = await createCitizenSession(c, citizenRow.id, { ...times, ip: req.ip, userAgent: ua(req) });
        await writeAudit(c, 'citizen', {
          action: 'citizen.login.success', actorId: citizenRow.id, targetType: 'session', targetId: s.sessionId, scopePath: policy.pathOf(nodeId).join('.'), ip: req.ip
        });
        return { kind: 'OK', token: s.token, citizenId: citizenRow.id };
      });

      if (outcome.kind === 'NO_CHALLENGE' || outcome.kind === 'WRONG') throw new AppError('NP-CIT-0003');
      if (outcome.kind === 'TOO_MANY') throw new AppError('NP-CIT-0004');
      if (outcome.kind === 'DISABLED') throw new AppError('NP-CIT-0005', { citizenId: outcome.citizenId });
      const { token, citizenId } = outcome;

      await resetRateLimit(pools.citizen, bucketKey('cit-otp-verify-mobile', mobile));
      await resetRateLimit(pools.citizen, bucketKey('cit-otp-req-mobile', mobile));
      setCookie(reply, token);
      const d = await query<{ display_name: string | null; preferred_locale: 'hi' | 'en' }>(
        pools.citizen, 'SELECT display_name, preferred_locale FROM citizen.citizens WHERE id = $1', [citizenId]
      );
      return { csrfToken: csrfFor(token), citizen: { displayName: d.rows[0]?.display_name ?? null, locale: d.rows[0]?.preferred_locale ?? 'hi' } };
    }
  );

  // ---- GET /citizen/session ------------------------------------------------
  app.get('/api/v1/citizen/session', { config: { access: { kind: 'public' } } }, async (req) => {
    const auth = await citizenAuthOf(req);
    return { citizen: { id: auth.citizenId, displayName: auth.displayName, locale: auth.locale }, csrfToken: csrfFor(auth.token) };
  });

  // ---- POST /citizen/logout -------------------------------------------------
  app.post('/api/v1/citizen/logout', { config: { access: { kind: 'public' } } }, async (req, reply) => {
    const auth = await citizenAuthOf(req);
    requireCsrf(req, auth);
    await withTx(pools.citizen, async (c) => {
      await revokeCitizenSession(c, auth.sessionId, 'logout');
      await writeAudit(c, 'citizen', { action: 'citizen.logout', actorId: auth.citizenId, targetType: 'session', targetId: auth.sessionId, ip: req.ip });
    });
    void reply.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  });

  // ---- PUT /citizen/locale --------------------------------------------------
  app.put(
    '/api/v1/citizen/locale',
    { config: { access: { kind: 'public' } }, schema: { body: localeBody } },
    async (req) => {
      const auth = await citizenAuthOf(req);
      requireCsrf(req, auth);
      await query(pools.citizen, 'UPDATE citizen.citizens SET preferred_locale = $2 WHERE id = $1', [auth.citizenId, req.body.locale]);
      return { locale: req.body.locale };
    }
  );
}
