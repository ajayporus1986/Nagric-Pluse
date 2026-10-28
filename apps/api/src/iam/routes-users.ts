/**
 * Staff account administration.
 *
 *   GET  /users?nodeId=        accounts working in the node's subtree, plus unassigned accounts
 *   POST /users                create an account (no roles); returns a one-time password once
 *   POST /users/:id/disable    disable immediately and sign out everywhere (protective action)
 *
 * Granting roles, re-enabling accounts and resetting credentials are NOT done
 * here: they need a Realm Governor quorum (see platform change requests).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getRole, isAncestorOrSelf } from '@np/shared';
import { AppError } from '../core/errors.js';
import { query, withTx } from '../db/pools.js';
import { writeAudit } from '../audit/outbox.js';
import type { App, AppDeps } from '../http/app.js';
import { authOf, rolesOf } from '../http/app.js';
import { encryptField, generateOneTimePassword, hashPassword } from '../security/crypto.js';
import { revokeUserSessions } from './sessions.js';

const nodeQuery = z.object({ nodeId: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) }).strict();
const createBody = z
  .object({
    nodeId: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
    username: z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/),
    displayName: z.string().trim().min(1).max(200),
    email: z.string().email().max(254).optional()
  })
  .strict();
const disableBody = z.object({ nodeId: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), reason: z.string().trim().min(10).max(2000) }).strict();

export function registerUserRoutes(app: App, deps: AppDeps): void {
  const { pools, ring, policy } = deps;

  // ---- GET /users ---------------------------------------------------------
  app.get(
    '/api/v1/users',
    {
      config: { access: { kind: 'feature', feature: 'iam.users', action: 'view', node: (req) => (req.query as { nodeId: string }).nodeId } },
      schema: { querystring: nodeQuery }
    },
    async (req) => {
      const path = policy.pathOf(req.query.nodeId).join('.');
      // Users with a role anywhere in the subtree, plus users with no active role yet
      // (newly created accounts waiting for a role grant).
      const { rows } = await query<{
        id: string; username: string; display_name: string; status: string; totp_enrolled: boolean; must_change_password: boolean;
        created_at: Date; roles: { role: string; nodeId: string; assignmentId: string }[] | null;
      }>(
        pools.iam,
        `SELECT u.id, u.username, u.display_name, u.status, u.totp_enrolled_at IS NOT NULL AS totp_enrolled, u.must_change_password, u.created_at,
                (SELECT json_agg(json_build_object('role', ra.role, 'nodeId', ra.node_id, 'assignmentId', ra.id) ORDER BY ra.role)
                   FROM iam.role_assignments ra WHERE ra.user_id = u.id AND ra.revoked_at IS NULL) AS roles
           FROM iam.users u
          WHERE EXISTS (SELECT 1 FROM iam.role_assignments ra JOIN platform.scope_nodes n ON n.id = ra.node_id
                         WHERE ra.user_id = u.id AND ra.revoked_at IS NULL AND n.path <@ $1::ltree)
             OR NOT EXISTS (SELECT 1 FROM iam.role_assignments ra WHERE ra.user_id = u.id AND ra.revoked_at IS NULL)
          ORDER BY u.username
          LIMIT 1000`,
        [path]
      );
      return {
        users: rows.map((r) => ({
          id: r.id, username: r.username, displayName: r.display_name, status: r.status, totpEnrolled: r.totp_enrolled,
          mustChangePassword: r.must_change_password, createdAt: r.created_at, roles: r.roles ?? []
        }))
      };
    }
  );

  // ---- POST /users --------------------------------------------------------
  app.post(
    '/api/v1/users',
    {
      config: { access: { kind: 'feature', feature: 'iam.users', action: 'create', node: (req) => (req.body as { nodeId: string }).nodeId } },
      schema: { body: createBody }
    },
    async (req, reply) => {
      const auth = authOf(req);
      const id = randomUUID();
      const oneTimePassword = generateOneTimePassword();
      const hash = await hashPassword(oneTimePassword);
      await withTx(pools.iam, async (c) => {
        const exists = await c.query('SELECT 1 FROM iam.users WHERE username = $1', [req.body.username]);
        if (exists.rowCount) throw new AppError('NP-USER-0001', { username: req.body.username });
        await c.query(
          `INSERT INTO iam.users (id, username, display_name, email_enc, password_hash, must_change_password, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6)`,
          [id, req.body.username, req.body.displayName, req.body.email ? encryptField(ring, req.body.email, `iam.users.email:${id}`) : null, hash, auth.userId]
        );
        await writeAudit(c, 'iam', {
          action: 'iam.user.created', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'iam.users', ip: req.ip,
          scopePath: policy.pathOf(req.body.nodeId).join('.'), targetType: 'user', targetId: id, decision: req.decision?.decision ?? null,
          detail: { username: req.body.username }
        });
      });
      // The one-time password is shown exactly once; it must be handed over in person or by a secure channel.
      void reply.status(201);
      return { id, username: req.body.username, oneTimePassword };
    }
  );

  // ---- POST /users/:id/disable -------------------------------------------
  app.post(
    '/api/v1/users/:id/disable',
    {
      config: { access: { kind: 'feature', feature: 'iam.users', action: 'update', node: (req) => (req.body as { nodeId: string }).nodeId } },
      schema: { params: z.object({ id: z.string().uuid() }), body: disableBody }
    },
    async (req) => {
      const auth = authOf(req);
      if (req.params.id === auth.userId) throw new AppError('NP-CR-0004', { action: 'disable_self' });
      const nodePath = policy.pathOf(req.body.nodeId);
      const revoked = await withTx(pools.iam, async (c) => {
        const u = await c.query<{ status: string }>('SELECT status FROM iam.users WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!u.rows[0]) throw new AppError('NP-USER-0002', { userId: req.params.id });
        // The caller's node must cover every active assignment of the target, so nobody can
        // disable an account that works above or beside their own jurisdiction.
        const ra = await c.query<{ path: string; role: string }>(
          `SELECT n.path::text AS path, ra.role FROM iam.role_assignments ra JOIN platform.scope_nodes n ON n.id = ra.node_id
            WHERE ra.user_id = $1 AND ra.revoked_at IS NULL`,
          [req.params.id]
        );
        for (const r of ra.rows) {
          if (!isAncestorOrSelf(nodePath, r.path.split('.'))) {
            throw new AppError('NP-POL-0001', { reason: 'target has a role outside caller scope', role: r.role, roleSensitive: getRole(r.role)?.sensitive });
          }
          // Oversight roles (governors, DPO, operators, reviewers…) can only be disabled by quorum,
          // so no single person can lock the others out.
          if (getRole(r.role)?.sensitive) throw new AppError('NP-USER-0003', { role: r.role });
        }
        await c.query(`UPDATE iam.users SET status = 'DISABLED' WHERE id = $1`, [req.params.id]);
        const n = await revokeUserSessions(c, req.params.id, 'account_disabled');
        await writeAudit(c, 'iam', {
          action: 'iam.user.disabled', actorId: auth.userId, actorRoles: rolesOf(req), featureCode: 'iam.users', ip: req.ip,
          scopePath: nodePath.join('.'), targetType: 'user', targetId: req.params.id, decision: req.decision?.decision ?? null,
          detail: { reason: req.body.reason, sessionsRevoked: n, previousStatus: u.rows[0].status }
        });
        return n;
      });
      return { ok: true, sessionsRevoked: revoked };
    }
  );
}
