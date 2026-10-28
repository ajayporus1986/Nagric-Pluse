/**
 * Runtime configuration, read once from environment variables and validated.
 *
 * Secure-by-default rules:
 *   - The process refuses to start on any invalid or missing value (NP-CFG-0001).
 *   - In production, cookies are always Secure and per-module database URLs are
 *     mandatory (no shared superuser connection).
 *   - Secrets are never logged; `describeConfig` returns a redacted summary.
 */
import { z } from 'zod';
import { AppError } from './errors.js';

/** Comma-separated list helper for env values. */
const csv = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

/** Boolean env parser: only the literal strings "true"/"false" are accepted. */
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    // Database connections. Each module gets its own login role (least privilege).
    DATABASE_URL: z.string().url().optional(), // development fallback only
    DATABASE_URL_PLATFORM: z.string().url().optional(),
    DATABASE_URL_IAM: z.string().url().optional(),
    DATABASE_URL_AUDIT: z.string().url().optional(),
    DATABASE_URL_REGISTRY: z.string().url().optional(),
    DATABASE_URL_CITIZEN: z.string().url().optional(),
    DATABASE_URL_ORG: z.string().url().optional(),
    DATABASE_URL_INTAKE: z.string().url().optional(),
    DATABASE_URL_CASE: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),

    // Field encryption keyring: "v1:<base64 32 bytes>,v2:<base64 32 bytes>".
    FIELD_ENCRYPTION_KEYS: csv,
    FIELD_ENCRYPTION_ACTIVE_KEY: z.string().regex(/^[a-z0-9]{1,16}$/),

    // Web security.
    PUBLIC_ORIGIN: z.string().url(), // exact origin of the admin console, used for Origin checks
    // prefault: the default string is parsed (and transformed to a boolean) like a real value.
    COOKIE_SECURE: bool.prefault('true'),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0), // number of reverse-proxy hops to trust

    // Session lifetimes.
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24).default(12),

    // General per-IP request budget per API replica (requests per minute). Sign-in and
    // code checks have their own, much stricter, database-backed limits.
    RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().min(60).max(100_000).default(600),

    // Change requests expire if not decided in this many days.
    CHANGE_REQUEST_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),

    // Citizen OTP sign-in. Never hardcoded: an operator may need a longer
    // window for low-connectivity areas, or stricter limits under abuse.
    OTP_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    CITIZEN_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    CITIZEN_SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(168).default(72),
    // How the OTP is actually delivered. "console" only logs it (dev/test);
    // "webhook" POSTs to the operator's own SMS-gateway bridge. See
    // citizen/otp-sender.ts for why no vendor SDK is wired in directly.
    SMS_PROVIDER: z.enum(['console', 'webhook']).default('console'),
    SMS_WEBHOOK_URL: z.string().url().optional(),
    SMS_WEBHOOK_SECRET: z.string().min(16).optional(),

    // Case engine: SLA-breach escalation sweep and the citizen closure-
    // confirmation window (how long a citizen has to confirm or dispute a
    // RESOLVED grievance before it auto-closes).
    CASE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),
    CASE_CLOSURE_CONFIRMATION_WINDOW_DAYS: z.coerce.number().int().min(1).max(60).default(7)
  })
  .superRefine((c, ctx) => {
    // Production must use one database role per module, never a shared URL.
    if (c.NODE_ENV === 'production') {
      for (const k of ['DATABASE_URL_PLATFORM', 'DATABASE_URL_IAM', 'DATABASE_URL_AUDIT', 'DATABASE_URL_REGISTRY', 'DATABASE_URL_CITIZEN', 'DATABASE_URL_ORG', 'DATABASE_URL_INTAKE', 'DATABASE_URL_CASE'] as const) {
        if (!c[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required in production' });
      }
      if (!c.COOKIE_SECURE) ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'must be true in production' });
      if (!c.PUBLIC_ORIGIN.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'must be https in production' });
      // The console OTP sender only logs the code: never acceptable once real citizens use it.
      if (c.SMS_PROVIDER === 'console') ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'console stub cannot be used in production; set webhook' });
    } else if (
      !c.DATABASE_URL &&
      !(c.DATABASE_URL_PLATFORM && c.DATABASE_URL_IAM && c.DATABASE_URL_AUDIT && c.DATABASE_URL_REGISTRY && c.DATABASE_URL_CITIZEN && c.DATABASE_URL_ORG && c.DATABASE_URL_INTAKE && c.DATABASE_URL_CASE)
    ) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'set DATABASE_URL or all per-module URLs' });
    }
    if (c.SMS_PROVIDER === 'webhook' && (!c.SMS_WEBHOOK_URL || !c.SMS_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['SMS_WEBHOOK_URL'], message: 'SMS_WEBHOOK_URL and SMS_WEBHOOK_SECRET are required when SMS_PROVIDER=webhook' });
    }
    // The active key id must exist in the keyring.
    const ids = c.FIELD_ENCRYPTION_KEYS.map((k) => k.split(':')[0]);
    if (!ids.includes(c.FIELD_ENCRYPTION_ACTIVE_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['FIELD_ENCRYPTION_ACTIVE_KEY'], message: 'not present in FIELD_ENCRYPTION_KEYS' });
    }
  });

/** Validated configuration object. */
export type Config = z.output<typeof schema> & {
  /** Resolved connection string per module (falls back to DATABASE_URL in dev/test). */
  db: { platform: string; iam: string; audit: string; registry: string; citizen: string; org: string; intake: string; case: string };
};

/**
 * Parses and validates the environment. Throws NP-CFG-0001 listing the
 * offending variable names (never their values).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Only variable names and reasons are reported; values may be secrets.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new AppError('NP-CFG-0001', { problems });
  }
  const c = parsed.data;
  const fallback = c.DATABASE_URL ?? '';
  return {
    ...c,
    db: {
      platform: c.DATABASE_URL_PLATFORM ?? fallback,
      iam: c.DATABASE_URL_IAM ?? fallback,
      audit: c.DATABASE_URL_AUDIT ?? fallback,
      registry: c.DATABASE_URL_REGISTRY ?? fallback,
      citizen: c.DATABASE_URL_CITIZEN ?? fallback,
      org: c.DATABASE_URL_ORG ?? fallback,
      intake: c.DATABASE_URL_INTAKE ?? fallback,
      case: c.DATABASE_URL_CASE ?? fallback
    }
  };
}

/** Redacted summary safe to log at startup. */
export function describeConfig(c: Config): Record<string, unknown> {
  // Strip credentials from connection strings before logging.
  const host = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.hostname}:${x.port || 5432}${x.pathname}`;
    } catch {
      return 'invalid';
    }
  };
  return {
    env: c.NODE_ENV,
    port: c.PORT,
    publicOrigin: c.PUBLIC_ORIGIN,
    cookieSecure: c.COOKIE_SECURE,
    trustProxy: c.TRUST_PROXY,
    db: {
      platform: host(c.db.platform), iam: host(c.db.iam), audit: host(c.db.audit), registry: host(c.db.registry),
      citizen: host(c.db.citizen), org: host(c.db.org), intake: host(c.db.intake), case: host(c.db.case)
    },
    smsProvider: c.SMS_PROVIDER,
    sharedDbUrl: !c.DATABASE_URL_PLATFORM,
    encryptionKeyIds: c.FIELD_ENCRYPTION_KEYS.map((k) => k.split(':')[0]),
    activeKey: c.FIELD_ENCRYPTION_ACTIVE_KEY
  };
}
