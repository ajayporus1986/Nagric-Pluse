/**
 * Lego registry HTTP API: jurisdiction tree, module states, capability map,
 * change requests with quorum, and the emergency kill switch.
 */
import { z } from 'zod';
import { capabilityMap, featureAvailability, type TraceStep } from '@np/policy';
import { ROLES, type ScopeLevel } from '@np/shared';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../core/errors.js';
import { query, withTx } from '../db/pools.js';
import { writeAudit } from '../audit/outbox.js';
import type { App, AppDeps } from '../http/app.js';
import { authOf, rolesOf } from '../http/app.js';
import { CHANGE_KINDS, applyChange, computeImpact, validateChange, type ChangeKind } from './changes.js';

const nodeId = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const uuidParam = z.object({ id: z.string().uuid() });

/** Max nodes walked for an impact preview. */
const IMPACT_NODE_CAP = 5000;

export function registerPlatformRoutes(app: App, deps: AppDeps): void {
  const { pools, policy, cfg } = deps;

  /** Looks up the node of a change request for access checks (404 if unknown). */
  async function crNode(req: FastifyRequest): Promise<string> {
    const { id } = req.params as { id: string };
    const r = await query<{ node_id: string }>(pools.platform, 'SELECT node_id FROM platform.change_requests WHERE id = $1', [id]);
    if (!r.rows[0]) throw new AppError('NP-CR-0001', { id });
    return r.rows[0].node_id;
  }

  /** Looks up the node of a kill switch for access checks. */
  async function killNode(req: FastifyRequest): Promise<string> {
    const { id } = req.params as { id: string };
    const r = await query<{ node_id: string }>(pools.platform, 'SELECT node_id FROM platform.kill_switches WHERE id = $1', [id]);
    if (!r.rows[0]) throw new AppError('NP-KILL-0003', { id });
    return r.rows[0].node_id;
  }

  // ---- GET /roles (catalogue for the UI) ----------------------------------
  app.get('/api/v1/roles', { config: { access: { kind: 'session' } } }, async () => ({
    roles: ROLES.filter((r) => r.staff).map((r) => ({ code: r.code, realm: r.realm, nameEn: r.nameEn, nameHi: r.nameHi, sensitive: r.sensitive, levels: r.levels }))
  }));

  // ---- GET /scopes/tree ---------------------------------------------------
  app.get(
    '/api/v1/scopes/tree',
    {
      config: { access: { kind: 'feature', feature: 'platform.scope', action: 'view', node: (req) => (req.query as { rootId: string }).rootId } },
      schema: { querystring: z.object({ rootId: nodeId, depth: z.coerce.number().int().min(0).max(3).default(1) }).strict() }
    },
    async (req) => {
      const st = policy.current();
      type Out = { id: string; level: ScopeLevel; lgdCode: string | null; nameEn: string; nameHi: string; childCount: number; children?: Out[] };
      // Recursive build limited by depth; children sorted by English name for stable display.
      const build = (id: string, depth: number): Out => {
        const n = st.nodes.get(id)!;
        const kids = (st.children.get(id) ?? []).filter((k) => st.nodes.get(k)?.active);
        const out: Out = { id, level: n.level, lgdCode: n.lgdCode, nameEn: n.nameEn, nameHi: n.nameHi, childCount: kids.length };
        if (depth > 0) out.children = kids.map((k) => build(k, depth - 1)).sort((a, b) => a.nameEn.localeCompare(b.nameEn));
        return out;
      };
      const root = st.nodes.get(req.query.rootId);
      if (!root) throw new AppError('NP-SCOPE-0001', { nodeId: req.query.rootId });
      return { path: root.path.map((p) => ({ id: p, nameEn: st.nodes.get(p)?.nameEn, nameHi: st.nodes.get(p)?.nameHi })), node: build(root.id, req.query.depth) };
    }
  );

  // ---- GET /capabilities --------------------------------------------------
  app.get(
    '/api/v1/capabilities',
    { config: { access: { kind: 'session' } }, schema: { querystring: z.object({ nodeId }).strict() } },
    async (req) => {
      const auth = authOf(req);
      return { nodeId: req.query.nodeId, capabilities: capabilityMap(policy.principalOf(auth), policy.pathOf(req.query.nodeId), policy.current().snapshot) };
    }
  );

  // ---- GET /modules -------------------------------------------------------
  app.get(
    '/api/v1/modules',
    {
      config: { access: { kind: 'feature', feature: 'platform.modules', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId }).strict() }
    },
    async (req) => {
      const st = policy.current();
      const path = policy.pathOf(req.query.nodeId);
      const now = new Date();
      const explicitModule = new Map(st.rows.moduleSettings.filter((r) => r.nodeId === req.query.nodeId).map((r) => [r.moduleId, r.state]));
      const explicitFeature = new Map(st.rows.featureSettings.filter((r) => r.nodeId === req.query.nodeId).map((r) => [r.featureCode, r.state]));
      const kills = st.rows.killSwitches.filter((k) => k.expiresAt > now && path.join('.').startsWith(k.path.join('.')));
      return {
        nodeId: req.query.nodeId,
        realms: st.rows.realmSettings.filter((r) => r.nodeId === req.query.nodeId),
        modules: [...st.snapshot.modules.values()].map((m) => ({
          id: m.id,
          version: m.version,
          name: m.name,
          realm: m.realm,
          invariant: m.invariant,
          defaultEnabled: m.defaultEnabled,
          requires: m.requires,
          explicit: explicitModule.get(m.id) ?? 'INHERIT',
          killSwitch: kills.find((k) => k.moduleId === m.id) ? { expiresAt: kills.find((k) => k.moduleId === m.id)!.expiresAt } : null,
          features: m.features.map((f) => {
            const trace: TraceStep[] = [];
            const available = featureAvailability(st.snapshot, f.code, path, now, trace);
            return { code: f.code, name: f.name, actions: f.actions, invariant: f.invariant, explicit: explicitFeature.get(f.code) ?? 'INHERIT', available, trace, defaultGrants: f.defaultGrants };
          })
        }))
      };
    }
  );

  // ---- GET /change-requests -----------------------------------------------
  app.get(
    '/api/v1/change-requests',
    {
      config: { access: { kind: 'feature', feature: 'platform.change_requests', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: {
        querystring: z
          .object({ nodeId, status: z.enum(['PENDING', 'APPLIED', 'REJECTED', 'EXPIRED', 'WITHDRAWN']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
          .strict()
      }
    },
    async (req) => {
      const path = policy.pathOf(req.query.nodeId).join('.');
      const { rows } = await query(
        pools.platform,
        `SELECT cr.id, cr.node_id AS "nodeId", cr.kind, cr.payload, cr.reason, cr.impact, cr.status, cr.required_approvals AS "requiredApprovals",
                cr.proposed_by AS "proposedBy", cr.proposed_at AS "proposedAt", cr.expires_at AS "expiresAt", cr.decided_at AS "decidedAt", cr.outcome,
                COALESCE((SELECT json_agg(json_build_object('approverId', a.approver_id, 'verdict', a.verdict, 'comment', a.comment, 'at', a.at) ORDER BY a.at)
                            FROM platform.approvals a WHERE a.change_request_id = cr.id), '[]') AS votes
           FROM platform.change_requests cr JOIN platform.scope_nodes n ON n.id = cr.node_id
          WHERE n.path <@ $1::ltree AND ($2::text IS NULL OR cr.status = $2)
          ORDER BY cr.proposed_at DESC LIMIT $3`,
        [path, req.query.status ?? null, req.query.limit]
      );
      // Resolve user display names through the iam pool (platform role may read only id/username/display_name).
      const ids = [...new Set(rows.flatMap((r) => [r.proposedBy as string, ...(r.votes as { approverId: string }[]).map((v) => v.approverId)]))];
      const names = ids.length
        ? new Map((await query<{ id: string; display_name: string; username: string }>(pools.iam, 'SELECT id, display_name, username FROM iam.users WHERE id = ANY($1)', [ids])).rows.map((u) => [u.id, `${u.display_name} (${u.username})`]))
        : new Map<string, string>();
      return { changeRequests: rows.map((r) => ({ ...r, proposedByName: names.get(r.proposedBy as string), votes: (r.votes as { approverId: string }[]).map((v) => ({ ...v, approverName: names.get(v.approverId) })) })) };
    }
  );

  // ---- POST /change-requests ----------------------------------------------
  app.post(
    '/api/v1/change-requests',
    {
      config: { access: { kind: 'feature', feature: 'platform.change_requests', action: 'create', node: (req) => (req.body as { nodeId: string }).nodeId } },
      schema: {
        body: z
          .object({ nodeId, kind: z.enum(CHANGE_KINDS as [ChangeKind, ...ChangeKind[]]), payload: z.record(z.string(), z.unknown()), reason: z.string().trim().min(10).max(2000) })
          .strict()
      }
    },
    async (req, reply) => {
      const auth = authOf(req);
      const st = policy.current();
      const out = await withTx(pools.platform, async (c) => {
        const ch = await validateChange(c, st, req.body.kind, req.body.nodeId, req.body.payload);
        if (ch.subjectUserId === auth.userId) throw new AppError('NP-CR-0004', { kind: ch.kind });
        // Kill-switch ratification previews the module that will be disabled.
        let killModule: string | undefined;
        if (ch.kind === 'KILL_SWITCH_RATIFY') {
          const k = await c.query<{ module_id: string }>('SELECT module_id FROM platform.kill_switches WHERE id = $1', [(ch.payload as { killSwitchId: string }).killSwitchId]);
          killModule = k.rows[0]?.module_id;
        }
        const subtree = policy.subtree(ch.nodeId, IMPACT_NODE_CAP + 1);
        const impact = computeImpact(st, ch, subtree.slice(0, IMPACT_NODE_CAP), subtree.length > IMPACT_NODE_CAP, killModule);
        const level = st.nodes.get(ch.nodeId)!.level;
        const q = await c.query<{ required: number }>('SELECT required FROM platform.quorum_config WHERE level = $1', [level]);
        const required = q.rows[0]?.required ?? 2;
        let id: string;
        try {
          const ins = await c.query<{ id: string }>(
            `INSERT INTO platform.change_requests (node_id, kind, payload, reason, impact, required_approvals, proposed_by, expires_at, target_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8), $9) RETURNING id`,
            [ch.nodeId, ch.kind, ch.payload, req.body.reason, impact, required, auth.userId, cfg.CHANGE_REQUEST_TTL_DAYS, ch.targetKey]
          );
          id = ins.rows[0]!.id;
        } catch (e) {
          // Partial unique index: another pending request already targets the same thing here.
          if ((e as { code?: string }).code === '23505') throw new AppError('NP-CR-0009', { targetKey: ch.targetKey }, { cause: e });
          throw e;
        }
        // The proposer's approval is the first vote.
        await c.query(`INSERT INTO platform.approvals (change_request_id, approver_id, verdict, comment) VALUES ($1, $2, 'APPROVE', 'proposer')`, [id, auth.userId]);
        await writeAudit(c, 'platform', {
          action: 'platform.change_request.proposed', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'platform.change_requests',
          scopePath: st.nodes.get(ch.nodeId)!.path.join('.'), targetType: 'change_request', targetId: id, decision: req.decision?.decision ?? null, ip: req.ip,
          detail: { kind: ch.kind, payload: ch.payload, reason: req.body.reason, requiredApprovals: required }
        });
        return { id, impact, requiredApprovals: required };
      });
      void reply.status(201);
      return out;
    }
  );

  // ---- POST /change-requests/:id/votes ------------------------------------
  app.post(
    '/api/v1/change-requests/:id/votes',
    {
      config: { access: { kind: 'feature', feature: 'platform.change_requests', action: 'approve', node: crNode } },
      schema: { params: uuidParam, body: z.object({ verdict: z.enum(['APPROVE', 'REJECT']), comment: z.string().trim().max(2000).optional() }).strict() }
    },
    async (req) => {
      const auth = authOf(req);
      const st = policy.current();
      const result = await withTx(pools.platform, async (c) => {
        // Row lock serialises concurrent votes on the same request.
        const r = await c.query<{
          id: string; kind: ChangeKind; node_id: string; payload: Record<string, unknown>; status: string; required_approvals: number;
          proposed_by: string; expires_at: Date;
        }>('SELECT id, kind, node_id, payload, status, required_approvals, proposed_by, expires_at FROM platform.change_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
        const cr = r.rows[0];
        if (!cr) throw new AppError('NP-CR-0001', { id: req.params.id });
        if (cr.status !== 'PENDING') throw new AppError('NP-CR-0002', { status: cr.status });
        if (cr.expires_at.getTime() <= Date.now()) {
          await c.query(`UPDATE platform.change_requests SET status = 'EXPIRED', decided_at = now() WHERE id = $1`, [cr.id]);
          throw new AppError('NP-CR-0002', { status: 'EXPIRED' });
        }
        const prior = await c.query('SELECT 1 FROM platform.approvals WHERE change_request_id = $1 AND approver_id = $2', [cr.id, auth.userId]);
        if (prior.rowCount) throw new AppError('NP-CR-0003', {});
        // Re-validate to learn the subject (and whether the change is still possible).
        let subject: string | null = null;
        let stillValid = true;
        let invalidCode: string | undefined;
        try {
          subject = (await validateChange(c, st, cr.kind, cr.node_id, cr.payload)).subjectUserId;
        } catch (e) {
          stillValid = false;
          invalidCode = (e as AppError).code;
        }
        if (subject === auth.userId) throw new AppError('NP-CR-0004', { kind: cr.kind });

        await c.query('INSERT INTO platform.approvals (change_request_id, approver_id, verdict, comment) VALUES ($1, $2, $3, $4)', [
          cr.id, auth.userId, req.body.verdict, req.body.comment ?? null
        ]);
        const scopePath = st.nodes.get(cr.node_id)?.path.join('.') ?? null;
        const audit = (action: string, detail: Record<string, unknown>) =>
          writeAudit(c, 'platform', {
            action, actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'platform.change_requests', scopePath, targetType: 'change_request',
            targetId: cr.id, decision: req.decision?.decision ?? null, ip: req.ip, detail
          });

        if (req.body.verdict === 'REJECT') {
          await c.query(`UPDATE platform.change_requests SET status = 'REJECTED', decided_at = now(), outcome = $2 WHERE id = $1`, [cr.id, { rejectedBy: auth.userId }]);
          await audit('platform.change_request.rejected', { comment: req.body.comment });
          return { status: 'REJECTED' };
        }
        const count = await c.query<{ n: string }>(`SELECT count(*) AS n FROM platform.approvals WHERE change_request_id = $1 AND verdict = 'APPROVE'`, [cr.id]);
        const approvals = Number(count.rows[0]!.n);
        await audit('platform.change_request.approved', { approvals, required: cr.required_approvals });
        if (approvals < cr.required_approvals) return { status: 'PENDING', approvals, required: cr.required_approvals };

        // Quorum reached: apply now, or reject with a specific code if it can no longer apply.
        if (!stillValid) {
          await c.query(`UPDATE platform.change_requests SET status = 'REJECTED', decided_at = now(), outcome = $2 WHERE id = $1`, [cr.id, { code: 'NP-CR-0008', cause: invalidCode }]);
          await audit('platform.change_request.apply_failed', { cause: invalidCode });
          return { status: 'REJECTED', code: 'NP-CR-0008', cause: invalidCode };
        }
        await c.query('SAVEPOINT apply_change');
        try {
          const result = await applyChange(c, cr, auth.userId, req.ip);
          await c.query(`UPDATE platform.change_requests SET status = 'APPLIED', decided_at = now(), outcome = $2 WHERE id = $1`, [cr.id, { appliedBy: auth.userId }]);
          await audit('platform.change_request.applied', { kind: cr.kind });
          return { status: 'APPLIED', ...result };
        } catch (e) {
          // Undo partial writes of the apply, keep the vote, and record why.
          await c.query('ROLLBACK TO SAVEPOINT apply_change');
          const code = (e as AppError).code ?? 'NP-INT-0001';
          deps.log.warn({ err: e, errCode: 'NP-CR-0008', crId: cr.id }, 'approved change could not be applied');
          await c.query(`UPDATE platform.change_requests SET status = 'REJECTED', decided_at = now(), outcome = $2 WHERE id = $1`, [cr.id, { code: 'NP-CR-0008', cause: code }]);
          await audit('platform.change_request.apply_failed', { cause: code });
          return { status: 'REJECTED', code: 'NP-CR-0008', cause: code };
        }
      });
      // Applied changes take effect on this replica before the response returns.
      if (result.status === 'APPLIED') await policy.reload('change_applied');
      return result;
    }
  );

  // ---- POST /change-requests/:id/withdraw ---------------------------------
  app.post(
    '/api/v1/change-requests/:id/withdraw',
    { config: { access: { kind: 'feature', feature: 'platform.change_requests', action: 'create', node: crNode } }, schema: { params: uuidParam } },
    async (req) => {
      const auth = authOf(req);
      return withTx(pools.platform, async (c) => {
        const r = await c.query(
          `UPDATE platform.change_requests SET status = 'WITHDRAWN', decided_at = now() WHERE id = $1 AND status = 'PENDING' AND proposed_by = $2 RETURNING node_id`,
          [req.params.id, auth.userId]
        );
        if (!r.rowCount) throw new AppError('NP-CR-0002', { reason: 'not pending or not the proposer' });
        await writeAudit(c, 'platform', { action: 'platform.change_request.withdrawn', actorId: auth.userId, actorRoles: rolesOf(req), targetType: 'change_request', targetId: req.params.id, ip: req.ip });
        return { status: 'WITHDRAWN' };
      });
    }
  );

  // ---- GET /kill-switches -------------------------------------------------
  app.get(
    '/api/v1/kill-switches',
    {
      config: { access: { kind: 'feature', feature: 'platform.kill_switch', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId }).strict() }
    },
    async (req) => {
      const path = policy.pathOf(req.query.nodeId).join('.');
      const { rows } = await query(
        pools.platform,
        `SELECT k.id, k.module_id AS "moduleId", k.node_id AS "nodeId", k.reason, k.activated_by AS "activatedBy", k.activated_at AS "activatedAt",
                k.expires_at AS "expiresAt", k.cleared_at AS "clearedAt", k.ratified_by_cr AS "ratifiedBy",
                (k.cleared_at IS NULL AND k.expires_at > now()) AS active
           FROM platform.kill_switches k JOIN platform.scope_nodes n ON n.id = k.node_id
          WHERE n.path <@ $1::ltree ORDER BY k.activated_at DESC LIMIT 100`,
        [path]
      );
      return { killSwitches: rows };
    }
  );

  // ---- POST /kill-switches ------------------------------------------------
  app.post(
    '/api/v1/kill-switches',
    {
      config: { access: { kind: 'feature', feature: 'platform.kill_switch', action: 'special', node: (req) => (req.body as { nodeId: string }).nodeId } },
      schema: {
        body: z
          .object({ nodeId, moduleId: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), reason: z.string().trim().min(10).max(2000), hours: z.number().int().min(1).max(24) })
          .strict()
      }
    },
    async (req, reply) => {
      const auth = authOf(req);
      const st = policy.current();
      const m = st.snapshot.modules.get(req.body.moduleId);
      if (!m) throw new AppError('NP-CR-0007', { moduleId: req.body.moduleId });
      if (m.invariant) throw new AppError('NP-KILL-0001', { moduleId: m.id });
      const out = await withTx(pools.platform, async (c) => {
        const dup = await c.query(
          'SELECT 1 FROM platform.kill_switches WHERE module_id = $1 AND node_id = $2 AND cleared_at IS NULL AND expires_at > now()',
          [m.id, req.body.nodeId]
        );
        if (dup.rowCount) throw new AppError('NP-KILL-0002', { moduleId: m.id });
        const r = await c.query<{ id: string; expires_at: Date }>(
          `INSERT INTO platform.kill_switches (module_id, node_id, reason, activated_by, expires_at)
           VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5)) RETURNING id, expires_at`,
          [m.id, req.body.nodeId, req.body.reason, auth.userId, req.body.hours]
        );
        await writeAudit(c, 'platform', {
          action: 'platform.kill_switch.activated', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'platform.kill_switch',
          scopePath: policy.pathOf(req.body.nodeId).join('.'), targetType: 'module', targetId: m.id, decision: req.decision?.decision ?? null, ip: req.ip,
          detail: { reason: req.body.reason, hours: req.body.hours, killSwitchId: r.rows[0]!.id }
        });
        return { id: r.rows[0]!.id, expiresAt: r.rows[0]!.expires_at };
      });
      // Make the stop effective on this replica immediately (others follow via NOTIFY).
      await policy.reload('kill_switch');
      void reply.status(201);
      return out;
    }
  );

  // ---- POST /kill-switches/:id/clear --------------------------------------
  app.post(
    '/api/v1/kill-switches/:id/clear',
    { config: { access: { kind: 'feature', feature: 'platform.kill_switch', action: 'special', node: killNode } }, schema: { params: uuidParam } },
    async (req) => {
      const auth = authOf(req);
      await withTx(pools.platform, async (c) => {
        const r = await c.query<{ module_id: string; node_id: string }>(
          `UPDATE platform.kill_switches SET cleared_at = now(), cleared_by = $2 WHERE id = $1 AND cleared_at IS NULL RETURNING module_id, node_id`,
          [req.params.id, auth.userId]
        );
        if (!r.rows[0]) throw new AppError('NP-KILL-0003', { id: req.params.id });
        await writeAudit(c, 'platform', {
          action: 'platform.kill_switch.cleared', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'platform.kill_switch',
          scopePath: policy.pathOf(r.rows[0].node_id).join('.'), targetType: 'module', targetId: r.rows[0].module_id, ip: req.ip, detail: { killSwitchId: req.params.id }
        });
      });
      await policy.reload('kill_switch_cleared');
      return { ok: true };
    }
  );
}
