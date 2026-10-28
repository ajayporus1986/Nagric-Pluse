/**
 * Case engine module (Phase 3): assignment, SLA-breach escalation and
 * citizen closure confirmation on top of grievance intake (Phase 2). See
 * db/migrations/0014_case_engine.sql for why this writes into intake's
 * tables for a few narrow, automated transitions instead of intake owning
 * them itself.
 *
 *   POST /case/assignments                        assign/reassign a grievance to a staff member (Lego-gated)
 *   GET  /case/assignments/:grievanceId            current assignee + history (Lego-gated)
 *   GET  /case/inbox?nodeId=                       responder inbox: assigned-to-me + unassigned in my subtree (Lego-gated)
 *   POST /case/grievances/:id/confirm-closure      citizen confirms or disputes a RESOLVED grievance (public, citizen session required)
 *
 * The escalation sweep and the closure-confirmation-window sweep themselves
 * are worker jobs (worker/jobs.ts), not routes here.
 */
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { query, withTx } from '../db/pools.js';
import { writeAudit } from '../audit/outbox.js';
import type { App, AppDeps } from '../http/app.js';
import { authOf, rolesOf } from '../http/app.js';
import { citizenCookieName, csrfValid, loadCitizenSession } from '../citizen/sessions.js';
import { bucketKey, dbRateLimit } from './rate-limit.js';

const nodeIdField = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const uuidParam = z.object({ id: z.string().uuid() }).strict();

const assignBody = z.object({ grievanceId: z.string().uuid(), assigneeUserId: z.string().uuid() }).strict();
const confirmClosureBody = z.object({ confirmed: z.boolean(), note: z.string().trim().max(2000).optional() }).strict();

export function registerCaseRoutes(app: App, deps: AppDeps): void {
  const { pools, policy, cfg } = deps;
  const cookieName = citizenCookieName(cfg.COOKIE_SECURE);
  const times = { idleMinutes: cfg.CITIZEN_SESSION_IDLE_MINUTES, absoluteHours: cfg.CITIZEN_SESSION_ABSOLUTE_HOURS };

  /** Node of an existing grievance (404 NP-CASE-0001 if unknown), read via the case role's grant on intake.grievances. */
  async function grievanceNode(id: string): Promise<{ nodeId: string; status: string }> {
    const r = await query<{ node_id: string; status: string }>(pools.case, 'SELECT node_id, status FROM intake.grievances WHERE id = $1', [id]);
    if (!r.rows[0]) throw new AppError('NP-CASE-0001', { id });
    return { nodeId: r.rows[0].node_id, status: r.rows[0].status };
  }

  // ===== POST /case/assignments (staff) ======================================
  app.post(
    '/api/v1/case/assignments',
    {
      config: { access: { kind: 'feature', feature: 'case.assignments', action: 'update', node: async (req) => (await grievanceNode((req.body as { grievanceId: string }).grievanceId)).nodeId } },
      schema: { body: assignBody }
    },
    async (req, reply) => {
      const auth = authOf(req);
      const b = req.body;
      const { nodeId } = await grievanceNode(b.grievanceId);

      const id = await withTx(pools.case, async (c) => {
        const u = await c.query<{ status: string }>('SELECT status FROM iam.users WHERE id = $1', [b.assigneeUserId]);
        if (!u.rows[0] || u.rows[0].status !== 'ACTIVE') throw new AppError('NP-CASE-0002', { assigneeUserId: b.assigneeUserId });

        await c.query('UPDATE "case".assignments SET unassigned_at = now() WHERE grievance_id = $1 AND unassigned_at IS NULL', [b.grievanceId]);
        const r = await c.query<{ id: string }>(
          'INSERT INTO "case".assignments (grievance_id, node_id, assignee_user_id, assigned_by) VALUES ($1,$2,$3,$4) RETURNING id',
          [b.grievanceId, nodeId, b.assigneeUserId, auth.userId]
        );
        await writeAudit(c, 'case', {
          action: 'case.assignment.changed', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'case.assignments', ip: req.ip,
          scopePath: policy.pathOf(nodeId).join('.'), targetType: 'grievance', targetId: b.grievanceId,
          decision: req.decision?.decision ?? null, detail: { assigneeUserId: b.assigneeUserId }
        });
        return r.rows[0]!.id;
      });
      void reply.status(201);
      return { id };
    }
  );

  // ===== GET /case/assignments/:grievanceId (staff) ==========================
  app.get(
    '/api/v1/case/assignments/:grievanceId',
    {
      config: { access: { kind: 'feature', feature: 'case.assignments', action: 'view', node: async (req) => (await grievanceNode((req.params as { grievanceId: string }).grievanceId)).nodeId } },
      schema: { params: z.object({ grievanceId: z.string().uuid() }).strict() }
    },
    async (req) => {
      const { rows } = await query<{ id: string; assignee_user_id: string; display_name: string; assigned_by: string; assigned_at: string; unassigned_at: string | null }>(
        pools.case,
        `SELECT a.id, a.assignee_user_id, u.display_name, a.assigned_by, a.assigned_at, a.unassigned_at
           FROM "case".assignments a JOIN iam.users u ON u.id = a.assignee_user_id
           WHERE a.grievance_id = $1 ORDER BY a.assigned_at DESC`,
        [req.params.grievanceId]
      );
      return {
        history: rows.map((r) => ({
          id: r.id, assigneeUserId: r.assignee_user_id, assigneeName: r.display_name, assignedBy: r.assigned_by, assignedAt: r.assigned_at, unassignedAt: r.unassigned_at
        })),
        current: rows.find((r) => !r.unassigned_at)?.assignee_user_id ?? null
      };
    }
  );

  // ===== GET /case/inbox (staff) ==============================================
  app.get(
    '/api/v1/case/inbox',
    {
      config: { access: { kind: 'feature', feature: 'case.inbox', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId: nodeIdField }).strict() }
    },
    async (req) => {
      const auth = authOf(req);
      const subtree = policy.subtree(req.query.nodeId, 5000);
      const cols = `g.id, g.reference_code, g.node_id, g.subject, g.status, g.escalation_level, g.sla_due_at, g.created_at`;

      const mine = await query(
        pools.case,
        `SELECT ${cols} FROM intake.grievances g
           JOIN "case".assignments a ON a.grievance_id = g.id AND a.unassigned_at IS NULL
           WHERE g.node_id = ANY($1::text[]) AND a.assignee_user_id = $2
           ORDER BY g.escalation_level DESC, g.sla_due_at ASC NULLS LAST LIMIT 500`,
        [subtree, auth.userId]
      );
      const unassigned = await query(
        pools.case,
        `SELECT ${cols} FROM intake.grievances g
           WHERE g.node_id = ANY($1::text[]) AND g.status NOT IN ('CLOSED','REJECTED')
             AND NOT EXISTS (SELECT 1 FROM "case".assignments a WHERE a.grievance_id = g.id AND a.unassigned_at IS NULL)
           ORDER BY g.escalation_level DESC, g.sla_due_at ASC NULLS LAST LIMIT 500`,
        [subtree]
      );
      const shape = (rows: typeof mine.rows) =>
        rows.map((r) => ({
          id: r.id, referenceCode: r.reference_code, nodeId: r.node_id, subject: r.subject, status: r.status,
          escalationLevel: r.escalation_level, slaDueAt: r.sla_due_at, createdAt: r.created_at
        }));
      return { mine: shape(mine.rows), unassigned: shape(unassigned.rows) };
    }
  );

  // ===== POST /case/grievances/:id/confirm-closure (citizen, public) =========
  app.post(
    '/api/v1/case/grievances/:id/confirm-closure',
    { config: { access: { kind: 'public' } }, schema: { params: uuidParam, body: confirmClosureBody } },
    async (req) => {
      const token = req.cookies[cookieName];
      if (!token) throw new AppError('NP-CIT-0008', {});
      const citizen = await loadCitizenSession(pools.citizen, token, times);
      const header = req.headers['x-csrf-token'];
      if (!csrfValid(citizen.token, typeof header === 'string' ? header : undefined)) throw new AppError('NP-CSRF-0001', {});

      await dbRateLimit(pools.case, bucketKey('case-confirm-ip', req.ip), 20, 3600);

      const b = req.body;
      await withTx(pools.case, async (c) => {
        const g = await c.query<{ status: string; citizen_id: string | null; node_id: string }>(
          'SELECT status, citizen_id, node_id FROM intake.grievances WHERE id = $1', [req.params.id]
        );
        if (!g.rows[0]) throw new AppError('NP-CASE-0001', { id: req.params.id });
        if (g.rows[0].citizen_id !== citizen.citizenId) throw new AppError('NP-CASE-0004', {});
        if (g.rows[0].status !== 'RESOLVED') throw new AppError('NP-CASE-0003', {});

        const conf = await c.query<{ window_expires_at: string; confirmed: boolean | null }>(
          'SELECT window_expires_at, confirmed FROM "case".closure_confirmations WHERE grievance_id = $1 FOR UPDATE', [req.params.id]
        );
        if (!conf.rows[0] || conf.rows[0].confirmed !== null) throw new AppError('NP-CASE-0003', {});
        if (new Date(conf.rows[0].window_expires_at).getTime() < Date.now()) throw new AppError('NP-CASE-0005', {});

        const toStatus = b.confirmed ? 'CLOSED' : 'IN_PROGRESS';
        await c.query(
          `UPDATE intake.grievances SET status = $2, updated_at = now(),
             resolved_at = CASE WHEN $2 = 'CLOSED' THEN resolved_at ELSE NULL END,
             escalation_level = CASE WHEN $2 = 'IN_PROGRESS' THEN escalation_level + 1 ELSE escalation_level END
           WHERE id = $1`,
          [req.params.id, toStatus]
        );
        await c.query('INSERT INTO intake.grievance_events (grievance_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)', [
          req.params.id, 'RESOLVED', toStatus, b.confirmed ? 'Citizen confirmed resolution' : (b.note ?? 'Citizen disputed resolution')
        ]);
        await c.query('UPDATE "case".closure_confirmations SET confirmed = $2, confirmed_at = now(), dispute_note = $3 WHERE grievance_id = $1', [
          req.params.id, b.confirmed, b.confirmed ? null : (b.note ?? null)
        ]);
        await writeAudit(c, 'case', {
          action: 'case.closure.confirmed', actorId: citizen.citizenId, featureCode: 'case.assignments', ip: req.ip,
          scopePath: policy.pathOf(g.rows[0]!.node_id).join('.'), targetType: 'grievance', targetId: req.params.id,
          detail: { confirmed: b.confirmed }
        });
      });
      return { ok: true };
    }
  );
}
