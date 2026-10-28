/**
 * Org directory module: an ERP-style register of departments, ministries,
 * statutory authorities, SPVs, SEZ offices and other service providers.
 *
 *   GET    /org/entities?nodeId=        entities in the node's subtree
 *   POST   /org/entities                 create an entity
 *   PATCH  /org/entities/:id              edit an entity (not its node)
 *   DELETE /org/entities/:id              retire an entity (soft delete)
 *
 * `kind` is validated against platform.classification_values (axis
 * orgEntityKind) at write time rather than a hardcoded enum, so a new
 * organization type (a state's own parastatal, say) needs only a new
 * classification row, never a code change. This is the directory every other
 * module (registry services today; intake/case-engine/ground-audit later)
 * can point at instead of a free-text department name.
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
const localizedName = (max: number) => z.string().trim().min(1).max(max);
const kindCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/);

const entityCreateBody = z
  .object({
    nodeId: nodeIdField,
    kind: kindCode,
    nameEn: localizedName(300),
    nameHi: localizedName(300),
    parentEntityId: z.string().uuid().optional(),
    contactEn: z.string().trim().max(500).optional(),
    contactHi: z.string().trim().max(500).optional()
  })
  .strict();
const entityUpdateBody = entityCreateBody.omit({ nodeId: true }).partial().extend({ active: z.boolean().optional() }).strict();

export function registerOrgRoutes(app: App, deps: AppDeps): void {
  const { pools, policy } = deps;

  /** Confirms `kind` is a known, active orgEntityKind value (NP-ORG lookup is admin-addable, never hardcoded). */
  async function assertKnownKind(kind: string): Promise<void> {
    const r = await query(pools.org, `SELECT 1 FROM platform.classification_values WHERE axis_code = 'orgEntityKind' AND code = $1 AND active`, [kind]);
    if (!r.rowCount) throw new AppError('NP-VAL-0001', {}, { fields: [{ path: 'kind', message: `unknown org entity kind ${kind}` }] });
  }

  /** Node (and active parent-chain validity) of an existing entity (404 if unknown or retired). */
  async function entityNodeParam(req: FastifyRequest): Promise<string> {
    const { id } = req.params as { id: string };
    const r = await query<{ node_id: string }>(pools.org, 'SELECT node_id FROM org.entities WHERE id = $1 AND active', [id]);
    if (!r.rows[0]) throw new AppError('NP-ORG-0001', { id });
    return r.rows[0].node_id;
  }

  app.get(
    '/api/v1/org/entities',
    {
      config: { access: { kind: 'feature', feature: 'org.directory', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: z.object({ nodeId: nodeIdField }).strict() }
    },
    async (req) => {
      const subtree = policy.subtree(req.query.nodeId, 5000);
      const { rows } = await query<{
        id: string; node_id: string; kind: string; name_en: string; name_hi: string; parent_entity_id: string | null;
        contact_en: string | null; contact_hi: string | null; active: boolean;
      }>(
        pools.org,
        `SELECT id, node_id, kind, name_en, name_hi, parent_entity_id, contact_en, contact_hi, active
           FROM org.entities WHERE node_id = ANY($1::text[]) AND active ORDER BY name_en LIMIT 2000`,
        [subtree]
      );
      return {
        entities: rows.map((r) => ({
          id: r.id, nodeId: r.node_id, kind: r.kind, nameEn: r.name_en, nameHi: r.name_hi, parentEntityId: r.parent_entity_id,
          contactEn: r.contact_en, contactHi: r.contact_hi, active: r.active
        }))
      };
    }
  );

  app.post(
    '/api/v1/org/entities',
    { config: { access: { kind: 'feature', feature: 'org.directory', action: 'create', node: (req) => (req.body as { nodeId: string }).nodeId } }, schema: { body: entityCreateBody } },
    async (req, reply) => {
      const auth = authOf(req);
      const b = req.body;
      await assertKnownKind(b.kind);
      const id = await withTx(pools.org, async (c) => {
        if (b.parentEntityId) {
          // A parent must sit at this node or an ancestor node, mirroring the subtree the child reports into.
          const p = await c.query<{ node_id: string }>('SELECT node_id FROM org.entities WHERE id = $1 AND active', [b.parentEntityId]);
          if (!p.rows[0]) throw new AppError('NP-ORG-0001', { id: b.parentEntityId });
          const childPath = policy.pathOf(b.nodeId);
          const parentPath = policy.pathOf(p.rows[0].node_id);
          if (!parentPath.every((seg, i) => childPath[i] === seg)) throw new AppError('NP-ORG-0003', { nodeId: b.nodeId, parentNodeId: p.rows[0].node_id });
        }
        const r = await c.query<{ id: string }>(
          `INSERT INTO org.entities (node_id, kind, name_en, name_hi, parent_entity_id, contact_en, contact_hi, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [b.nodeId, b.kind, b.nameEn, b.nameHi, b.parentEntityId ?? null, b.contactEn ?? null, b.contactHi ?? null, auth.userId]
        );
        const newId = r.rows[0]!.id;
        await writeAudit(c, 'org', {
          action: 'org.entity.created', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'org.directory', ip: req.ip,
          scopePath: policy.pathOf(b.nodeId).join('.'), targetType: 'entity', targetId: newId, decision: req.decision?.decision ?? null, detail: { kind: b.kind, nameEn: b.nameEn }
        });
        return newId;
      });
      void reply.status(201);
      return { id };
    }
  );

  app.patch(
    '/api/v1/org/entities/:id',
    { config: { access: { kind: 'feature', feature: 'org.directory', action: 'update', node: entityNodeParam } }, schema: { params: uuidParam, body: entityUpdateBody } },
    async (req) => {
      const auth = authOf(req);
      const b = req.body;
      if (b.kind) await assertKnownKind(b.kind);
      await withTx(pools.org, async (c) => {
        const r = await c.query(
          `UPDATE org.entities SET
             kind = coalesce($2, kind), name_en = coalesce($3, name_en), name_hi = coalesce($4, name_hi),
             parent_entity_id = coalesce($5, parent_entity_id), contact_en = coalesce($6, contact_en), contact_hi = coalesce($7, contact_hi),
             active = coalesce($8, active), updated_at = now()
           WHERE id = $1 AND active RETURNING node_id`,
          [req.params.id, b.kind, b.nameEn, b.nameHi, b.parentEntityId, b.contactEn, b.contactHi, b.active]
        );
        if (!r.rows[0]) throw new AppError('NP-ORG-0001', { id: req.params.id });
        await writeAudit(c, 'org', {
          action: 'org.entity.updated', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'org.directory', ip: req.ip,
          scopePath: policy.pathOf(r.rows[0].node_id).join('.'), targetType: 'entity', targetId: req.params.id, decision: req.decision?.decision ?? null, detail: { changed: Object.keys(b) }
        });
      });
      return { ok: true };
    }
  );

  app.delete(
    '/api/v1/org/entities/:id',
    { config: { access: { kind: 'feature', feature: 'org.directory', action: 'delete', node: entityNodeParam } }, schema: { params: uuidParam } },
    async (req) => {
      const auth = authOf(req);
      await withTx(pools.org, async (c) => {
        const inUse = await c.query('SELECT 1 FROM org.entities WHERE parent_entity_id = $1 AND active LIMIT 1', [req.params.id]);
        if (inUse.rowCount) throw new AppError('NP-ORG-0002', { reason: 'entity has active child entities', id: req.params.id });
        const r = await c.query('UPDATE org.entities SET active = false, updated_at = now() WHERE id = $1 AND active RETURNING node_id', [req.params.id]);
        if (!r.rows[0]) throw new AppError('NP-ORG-0001', { id: req.params.id });
        await writeAudit(c, 'org', {
          action: 'org.entity.retired', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'org.directory', ip: req.ip,
          scopePath: policy.pathOf(r.rows[0].node_id).join('.'), targetType: 'entity', targetId: req.params.id, decision: req.decision?.decision ?? null
        });
      });
      return { ok: true };
    }
  );
}
