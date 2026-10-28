/**
 * Background jobs. Each job is safe to run on several worker replicas at once:
 * it takes a transaction-scoped advisory lock and simply skips the tick if
 * another replica holds it.
 *
 *   relayAudit        outbox rows → audit.ledger (in order), then deletes them
 *   signCheckpoint    Ed25519-signs the latest ledger hash periodically
 *   expireRecords     expires stale change requests and kill switches
 *   cleanupIam        deletes long-expired sessions and old rate-limit windows
 *   cleanupCitizen    same, for citizen sessions, rate limits and spent OTP challenges
 */
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import type { Logger } from 'pino';
import { signCheckpoint } from '../audit/checkpoint.js';

/** Advisory lock keys (arbitrary constants, one per job). */
const LOCK = { relay: 7_310_001, checkpoint: 7_310_002, expire: 7_310_003, cleanup: 7_310_004, cleanupCitizen: 7_310_005 };

/** Runs `fn` in a READ COMMITTED transaction if the advisory lock is free; returns undefined if skipped. */
async function exclusive<T>(pool: pg.Pool, lockKey: number, fn: (c: pg.PoolClient) => Promise<T>): Promise<T | undefined> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const got = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [lockKey]);
    if (!got.rows[0]?.ok) {
      await c.query('ROLLBACK');
      return undefined;
    }
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Outbox tables relayed into the ledger; `source` is recorded on each ledger row. */
const OUTBOXES = [
  { source: 'platform', table: 'platform.audit_outbox' },
  { source: 'iam', table: 'iam.audit_outbox' },
  { source: 'registry', table: 'registry.audit_outbox' },
  { source: 'citizen', table: 'citizen.audit_outbox' },
  { source: 'org', table: 'org.audit_outbox' }
] as const;

/**
 * Moves up to `batch` rows per outbox into the ledger. Delete and insert happen
 * in one transaction, so a crash cannot lose or duplicate events (event_id is
 * also UNIQUE in the ledger as a second guard). Returns rows relayed.
 */
export async function relayAudit(relayPool: pg.Pool, batch = 500): Promise<number> {
  const n = await exclusive(relayPool, LOCK.relay, async (c) => {
    let total = 0;
    for (const o of OUTBOXES) {
      // Table names come from the constant list above, never from input.
      const r = await c.query(
        `WITH moved AS (
           DELETE FROM ${o.table} WHERE id IN (SELECT id FROM ${o.table} ORDER BY id LIMIT $1) RETURNING *
         )
         INSERT INTO audit.ledger (event_id, source, occurred_at, actor_id, actor_roles, action, feature_code, scope_path, target_type, target_id, decision, ip, detail)
         SELECT event_id, $2, occurred_at, actor_id, actor_roles, action, feature_code, scope_path, target_type, target_id, decision, ip, detail
           FROM moved ORDER BY id`,
        [batch, o.source]
      );
      total += r.rowCount ?? 0;
    }
    return total;
  });
  return n ?? 0;
}

/** Signing key loaded by the worker. */
export interface SigningKey {
  keyId: string;
  privateKey: KeyObject;
}

/**
 * Signs a checkpoint when at least `minRows` new entries exist or `maxAgeMs`
 * passed since the last one (and there is anything new). Returns the signed
 * sequence number, or null if nothing was signed.
 */
export async function signCheckpointIfDue(relayPool: pg.Pool, key: SigningKey, minRows: number, maxAgeMs: number, log: Logger): Promise<string | null> {
  const r = await exclusive(relayPool, LOCK.checkpoint, async (c) => {
    const k = await c.query('SELECT 1 FROM audit.signing_keys WHERE key_id = $1 AND retired_at IS NULL', [key.keyId]);
    if (!k.rowCount) {
      log.error({ errCode: 'NP-WORK-0003', keyId: key.keyId }, 'signing key is not registered or is retired; run audit-key register');
      return null;
    }
    const last = await c.query<{ seq: string; hash: Buffer }>('SELECT seq::text, hash FROM audit.ledger ORDER BY seq DESC LIMIT 1');
    const head = last.rows[0];
    if (!head) return null;
    const cp = await c.query<{ up_to_seq: string; signed_at: Date }>('SELECT up_to_seq::text, signed_at FROM audit.checkpoints ORDER BY up_to_seq DESC LIMIT 1');
    const prev = cp.rows[0];
    const newRows = BigInt(head.seq) - BigInt(prev?.up_to_seq ?? '0');
    if (newRows <= 0n) return null;
    const age = prev ? Date.now() - prev.signed_at.getTime() : Infinity;
    if (newRows < BigInt(minRows) && age < maxAgeMs) return null;
    const signature = signCheckpoint(key.privateKey, head.seq, head.hash);
    await c.query('INSERT INTO audit.checkpoints (up_to_seq, ledger_hash, key_id, signature) VALUES ($1, $2, $3, $4)', [head.seq, head.hash, key.keyId, signature]);
    return head.seq;
  });
  return r ?? null;
}

/** Expires overdue change requests and kill switches, auditing each. Returns counts. */
export async function expireRecords(platformPool: pg.Pool): Promise<{ changeRequests: number; killSwitches: number }> {
  const r = await exclusive(platformPool, LOCK.expire, async (c) => {
    const crs = await c.query<{ id: string; node_id: string }>(
      `UPDATE platform.change_requests SET status = 'EXPIRED', decided_at = now() WHERE status = 'PENDING' AND expires_at <= now() RETURNING id, node_id`
    );
    for (const cr of crs.rows) {
      await c.query(`INSERT INTO platform.audit_outbox (action, target_type, target_id, detail) VALUES ('platform.change_request.expired', 'change_request', $1, $2)`, [
        cr.id, { nodeId: cr.node_id }
      ]);
    }
    // Expired kill switches are already ignored by the resolver; marking them cleared keeps the record tidy
    // and fires the policy NOTIFY so replicas drop them from memory.
    const ks = await c.query<{ id: string; module_id: string }>(
      `UPDATE platform.kill_switches SET cleared_at = expires_at WHERE cleared_at IS NULL AND expires_at <= now() RETURNING id, module_id`
    );
    for (const k of ks.rows) {
      await c.query(`INSERT INTO platform.audit_outbox (action, target_type, target_id, detail) VALUES ('platform.kill_switch.expired', 'module', $1, $2)`, [
        k.module_id, { killSwitchId: k.id }
      ]);
    }
    return { changeRequests: crs.rowCount ?? 0, killSwitches: ks.rowCount ?? 0 };
  });
  return r ?? { changeRequests: 0, killSwitches: 0 };
}

/** Deletes sessions expired for over 30 days and rate-limit windows older than a day. */
export async function cleanupIam(iamPool: pg.Pool): Promise<{ sessions: number; rateLimits: number }> {
  const r = await exclusive(iamPool, LOCK.cleanup, async (c) => {
    const s = await c.query(`DELETE FROM iam.sessions WHERE absolute_expires_at < now() - interval '30 days'`);
    const rl = await c.query(`DELETE FROM iam.rate_limits WHERE window_start < now() - interval '1 day'`);
    return { sessions: s.rowCount ?? 0, rateLimits: rl.rowCount ?? 0 };
  });
  return r ?? { sessions: 0, rateLimits: 0 };
}

/** Deletes expired citizen sessions, old rate-limit windows, and OTP challenges that can no longer be used. */
export async function cleanupCitizen(citizenPool: pg.Pool): Promise<{ sessions: number; rateLimits: number; otpChallenges: number }> {
  const r = await exclusive(citizenPool, LOCK.cleanupCitizen, async (c) => {
    const s = await c.query(`DELETE FROM citizen.sessions WHERE absolute_expires_at < now() - interval '30 days'`);
    const rl = await c.query(`DELETE FROM citizen.rate_limits WHERE window_start < now() - interval '1 day'`);
    // A challenge is useless once consumed or well past its expiry; keep a short tail for abuse investigation.
    const otp = await c.query(`DELETE FROM citizen.otp_challenges WHERE consumed_at IS NOT NULL OR expires_at < now() - interval '1 day'`);
    return { sessions: s.rowCount ?? 0, rateLimits: rl.rowCount ?? 0, otpChallenges: otp.rowCount ?? 0 };
  });
  return r ?? { sessions: 0, rateLimits: 0, otpChallenges: 0 };
}
