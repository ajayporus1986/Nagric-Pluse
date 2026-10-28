/**
 * Grievance intake module (Phase 2): citizens and businesses file a
 * grievance against a notified service (registry.services, for SLA
 * tracking) or a general org entity (org.entities), or a plain civic
 * complaint with just a subject. Built on the shared shapes forward-declared
 * in @np/shared (complainantSchema/businessProfileSchema/frictionReportSchema)
 * so later modules (ground audit, named explicitly in the governance
 * research) reuse the same complainant/friction-report block rather than
 * inventing their own.
 *
 *   POST /intake/grievances                       file a grievance (public; citizen session optional unless ANONYMOUS)
 *   GET  /intake/grievances/lookup?referenceCode=  status-only lookup by reference code (public, no PII)
 *   GET  /intake/grievances?nodeId=                staff list in a node's subtree (Lego-gated)
 *   GET  /intake/grievances/:id                    staff detail incl. complainant block and event history
 *   PATCH /intake/grievances/:id/status            staff status transition (Lego-gated, audited)
 *
 * Filing is checked against the Lego module/feature toggle directly via
 * PolicyService.featureAvailable('intake.grievances', nodeId), the same
 * mechanism citizen.identity uses: citizens hold no role in the Lego model,
 * so the generic staff decision pipeline does not apply to that one route.
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../core/errors.js';
import { query, withTx } from '../db/pools.js';
import { writeAudit } from '../audit/outbox.js';
import type { App, AppDeps } from '../http/app.js';
import { authOf, rolesOf } from '../http/app.js';
import { citizenCookieName, csrfValid, loadCitizenSession, type CitizenAuthContext } from '../citizen/sessions.js';
import { bucketKey, dbRateLimit } from './rate-limit.js';
import { complainantSchema } from '@np/shared';

const nodeIdField = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const uuidParam = z.object({ id: z.string().uuid() }).strict();
const referenceCode = z.string().regex(/^NP-[A-Za-z0-9_]{1,64}-\d{6,}$/);

const grievanceCreateBody = z
  .object({
    nodeId: nodeIdField,
    serviceId: z.string().uuid().optional(),
    entityId: z.string().uuid().optional(),
    // Single-window routing (business-sector research §3.4): a grievance may
    // name more than one responsible department. entityId stays the primary
    // one for backward compatibility; these are the rest.
    additionalEntityIds: z.array(z.string().uuid()).max(5).optional(),
    // platform.classification_values(axis_code='grievanceSubtype').code;
    // validated below, same pattern as org.entities.kind. Defaults to the
    // ordinary service-delay fact pattern.
    subtype: z.string().trim().min(1).max(64).default('STANDARD'),
    subject: z.string().trim().min(3).max(300),
    description: z.string().trim().min(1).max(5000),
    locale: z.enum(['hi', 'en']).default('hi'),
    complainant: complainantSchema
  })
  .strict();

const STATUSES = ['NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED', 'CLOSED'] as const;
const statusChangeBody = z.object({ toStatus: z.enum(STATUSES), note: z.string().trim().max(2000).optional() }).strict();

/** Allowed forward transitions; anything else throws NP-INTAKE-0003. */
const TRANSITIONS: Record<string, readonly string[]> = {
  NEW: ['ACKNOWLEDGED', 'REJECTED'],
  ACKNOWLEDGED: ['IN_PROGRESS', 'REJECTED'],
  IN_PROGRESS: ['RESOLVED', 'REJECTED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  REJECTED: ['CLOSED'],
  CLOSED: []
};

export function registerIntakeRoutes(app: App, deps: AppDeps): void {
  const { pools, policy, cfg } = deps;
  const cookieName = citizenCookieName(cfg.COOKIE_SECURE);
  const times = { idleMinutes: cfg.CITIZEN_SESSION_IDLE_MINUTES, absoluteHours: cfg.CITIZEN_SESSION_ABSOLUTE_HOURS };

  /** Loads the citizen session if the cookie is present and valid; null otherwise (never throws). */
  async function optionalCitizen(req: FastifyRequest): Promise<CitizenAuthContext | null> {
    const token = req.cookies[cookieName];
    if (!token) return null;
    try {
      return await loadCitizenSession(pools.citizen, token, times);
    } catch {
      return null;
    }
  }

  function requireCsrfIfCitizen(req: FastifyRequest, citizen: CitizenAuthContext | null): void {
    if (!citizen) return; // no session cookie => no ambient authority to steal
    const header = req.headers['x-csrf-token'];
    if (!csrfValid(citizen.token, typeof header === 'string' ? header : undefined)) throw new AppError('NP-CSRF-0001', {});
  }

  async function assertFeatureOn(nodeId: string): Promise<void> {
    if (!policy.featureAvailable('intake.grievances', nodeId)) throw new AppError('NP-INTAKE-0004', { nodeId });
  }

  // ===== POST /intake/grievances (public) ===================================
  app.post(
    '/api/v1/intake/grievances',
    { config: { access: { kind: 'public' } }, schema: { body: grievanceCreateBody } },
    async (req, reply) => {
      const b = req.body;
      await assertFeatureOn(b.nodeId);
      const citizen = await optionalCitizen(req);
      requireCsrfIfCitizen(req, citizen);

      if (b.complainant.type === 'ANONYMOUS' && citizen) {
        // An authenticated citizen may still choose to file anonymously; the record carries no citizen_id either way.
      }
      if (b.complainant.type !== 'ANONYMOUS' && !citizen) throw new AppError('NP-INTAKE-0005', {});
      const citizenId = b.complainant.type === 'ANONYMOUS' ? null : (citizen?.citizenId ?? null);

      await dbRateLimit(pools.intake, bucketKey('intake-file-ip', req.ip), 20, 3600);

      const id = await withTx(pools.intake, async (c) => {
        let slaDays: number | null = null;
        let sNode: string | null = null;
        if (b.serviceId) {
          const s = await c.query<{ node_id: string; sla_days: number }>('SELECT node_id, sla_days FROM registry.services WHERE id = $1 AND active', [b.serviceId]);
          if (!s.rows[0] || s.rows[0].node_id !== b.nodeId) throw new AppError('NP-INTAKE-0002', { reason: 'unknown or mismatched service', serviceId: b.serviceId });
          slaDays = s.rows[0].sla_days;
          sNode = s.rows[0].node_id;
        }
        if (b.entityId) {
          const e = await c.query('SELECT 1 FROM org.entities WHERE id = $1 AND active', [b.entityId]);
          if (!e.rowCount) throw new AppError('NP-INTAKE-0002', { reason: 'unknown entity', entityId: b.entityId });
        }
        void sNode;

        const subtypeCheck = await c.query('SELECT 1 FROM platform.classification_values WHERE axis_code = $1 AND code = $2', ['grievanceSubtype', b.subtype]);
        if (!subtypeCheck.rowCount) throw new AppError('NP-INTAKE-0002', { reason: 'unknown subtype', subtype: b.subtype });

        // Single-window routing: primary entityId plus any additional named
        // departments, deduplicated, each checked to exist.
        const extraIds = [...new Set(b.additionalEntityIds ?? [])].filter((eid) => eid !== b.entityId);
        if (extraIds.length) {
          const found = await c.query('SELECT id FROM org.entities WHERE id = ANY($1::uuid[]) AND active', [extraIds]);
          if (found.rowCount !== extraIds.length) throw new AppError('NP-INTAKE-0002', { reason: 'unknown additional entity' });
        }

        const seq = await c.query<{ nextval: string }>('SELECT nextval($1)', ['intake.grievance_seq']);
        const refCode = `NP-${b.nodeId}-${seq.rows[0]!.nextval.padStart(6, '0')}`;

        const r = await c.query<{ id: string }>(
          `INSERT INTO intake.grievances
             (reference_code, node_id, service_id, entity_id, citizen_id, complainant_type, business_profile, friction_report,
              subject, description, locale, subtype, sla_days, sla_due_at, created_by_ip)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $13::int IS NULL THEN NULL ELSE now() + make_interval(days => $13) END, $14)
           RETURNING id`,
          [
            refCode, b.nodeId, b.serviceId ?? null, b.entityId ?? null, citizenId, b.complainant.type,
            b.complainant.businessProfile ? JSON.stringify(b.complainant.businessProfile) : null,
            b.complainant.frictionReport ? JSON.stringify(b.complainant.frictionReport) : null,
            b.subject, b.description, b.locale, b.subtype, slaDays, req.ip
          ]
        );
        const newId = r.rows[0]!.id;
        await c.query(`INSERT INTO intake.grievance_events (grievance_id, from_status, to_status, note) VALUES ($1, NULL, 'NEW', NULL)`, [newId]);
        if (b.entityId) await c.query('INSERT INTO intake.grievance_departments (grievance_id, entity_id, is_primary) VALUES ($1,$2,true)', [newId, b.entityId]);
        for (const eid of extraIds) {
          await c.query('INSERT INTO intake.grievance_departments (grievance_id, entity_id, is_primary) VALUES ($1,$2,false)', [newId, eid]);
        }
        await writeAudit(c, 'intake', {
          action: 'intake.grievance.filed', actorId: citizenId, featureCode: 'intake.grievances', ip: req.ip,
          scopePath: policy.pathOf(b.nodeId).join('.'), targetType: 'grievance', targetId: newId,
          detail: {
            complainantType: b.complainant.type, hasService: Boolean(b.serviceId), hasEntity: Boolean(b.entityId),
            additionalDepartments: extraIds.length, subtype: b.subtype, friction: b.complainant.frictionReport?.occurred ?? false
          }
        });
        return { id: newId, referenceCode: refCode };
      });
      void reply.status(201);
      return id;
    }
  );

  // ===== GET /intake/grievances/lookup (public, status only) ================
  app.get(
    '/api/v1/intake/grievances/lookup',
    { config: { access: { kind: 'public' } }, schema: { querystring: z.object({ referenceCode }).strict() } },
    async (req) => {
      await dbRateLimit(pools.intake, bucketKey('intake-lookup-ip', req.ip), 60, 3600);
      const r = await query<{ reference_code: string; status: string; subject: string; created_at: string; sla_due_at: string | null }>(
        pools.intake,
        'SELECT reference_code, status, subject, created_at, sla_due_at FROM intake.grievances WHERE reference_code = $1',
        [req.query.referenceCode]
      );
      if (!r.rows[0]) throw new AppError('NP-INTAKE-0001', {});
      const g = r.rows[0];
      return { referenceCode: g.reference_code, status: g.status, subject: g.subject, createdAt: g.created_at, slaDueAt: g.sla_due_at };
    }
  );

  // ===== GET /intake/grievances (staff list) =================================
  app.get(
    '/api/v1/intake/grievances',
    {
      config: { access: { kind: 'feature', feature: 'intake.grievances', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId: nodeIdField, status: z.enum(STATUSES).optional(), subtype: z.string().max(64).optional() }).strict() }
    },
    async (req) => {
      const subtree = policy.subtree(req.query.nodeId, 5000);
      const status = req.query.status;
      const subtype = req.query.subtype;
      const { rows } = await query<{
        id: string; reference_code: string; node_id: string; subject: string; status: string; complainant_type: string; subtype: string;
        friction_report: { occurred?: boolean } | null; sla_due_at: string | null; created_at: string;
      }>(
        pools.intake,
        `SELECT id, reference_code, node_id, subject, status, complainant_type, subtype, friction_report, sla_due_at, created_at
           FROM intake.grievances WHERE node_id = ANY($1::text[]) AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR subtype = $3)
           ORDER BY created_at DESC LIMIT 2000`,
        [subtree, status ?? null, subtype ?? null]
      );
      return {
        grievances: rows.map((r) => ({
          id: r.id, referenceCode: r.reference_code, nodeId: r.node_id, subject: r.subject, status: r.status, subtype: r.subtype,
          complainantType: r.complainant_type, hasFriction: Boolean(r.friction_report?.occurred), slaDueAt: r.sla_due_at, createdAt: r.created_at
        }))
      };
    }
  );

  /** Node of an existing grievance (404 NP-INTAKE-0001 if unknown). */
  async function grievanceNodeParam(req: FastifyRequest): Promise<string> {
    const { id } = req.params as { id: string };
    const r = await query<{ node_id: string }>(pools.intake, 'SELECT node_id FROM intake.grievances WHERE id = $1', [id]);
    if (!r.rows[0]) throw new AppError('NP-INTAKE-0001', { id });
    return r.rows[0].node_id;
  }

  // ===== GET /intake/grievances/:id (staff detail) ===========================
  app.get(
    '/api/v1/intake/grievances/:id',
    { config: { access: { kind: 'feature', feature: 'intake.grievances', action: 'view', node: grievanceNodeParam } }, schema: { params: uuidParam } },
    async (req) => {
      const g = await query(
        pools.intake,
        `SELECT id, reference_code, node_id, service_id, entity_id, complainant_type, business_profile, friction_report,
                subject, description, locale, status, subtype, sla_days, sla_due_at, created_at, updated_at, resolved_at
           FROM intake.grievances WHERE id = $1`,
        [req.params.id]
      );
      if (!g.rows[0]) throw new AppError('NP-INTAKE-0001', { id: req.params.id });
      const row = g.rows[0] as Record<string, unknown>;
      const events = await query(
        pools.intake,
        'SELECT id, from_status, to_status, note, actor_user_id, created_at FROM intake.grievance_events WHERE grievance_id = $1 ORDER BY created_at',
        [req.params.id]
      );
      const departments = await query<{ entity_id: string; is_primary: boolean; name_en: string; name_hi: string }>(
        pools.intake,
        `SELECT d.entity_id, d.is_primary, e.name_en, e.name_hi
           FROM intake.grievance_departments d JOIN org.entities e ON e.id = d.entity_id
           WHERE d.grievance_id = $1 ORDER BY d.is_primary DESC, e.name_en`,
        [req.params.id]
      );
      return {
        id: row.id, referenceCode: row.reference_code, nodeId: row.node_id, serviceId: row.service_id, entityId: row.entity_id,
        complainantType: row.complainant_type, businessProfile: row.business_profile, frictionReport: row.friction_report,
        subject: row.subject, description: row.description, locale: row.locale, status: row.status, subtype: row.subtype,
        slaDays: row.sla_days, slaDueAt: row.sla_due_at, createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at,
        departments: departments.rows.map((d) => ({ entityId: d.entity_id, isPrimary: d.is_primary, nameEn: d.name_en, nameHi: d.name_hi })),
        events: events.rows.map((e) => ({
          id: e.id, fromStatus: e.from_status, toStatus: e.to_status, note: e.note, actorUserId: e.actor_user_id, createdAt: e.created_at
        }))
      };
    }
  );

  // ===== PATCH /intake/grievances/:id/status (staff triage) ==================
  app.patch(
    '/api/v1/intake/grievances/:id/status',
    { config: { access: { kind: 'feature', feature: 'intake.grievances', action: 'update', node: grievanceNodeParam } }, schema: { params: uuidParam, body: statusChangeBody } },
    async (req) => {
      const auth = authOf(req);
      const b = req.body;
      await withTx(pools.intake, async (c) => {
        const g = await c.query<{ status: string; node_id: string }>('SELECT status, node_id FROM intake.grievances WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!g.rows[0]) throw new AppError('NP-INTAKE-0001', { id: req.params.id });
        const from = g.rows[0].status;
        if (!TRANSITIONS[from]?.includes(b.toStatus)) throw new AppError('NP-INTAKE-0003', { from, to: b.toStatus });
        await c.query(
          `UPDATE intake.grievances SET status = $2, updated_at = now(), resolved_at = CASE WHEN $2 = 'RESOLVED' THEN now() ELSE resolved_at END WHERE id = $1`,
          [req.params.id, b.toStatus]
        );
        await c.query('INSERT INTO intake.grievance_events (grievance_id, from_status, to_status, note, actor_user_id) VALUES ($1,$2,$3,$4,$5)', [
          req.params.id, from, b.toStatus, b.note ?? null, auth.userId
        ]);
        await writeAudit(c, 'intake', {
          action: 'intake.grievance.status_changed', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'intake.grievances', ip: req.ip,
          scopePath: policy.pathOf(g.rows[0]!.node_id).join('.'), targetType: 'grievance', targetId: req.params.id,
          decision: req.decision?.decision ?? null, detail: { from, to: b.toStatus }
        });
      });
      return { ok: true };
    }
  );
}
