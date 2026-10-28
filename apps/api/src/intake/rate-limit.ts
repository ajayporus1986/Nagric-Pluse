/**
 * Rate limiting for the intake module, backed by intake.rate_limits.
 *
 * Separate, small copy of the same fixed-window pattern used by
 * iam/rate-limit.ts and citizen/rate-limit.ts, rather than a shared helper
 * pointed at any of those tables: each module owns its own schema and its
 * own least-privilege database role (np_intake_rw never gets a grant on
 * citizen.rate_limits or iam.rate_limits, or vice versa).
 */
import type pg from 'pg';
import { AppError } from '../core/errors.js';
import { bucketKey } from '../iam/rate-limit.js';

export { bucketKey };

/** Counts one hit in `bucket`. Throws NP-RATE-0001 once more than `limit` hits happen within `windowSeconds`. */
export async function dbRateLimit(db: pg.Pool | pg.PoolClient, bucket: string, limit: number, windowSeconds: number): Promise<void> {
  const { rows } = await db.query<{ hits: number }>(
    `INSERT INTO intake.rate_limits (bucket, window_start, hits) VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN intake.rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE intake.rate_limits.hits + 1 END,
       window_start = CASE WHEN intake.rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE intake.rate_limits.window_start END
     RETURNING hits`,
    [bucket, windowSeconds]
  );
  const hits = rows[0]?.hits ?? 0;
  if (hits > limit) throw new AppError('NP-RATE-0001', { bucket: bucket.split(':')[0], hits, limit, windowSeconds });
}
