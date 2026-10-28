/**
 * Rate limiting for the citizen module, backed by citizen.rate_limits.
 *
 * Deliberately a separate, small copy of the same fixed-window pattern used
 * by iam/rate-limit.ts (dbRateLimit/resetRateLimit), rather than a shared
 * helper pointed at either table: each module owns its own schema and its
 * own least-privilege database role, so the citizen role (np_citizen_rw)
 * never needs a grant on iam.rate_limits, or vice versa.
 */
import type pg from 'pg';
import { AppError } from '../core/errors.js';
import { bucketKey } from '../iam/rate-limit.js';

export { bucketKey };

/**
 * Counts one hit in `bucket`. Throws NP-RATE-0001 once more than `limit` hits
 * happen within `windowSeconds`. Atomic under concurrency (single upsert).
 */
export async function dbRateLimit(db: pg.Pool | pg.PoolClient, bucket: string, limit: number, windowSeconds: number): Promise<void> {
  const { rows } = await db.query<{ hits: number }>(
    `INSERT INTO citizen.rate_limits (bucket, window_start, hits) VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN citizen.rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE citizen.rate_limits.hits + 1 END,
       window_start = CASE WHEN citizen.rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE citizen.rate_limits.window_start END
     RETURNING hits`,
    [bucket, windowSeconds]
  );
  const hits = rows[0]?.hits ?? 0;
  if (hits > limit) throw new AppError('NP-RATE-0001', { bucket: bucket.split(':')[0], hits, limit, windowSeconds });
}

/** Clears a bucket, e.g. after a successful OTP verification resets the per-mobile counter. */
export async function resetRateLimit(db: pg.Pool | pg.PoolClient, bucket: string): Promise<void> {
  await db.query('DELETE FROM citizen.rate_limits WHERE bucket = $1', [bucket]);
}
