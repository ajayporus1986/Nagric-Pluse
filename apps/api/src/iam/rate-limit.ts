/**
 * Rate limiting.
 *
 * Two layers:
 *   1. `dbRateLimit` — fixed window counters in iam.rate_limits, shared by all
 *      API replicas. Used for security-sensitive endpoints (sign-in, codes).
 *   2. `MemoryRateLimiter` — per-replica sliding counter for general traffic,
 *      cheap enough to run on every request.
 *
 * Bucket keys never contain raw IP addresses or usernames: they are hashed so
 * the table does not become a log of who tried to sign in from where.
 */
import type pg from 'pg';
import { AppError } from '../core/errors.js';
import { sha256 } from '../security/crypto.js';

/** Hashes a bucket key so personal data is not stored in clear. */
export function bucketKey(kind: string, value: string): string {
  return `${kind}:${sha256(`${kind}|${value.toLowerCase()}`).subarray(0, 16).toString('hex')}`;
}

/**
 * Counts one hit in `bucket`. Throws NP-RATE-0001 once more than `limit` hits
 * happen within `windowSeconds`. Atomic under concurrency (single upsert).
 */
export async function dbRateLimit(db: pg.Pool | pg.PoolClient, bucket: string, limit: number, windowSeconds: number): Promise<void> {
  const { rows } = await db.query<{ hits: number }>(
    `INSERT INTO iam.rate_limits (bucket, window_start, hits) VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN iam.rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE iam.rate_limits.hits + 1 END,
       window_start = CASE WHEN iam.rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE iam.rate_limits.window_start END
     RETURNING hits`,
    [bucket, windowSeconds]
  );
  const hits = rows[0]?.hits ?? 0;
  if (hits > limit) throw new AppError('NP-RATE-0001', { bucket: bucket.split(':')[0], hits, limit, windowSeconds });
}

/** Clears a bucket, e.g. after a successful sign-in resets the per-user counter. */
export async function resetRateLimit(db: pg.Pool | pg.PoolClient, bucket: string): Promise<void> {
  await db.query('DELETE FROM iam.rate_limits WHERE bucket = $1', [bucket]);
}

/**
 * In-memory fixed-window limiter. Holds at most `maxKeys` entries; when full,
 * the oldest windows are evicted so memory cannot be exhausted by many IPs.
 */
export class MemoryRateLimiter {
  private readonly windows = new Map<string, { start: number; hits: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000
  ) {}

  /** Returns true if the hit is allowed, false if the key is over its limit. */
  hit(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      // Evict the oldest entry when the map is full (Map preserves insertion order).
      if (!w && this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      this.windows.delete(key);
      this.windows.set(key, { start: now, hits: 1 });
      return true;
    }
    w.hits += 1;
    return w.hits <= this.limit;
  }
}
