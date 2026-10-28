/**
 * Background jobs. Each job is safe to run on several worker replicas at once:
 * it takes a transaction-scoped advisory lock and simply skips the tick if
 * another replica holds it.
 *
 *   relayAudit                  outbox rows → audit.ledger (in order), then deletes them
 *   signCheckpoint               Ed25519-signs the latest ledger hash periodically
 *   expireRecords                expires stale change requests and kill switches
 *   cleanupIam                   deletes long-expired sessions and old rate-limit windows
 *   cleanupCitizen                same, for citizen sessions, rate limits and spent OTP challenges
 *   escalateOverdueCases         case engine: bumps escalation_level on open grievances past their SLA
 *   sweepClosureConfirmations    case engine: opens the citizen confirmation window on RESOLVED grievances, auto-closes lapsed ones
 *   rollupProcessMetrics         accountability: materializes daily office/department process KPIs from intake + case
 *   rollupPersonMetrics          accountability: materializes the evidence-gated officer-level rolling-window snapshot
 *   fireSlaAlerts                accountability: immediate alert off each new "case".sla_escalations row (additional to the monthly push)
 *   pushMonthlyRollup            accountability: materializes + logs the monthly district rollup (no state/national hub to send it to yet)
 */
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import type { Logger } from 'pino';
import { signCheckpoint } from '../audit/checkpoint.js';

/** Advisory lock keys (arbitrary constants, one per job). */
const LOCK = {
  relay: 7_310_001, checkpoint: 7_310_002, expire: 7_310_003, cleanup: 7_310_004, cleanupCitizen: 7_310_005,
  caseEscalate: 7_310_006, caseClosure: 7_310_007,
  accRollupProcess: 7_310_008, accRollupPerson: 7_310_009, accAlerts: 7_310_010, accPush: 7_310_011
};

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
  { source: 'org', table: 'org.audit_outbox' },
  { source: 'intake', table: 'intake.audit_outbox' },
  { source: 'case', table: '"case".audit_outbox' },
  { source: 'accountability', table: 'accountability.audit_outbox' }
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

/**
 * Case engine: bumps escalation_level on grievances still open (NEW,
 * ACKNOWLEDGED or IN_PROGRESS) past their sla_due_at, once per tick per
 * grievance, up to `maxLevel`, and records the step in "case".sla_escalations.
 * Capped at maxLevel so a permanently-stuck case does not escalate forever;
 * a human (responder inbox, sorted by escalation_level) takes it from there.
 */
export async function escalateOverdueCases(casePool: pg.Pool, maxLevel = 3): Promise<number> {
  const n = await exclusive(casePool, LOCK.caseEscalate, async (c) => {
    const due = await c.query<{ id: string; escalation_level: number }>(
      `SELECT id, escalation_level FROM intake.grievances
         WHERE status IN ('NEW','ACKNOWLEDGED','IN_PROGRESS') AND sla_due_at IS NOT NULL AND sla_due_at < now() AND escalation_level < $1
         ORDER BY sla_due_at LIMIT 500`,
      [maxLevel]
    );
    for (const row of due.rows) {
      const toLevel = row.escalation_level + 1;
      await c.query('UPDATE intake.grievances SET escalation_level = $2, updated_at = now() WHERE id = $1', [row.id, toLevel]);
      await c.query('INSERT INTO "case".sla_escalations (grievance_id, from_level, to_level) VALUES ($1,$2,$3)', [row.id, row.escalation_level, toLevel]);
    }
    return due.rowCount ?? 0;
  });
  return n ?? 0;
}

/**
 * Case engine: (1) opens a closure-confirmation window on every RESOLVED
 * grievance filed by an identified citizen, and (2) auto-closes any window
 * that lapsed with no citizen response -- exactly the RESOLVED -> CLOSED
 * transition a citizen's own confirmation would have made, just
 * system-initiated (actor_user_id NULL, same convention as intake's initial
 * 'filed' event). An anonymous/business grievance with no citizen_id never
 * gets a window and simply stays RESOLVED until staff close it manually --
 * there is no one to ask.
 *
 * A grievance can cycle through RESOLVED more than once (a dispute reopens
 * it to IN_PROGRESS, and it can be resolved again), so this is an upsert:
 * a still-open window (confirmed IS NULL) is left alone, but a RESOLVED
 * grievance whose previous window already concluded (confirmed IS NOT
 * NULL, from an earlier cycle) gets a fresh window for the new cycle.
 */
export async function sweepClosureConfirmations(casePool: pg.Pool, windowDays: number): Promise<{ opened: number; autoClosed: number }> {
  const r = await exclusive(casePool, LOCK.caseClosure, async (c) => {
    const opened = await c.query(
      `INSERT INTO "case".closure_confirmations (grievance_id, window_expires_at)
         SELECT g.id, now() + make_interval(days => $1) FROM intake.grievances g
         WHERE g.status = 'RESOLVED' AND g.citizen_id IS NOT NULL
       ON CONFLICT (grievance_id) DO UPDATE SET
         window_expires_at = excluded.window_expires_at, confirmed = NULL, confirmed_at = NULL, dispute_note = NULL, auto_closed = false
       WHERE "case".closure_confirmations.confirmed IS NOT NULL`,
      [windowDays]
    );
    const due = await c.query<{ grievance_id: string }>(
      `SELECT cc.grievance_id FROM "case".closure_confirmations cc
         JOIN intake.grievances g ON g.id = cc.grievance_id
         WHERE cc.confirmed IS NULL AND cc.window_expires_at < now() AND g.status = 'RESOLVED'`
    );
    for (const row of due.rows) {
      await c.query(`UPDATE intake.grievances SET status = 'CLOSED', updated_at = now() WHERE id = $1`, [row.grievance_id]);
      await c.query(`INSERT INTO intake.grievance_events (grievance_id, from_status, to_status, note) VALUES ($1,'RESOLVED','CLOSED',$2)`, [
        row.grievance_id, 'Auto-closed: no citizen response within the confirmation window'
      ]);
      await c.query(`UPDATE "case".closure_confirmations SET confirmed = true, confirmed_at = now(), auto_closed = true WHERE grievance_id = $1`, [row.grievance_id]);
    }
    return { opened: opened.rowCount ?? 0, autoClosed: due.rowCount ?? 0 };
  });
  return r ?? { opened: 0, autoClosed: 0 };
}

/**
 * Accountability: materializes accountability.process_metrics_daily for the
 * trailing `windowDays` (default enough to catch late-arriving updates near
 * midnight; idempotent upsert, safe to run hourly) from intake + case data.
 * Process-level metrics only -- always computed, never gated (see migration
 * header). Returns rows upserted.
 */
export async function rollupProcessMetrics(accPool: pg.Pool, windowDays = 3): Promise<number> {
  const n = await exclusive(accPool, LOCK.accRollupProcess, async (c) => {
    const r = await c.query(
      `WITH filed AS (
         SELECT node_id, entity_id, created_at::date AS d, count(*) AS filed_count
           FROM intake.grievances WHERE created_at::date >= CURRENT_DATE - $1::int
           GROUP BY node_id, entity_id, created_at::date
       ), resolved AS (
         SELECT node_id, entity_id, resolved_at::date AS d,
           count(*) FILTER (WHERE status IN ('RESOLVED','CLOSED')) AS resolved_count,
           count(*) FILTER (WHERE sla_due_at IS NOT NULL AND resolved_at <= sla_due_at) AS sla_met_count,
           count(*) FILTER (WHERE sla_due_at IS NOT NULL AND resolved_at > sla_due_at) AS sla_breached_count,
           avg(EXTRACT(EPOCH FROM resolved_at - created_at)) / 3600.0 AS avg_resolution_hours
           FROM intake.grievances WHERE resolved_at IS NOT NULL AND resolved_at::date >= CURRENT_DATE - $1::int
           GROUP BY node_id, entity_id, resolved_at::date
       ), closed AS (
         -- intake.grievances has no closed_at column; updated_at at the time
         -- status became CLOSED is the available proxy for "closed that day".
         SELECT node_id, entity_id, updated_at::date AS d, count(*) AS closed_count
           FROM intake.grievances WHERE status = 'CLOSED' AND updated_at::date >= CURRENT_DATE - $1::int
           GROUP BY node_id, entity_id, updated_at::date
       ), reopened AS (
         SELECT g.node_id, g.entity_id, e.created_at::date AS d, count(*) AS reopened_count
           FROM intake.grievance_events e JOIN intake.grievances g ON g.id = e.grievance_id
           WHERE e.from_status = 'RESOLVED' AND e.to_status = 'IN_PROGRESS' AND e.created_at::date >= CURRENT_DATE - $1::int
           GROUP BY g.node_id, g.entity_id, e.created_at::date
       ), escalated AS (
         SELECT g.node_id, g.entity_id, se.escalated_at::date AS d, count(*) AS escalated_count
           FROM "case".sla_escalations se JOIN intake.grievances g ON g.id = se.grievance_id
           WHERE se.escalated_at::date >= CURRENT_DATE - $1::int
           GROUP BY g.node_id, g.entity_id, se.escalated_at::date
       ), confirmed AS (
         SELECT g.node_id, g.entity_id, cc.confirmed_at::date AS d, count(*) AS citizen_confirmed_count
           FROM "case".closure_confirmations cc JOIN intake.grievances g ON g.id = cc.grievance_id
           WHERE cc.confirmed = true AND cc.auto_closed = false AND cc.confirmed_at::date >= CURRENT_DATE - $1::int
           GROUP BY g.node_id, g.entity_id, cc.confirmed_at::date
       ), firstack AS (
         SELECT g.node_id, g.entity_id, e.created_at::date AS d,
           avg(EXTRACT(EPOCH FROM e.created_at - g.created_at)) / 3600.0 AS avg_first_ack_hours
           FROM intake.grievance_events e JOIN intake.grievances g ON g.id = e.grievance_id
           WHERE e.to_status = 'ACKNOWLEDGED' AND e.created_at::date >= CURRENT_DATE - $1::int
           GROUP BY g.node_id, g.entity_id, e.created_at::date
       ), combined AS (
         SELECT node_id, entity_id, d FROM filed UNION SELECT node_id, entity_id, d FROM resolved
         UNION SELECT node_id, entity_id, d FROM closed UNION SELECT node_id, entity_id, d FROM reopened
         UNION SELECT node_id, entity_id, d FROM escalated UNION SELECT node_id, entity_id, d FROM confirmed
         UNION SELECT node_id, entity_id, d FROM firstack
       )
       INSERT INTO accountability.process_metrics_daily
         (node_id, entity_id, metric_date, filed_count, resolved_count, closed_count, reopened_count, escalated_count,
          sla_met_count, sla_breached_count, avg_time_to_resolution_hours, avg_time_to_first_ack_hours, citizen_confirmed_count, computed_at)
       SELECT c.node_id, c.entity_id, c.d,
         coalesce(f.filed_count,0), coalesce(r.resolved_count,0), coalesce(cl.closed_count,0), coalesce(ro.reopened_count,0), coalesce(es.escalated_count,0),
         coalesce(r.sla_met_count,0), coalesce(r.sla_breached_count,0), r.avg_resolution_hours, fa.avg_first_ack_hours, coalesce(co.citizen_confirmed_count,0), now()
       FROM combined c
       LEFT JOIN filed f ON f.node_id = c.node_id AND f.entity_id IS NOT DISTINCT FROM c.entity_id AND f.d = c.d
       LEFT JOIN resolved r ON r.node_id = c.node_id AND r.entity_id IS NOT DISTINCT FROM c.entity_id AND r.d = c.d
       LEFT JOIN closed cl ON cl.node_id = c.node_id AND cl.entity_id IS NOT DISTINCT FROM c.entity_id AND cl.d = c.d
       LEFT JOIN reopened ro ON ro.node_id = c.node_id AND ro.entity_id IS NOT DISTINCT FROM c.entity_id AND ro.d = c.d
       LEFT JOIN escalated es ON es.node_id = c.node_id AND es.entity_id IS NOT DISTINCT FROM c.entity_id AND es.d = c.d
       LEFT JOIN confirmed co ON co.node_id = c.node_id AND co.entity_id IS NOT DISTINCT FROM c.entity_id AND co.d = c.d
       LEFT JOIN firstack fa ON fa.node_id = c.node_id AND fa.entity_id IS NOT DISTINCT FROM c.entity_id AND fa.d = c.d
       ON CONFLICT (node_id, metric_date, (COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid)))
       DO UPDATE SET
         filed_count = EXCLUDED.filed_count, resolved_count = EXCLUDED.resolved_count, closed_count = EXCLUDED.closed_count,
         reopened_count = EXCLUDED.reopened_count, escalated_count = EXCLUDED.escalated_count,
         sla_met_count = EXCLUDED.sla_met_count, sla_breached_count = EXCLUDED.sla_breached_count,
         avg_time_to_resolution_hours = EXCLUDED.avg_time_to_resolution_hours, avg_time_to_first_ack_hours = EXCLUDED.avg_time_to_first_ack_hours,
         citizen_confirmed_count = EXCLUDED.citizen_confirmed_count, computed_at = now()`,
      [windowDays]
    );
    return r.rowCount ?? 0;
  });
  return n ?? 0;
}

/**
 * Accountability: materializes the evidence-gated officer-level snapshot
 * (accountability.person_metrics) over a trailing `windowDays` window. One
 * row per officer who has at least one case assignment in the window;
 * `evidence_met` is the proxy gate documented in the migration header
 * (volume + distinct-citizen diversity -- NOT the full Blueprint §9.6
 * integrity/corroboration gate, which this codebase has not built) and is
 * computed here, not left to the API, so a query bug can never leak a row
 * that hasn't cleared it. Returns rows upserted.
 */
export async function rollupPersonMetrics(accPool: pg.Pool, windowDays: number, minResolved: number, minDistinctCitizens: number): Promise<number> {
  const n = await exclusive(accPool, LOCK.accRollupPerson, async (c) => {
    const r = await c.query(
      `INSERT INTO accountability.person_metrics
         (assignee_user_id, node_id, window_days, assigned_count, resolved_count, sla_met_count, sla_breached_count,
          avg_time_to_resolution_hours, distinct_citizens, evidence_met, computed_at)
       SELECT a.assignee_user_id,
         (array_agg(a.node_id ORDER BY a.assigned_at DESC))[1] AS node_id,
         $1::int,
         count(*) AS assigned_count,
         count(*) FILTER (WHERE g.status IN ('RESOLVED','CLOSED')) AS resolved_count,
         count(*) FILTER (WHERE g.sla_due_at IS NOT NULL AND g.resolved_at IS NOT NULL AND g.resolved_at <= g.sla_due_at) AS sla_met_count,
         count(*) FILTER (WHERE g.sla_due_at IS NOT NULL AND g.resolved_at IS NOT NULL AND g.resolved_at > g.sla_due_at) AS sla_breached_count,
         avg(EXTRACT(EPOCH FROM g.resolved_at - g.created_at)) FILTER (WHERE g.resolved_at IS NOT NULL) / 3600.0 AS avg_time_to_resolution_hours,
         count(DISTINCT g.citizen_id) FILTER (WHERE g.citizen_id IS NOT NULL) AS distinct_citizens,
         (count(*) FILTER (WHERE g.status IN ('RESOLVED','CLOSED')) >= $2::int
           AND count(DISTINCT g.citizen_id) FILTER (WHERE g.citizen_id IS NOT NULL) >= $3::int) AS evidence_met,
         now()
       FROM "case".assignments a JOIN intake.grievances g ON g.id = a.grievance_id
       WHERE a.assigned_at >= now() - make_interval(days => $1::int)
       GROUP BY a.assignee_user_id
       ON CONFLICT (assignee_user_id) DO UPDATE SET
         node_id = EXCLUDED.node_id, window_days = EXCLUDED.window_days, assigned_count = EXCLUDED.assigned_count,
         resolved_count = EXCLUDED.resolved_count, sla_met_count = EXCLUDED.sla_met_count, sla_breached_count = EXCLUDED.sla_breached_count,
         avg_time_to_resolution_hours = EXCLUDED.avg_time_to_resolution_hours, distinct_citizens = EXCLUDED.distinct_citizens,
         evidence_met = EXCLUDED.evidence_met, computed_at = now()`,
      [windowDays, minResolved, minDistinctCitizens]
    );
    return r.rowCount ?? 0;
  });
  return n ?? 0;
}

/**
 * Accountability: fires one immediate alert per (grievance, escalation
 * level) the first time case engine's escalation sweep reaches it --
 * additional to the monthly push, per the confirmed decision that breach
 * visibility should not wait a month. Idempotent: a level already alerted
 * is skipped. Returns alerts fired.
 */
export async function fireSlaAlerts(accPool: pg.Pool): Promise<number> {
  const n = await exclusive(accPool, LOCK.accAlerts, async (c) => {
    const r = await c.query(
      `INSERT INTO accountability.sla_alerts (grievance_id, node_id, escalation_level, alerted_at)
       SELECT se.grievance_id, g.node_id, se.to_level, now()
         FROM "case".sla_escalations se JOIN intake.grievances g ON g.id = se.grievance_id
         WHERE NOT EXISTS (
           SELECT 1 FROM accountability.sla_alerts al WHERE al.grievance_id = se.grievance_id AND al.escalation_level = se.to_level
         )
       ON CONFLICT (grievance_id, escalation_level) DO NOTHING`
    );
    return r.rowCount ?? 0;
  });
  return n ?? 0;
}

/**
 * Accountability: the scheduled upward push (district -> state -> national),
 * monthly per the confirmed cadence decision. This codebase builds a single
 * district pod with no state/national hub to send to yet, so for now this
 * materializes and logs an audited local snapshot of the last COMPLETED
 * calendar month per district node (accountability.monthly_pushes) -- once a
 * real hub or external endpoint exists, this is the job to point at it.
 * Idempotent per (node, period): a period already pushed is never
 * overwritten. Returns pushes written.
 */
export async function pushMonthlyRollup(accPool: pg.Pool): Promise<number> {
  const n = await exclusive(accPool, LOCK.accPush, async (c) => {
    const r = await c.query(
      `INSERT INTO accountability.monthly_pushes (node_id, period, payload)
       SELECT n.id, date_trunc('month', CURRENT_DATE - interval '1 month')::date,
         coalesce((
           SELECT jsonb_agg(to_jsonb(m) - 'id')
             FROM accountability.process_metrics_daily m
             WHERE m.node_id = n.id
               AND m.metric_date >= date_trunc('month', CURRENT_DATE - interval '1 month')
               AND m.metric_date < date_trunc('month', CURRENT_DATE)
         ), '[]'::jsonb)
         FROM platform.scope_nodes n WHERE n.level = 'DISTRICT'
       ON CONFLICT (node_id, period) DO NOTHING`
    );
    return r.rowCount ?? 0;
  });
  return n ?? 0;
}
