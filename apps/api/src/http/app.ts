/**
 * HTTP application: builds the Fastify instance with all security middleware,
 * the access-declaration guard, error handling and request logging.
 *
 * Request pipeline (in order):
 *   onRequest   1. request id + per-replica rate limit
 *               2. Origin / Fetch-Metadata check on state-changing methods
 *               3. session cookie → req.auth (if present)
 *               4. access kind check: public / session / feature
 *               5. CSRF token check on state-changing methods with a session
 *   preHandler  6. feature routes: resolve target node, run policy decision
 *   handler
 *   onResponse  7. one structured log line per request (status, ms, user, errCode)
 *
 * Every route MUST declare `config.access`; registration fails otherwise
 * (NP-CFG-0004), so an endpoint can never be accidentally public.
 */
import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { ERRORS, negotiateLocale, type Action, type ApiErrorBody, type ErrorCode, type Locale } from '@np/shared';
import type { PolicyResult } from '@np/policy';
import type { Config } from '../core/config.js';
import { AppError, fromPgError, isAppError } from '../core/errors.js';
import type { Pools } from '../db/pools.js';
import { MemoryRateLimiter } from '../iam/rate-limit.js';
import { csrfValid, loadSession, nextStep, sessionCookieName, type AuthContext } from '../iam/sessions.js';
import type { PolicyService } from '../policy/service.js';
import type { KeyRing } from '../security/crypto.js';

/** How a route may be reached. */
export type Access =
  /** No session required (health, sign-in). */
  | { kind: 'public' }
  /**
   * Any signed-in staff user. `allowIncomplete` permits sessions that have not
   * yet changed their first password or passed the second factor (used only by
   * the sign-in flow itself).
   */
  | { kind: 'session'; allowIncomplete?: boolean }
  /** Signed-in, fully verified, and the policy resolver allows `action` on `feature` at the node returned by `node`. */
  | { kind: 'feature'; feature: string; action: Action; node: (req: FastifyRequest) => string | Promise<string> };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    /** Set when a valid session cookie was presented. */
    auth?: AuthContext;
    /** Policy decision for feature routes (ALLOW or ALLOW_AUDITED or LIMIT). */
    decision?: PolicyResult & { nodeId: string };
    /** Error code of a failed request, for the access log line. */
    errCode?: ErrorCode;
    /** Locale used for messages in this response. */
    locale: Locale;
  }
}

/** Dependencies shared by all route modules. */
export interface AppDeps {
  cfg: Config;
  log: Logger;
  pools: Pools;
  policy: PolicyService;
  ring: KeyRing;
}

/** Fastify instance with the zod type provider, as passed to route modules. */
export type App = FastifyInstance<
  import('node:http').Server,
  import('node:http').IncomingMessage,
  import('node:http').ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** Methods that change state and therefore need CSRF and Origin checks. */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Builds a localised error body. */
function errorBody(code: ErrorCode, locale: Locale, requestId: string, fields?: { path: string; message: string }[]): ApiErrorBody {
  return { error: { code, message: ERRORS[code][locale], requestId, ...(fields ? { fields } : {}) } };
}

/** Builds the application. Routes are registered by `routes(app)` inside the guarded scope. */
export async function buildApp(deps: AppDeps, routes: (app: App, deps: AppDeps) => Promise<void> | void): Promise<App> {
  const { cfg, log, pools, policy } = deps;

  const app = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
    // We emit our own single access-log line in onResponse.
    disableRequestLogging: true,
    // Trust exactly the configured number of reverse-proxy hops for req.ip.
    trustProxy: (_address: string, hop: number) => hop < cfg.TRUST_PROXY,
    bodyLimit: 64 * 1024,
    // Reuse a well-formed upstream request id (from nginx) or create one.
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(h) ? h : randomUUID();
    }
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', undefined);
  app.decorateRequest('decision', undefined);
  app.decorateRequest('errCode', undefined);
  app.decorateRequest('locale', 'hi');

  // ---- Security headers ---------------------------------------------------
  // API responses are JSON only: forbid everything in CSP and framing.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: cfg.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true } : false
  });
  await app.register(fastifyCookie);

  // ---- Guard: every route must declare access ----------------------------
  app.addHook('onRoute', (route) => {
    if (!route.config?.access) {
      throw new AppError('NP-CFG-0004', { method: route.method, url: route.url });
    }
  });

  const generalLimiter = new MemoryRateLimiter(600, 60_000); // 600 requests/min/IP per replica
  const cookieName = sessionCookieName(cfg.COOKIE_SECURE);

  // ---- onRequest: rate limit, origin, session, access kind, CSRF ----------
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
    req.locale = negotiateLocale(req.headers['accept-language']);

    if (!generalLimiter.hit(req.ip)) throw new AppError('NP-RATE-0001', { limiter: 'general' });

    // Not-found routes have no config; let the 404 handler answer.
    const access = req.routeOptions.config?.access;
    if (!access) return;

    if (UNSAFE.has(req.method)) {
      // Browsers send Origin on every cross-origin and same-origin POST; reject foreign origins.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== cfg.PUBLIC_ORIGIN) throw new AppError('NP-CSRF-0002', { origin });
      // Fetch Metadata: a cross-site request is never legitimate for this API.
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('NP-CSRF-0002', { secFetchSite: 'cross-site' });
    }

    // Load the session if a cookie is present (even on public routes, e.g. to show "already signed in").
    const token = req.cookies[cookieName];
    if (token) {
      try {
        req.auth = await loadSession(pools.iam, token, { idleMinutes: cfg.SESSION_IDLE_MINUTES, absoluteHours: cfg.SESSION_ABSOLUTE_HOURS });
        req.locale = req.auth.locale;
      } catch (e) {
        // A bad cookie is only an error where a session is required; clear it either way.
        void reply.clearCookie(cookieName, { path: '/' });
        if (access.kind !== 'public') throw e;
      }
    }

    if (access.kind === 'public') return;
    if (!req.auth) throw new AppError('NP-AUTH-0001');

    // Sessions that have not finished sign-in may only use the sign-in flow.
    const allowIncomplete = access.kind === 'session' && access.allowIncomplete === true;
    if (!allowIncomplete) {
      const step = nextStep(req.auth);
      if (step === 'CHANGE_PASSWORD') throw new AppError('NP-AUTH-0005');
      if (step === 'MFA_ENROLL') throw new AppError('NP-MFA-0002');
      if (step === 'MFA_VERIFY') throw new AppError('NP-MFA-0001');
    }

    // CSRF: state-changing requests must echo the per-session token in a header.
    if (UNSAFE.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (!csrfValid(req.auth.token, typeof header === 'string' ? header : undefined)) {
        throw new AppError('NP-CSRF-0001', { userId: req.auth.userId });
      }
    }
  });

  // ---- preHandler: policy decision for feature routes ---------------------
  // Runs after body/query validation so the node id can come from validated input.
  app.addHook('preHandler', async (req) => {
    const access = req.routeOptions.config?.access;
    if (access?.kind !== 'feature' || !req.auth) return;
    const nodeId = await access.node(req);
    const result = policy.decide(req.auth, access.feature, access.action, nodeId);
    if (result.decision === 'BLOCK') {
      // Distinguish "switched off here" from "not permitted" so users get the right message.
      const code: ErrorCode = result.available ? 'NP-POL-0001' : 'NP-POL-0002';
      throw new AppError(code, { feature: access.feature, action: access.action, nodeId, trace: result.trace });
    }
    req.decision = { ...result, nodeId };
  });

  // ---- Errors -------------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    let e: AppError;
    if (isAppError(err)) {
      e = err;
    } else if ((err as { validation?: unknown }).validation || (err as { code?: string }).code === 'FST_ERR_VALIDATION') {
      // zod validation failure: report field paths and messages, never the submitted values.
      const issues = ((err as { validation?: { instancePath?: string; message?: string; params?: { issue?: { path?: (string | number)[] } } }[] }).validation ?? []).map((v) => ({
        path: (v.params?.issue?.path ?? []).join('.') || (v.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.'),
        message: v.message ?? 'invalid'
      }));
      e = new AppError('NP-VAL-0001', { context: (err as { validationContext?: string }).validationContext }, { fields: issues });
    } else {
      const fcode = (err as { code?: string }).code;
      if (fcode === 'FST_ERR_CTP_BODY_TOO_LARGE') e = new AppError('NP-HTTP-0002');
      else if (fcode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') e = new AppError('NP-HTTP-0003');
      else if (fcode === 'FST_ERR_CTP_INVALID_JSON_BODY' || fcode === 'FST_ERR_CTP_EMPTY_JSON_BODY' || (err as { statusCode?: number }).statusCode === 400) {
        e = new AppError('NP-HTTP-0004', { fastifyCode: fcode });
      } else {
        e = fromPgError(err) ?? new AppError('NP-INT-0001', {}, { cause: err });
      }
    }
    req.errCode = e.code;
    const spec = ERRORS[e.code];
    // Faults log the full error with stack; expected user errors log only code and detail.
    const fields = { reqId: req.id, errCode: e.code, userId: req.auth?.userId, detail: e.detail, route: req.routeOptions.url };
    if (spec.level === 'error' || spec.level === 'fatal') req.log.error({ ...fields, err: e.cause ?? err }, e.message);
    else req.log[spec.level](fields, e.message);
    void reply.status(e.status).send(errorBody(e.code, req.locale, req.id, e.fields));
  });

  app.setNotFoundHandler((req, reply) => {
    req.errCode = 'NP-HTTP-0001';
    void reply.status(404).send(errorBody('NP-HTTP-0001', req.locale, req.id));
  });

  // ---- Access log: exactly one line per request ---------------------------
  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        reqId: req.id,
        method: req.method,
        route: req.routeOptions.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        userId: req.auth?.userId,
        errCode: req.errCode,
        decision: req.decision?.decision
      },
      'request'
    );
  });

  await routes(app, deps);
  return app;
}

/** Helper for handlers: the authenticated context, or NP-AUTH-0001 (should be unreachable behind the guard). */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new AppError('NP-AUTH-0001', { reason: 'handler reached without session' });
  return req.auth;
}

/** Roles of the caller, for audit records. */
export function rolesOf(req: FastifyRequest): string[] {
  return [...new Set(req.auth?.assignments.map((a) => a.role) ?? [])];
}
