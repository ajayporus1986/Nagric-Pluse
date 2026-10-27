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
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),

    // Field encryption keyring: "v1:<base64 32 bytes>,v2:<base64 32 bytes>".
    FIELD_ENCRYPTION_KEYS: csv,
    FIELD_ENCRYPTION_ACTIVE_KEY: z.string().regex(/^[a-z0-9]{1,16}$/),

    // Web security.
    PUBLIC_ORIGIN: z.string().url(), // exact origin of the admin console, used for Origin checks
    COOKIE_SECURE: bool.default('true'),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0), // number of reverse-proxy hops to trust

    // Session lifetimes.
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24).default(12),

    // Change requests expire if not decided in this many days.
    CHANGE_REQUEST_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7)
  })
  .superRefine((c, ctx) => {
    // Production must use one database role per module, never a shared URL.
    if (c.NODE_ENV === 'production') {
      for (const k of ['DATABASE_URL_PLATFORM', 'DATABASE_URL_IAM', 'DATABASE_URL_AUDIT'] as const) {
        if (!c[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'required in production' });
      }
      if (!c.COOKIE_SECURE) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['COOKIE_SECURE'], message: 'must be true in production' });
      if (!c.PUBLIC_ORIGIN.startsWith('https://')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PUBLIC_ORIGIN'], message: 'must be https in production' });
    } else if (!c.DATABASE_URL && !(c.DATABASE_URL_PLATFORM && c.DATABASE_URL_IAM && c.DATABASE_URL_AUDIT)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'], message: 'set DATABASE_URL or all per-module URLs' });
    }
    // The active key id must exist in the keyring.
    const ids = c.FIELD_ENCRYPTION_KEYS.map((k) => k.split(':')[0]);
    if (!ids.includes(c.FIELD_ENCRYPTION_ACTIVE_KEY)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FIELD_ENCRYPTION_ACTIVE_KEY'], message: 'not present in FIELD_ENCRYPTION_KEYS' });
    }
  });

/** Validated configuration object. */
export type Config = z.output<typeof schema> & {
  /** Resolved connection string per module (falls back to DATABASE_URL in dev/test). */
  db: { platform: string; iam: string; audit: string };
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
      audit: c.DATABASE_URL_AUDIT ?? fallback
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
    db: { platform: host(c.db.platform), iam: host(c.db.iam), audit: host(c.db.audit) },
    sharedDbUrl: !c.DATABASE_URL_PLATFORM,
    encryptionKeyIds: c.FIELD_ENCRYPTION_KEYS.map((k) => k.split(':')[0]),
    activeKey: c.FIELD_ENCRYPTION_ACTIVE_KEY
  };
}
