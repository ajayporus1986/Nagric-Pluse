/**
 * Rate limiting for the case engine module, backed by "case".rate_limits.
 *
 * Same fixed-window pattern as every other module's rate-limit.ts (iam,
 * citizen, intake) -- its own small copy against its own schema and role,
 * never a shared helper pointed at another module's table.
 */
import type pg from 'pg';
import { AppError } from '../core/errors.js';
import { bucketKey } from '../iam/rate-limit.js';

export { bucketKey };

/** Counts one hit in `bucket`. Throws NP-RATE-0001 once more than `limit` hits happen within `windowSeconds`. */
export async function dbRateLimit(db: pg.Pool | pg.PoolClient, bucket: string, limit: number, windowSeconds: number): Promise<void> {
  const { rows } = await db.query<{ hits: number }>(
    `INSERT INTO "case".rate_limits (bucket, window_start, hits) VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN "case".rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE "case".rate_limits.hits + 1 END,
       window_start = CASE WHEN "case".rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE "case".rate_limits.window_start END
     RETURNING hits`,
    [bucket, windowSeconds]
  );
  const hits = rows[0]?.hits ?? 0;
  if (hits > limit) throw new AppError('NP-RATE-0001', { bucket: bucket.split(':')[0], hits, limit, windowSeconds });
}
