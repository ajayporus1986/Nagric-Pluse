/**
 * Database connection pools, one per module.
 *
 * Each module connects with its own Postgres login role, so a bug or injection
 * in one module cannot read or write another module's schema. Every
 * connection gets a statement timeout and an application_name that shows up
 * in pg_stat_activity for debugging.
 */
import pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../core/config.js';
import { AppError, fromPgError } from '../core/errors.js';

/** Module pools available to the API. */
export interface Pools {
  platform: pg.Pool;
  iam: pg.Pool;
  audit: pg.Pool;
  registry: pg.Pool;
  citizen: pg.Pool;
}

/** Creates one pool with safe defaults and error logging. */
function makePool(name: keyof Pools, url: string, cfg: Config, log: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: cfg.DB_POOL_MAX,
    application_name: `np-api-${name}`,
    // Fail fast instead of queueing forever when the database is unreachable.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Server-side guard against runaway queries.
    statement_timeout: cfg.DB_STATEMENT_TIMEOUT_MS,
    // Never hold a transaction open while idle (e.g. after an unhandled await).
    idle_in_transaction_session_timeout: 30_000
  });
  // Errors on idle clients (e.g. server restart) would otherwise crash the process.
  pool.on('error', (err) => log.error({ err, pool: name, errCode: 'NP-DB-0001' }, 'idle database client error'));
  return pool;
}

/** Creates all module pools from config. */
export function createPools(cfg: Config, log: Logger): Pools {
  return {
    platform: makePool('platform', cfg.db.platform, cfg, log),
    iam: makePool('iam', cfg.db.iam, cfg, log),
    audit: makePool('audit', cfg.db.audit, cfg, log),
    registry: makePool('registry', cfg.db.registry, cfg, log),
    citizen: makePool('citizen', cfg.db.citizen, cfg, log)
  };
}

/** Closes all pools; used on graceful shutdown. */
export async function closePools(p: Pools): Promise<void> {
  await Promise.allSettled([p.platform.end(), p.iam.end(), p.audit.end(), p.registry.end(), p.citizen.end()]);
}

/**
 * Runs `fn` inside a READ COMMITTED transaction on a client from `pool`.
 * Commits on success, rolls back on any error, always releases the client.
 * Postgres errors are translated to catalogue codes.
 */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (e) {
    // Could not even get a connection: report as database unavailable.
    throw fromPgError(e) ?? new AppError('NP-DB-0001', { reason: (e as Error).message }, { cause: e });
  }
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    // Rollback failure is ignored: the original error is the one that matters,
    // and a broken connection is discarded by release(true) below.
    await client.query('ROLLBACK').catch(() => undefined);
    throw fromPgError(e) ?? e;
  } finally {
    client.release();
  }
}

/** Single query outside a transaction, with error translation. */
export async function query<R extends pg.QueryResultRow>(pool: pg.Pool | pg.PoolClient, text: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
  try {
    return await pool.query<R>(text, params);
  } catch (e) {
    throw fromPgError(e) ?? e;
  }
}
