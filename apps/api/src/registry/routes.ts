/**
 * Registry module: offices, posts (and who holds them), and the services
 * notified under a right-to-public-service law such as the Uttar Pradesh
 * Janhit Guarantee Adhiniyam, 2011.
 *
 *   GET    /registry/offices?nodeId=        offices in the node's subtree
 *   POST   /registry/offices                create an office
 *   PATCH  /registry/offices/:id             edit an office (not its node)
 *   DELETE /registry/offices/:id             retire an office (soft delete)
 *
 *   GET    /registry/posts?officeId=         posts of one office, with current holder
 *   POST   /registry/posts                   create a post under an office
 *   PATCH  /registry/posts/:id                edit a post's title
 *   DELETE /registry/posts/:id                retire a post (soft delete)
 *   POST   /registry/posts/:id/holder         assign the current holder
 *   POST   /registry/posts/:id/holder/end     end the current holder's assignment
 *
 *   GET    /registry/services?nodeId=        notified services in the subtree
 *   POST   /registry/services                 create a service (initial SLA included)
 *   PATCH  /registry/services/:id              edit everything except sla_days
 *   DELETE /registry/services/:id              retire a service (soft delete)
 *
 * sla_days is deliberately absent from the PATCH body schema: changing a
 * service's statutory time limit is only possible through a Realm Governor
 * change request (kind SERVICE_SLA_SET, see platform/changes.ts), so it is
 * structurally impossible to slip an SLA edit through this endpoint.
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../core/errors.js';
import { query, withTx } from '../db/pools.js';
import { writeAudit } from '../audit/outbox.js';
import type { App, AppDeps } from '../http/app.js';
import { authOf, rolesOf } from '../http/app.js';

const nodeIdField = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const uuidParam = z.object({ id: z.string().uuid() }).strict();
const phone = z.string().regex(/^[0-9+()\- ]{6,20}$/).optional();
const localizedName = (max: number) => z.string().trim().min(1).max(max);

const officeCreateBody = z
  .object({
    nodeId: nodeIdField,
    nameEn: localizedName(200),
    nameHi: localizedName(200),
    departmentEn: localizedName(200),
    departmentHi: localizedName(200),
    addressEn: z.string().trim().max(500).optional(),
    addressHi: z.string().trim().max(500).optional(),
    phone
  })
  .strict();
const officeUpdateBody = officeCreateBody.omit({ nodeId: true }).partial().extend({ active: z.boolean().optional() }).strict();

const postCreateBody = z.object({ officeId: z.string().uuid(), titleEn: localizedName(200), titleHi: localizedName(200) }).strict();
const postUpdateBody = z.object({ titleEn: localizedName(200).optional(), titleHi: localizedName(200).optional(), active: z.boolean().optional() }).strict();
const holderAssignBody = z.object({ userId: z.string().uuid(), assignedFrom: z.string().date().optional() }).strict();

const serviceCreateBody = z
  .object({
    nodeId: nodeIdField,
    code: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
    nameEn: localizedName(300),
    nameHi: localizedName(300),
    departmentEn: localizedName(200),
    departmentHi: localizedName(200),
    designatedOfficerPostId: z.string().uuid().optional(),
    firstAppealOfficerPostId: z.string().uuid().optional(),
    secondAppellateAuthorityEn: z.string().trim().max(300).optional(),
    secondAppellateAuthorityHi: z.string().trim().max(300).optional(),
    slaDays: z.number().int().min(1).max(365),
    isNotified: z.boolean().optional(),
    // Optional link into the org directory (Phase 1.5): lets a service point
    // at a real department/authority entity instead of only free-text
    // departmentEn/Hi. Nullable and optional so existing districts that
    // haven't adopted the org directory yet are unaffected.
    entityId: z.string().uuid().optional()
  })
  .strict();
// Everything a direct edit may touch, except sla_days (see module comment).
const serviceUpdateBody = serviceCreateBody.omit({ nodeId: true, code: true, slaDays: true }).partial().extend({ active: z.boolean().optional() }).strict();

export function registerRegistryRoutes(app: App, deps: AppDeps): void {
  const { pools, policy } = deps;

  /** Node of an existing office (404 if unknown or retired). */
  async function officeNodeParam(req: FastifyRequest): Promise<string> {
    const { id } = req.params as { id: string };
    const r = await query<{ node_id: string }>(pools.registry, 'SELECT node_id FROM registry.offices WHERE id = $1 AND active', [id]);
    if (!r.rows[0]) throw new AppError('NP-REG-0001', { id });
    return r.rows[0].node_id;
  }

  /** Node of the office a given officeId belongs to (for creating a post). */
  async function officeNodeOfBody(req: FastifyRequest): Promise<string> {
    const { officeId } = req.body as { officeId: string };
    const r = await query<{ node_id: string }>(pools.registry, 'SELECT node_id FROM registry.offices WHERE id = $1 AND active', [officeId]);
    if (!r.rows[0]) throw new AppError('NP-REG-0001', { officeId });
    return r.rows[0].node_id;
  }

  /** Node of an existing post, via its office (404 if unknown or retired). */
  async function postNodeParam(req: FastifyRequest): Promise<string> {
    const { id } = req.params as { id: string };
    const r = await query<{ node_id: string }>(
      pools.registry,
      `SELECT o.node_id FROM registry.posts p JOIN registry.offices o ON o.id = p.office_id WHERE p.id = $1 AND p.active AND o.active`,
      [id]
    );
    if (!r.rows[0]) throw new AppError('NP-REG-0002', { id });
    return r.rows[0].node_id;
  }

  /** Node of an existing service (404 if unknown or retired). */
  async function serviceNodeParam(req: FastifyRequest): Promise<string> {
    const { id } = req.params as { id: string };
    const r = await query<{ node_id: string }>(pools.registry, 'SELECT node_id FROM registry.services WHERE id = $1 AND active', [id]);
    if (!r.rows[0]) throw new AppError('NP-REG-0003', { id });
    return r.rows[0].node_id;
  }

  // ===== Offices ============================================================

  app.get(
    '/api/v1/registry/offices',
    {
      config: { access: { kind: 'feature', feature: 'registry.offices', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId: nodeIdField }).strict() }
    },
    async (req) => {
      const subtree = policy.subtree(req.query.nodeId, 5000);
      const { rows } = await query<{
        id: string; node_id: string; name_en: string; name_hi: string; department_en: string; department_hi: string;
        address_en: string | null; address_hi: string | null; phone: string | null; active: boolean;
      }>(
        pools.registry,
        `SELECT id, node_id, name_en, name_hi, department_en, department_hi, address_en, address_hi, phone, active
           FROM registry.offices WHERE node_id = ANY($1::text[]) AND active ORDER BY name_en LIMIT 2000`,
        [subtree]
      );
      return {
        offices: rows.map((r) => ({
          id: r.id, nodeId: r.node_id, nameEn: r.name_en, nameHi: r.name_hi, departmentEn: r.department_en, departmentHi: r.department_hi,
          addressEn: r.address_en, addressHi: r.address_hi, phone: r.phone, active: r.active
        }))
      };
    }
  );

  app.post(
    '/api/v1/registry/offices',
    { config: { access: { kind: 'feature', feature: 'registry.offices', action: 'create', node: (req) => (req.body as { nodeId: string }).nodeId } }, schema: { body: officeCreateBody } },
    async (req, reply) => {
      const auth = authOf(req);
      const b = req.body;
      const id = await withTx(pools.registry, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO registry.offices (node_id, name_en, name_hi, department_en, department_hi, address_en, address_hi, phone, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [b.nodeId, b.nameEn, b.nameHi, b.departmentEn, b.departmentHi, b.addressEn ?? null, b.addressHi ?? null, b.phone ?? null, auth.userId]
        );
        const newId = r.rows[0]!.id;
        await writeAudit(c, 'registry', {
          action: 'registry.office.created', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.offices', ip: req.ip,
          scopePath: policy.pathOf(b.nodeId).join('.'), targetType: 'office', targetId: newId, decision: req.decision?.decision ?? null, detail: { nameEn: b.nameEn }
        });
        return newId;
      });
      void reply.status(201);
      return { id };
    }
  );

  app.patch(
    '/api/v1/registry/offices/:id',
    { config: { access: { kind: 'feature', feature: 'registry.offices', action: 'update', node: officeNodeParam } }, schema: { params: uuidParam, body: officeUpdateBody } },
    async (req) => {
      const auth = authOf(req);
      const b = req.body;
      await withTx(pools.registry, async (c) => {
        const r = await c.query(
          `UPDATE registry.offices SET
             name_en = coalesce($2, name_en), name_hi = coalesce($3, name_hi),
             department_en = coalesce($4, department_en), department_hi = coalesce($5, department_hi),
             address_en = coalesce($6, address_en), address_hi = coalesce($7, address_hi), phone = coalesce($8, phone),
             active = coalesce($9, active), updated_at = now()
           WHERE id = $1 AND active RETURNING node_id`,
          [req.params.id, b.nameEn, b.nameHi, b.departmentEn, b.departmentHi, b.addressEn, b.addressHi, b.phone, b.active]
        );
        if (!r.rows[0]) throw new AppError('NP-REG-0001', { id: req.params.id });
        await writeAudit(c, 'registry', {
          action: 'registry.office.updated', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.offices', ip: req.ip,
          scopePath: policy.pathOf(r.rows[0].node_id).join('.'), targetType: 'office', targetId: req.params.id, decision: req.decision?.decision ?? null, detail: { changed: Object.keys(b) }
        });
      });
      return { ok: true };
    }
  );

  app.delete(
    '/api/v1/registry/offices/:id',
    { config: { access: { kind: 'feature', feature: 'registry.offices', action: 'delete', node: officeNodeParam } }, schema: { params: uuidParam } },
    async (req) => {
      const auth = authOf(req);
      await withTx(pools.registry, async (c) => {
        const inUse = await c.query('SELECT 1 FROM registry.posts WHERE office_id = $1 AND active LIMIT 1', [req.params.id]);
        if (inUse.rowCount) throw new AppError('NP-REG-0004', { reason: 'office has active posts', id: req.params.id });
        const r = await c.query('UPDATE registry.offices SET active = false, updated_at = now() WHERE id = $1 AND active RETURNING node_id', [req.params.id]);
        if (!r.rows[0]) throw new AppError('NP-REG-0001', { id: req.params.id });
        await writeAudit(c, 'registry', {
          action: 'registry.office.retired', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.offices', ip: req.ip,
          scopePath: policy.pathOf(r.rows[0].node_id).join('.'), targetType: 'office', targetId: req.params.id, decision: req.decision?.decision ?? null
        });
      });
      return { ok: true };
    }
  );

  // ===== Posts & post holders ===============================================

  app.get(
    '/api/v1/registry/posts',
    {
      config: { access: { kind: 'feature', feature: 'registry.posts', action: 'view', node: officeNodeOfQuery } },
      schema: { querystring: z.object({ officeId: z.string().uuid() }).strict() }
    },
    async (req) => {
      const { rows } = await query<{
        id: string; office_id: string; title_en: string; title_hi: string; active: boolean;
        holder_user_id: string | null; holder_username: string | null; holder_display_name: string | null; assigned_from: string | null;
      }>(
        pools.registry,
        `SELECT p.id, p.office_id, p.title_en, p.title_hi, p.active, h.user_id AS holder_user_id, u.username AS holder_username, u.display_name AS holder_display_name, h.assigned_from
           FROM registry.posts p
           LEFT JOIN registry.post_holders h ON h.post_id = p.id AND h.assigned_to IS NULL
           LEFT JOIN iam.users u ON u.id = h.user_id
          WHERE p.office_id = $1 AND p.active ORDER BY p.title_en LIMIT 2000`,
        [req.query.officeId]
      );
      return {
        posts: rows.map((r) => ({
          id: r.id, officeId: r.office_id, titleEn: r.title_en, titleHi: r.title_hi, active: r.active,
          holder: r.holder_user_id ? { userId: r.holder_user_id, username: r.holder_username, displayName: r.holder_display_name, assignedFrom: r.assigned_from } : null
        }))
      };
    }
  );

  app.post(
    '/api/v1/registry/posts',
    { config: { access: { kind: 'feature', feature: 'registry.posts', action: 'create', node: officeNodeOfBody } }, schema: { body: postCreateBody } },
    async (req, reply) => {
      const auth = authOf(req);
      const b = req.body;
      const id = await withTx(pools.registry, async (c) => {
        const r = await c.query<{ id: string }>(
          'INSERT INTO registry.posts (office_id, title_en, title_hi, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
          [b.officeId, b.titleEn, b.titleHi, auth.userId]
        );
        const newId = r.rows[0]!.id;
        await writeAudit(c, 'registry', {
          action: 'registry.post.created', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.posts', ip: req.ip,
          targetType: 'post', targetId: newId, decision: req.decision?.decision ?? null, detail: { officeId: b.officeId, titleEn: b.titleEn }
        });
        return newId;
      });
      void reply.status(201);
      return { id };
    }
  );

  app.patch(
    '/api/v1/registry/posts/:id',
    { config: { access: { kind: 'feature', feature: 'registry.posts', action: 'update', node: postNodeParam } }, schema: { params: uuidParam, body: postUpdateBody } },
    async (req) => {
      const auth = authOf(req);
      const b = req.body;
      await withTx(pools.registry, async (c) => {
        const r = await c.query(
          'UPDATE registry.posts SET title_en = coalesce($2, title_en), title_hi = coalesce($3, title_hi), active = coalesce($4, active), updated_at = now() WHERE id = $1 AND active RETURNING id',
          [req.params.id, b.titleEn, b.titleHi, b.active]
        );
        if (!r.rows[0]) throw new AppError('NP-REG-0002', { id: req.params.id });
        await writeAudit(c, 'registry', {
          action: 'registry.post.updated', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.posts', ip: req.ip,
          targetType: 'post', targetId: req.params.id, decision: req.decision?.decision ?? null, detail: { changed: Object.keys(b) }
        });
      });
      return { ok: true };
    }
  );

  app.delete(
    '/api/v1/registry/posts/:id',
    { config: { access: { kind: 'feature', feature: 'registry.posts', action: 'delete', node: postNodeParam } }, schema: { params: uuidParam } },
    async (req) => {
      const auth = authOf(req);
      await withTx(pools.registry, async (c) => {
        const inUse = await c.query(
          'SELECT 1 FROM registry.services WHERE active AND (designated_officer_post_id = $1 OR first_appeal_officer_post_id = $1) LIMIT 1',
          [req.params.id]
        );
        if (inUse.rowCount) throw new AppError('NP-REG-0004', { reason: 'post is referenced by a service', id: req.params.id });
        const r = await c.query('UPDATE registry.posts SET active = false, updated_at = now() WHERE id = $1 AND active RETURNING id', [req.params.id]);
        if (!r.rows[0]) throw new AppError('NP-REG-0002', { id: req.params.id });
        await writeAudit(c, 'registry', {
          action: 'registry.post.retired', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.posts', ip: req.ip,
          targetType: 'post', targetId: req.params.id, decision: req.decision?.decision ?? null
        });
      });
      return { ok: true };
    }
  );

  app.post(
    '/api/v1/registry/posts/:id/holder',
    { config: { access: { kind: 'feature', feature: 'registry.posts', action: 'update', node: postNodeParam } }, schema: { params: uuidParam, body: holderAssignBody } },
    async (req, reply) => {
      const auth = authOf(req);
      const b = req.body;
      const id = await withTx(pools.registry, async (c) => {
        const open = await c.query('SELECT 1 FROM registry.post_holders WHERE post_id = $1 AND assigned_to IS NULL', [req.params.id]);
        if (open.rowCount) throw new AppError('NP-REG-0006', { postId: req.params.id });
        const u = await c.query('SELECT 1 FROM iam.users WHERE id = $1', [b.userId]);
        if (!u.rowCount) throw new AppError('NP-USER-0002', { userId: b.userId });
        const r = await c.query<{ id: string }>(
          'INSERT INTO registry.post_holders (post_id, user_id, assigned_from, created_by) VALUES ($1, $2, coalesce($3, CURRENT_DATE), $4) RETURNING id',
          [req.params.id, b.userId, b.assignedFrom ?? null, auth.userId]
        );
        const newId = r.rows[0]!.id;
        await writeAudit(c, 'registry', {
          action: 'registry.post.holder_assigned', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.posts', ip: req.ip,
          targetType: 'post', targetId: req.params.id, decision: req.decision?.decision ?? null, detail: { userId: b.userId }
        });
        return newId;
      });
      void reply.status(201);
      return { id };
    }
  );

  app.post(
    '/api/v1/registry/posts/:id/holder/end',
    { config: { access: { kind: 'feature', feature: 'registry.posts', action: 'update', node: postNodeParam } }, schema: { params: uuidParam } },
    async (req) => {
      const auth = authOf(req);
      await withTx(pools.registry, async (c) => {
        const r = await c.query('UPDATE registry.post_holders SET assigned_to = CURRENT_DATE WHERE post_id = $1 AND assigned_to IS NULL RETURNING id', [req.params.id]);
        if (!r.rows[0]) throw new AppError('NP-REG-0002', { reason: 'post has no current holder', id: req.params.id });
        await writeAudit(c, 'registry', {
          action: 'registry.post.holder_ended', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.posts', ip: req.ip,
          targetType: 'post', targetId: req.params.id, decision: req.decision?.decision ?? null
        });
      });
      return { ok: true };
    }
  );

  // ===== Services (notified, with editable-by-quorum SLA) ==================

  app.get(
    '/api/v1/registry/services',
    {
      config: { access: { kind: 'feature', feature: 'registry.services', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId: nodeIdField }).strict() }
    },
    async (req) => {
      const subtree = policy.subtree(req.query.nodeId, 5000);
      const { rows } = await query<{
        id: string; node_id: string; code: string; name_en: string; name_hi: string; department_en: string; department_hi: string;
        designated_officer_post_id: string | null; first_appeal_officer_post_id: string | null;
        second_appellate_authority_en: string | null; second_appellate_authority_hi: string | null;
        sla_days: number; source_act_en: string; source_act_hi: string; is_notified: boolean; active: boolean; entity_id: string | null;
      }>(
        pools.registry,
        `SELECT id, node_id, code, name_en, name_hi, department_en, department_hi, designated_officer_post_id, first_appeal_officer_post_id,
                second_appellate_authority_en, second_appellate_authority_hi, sla_days, source_act_en, source_act_hi, is_notified, active, entity_id
           FROM registry.services WHERE node_id = ANY($1::text[]) AND active ORDER BY name_en LIMIT 2000`,
        [subtree]
      );
      return {
        services: rows.map((r) => ({
          id: r.id, nodeId: r.node_id, code: r.code, nameEn: r.name_en, nameHi: r.name_hi, departmentEn: r.department_en, departmentHi: r.department_hi,
          designatedOfficerPostId: r.designated_officer_post_id, firstAppealOfficerPostId: r.first_appeal_officer_post_id,
          secondAppellateAuthorityEn: r.second_appellate_authority_en, secondAppellateAuthorityHi: r.second_appellate_authority_hi,
          slaDays: r.sla_days, sourceActEn: r.source_act_en, sourceActHi: r.source_act_hi, isNotified: r.is_notified, active: r.active, entityId: r.entity_id
        }))
      };
    }
  );

  app.post(
    '/api/v1/registry/services',
    { config: { access: { kind: 'feature', feature: 'registry.services', action: 'create', node: (req) => (req.body as { nodeId: string }).nodeId } }, schema: { body: serviceCreateBody } },
    async (req, reply) => {
      const auth = authOf(req);
      const b = req.body;
      const id = await withTx(pools.registry, async (c) => {
        const exists = await c.query('SELECT 1 FROM registry.services WHERE node_id = $1 AND code = $2', [b.nodeId, b.code]);
        if (exists.rowCount) throw new AppError('NP-REG-0005', { code: b.code });
        if (b.entityId) {
          const e = await c.query('SELECT 1 FROM org.entities WHERE id = $1 AND active', [b.entityId]);
          if (!e.rowCount) throw new AppError('NP-ORG-0001', { id: b.entityId });
        }
        const r = await c.query<{ id: string }>(
          `INSERT INTO registry.services (node_id, code, name_en, name_hi, department_en, department_hi, designated_officer_post_id,
                                           first_appeal_officer_post_id, second_appellate_authority_en, second_appellate_authority_hi, sla_days, is_notified, entity_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
          [
            b.nodeId, b.code, b.nameEn, b.nameHi, b.departmentEn, b.departmentHi, b.designatedOfficerPostId ?? null,
            b.firstAppealOfficerPostId ?? null, b.secondAppellateAuthorityEn ?? null, b.secondAppellateAuthorityHi ?? null, b.slaDays, b.isNotified ?? true,
            b.entityId ?? null, auth.userId
          ]
        );
        const newId = r.rows[0]!.id;
        await writeAudit(c, 'registry', {
          action: 'registry.service.created', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.services', ip: req.ip,
          scopePath: policy.pathOf(b.nodeId).join('.'), targetType: 'service', targetId: newId, decision: req.decision?.decision ?? null,
          detail: { code: b.code, slaDays: b.slaDays }
        });
        return newId;
      });
      void reply.status(201);
      return { id };
    }
  );

  app.patch(
    '/api/v1/registry/services/:id',
    { config: { access: { kind: 'feature', feature: 'registry.services', action: 'update', node: serviceNodeParam } }, schema: { params: uuidParam, body: serviceUpdateBody } },
    async (req) => {
      const auth = authOf(req);
      const b = req.body;
      await withTx(pools.registry, async (c) => {
        if (b.entityId) {
          const e = await c.query('SELECT 1 FROM org.entities WHERE id = $1 AND active', [b.entityId]);
          if (!e.rowCount) throw new AppError('NP-ORG-0001', { id: b.entityId });
        }
        const r = await c.query(
          `UPDATE registry.services SET
             name_en = coalesce($2, name_en), name_hi = coalesce($3, name_hi),
             department_en = coalesce($4, department_en), department_hi = coalesce($5, department_hi),
             designated_officer_post_id = coalesce($6, designated_officer_post_id), first_appeal_officer_post_id = coalesce($7, first_appeal_officer_post_id),
             second_appellate_authority_en = coalesce($8, second_appellate_authority_en), second_appellate_authority_hi = coalesce($9, second_appellate_authority_hi),
             is_notified = coalesce($10, is_notified), active = coalesce($11, active), entity_id = coalesce($12, entity_id), updated_at = now()
           WHERE id = $1 AND active RETURNING node_id`,
          [
            req.params.id, b.nameEn, b.nameHi, b.departmentEn, b.departmentHi, b.designatedOfficerPostId, b.firstAppealOfficerPostId,
            b.secondAppellateAuthorityEn, b.secondAppellateAuthorityHi, b.isNotified, b.active, b.entityId
          ]
        );
        if (!r.rows[0]) throw new AppError('NP-REG-0003', { id: req.params.id });
        await writeAudit(c, 'registry', {
          action: 'registry.service.updated', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.services', ip: req.ip,
          scopePath: policy.pathOf(r.rows[0].node_id).join('.'), targetType: 'service', targetId: req.params.id, decision: req.decision?.decision ?? null, detail: { changed: Object.keys(b) }
        });
      });
      return { ok: true };
    }
  );

  app.delete(
    '/api/v1/registry/services/:id',
    { config: { access: { kind: 'feature', feature: 'registry.services', action: 'delete', node: serviceNodeParam } }, schema: { params: uuidParam } },
    async (req) => {
      const auth = authOf(req);
      await withTx(pools.registry, async (c) => {
        const r = await c.query('UPDATE registry.services SET active = false, updated_at = now() WHERE id = $1 AND active RETURNING node_id', [req.params.id]);
        if (!r.rows[0]) throw new AppError('NP-REG-0003', { id: req.params.id });
        await writeAudit(c, 'registry', {
          action: 'registry.service.retired', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'registry.services', ip: req.ip,
          scopePath: policy.pathOf(r.rows[0].node_id).join('.'), targetType: 'service', targetId: req.params.id, decision: req.decision?.decision ?? null
        });
      });
      return { ok: true };
    }
  );

  /** Node of the office named by ?officeId=, for the posts list route. */
  async function officeNodeOfQuery(req: FastifyRequest): Promise<string> {
    const { officeId } = req.query as { officeId: string };
    const r = await query<{ node_id: string }>(pools.registry, 'SELECT node_id FROM registry.offices WHERE id = $1 AND active', [officeId]);
    if (!r.rows[0]) throw new AppError('NP-REG-0001', { officeId });
    return r.rows[0].node_id;
  }
}
