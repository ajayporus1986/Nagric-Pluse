/**
 * Worker process entry point (same image as the API, different command).
 *
 * Runs the background jobs on fixed intervals. A failing job logs its error
 * code and is retried on the next tick; it never stops other jobs.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { z } from 'zod';
import { createLogger } from '../core/logger.js';
import { keyIdOf } from '../audit/checkpoint.js';
import { cleanupCitizen, cleanupIam, expireRecords, relayAudit, signCheckpointIfDue, type SigningKey } from './jobs.js';

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    DATABASE_URL: z.string().url().optional(),
    DATABASE_URL_AUDIT_RELAY: z.string().url().optional(),
    DATABASE_URL_PLATFORM: z.string().url().optional(),
    DATABASE_URL_IAM: z.string().url().optional(),
    DATABASE_URL_CITIZEN: z.string().url().optional(),
    AUDIT_SIGNING_KEY_FILE: z.string().optional(),
    RELAY_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
    CHECKPOINT_TICK_MS: z.coerce.number().int().min(1000).default(30_000),
    CHECKPOINT_MIN_ROWS: z.coerce.number().int().min(1).default(1000),
    CHECKPOINT_MAX_AGE_MS: z.coerce.number().int().min(10_000).default(300_000)
  })
  .parse(process.env);

const log = createLogger('worker', env.LOG_LEVEL);

/** Resolves a module URL, falling back to DATABASE_URL outside production. */
function url(specific: string | undefined, name: string): string {
  if (specific) return specific;
  if (env.NODE_ENV !== 'production' && env.DATABASE_URL) return env.DATABASE_URL;
  log.fatal({ errCode: 'NP-CFG-0001', missing: name }, 'database URL missing');
  process.exit(1);
}

const pools = {
  relay: new pg.Pool({ connectionString: url(env.DATABASE_URL_AUDIT_RELAY, 'DATABASE_URL_AUDIT_RELAY'), max: 2, application_name: 'np-worker-relay' }),
  platform: new pg.Pool({ connectionString: url(env.DATABASE_URL_PLATFORM, 'DATABASE_URL_PLATFORM'), max: 2, application_name: 'np-worker-platform' }),
  iam: new pg.Pool({ connectionString: url(env.DATABASE_URL_IAM, 'DATABASE_URL_IAM'), max: 2, application_name: 'np-worker-iam' }),
  citizen: new pg.Pool({ connectionString: url(env.DATABASE_URL_CITIZEN, 'DATABASE_URL_CITIZEN'), max: 2, application_name: 'np-worker-citizen' })
};
for (const [name, p] of Object.entries(pools)) p.on('error', (err) => log.error({ err, pool: name, errCode: 'NP-DB-0001' }, 'idle client error'));

/** Loads the Ed25519 signing key, if configured. Without it checkpoints are disabled (warned every start). */
async function loadKey(): Promise<SigningKey | null> {
  if (!env.AUDIT_SIGNING_KEY_FILE) {
    log.warn({ errCode: 'NP-WORK-0003' }, 'AUDIT_SIGNING_KEY_FILE not set: audit checkpoints will NOT be signed');
    return null;
  }
  const privateKey = createPrivateKey(await readFile(env.AUDIT_SIGNING_KEY_FILE, 'utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('audit signing key must be Ed25519');
  return { privateKey, keyId: keyIdOf(createPublicKey(privateKey)) };
}

/** Schedules a job; overlapping ticks are skipped, errors are logged with the job's code. */
function every(name: string, ms: number, errCode: string, fn: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    const started = Date.now();
    fn()
      .then((result) => {
        // Log only ticks that did something, to keep logs useful.
        const did = typeof result === 'number' ? result > 0 : result && typeof result === 'object' ? Object.values(result).some((v) => v) : Boolean(result);
        if (did) log.info({ job: name, result, ms: Date.now() - started }, 'job tick');
      })
      .catch((err) => log.error({ err, job: name, errCode }, 'job failed'))
      .finally(() => {
        running = false;
      });
  }, ms);
}

async function main(): Promise<void> {
  const key = await loadKey();
  log.info({ checkpoints: Boolean(key), keyId: key?.keyId }, 'worker starting');
  const timers = [
    every('relayAudit', env.RELAY_INTERVAL_MS, 'NP-WORK-0002', () => relayAudit(pools.relay)),
    every('expireRecords', 60_000, 'NP-WORK-0001', () => expireRecords(pools.platform)),
    every('cleanupIam', 3_600_000, 'NP-WORK-0001', () => cleanupIam(pools.iam)),
    every('cleanupCitizen', 3_600_000, 'NP-WORK-0001', () => cleanupCitizen(pools.citizen))
  ];
  if (key) timers.push(every('signCheckpoint', env.CHECKPOINT_TICK_MS, 'NP-WORK-0003', () => signCheckpointIfDue(pools.relay, key, env.CHECKPOINT_MIN_ROWS, env.CHECKPOINT_MAX_AGE_MS, log)));

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'worker stopping');
    timers.forEach(clearInterval);
    // One last relay so events written just before shutdown reach the ledger promptly.
    await relayAudit(pools.relay).catch((err) => log.error({ err, errCode: 'NP-WORK-0002' }, 'final relay failed'));
    await Promise.allSettled(Object.values(pools).map((p) => p.end()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err, errCode: 'NP-CFG-0002' }, 'worker failed to start');
  process.exit(1);
});
