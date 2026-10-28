/**
 * Official accountability & leadership reporting module (Phase 4): process-
 * level KPI/KRI dashboards (always computed), evidence-gated person-level
 * metrics, due-process notices (notice -> reply -> independent review ->
 * appeal) and audited, reason-coded leadership pulls. See
 * db/migrations/0015_accountability.sql for the schema, the evidence-gate
 * limitation this module documents, and the decisions this route set
 * implements.
 *
 *   GET  /accountability/dashboard                 process metrics for a node + its subtree (Lego-gated)
 *   GET  /accountability/officers                   evidence-gated officer metrics (Lego-gated, separate/narrower feature)
 *   GET  /accountability/notices                     list notices for a node (Lego-gated)
 *   GET  /accountability/notices/:id                 a single notice's detail (Lego-gated)
 *   POST /accountability/notices                    issue a due-process notice to an officer (Lego-gated, audited)
 *   POST /accountability/notices/:id/reply           the named officer's own reply (self-check)
 *   POST /accountability/notices/:id/review          independent review sign-off (Lego-gated to Integrity Reviewer, audited)
 *   POST /accountability/notices/:id/appeal          the named officer's own appeal of an UPHELD notice (self-check)
 *   POST /accountability/pulls                       on-demand leadership pull: logged, reason-coded (Lego-gated to state/national leadership, audited)
 *   GET  /accountability/pulls                        pull history for a node (Lego-gated)
 *
 * The hourly rollups, the monthly push and the immediate SLA-breach alerts
 * are worker jobs (worker/jobs.ts), not routes here.
 */
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { query, withTx } from '../db/pools.js';
import { writeAudit } from '../audit/outbox.js';
import type { App, AppDeps } from '../http/app.js';
import { authOf, rolesOf } from '../http/app.js';
import { bucketKey, dbRateLimit } from './rate-limit.js';

const nodeIdField = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const uuidParam = z.object({ id: z.string().uuid() }).strict();

const noticeBody = z.object({
  assigneeUserId: z.string().uuid(),
  nodeId: nodeIdField,
  metricRef: z.string().trim().min(1).max(200),
  allegationSummary: z.string().trim().min(1).max(2000),
  replyWindowDays: z.coerce.number().int().min(1).max(60).optional()
}).strict();
const replyBody = z.object({ replyText: z.string().trim().min(1).max(4000) }).strict();
const reviewBody = z.object({ verdict: z.enum(['UPHELD', 'DISMISSED']), note: z.string().trim().max(2000).optional() }).strict();
const appealBody = z.object({ appealNote: z.string().trim().min(1).max(2000) }).strict();
const pullBody = z.object({ nodeId: nodeIdField, reasonCode: z.string().min(1).max(64), note: z.string().trim().max(1000).optional() }).strict();

export function registerAccountabilityRoutes(app: App, deps: AppDeps): void {
  const { pools, policy, cfg } = deps;
  const defaultReplyWindowDays = cfg.ACCOUNTABILITY_NOTICE_REPLY_WINDOW_DAYS;

  /** Node of an existing notice (404 NP-ACC-0001 if unknown). */
  async function noticeNode(id: string): Promise<{ nodeId: string; assigneeUserId: string; reviewStatus: string; replyDueAt: string }> {
    const r = await query<{ node_id: string; assignee_user_id: string; review_status: string; reply_due_at: string }>(
      pools.accountability, 'SELECT node_id, assignee_user_id, review_status, reply_due_at FROM accountability.notices WHERE id = $1', [id]
    );
    if (!r.rows[0]) throw new AppError('NP-ACC-0001', { id });
    return { nodeId: r.rows[0].node_id, assigneeUserId: r.rows[0].assignee_user_id, reviewStatus: r.rows[0].review_status, replyDueAt: r.rows[0].reply_due_at };
  }

  // ===== GET /accountability/dashboard (staff) ===============================
  app.get(
    '/api/v1/accountability/dashboard',
    {
      config: { access: { kind: 'feature', feature: 'accountability.dashboard', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId: nodeIdField, days: z.coerce.number().int().min(1).max(366).optional() }).strict() }
    },
    async (req) => {
      const subtree = policy.subtree(req.query.nodeId, 5000);
      const days = req.query.days ?? 30;
      const { rows } = await query(
        pools.accountability,
        `SELECT m.node_id, m.entity_id, e.name_en AS entity_name_en, e.name_hi AS entity_name_hi, m.metric_date,
                m.filed_count, m.resolved_count, m.closed_count, m.reopened_count, m.escalated_count,
                m.sla_met_count, m.sla_breached_count, m.avg_time_to_resolution_hours, m.avg_time_to_first_ack_hours,
                m.citizen_confirmed_count, m.computed_at
           FROM accountability.process_metrics_daily m
           LEFT JOIN org.entities e ON e.id = m.entity_id
           WHERE m.node_id = ANY($1::text[]) AND m.metric_date >= CURRENT_DATE - $2::int
           ORDER BY m.metric_date DESC LIMIT 5000`,
        [subtree, days]
      );
      return {
        rows: rows.map((r) => ({
          nodeId: r.node_id, entityId: r.entity_id, entityNameEn: r.entity_name_en, entityNameHi: r.entity_name_hi,
          metricDate: r.metric_date, filedCount: r.filed_count, resolvedCount: r.resolved_count, closedCount: r.closed_count,
          reopenedCount: r.reopened_count, escalatedCount: r.escalated_count, slaMetCount: r.sla_met_count, slaBreachedCount: r.sla_breached_count,
          avgTimeToResolutionHours: r.avg_time_to_resolution_hours, avgTimeToFirstAckHours: r.avg_time_to_first_ack_hours,
          citizenConfirmedCount: r.citizen_confirmed_count, computedAt: r.computed_at
        }))
      };
    }
  );

  // ===== GET /accountability/officers (staff, narrower feature) ==============
  app.get(
    '/api/v1/accountability/officers',
    {
      config: { access: { kind: 'feature', feature: 'accountability.officers', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId: nodeIdField }).strict() }
    },
    async (req) => {
      const subtree = policy.subtree(req.query.nodeId, 5000);
      // evidence_met is enforced here AND stored on the row (defence in
      // depth, see migration comment): a bug in this WHERE clause still
      // cannot leak evidence that hasn't cleared the gate, because the
      // underlying column is only ever set true when the worker job's own
      // threshold check passes.
      const { rows } = await query(
        pools.accountability,
        `SELECT p.assignee_user_id, u.display_name, p.node_id, p.window_days, p.assigned_count, p.resolved_count,
                p.sla_met_count, p.sla_breached_count, p.avg_time_to_resolution_hours, p.distinct_citizens, p.computed_at
           FROM accountability.person_metrics p JOIN iam.users u ON u.id = p.assignee_user_id
           WHERE p.node_id = ANY($1::text[]) AND p.evidence_met
           ORDER BY p.resolved_count DESC LIMIT 1000`,
        [subtree]
      );
      return {
        rows: rows.map((r) => ({
          assigneeUserId: r.assignee_user_id, assigneeName: r.display_name, nodeId: r.node_id, windowDays: r.window_days,
          assignedCount: r.assigned_count, resolvedCount: r.resolved_count, slaMetCount: r.sla_met_count, slaBreachedCount: r.sla_breached_count,
          avgTimeToResolutionHours: r.avg_time_to_resolution_hours, distinctCitizens: r.distinct_citizens, computedAt: r.computed_at
        }))
      };
    }
  );

  // ===== GET /accountability/notices (staff) ==================================
  app.get(
    '/api/v1/accountability/notices',
    {
      config: { access: { kind: 'feature', feature: 'accountability.notices', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId: nodeIdField }).strict() }
    },
    async (req) => {
      const { rows } = await query(
        pools.accountability,
        `SELECT n.id, n.node_id, n.assignee_user_id, u.display_name, n.metric_ref, n.issued_by, n.issued_at, n.reply_due_at,
                n.replied_at, n.review_status, n.reviewed_by, n.reviewed_at
           FROM accountability.notices n JOIN iam.users u ON u.id = n.assignee_user_id
           WHERE n.node_id = $1 ORDER BY n.issued_at DESC LIMIT 500`,
        [req.query.nodeId]
      );
      return {
        notices: rows.map((r) => ({
          id: r.id, nodeId: r.node_id, assigneeUserId: r.assignee_user_id, assigneeName: r.display_name, metricRef: r.metric_ref,
          issuedBy: r.issued_by, issuedAt: r.issued_at, replyDueAt: r.reply_due_at, repliedAt: r.replied_at,
          reviewStatus: r.review_status, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at
        }))
      };
    }
  );

  // ===== GET /accountability/notices/:id (staff) ===============================
  app.get(
    '/api/v1/accountability/notices/:id',
    {
      config: { access: { kind: 'feature', feature: 'accountability.notices', action: 'view', node: async (req) => (await noticeNode((req.params as { id: string }).id)).nodeId } },
      schema: { params: uuidParam }
    },
    async (req) => {
      const { rows } = await query(
        pools.accountability,
        `SELECT n.*, u.display_name FROM accountability.notices n JOIN iam.users u ON u.id = n.assignee_user_id WHERE n.id = $1`,
        [req.params.id]
      );
      const r = rows[0];
      if (!r) throw new AppError('NP-ACC-0001', { id: req.params.id });
      return {
        id: r.id, nodeId: r.node_id, assigneeUserId: r.assignee_user_id, assigneeName: r.display_name, metricRef: r.metric_ref,
        allegationSummary: r.allegation_summary, issuedBy: r.issued_by, issuedAt: r.issued_at, replyDueAt: r.reply_due_at,
        replyText: r.reply_text, repliedAt: r.replied_at, reviewStatus: r.review_status, reviewedBy: r.reviewed_by,
        reviewedAt: r.reviewed_at, reviewNote: r.review_note, appealNote: r.appeal_note, appealedAt: r.appealed_at
      };
    }
  );

  // ===== POST /accountability/notices (staff) =================================
  app.post(
    '/api/v1/accountability/notices',
    {
      config: { access: { kind: 'feature', feature: 'accountability.notices', action: 'create', node: (req) => (req.body as { nodeId: string }).nodeId } },
      schema: { body: noticeBody }
    },
    async (req, reply) => {
      const auth = authOf(req);
      const b = req.body;
      const id = await withTx(pools.accountability, async (c) => {
        const u = await c.query<{ status: string }>('SELECT status FROM iam.users WHERE id = $1', [b.assigneeUserId]);
        if (!u.rows[0] || u.rows[0].status !== 'ACTIVE') throw new AppError('NP-ACC-0002', { assigneeUserId: b.assigneeUserId });

        const r = await c.query<{ id: string }>(
          `INSERT INTO accountability.notices (node_id, assignee_user_id, metric_ref, allegation_summary, issued_by, reply_due_at)
             VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6)) RETURNING id`,
          [b.nodeId, b.assigneeUserId, b.metricRef, b.allegationSummary, auth.userId, b.replyWindowDays ?? defaultReplyWindowDays]
        );
        await writeAudit(c, 'accountability', {
          action: 'accountability.notice.issued', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'accountability.notices', ip: req.ip,
          scopePath: policy.pathOf(b.nodeId).join('.'), targetType: 'notice', targetId: r.rows[0]!.id,
          decision: req.decision?.decision ?? null, detail: { assigneeUserId: b.assigneeUserId, metricRef: b.metricRef }
        });
        return r.rows[0]!.id;
      });
      void reply.status(201);
      return { id };
    }
  );

  // ===== POST /accountability/notices/:id/reply (the named officer) ==========
  app.post(
    '/api/v1/accountability/notices/:id/reply',
    {
      config: { access: { kind: 'feature', feature: 'accountability.notices', action: 'update', node: async (req) => (await noticeNode((req.params as { id: string }).id)).nodeId } },
      schema: { params: uuidParam, body: replyBody }
    },
    async (req) => {
      const auth = authOf(req);
      const n = await noticeNode(req.params.id);
      if (n.assigneeUserId !== auth.userId) throw new AppError('NP-ACC-0004', {});
      if (n.reviewStatus !== 'PENDING_REPLY') throw new AppError('NP-ACC-0003', { reviewStatus: n.reviewStatus });
      if (new Date(n.replyDueAt).getTime() < Date.now()) throw new AppError('NP-ACC-0005', {});
      await withTx(pools.accountability, async (c) => {
        await c.query(
          `UPDATE accountability.notices SET reply_text = $2, replied_at = now(), review_status = 'UNDER_REVIEW' WHERE id = $1`,
          [req.params.id, req.body.replyText]
        );
        await writeAudit(c, 'accountability', {
          action: 'accountability.notice.replied', actorId: auth.userId, featureCode: 'accountability.notices', ip: req.ip,
          scopePath: policy.pathOf(n.nodeId).join('.'), targetType: 'notice', targetId: req.params.id, detail: {}
        });
      });
      return { ok: true };
    }
  );

  // ===== POST /accountability/notices/:id/review (Integrity Reviewer) ========
  app.post(
    '/api/v1/accountability/notices/:id/review',
    {
      config: { access: { kind: 'feature', feature: 'accountability.notices', action: 'approve', node: async (req) => (await noticeNode((req.params as { id: string }).id)).nodeId } },
      schema: { params: uuidParam, body: reviewBody }
    },
    async (req) => {
      const auth = authOf(req);
      const n = await noticeNode(req.params.id);
      if (n.reviewStatus !== 'UNDER_REVIEW') throw new AppError('NP-ACC-0003', { reviewStatus: n.reviewStatus });
      await withTx(pools.accountability, async (c) => {
        await c.query(
          `UPDATE accountability.notices SET review_status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
          [req.params.id, req.body.verdict, auth.userId, req.body.note ?? null]
        );
        await writeAudit(c, 'accountability', {
          action: 'accountability.notice.reviewed', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'accountability.notices', ip: req.ip,
          scopePath: policy.pathOf(n.nodeId).join('.'), targetType: 'notice', targetId: req.params.id,
          decision: req.decision?.decision ?? null, detail: { verdict: req.body.verdict }
        });
      });
      return { ok: true };
    }
  );

  // ===== POST /accountability/notices/:id/appeal (the named officer) =========
  app.post(
    '/api/v1/accountability/notices/:id/appeal',
    {
      config: { access: { kind: 'feature', feature: 'accountability.notices', action: 'update', node: async (req) => (await noticeNode((req.params as { id: string }).id)).nodeId } },
      schema: { params: uuidParam, body: appealBody }
    },
    async (req) => {
      const auth = authOf(req);
      const n = await noticeNode(req.params.id);
      if (n.assigneeUserId !== auth.userId) throw new AppError('NP-ACC-0004', {});
      if (n.reviewStatus !== 'UPHELD') throw new AppError('NP-ACC-0003', { reviewStatus: n.reviewStatus });
      await withTx(pools.accountability, async (c) => {
        await c.query(`UPDATE accountability.notices SET review_status = 'APPEALED', appeal_note = $2, appealed_at = now() WHERE id = $1`, [
          req.params.id, req.body.appealNote
        ]);
        await writeAudit(c, 'accountability', {
          action: 'accountability.notice.appealed', actorId: auth.userId, featureCode: 'accountability.notices', ip: req.ip,
          scopePath: policy.pathOf(n.nodeId).join('.'), targetType: 'notice', targetId: req.params.id, detail: {}
        });
      });
      return { ok: true };
    }
  );

  // ===== POST /accountability/pulls (state/national leadership) ==============
  app.post(
    '/api/v1/accountability/pulls',
    {
      config: { access: { kind: 'feature', feature: 'accountability.pulls', action: 'create', node: (req) => (req.body as { nodeId: string }).nodeId } },
      schema: { body: pullBody }
    },
    async (req, reply) => {
      const auth = authOf(req);
      const b = req.body;
      await dbRateLimit(pools.accountability, bucketKey('accountability-pull', auth.userId), 20, 3600);

      const id = await withTx(pools.accountability, async (c) => {
        const code = await c.query('SELECT 1 FROM platform.classification_values WHERE axis_code = $1 AND code = $2', ['accountabilityPullReason', b.reasonCode]);
        if (!code.rowCount) throw new AppError('NP-ACC-0006', { reasonCode: b.reasonCode });

        const subtree = policy.subtree(b.nodeId, 5000);
        const summary = await c.query(
          `SELECT node_id, entity_id, metric_date, filed_count, resolved_count, sla_met_count, sla_breached_count,
                  avg_time_to_resolution_hours, escalated_count, citizen_confirmed_count
             FROM accountability.process_metrics_daily WHERE node_id = ANY($1::text[]) AND metric_date >= CURRENT_DATE - 30 ORDER BY metric_date DESC`,
          [subtree]
        );
        const r = await c.query<{ id: string }>(
          `INSERT INTO accountability.pull_requests (requested_by, node_id, reason_code, note, result_summary) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [auth.userId, b.nodeId, b.reasonCode, b.note ?? null, JSON.stringify(summary.rows)]
        );
        await writeAudit(c, 'accountability', {
          action: 'accountability.pull.requested', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'accountability.pulls', ip: req.ip,
          scopePath: policy.pathOf(b.nodeId).join('.'), targetType: 'pull_request', targetId: r.rows[0]!.id,
          decision: req.decision?.decision ?? null, detail: { reasonCode: b.reasonCode }
        });
        return r.rows[0]!.id;
      });
      void reply.status(201);
      return { id };
    }
  );

  // ===== GET /accountability/pulls (history, Lego-gated) ======================
  app.get(
    '/api/v1/accountability/pulls',
    {
      config: { access: { kind: 'feature', feature: 'accountability.pulls', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId: nodeIdField }).strict() }
    },
    async (req) => {
      const { rows } = await query<{ id: string; requested_by: string; node_id: string; reason_code: string; note: string | null; requested_at: string }>(
        pools.accountability,
        `SELECT id, requested_by, node_id, reason_code, note, requested_at FROM accountability.pull_requests WHERE node_id = $1 ORDER BY requested_at DESC LIMIT 200`,
        [req.query.nodeId]
      );
      return { pulls: rows.map((r) => ({ id: r.id, requestedBy: r.requested_by, nodeId: r.node_id, reasonCode: r.reason_code, note: r.note, requestedAt: r.requested_at })) };
    }
  );
}
