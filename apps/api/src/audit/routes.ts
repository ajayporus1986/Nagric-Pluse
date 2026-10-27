/**
 * Audit ledger read and verification API.
 *
 *   GET  /audit/events       newest-first page of ledger entries in the caller's scope
 *   POST /audit/verify       recompute the hash chain and check every signed checkpoint
 *
 * Reading the audit log is itself audited (who looked, with which filters).
 */
import { z } from 'zod';
import { query, withTx } from '../db/pools.js';
import type { App, AppDeps } from '../http/app.js';
import { authOf, rolesOf } from '../http/app.js';
import { writeAudit } from './outbox.js';
import { verifyCheckpoint } from './checkpoint.js';

const nodeId = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);

export function registerAuditRoutes(app: App, deps: AppDeps): void {
  const { pools, policy, log } = deps;

  // ---- GET /audit/events --------------------------------------------------
  app.get(
    '/api/v1/audit/events',
    {
      config: { access: { kind: 'feature', feature: 'audit.ledger', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: {
        querystring: z
          .object({
            nodeId,
            beforeSeq: z.coerce.number().int().positive().optional(),
            action: z.string().regex(/^[a-z_.]{1,80}$/).optional(),
            actorId: z.string().uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50)
          })
          .strict()
      }
    },
    async (req) => {
      const auth = authOf(req);
      const path = policy.pathOf(req.query.nodeId).join('.');
      // Entries without a scope (sign-ins, account events) are visible to every audit viewer of the pod;
      // scoped entries only within the caller's subtree.
      const { rows } = await query(
        pools.audit,
        `SELECT seq::text, event_id AS "eventId", source, occurred_at AS "occurredAt", recorded_at AS "recordedAt", actor_id AS "actorId",
                actor_roles AS "actorRoles", action, feature_code AS "featureCode", scope_path AS "scopePath", target_type AS "targetType",
                target_id AS "targetId", decision, host(ip) AS ip, detail, encode(hash, 'hex') AS hash
           FROM audit.ledger
          WHERE (scope_path IS NULL OR scope_path::ltree <@ $1::ltree)
            AND ($2::bigint IS NULL OR seq < $2)
            AND ($3::text IS NULL OR action = $3)
            AND ($4::uuid IS NULL OR actor_id = $4)
          ORDER BY seq DESC LIMIT $5`,
        [path, req.query.beforeSeq ?? null, req.query.action ?? null, req.query.actorId ?? null, req.query.limit]
      );
      await withTx(pools.platform, (c) =>
        writeAudit(c, 'platform', {
          action: 'audit.ledger.viewed', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'audit.ledger', scopePath: path, ip: req.ip,
          decision: req.decision?.decision ?? null, detail: { filters: { action: req.query.action, actorId: req.query.actorId, beforeSeq: req.query.beforeSeq } }
        })
      );
      return { events: rows };
    }
  );

  // ---- POST /audit/verify -------------------------------------------------
  app.post(
    '/api/v1/audit/verify',
    {
      config: { access: { kind: 'feature', feature: 'audit.ledger', action: 'special', node: (req) => (req.body as { nodeId: string }).nodeId } },
      schema: { body: z.object({ nodeId }).strict() }
    },
    async (req) => {
      const auth = authOf(req);
      const started = Date.now();
      // 1. Recompute the whole hash chain inside the database.
      const chain = await query<{ ok: boolean; checked: string; first_bad_seq: string | null }>(pools.audit, 'SELECT * FROM audit.verify_chain()');
      const c = chain.rows[0]!;
      // 2. Check each checkpoint: the ledger hash still matches, and the signature verifies.
      const cps = await query<{ up_to_seq: string; ledger_hash: Buffer; signature: Buffer; key_id: string; public_key: string | null; current_hash: Buffer | null }>(
        pools.audit,
        `SELECT cp.up_to_seq::text, cp.ledger_hash, cp.signature, cp.key_id, k.public_key, l.hash AS current_hash
           FROM audit.checkpoints cp
           LEFT JOIN audit.signing_keys k ON k.key_id = cp.key_id
           LEFT JOIN audit.ledger l ON l.seq = cp.up_to_seq
          ORDER BY cp.up_to_seq`
      );
      const badCheckpoints = cps.rows
        .filter((r) => !r.public_key || !r.current_hash || !r.current_hash.equals(r.ledger_hash) || !verifyCheckpoint(r.public_key, r.up_to_seq, r.ledger_hash, r.signature))
        .map((r) => ({ upToSeq: r.up_to_seq, keyId: r.key_id, reason: !r.public_key ? 'unknown key' : !r.current_hash?.equals(r.ledger_hash) ? 'ledger hash changed' : 'bad signature' }));
      const ok = c.ok && badCheckpoints.length === 0;
      const result = {
        ok, entriesChecked: Number(c.checked), firstBadSeq: c.first_bad_seq, checkpointsChecked: cps.rowCount, badCheckpoints,
        lastCheckpointSeq: cps.rows.at(-1)?.up_to_seq ?? null, ms: Date.now() - started
      };
      // A failed verification is a security incident: log at fatal with its own code.
      if (!ok) log.fatal({ errCode: badCheckpoints.length ? 'NP-AUDIT-0003' : 'NP-AUDIT-0001', result, userId: auth.userId }, 'audit ledger verification FAILED');
      await withTx(pools.platform, (cl) =>
        writeAudit(cl, 'platform', { action: 'audit.ledger.verified', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'audit.ledger', ip: req.ip, detail: result })
      );
      // Verification failure is a result, not a request failure: return it with its code so the console can show details.
      return { ...result, errCode: ok ? null : badCheckpoints.length ? 'NP-AUDIT-0003' : 'NP-AUDIT-0001' };
    }
  );
}
