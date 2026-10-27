/**
 * Change requests: the only way Lego settings, permissions, role grants and
 * sensitive account actions change.
 *
 * Lifecycle: PENDING → APPLIED | REJECTED | EXPIRED | WITHDRAWN
 *   - The proposer's own approval counts as the first vote.
 *   - Approvers must be distinct Realm Governors whose scope covers the node.
 *   - Nobody may propose or approve a change about their own account.
 *   - One REJECT ends the request (safety bias: a contested change needs a new proposal).
 *   - When approvals reach the quorum, the change is re-validated against the
 *     current state and applied in the same transaction as the final vote.
 *
 * This file holds the pure-ish logic (payload schemas, validation, impact
 * preview, apply); HTTP handling lives in routes.ts.
 */
import { z } from 'zod';
import type pg from 'pg';
import { buildSnapshot, featureAvailability, grantedActions, type SnapshotRows } from '@np/policy';
import { ACTIONS, SCOPE_LEVELS, getRole, isAncestorOrSelf, type Action } from '@np/shared';
import { AppError } from '../core/errors.js';
import type { PolicyState } from '../policy/service.js';
import { writeAudit } from '../audit/outbox.js';
import { generateOneTimePassword, hashPassword } from '../security/crypto.js';

const id64 = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/);
const featureCode = z.string().regex(/^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_.]{1,60}$/);
const toggle = z.enum(['ENABLED', 'DISABLED', 'INHERIT']);

/** Payload schema per kind. `.strict()` rejects unexpected keys. */
export const PAYLOADS = {
  MODULE_SETTING: z.object({ moduleId: id64, state: toggle }).strict(),
  FEATURE_SETTING: z.object({ featureCode, state: toggle }).strict(),
  REALM_SETTING: z.object({ realm: z.enum(['GOVERNMENT', 'PARTY', 'OBSERVER']), state: toggle }).strict(),
  PERMISSION: z.object({ featureCode, role: z.string().min(1).max(40), actions: z.array(z.enum(ACTIONS)).max(7).nullable() }).strict(),
  ROLE_GRANT: z.object({ userId: z.string().uuid(), role: z.string().min(1).max(40) }).strict(),
  ROLE_REVOKE: z.object({ assignmentId: z.string().uuid() }).strict(),
  KILL_SWITCH_RATIFY: z.object({ killSwitchId: z.string().uuid() }).strict(),
  QUORUM_CONFIG: z.object({ level: z.enum(SCOPE_LEVELS), required: z.number().int().min(2).max(9) }).strict(),
  USER_ENABLE: z.object({ userId: z.string().uuid() }).strict(),
  USER_RESET_CREDENTIALS: z.object({ userId: z.string().uuid() }).strict(),
  USER_DISABLE: z.object({ userId: z.string().uuid() }).strict()
} as const;

export type ChangeKind = keyof typeof PAYLOADS;
export const CHANGE_KINDS = Object.keys(PAYLOADS) as ChangeKind[];

/** Parsed, validated proposal. */
export interface ValidatedChange {
  kind: ChangeKind;
  nodeId: string;
  payload: Record<string, unknown>;
  /** Unique key of what this change touches at the node (one pending request per key). */
  targetKey: string;
  /** User the change is about, if any (proposer/approvers may not be this user). */
  subjectUserId: string | null;
}

/** Parses a payload for a kind, mapping zod issues to NP-VAL-0001 fields. */
export function parsePayload(kind: ChangeKind, raw: unknown): Record<string, unknown> {
  const r = PAYLOADS[kind].safeParse(raw);
  if (!r.success) {
    throw new AppError('NP-VAL-0001', { kind }, { fields: r.error.issues.map((i) => ({ path: `payload.${i.path.join('.')}`, message: i.message })) });
  }
  return r.data as Record<string, unknown>;
}

/** Explicit setting at a node from snapshot rows (undefined = inherit). */
function explicitAt<T extends { nodeId: string }>(list: T[], nodeId: string, match: (r: T) => boolean): T | undefined {
  return list.find((r) => r.nodeId === nodeId && match(r));
}

/**
 * Validates a proposal against current state. `db` is used for checks that
 * need fresh data (users, assignments, kill switches). Throws catalogue errors.
 */
export async function validateChange(db: pg.PoolClient, state: PolicyState, kind: ChangeKind, nodeId: string, rawPayload: unknown): Promise<ValidatedChange> {
  const node = state.nodes.get(nodeId);
  if (!node || !node.active) throw new AppError('NP-SCOPE-0001', { nodeId });
  const payload = parsePayload(kind, rawPayload);
  const { rows, snapshot } = state;
  let targetKey: string = kind;
  let subjectUserId: string | null = null;

  switch (kind) {
    case 'MODULE_SETTING': {
      const p = payload as z.infer<typeof PAYLOADS.MODULE_SETTING>;
      const m = snapshot.modules.get(p.moduleId);
      if (!m) throw new AppError('NP-CR-0007', { moduleId: p.moduleId });
      if (m.invariant && p.state === 'DISABLED') throw new AppError('NP-CR-0006', { moduleId: p.moduleId });
      const cur = explicitAt(rows.moduleSettings, nodeId, (r) => r.moduleId === p.moduleId)?.state ?? 'INHERIT';
      if (cur === p.state) throw new AppError('NP-CR-0005', { current: cur });
      targetKey = `MODULE_SETTING:${p.moduleId}`;
      break;
    }
    case 'FEATURE_SETTING': {
      const p = payload as z.infer<typeof PAYLOADS.FEATURE_SETTING>;
      const f = snapshot.features.get(p.featureCode);
      if (!f) throw new AppError('NP-CR-0007', { featureCode: p.featureCode });
      if (f.feature.invariant && p.state === 'DISABLED') throw new AppError('NP-CR-0006', { featureCode: p.featureCode });
      const cur = explicitAt(rows.featureSettings, nodeId, (r) => r.featureCode === p.featureCode)?.state ?? 'INHERIT';
      if (cur === p.state) throw new AppError('NP-CR-0005', { current: cur });
      targetKey = `FEATURE_SETTING:${p.featureCode}`;
      break;
    }
    case 'REALM_SETTING': {
      const p = payload as z.infer<typeof PAYLOADS.REALM_SETTING>;
      const cur = explicitAt(rows.realmSettings, nodeId, (r) => r.realm === p.realm)?.state ?? 'INHERIT';
      if (cur === p.state) throw new AppError('NP-CR-0005', { current: cur });
      targetKey = `REALM_SETTING:${p.realm}`;
      break;
    }
    case 'PERMISSION': {
      const p = payload as z.infer<typeof PAYLOADS.PERMISSION>;
      const f = snapshot.features.get(p.featureCode);
      if (!f) throw new AppError('NP-CR-0007', { featureCode: p.featureCode });
      // Governance permissions are fixed in code so nobody can vote the governors out of governing.
      if (f.module.invariant && f.module.realm === 'GOVERNANCE') throw new AppError('NP-CR-0006', { featureCode: p.featureCode });
      if (!getRole(p.role)) throw new AppError('NP-VAL-0001', {}, { fields: [{ path: 'payload.role', message: 'unknown role' }] });
      if (p.actions) {
        for (const a of p.actions) {
          if (!f.feature.actions.includes(a)) {
            throw new AppError('NP-VAL-0001', {}, { fields: [{ path: 'payload.actions', message: `${a} is not an action of ${p.featureCode}` }] });
          }
        }
        p.actions = [...new Set(p.actions)].sort() as Action[];
      }
      const cur = explicitAt(rows.permissions, nodeId, (r) => r.featureCode === p.featureCode && r.role === p.role);
      const same = p.actions === null ? cur === undefined : cur !== undefined && [...cur.actions].sort().join(',') === p.actions.join(',');
      if (same) throw new AppError('NP-CR-0005', {});
      targetKey = `PERMISSION:${p.featureCode}:${p.role}`;
      break;
    }
    case 'ROLE_GRANT': {
      const p = payload as z.infer<typeof PAYLOADS.ROLE_GRANT>;
      const role = getRole(p.role);
      if (!role || !role.staff) throw new AppError('NP-SCOPE-0002', { role: p.role, reason: 'unknown or not a staff role' });
      if (!role.levels.includes(node.level)) throw new AppError('NP-SCOPE-0002', { role: p.role, level: node.level });
      const u = await db.query('SELECT 1 FROM iam.users WHERE id = $1', [p.userId]);
      if (!u.rowCount) throw new AppError('NP-USER-0002', { userId: p.userId });
      const dup = await db.query('SELECT 1 FROM iam.role_assignments WHERE user_id = $1 AND role = $2 AND node_id = $3 AND revoked_at IS NULL', [p.userId, p.role, nodeId]);
      if (dup.rowCount) throw new AppError('NP-CR-0005', { reason: 'already assigned' });
      subjectUserId = p.userId;
      targetKey = `ROLE:${p.userId}:${p.role}`;
      break;
    }
    case 'ROLE_REVOKE': {
      const p = payload as z.infer<typeof PAYLOADS.ROLE_REVOKE>;
      const r = await db.query<{ user_id: string; role: string; node_id: string; revoked_at: Date | null }>(
        'SELECT user_id, role, node_id, revoked_at FROM iam.role_assignments WHERE id = $1',
        [p.assignmentId]
      );
      const a = r.rows[0];
      if (!a || a.revoked_at) throw new AppError('NP-CR-0005', { reason: 'assignment not active' });
      // The request must be raised at the node where the role was granted.
      if (a.node_id !== nodeId) throw new AppError('NP-VAL-0001', {}, { fields: [{ path: 'nodeId', message: `assignment belongs to ${a.node_id}` }] });
      subjectUserId = a.user_id;
      targetKey = `ROLE:${a.user_id}:${a.role}`;
      break;
    }
    case 'KILL_SWITCH_RATIFY': {
      const p = payload as z.infer<typeof PAYLOADS.KILL_SWITCH_RATIFY>;
      const r = await db.query<{ node_id: string; module_id: string }>(
        'SELECT node_id, module_id FROM platform.kill_switches WHERE id = $1 AND cleared_at IS NULL AND expires_at > now()',
        [p.killSwitchId]
      );
      const k = r.rows[0];
      if (!k) throw new AppError('NP-KILL-0003', { killSwitchId: p.killSwitchId });
      if (k.node_id !== nodeId) throw new AppError('NP-VAL-0001', {}, { fields: [{ path: 'nodeId', message: `kill switch belongs to ${k.node_id}` }] });
      targetKey = `MODULE_SETTING:${k.module_id}`;
      break;
    }
    case 'QUORUM_CONFIG': {
      const p = payload as z.infer<typeof PAYLOADS.QUORUM_CONFIG>;
      // Quorum rules apply platform-wide, so only the root of the tree may change them.
      if (node.parentId !== null) throw new AppError('NP-POL-0001', { reason: 'quorum changes only at the root node' });
      const r = await db.query<{ required: number }>('SELECT required FROM platform.quorum_config WHERE level = $1', [p.level]);
      if (r.rows[0]?.required === p.required) throw new AppError('NP-CR-0005', {});
      targetKey = `QUORUM_CONFIG:${p.level}`;
      break;
    }
    case 'USER_ENABLE':
    case 'USER_DISABLE':
    case 'USER_RESET_CREDENTIALS': {
      const p = payload as { userId: string };
      const u = await db.query<{ status: string }>('SELECT status FROM iam.users WHERE id = $1', [p.userId]);
      if (!u.rows[0]) throw new AppError('NP-USER-0002', { userId: p.userId });
      if (kind === 'USER_ENABLE' && u.rows[0].status === 'ACTIVE') throw new AppError('NP-CR-0005', { reason: 'already active' });
      if (kind === 'USER_DISABLE' && u.rows[0].status === 'DISABLED') throw new AppError('NP-CR-0005', { reason: 'already disabled' });
      // Every active role of the subject must sit inside the request node's subtree.
      const ra = await db.query<{ path: string }>(
        `SELECT n.path::text AS path FROM iam.role_assignments ra JOIN platform.scope_nodes n ON n.id = ra.node_id
          WHERE ra.user_id = $1 AND ra.revoked_at IS NULL`,
        [p.userId]
      );
      for (const r of ra.rows) {
        if (!isAncestorOrSelf(node.path, r.path.split('.'))) throw new AppError('NP-POL-0001', { reason: 'subject has a role outside this node' });
      }
      subjectUserId = p.userId;
      targetKey = `USER:${p.userId}`;
      break;
    }
  }
  return { kind, nodeId, payload, targetKey, subjectUserId };
}

/** Returns snapshot rows with the proposed change applied (for impact preview). */
export function rowsWithChange(rows: SnapshotRows, ch: ValidatedChange, killSwitchModuleId?: string): SnapshotRows {
  const next: SnapshotRows = {
    ...rows,
    moduleSettings: [...rows.moduleSettings],
    featureSettings: [...rows.featureSettings],
    realmSettings: [...rows.realmSettings],
    permissions: [...rows.permissions]
  };
  const n = ch.nodeId;
  const p = ch.payload as Record<string, string>;
  if (ch.kind === 'MODULE_SETTING' || (ch.kind === 'KILL_SWITCH_RATIFY' && killSwitchModuleId)) {
    const moduleId = ch.kind === 'MODULE_SETTING' ? p.moduleId! : killSwitchModuleId!;
    const state = ch.kind === 'MODULE_SETTING' ? p.state! : 'DISABLED';
    next.moduleSettings = next.moduleSettings.filter((r) => !(r.nodeId === n && r.moduleId === moduleId));
    if (state !== 'INHERIT') next.moduleSettings.push({ nodeId: n, moduleId, state: state as 'ENABLED' | 'DISABLED' });
  } else if (ch.kind === 'FEATURE_SETTING') {
    next.featureSettings = next.featureSettings.filter((r) => !(r.nodeId === n && r.featureCode === p.featureCode));
    if (p.state !== 'INHERIT') next.featureSettings.push({ nodeId: n, featureCode: p.featureCode!, state: p.state as 'ENABLED' | 'DISABLED' });
  } else if (ch.kind === 'REALM_SETTING') {
    next.realmSettings = next.realmSettings.filter((r) => !(r.nodeId === n && r.realm === p.realm));
    if (p.state !== 'INHERIT') next.realmSettings.push({ nodeId: n, realm: p.realm as 'GOVERNMENT', state: p.state as 'ENABLED' | 'DISABLED' });
  }
  return next;
}

/** One line of the impact preview. */
export interface ImpactLine {
  featureCode: string;
  /** Availability before → after. */
  from: boolean;
  to: boolean;
  /** Number of jurisdiction nodes whose availability changes. */
  nodes: number;
  /** Up to five example node ids. */
  sample: string[];
}

/**
 * Impact preview. For availability changes: which features change at how many
 * nodes in the subtree (capped at 5,000 nodes; `truncated` says if the cap hit).
 * For permission changes: the role's actions before and after at the node.
 */
export function computeImpact(state: PolicyState, ch: ValidatedChange, subtree: string[], truncated: boolean, killSwitchModuleId?: string): Record<string, unknown> {
  if (ch.kind === 'PERMISSION') {
    const p = ch.payload as z.infer<typeof PAYLOADS.PERMISSION>;
    const f = state.snapshot.features.get(p.featureCode)!;
    const path = state.nodes.get(ch.nodeId)!.path;
    const before = grantedActions(state.snapshot, f.feature, p.role, path);
    const afterRows = { ...state.rows, permissions: state.rows.permissions.filter((r) => !(r.nodeId === ch.nodeId && r.featureCode === p.featureCode && r.role === p.role)) };
    if (p.actions) afterRows.permissions.push({ nodeId: ch.nodeId, featureCode: p.featureCode, role: p.role, actions: p.actions });
    const after = grantedActions(buildSnapshot(afterRows), f.feature, p.role, path);
    return { type: 'permission', role: p.role, featureCode: p.featureCode, before: before.actions, after: after.actions, appliesToSubtree: true };
  }
  if (!['MODULE_SETTING', 'FEATURE_SETTING', 'REALM_SETTING', 'KILL_SWITCH_RATIFY'].includes(ch.kind)) {
    return { type: 'account', note: 'affects one account; no availability change' };
  }
  const after = buildSnapshot(rowsWithChange(state.rows, ch, killSwitchModuleId));
  const now = new Date();
  const lines = new Map<string, ImpactLine>();
  for (const nodeId of subtree) {
    const path = state.nodes.get(nodeId)!.path;
    for (const code of state.snapshot.features.keys()) {
      const b = featureAvailability(state.snapshot, code, path, now);
      const a = featureAvailability(after, code, path, now);
      if (a === b) continue;
      const key = `${code}:${b}:${a}`;
      const line = lines.get(key) ?? { featureCode: code, from: b, to: a, nodes: 0, sample: [] };
      line.nodes += 1;
      if (line.sample.length < 5) line.sample.push(nodeId);
      lines.set(key, line);
    }
  }
  return { type: 'availability', lines: [...lines.values()], nodesChecked: subtree.length, truncated };
}

/** Result of applying a change; `oneTimePassword` only for credential resets. */
export interface ApplyResult {
  oneTimePassword?: string;
}

/**
 * Applies an approved change inside the caller's platform transaction.
 * `finalApproverId` is recorded as the actor for revocations.
 */
export async function applyChange(
  c: pg.PoolClient,
  cr: { id: string; kind: ChangeKind; node_id: string; payload: Record<string, unknown>; proposed_by: string },
  finalApproverId: string,
  ip: string | null
): Promise<ApplyResult> {
  const p = cr.payload as Record<string, string>;
  const n = cr.node_id;
  switch (cr.kind) {
    case 'MODULE_SETTING':
      if (p.state === 'INHERIT') await c.query('DELETE FROM platform.module_settings WHERE node_id = $1 AND module_id = $2', [n, p.moduleId]);
      else
        await c.query(
          `INSERT INTO platform.module_settings (node_id, module_id, state, change_request_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (node_id, module_id) DO UPDATE SET state = EXCLUDED.state, change_request_id = EXCLUDED.change_request_id, updated_at = now()`,
          [n, p.moduleId, p.state, cr.id]
        );
      return {};
    case 'FEATURE_SETTING':
      if (p.state === 'INHERIT') await c.query('DELETE FROM platform.feature_settings WHERE node_id = $1 AND feature_code = $2', [n, p.featureCode]);
      else
        await c.query(
          `INSERT INTO platform.feature_settings (node_id, feature_code, state, change_request_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (node_id, feature_code) DO UPDATE SET state = EXCLUDED.state, change_request_id = EXCLUDED.change_request_id, updated_at = now()`,
          [n, p.featureCode, p.state, cr.id]
        );
      return {};
    case 'REALM_SETTING':
      if (p.state === 'INHERIT') await c.query('DELETE FROM platform.realm_settings WHERE node_id = $1 AND realm = $2', [n, p.realm]);
      else
        await c.query(
          `INSERT INTO platform.realm_settings (node_id, realm, state, change_request_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (node_id, realm) DO UPDATE SET state = EXCLUDED.state, change_request_id = EXCLUDED.change_request_id, updated_at = now()`,
          [n, p.realm, p.state, cr.id]
        );
      return {};
    case 'PERMISSION': {
      const actions = (cr.payload as { actions: Action[] | null }).actions;
      if (actions === null) await c.query('DELETE FROM platform.permissions WHERE node_id = $1 AND feature_code = $2 AND role = $3', [n, p.featureCode, p.role]);
      else
        await c.query(
          `INSERT INTO platform.permissions (node_id, feature_code, role, actions, change_request_id) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (node_id, feature_code, role) DO UPDATE SET actions = EXCLUDED.actions, change_request_id = EXCLUDED.change_request_id, updated_at = now()`,
          [n, p.featureCode, p.role, actions, cr.id]
        );
      return {};
    }
    case 'ROLE_GRANT':
      await c.query(
        `INSERT INTO iam.role_assignments (user_id, role, node_id, granted_by, change_request_id) VALUES ($1, $2, $3, $4, $5)`,
        [p.userId, p.role, n, cr.proposed_by, cr.id]
      );
      return {};
    case 'ROLE_REVOKE': {
      const r = await c.query(`UPDATE iam.role_assignments SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL`, [p.assignmentId, finalApproverId]);
      if (r.rowCount !== 1) throw new AppError('NP-CR-0008', { reason: 'assignment no longer active' });
      return {};
    }
    case 'KILL_SWITCH_RATIFY': {
      const k = await c.query<{ module_id: string }>(
        `UPDATE platform.kill_switches SET cleared_at = now(), cleared_by = $2, ratified_by_cr = $3
          WHERE id = $1 AND cleared_at IS NULL AND expires_at > now() RETURNING module_id`,
        [p.killSwitchId, finalApproverId, cr.id]
      );
      if (!k.rows[0]) throw new AppError('NP-CR-0008', { reason: 'kill switch expired or cleared before ratification' });
      // Ratification turns the temporary stop into a normal DISABLED setting at the node.
      await c.query(
        `INSERT INTO platform.module_settings (node_id, module_id, state, change_request_id) VALUES ($1, $2, 'DISABLED', $3)
         ON CONFLICT (node_id, module_id) DO UPDATE SET state = 'DISABLED', change_request_id = EXCLUDED.change_request_id, updated_at = now()`,
        [n, k.rows[0].module_id, cr.id]
      );
      return {};
    }
    case 'QUORUM_CONFIG':
      await c.query('UPDATE platform.quorum_config SET required = $2 WHERE level = $1', [p.level, (cr.payload as { required: number }).required]);
      return {};
    case 'USER_ENABLE':
      await c.query(`UPDATE iam.users SET status = 'ACTIVE', failed_logins = 0, locked_until = NULL WHERE id = $1`, [p.userId]);
      await writeAudit(c, 'iam', { action: 'iam.user.enabled', actorId: finalApproverId, ip, targetType: 'user', targetId: p.userId!, detail: { changeRequestId: cr.id } });
      return {};
    case 'USER_DISABLE': {
      await c.query(`UPDATE iam.users SET status = 'DISABLED' WHERE id = $1`, [p.userId]);
      // Signing out everywhere is part of disabling.
      await c.query(`UPDATE iam.sessions SET revoked_at = now(), revoke_reason = 'account_disabled' WHERE user_id = $1 AND revoked_at IS NULL`, [p.userId]);
      await writeAudit(c, 'iam', { action: 'iam.user.disabled', actorId: finalApproverId, ip, targetType: 'user', targetId: p.userId!, detail: { changeRequestId: cr.id } });
      return {};
    }
    case 'USER_RESET_CREDENTIALS': {
      const oneTimePassword = generateOneTimePassword();
      await c.query(
        `UPDATE iam.users SET password_hash = $2, password_changed_at = now(), must_change_password = true,
                totp_secret_enc = NULL, totp_enrolled_at = NULL, totp_last_step = NULL, failed_logins = 0, locked_until = NULL
          WHERE id = $1`,
        [p.userId, await hashPassword(oneTimePassword)]
      );
      // Any existing session of the account is no longer trustworthy.
      await c.query(`UPDATE iam.sessions SET revoked_at = now(), revoke_reason = 'credentials_reset' WHERE user_id = $1 AND revoked_at IS NULL`, [p.userId]);
      await writeAudit(c, 'iam', { action: 'iam.user.credentials_reset', actorId: finalApproverId, ip, targetType: 'user', targetId: p.userId!, detail: { changeRequestId: cr.id } });
      return { oneTimePassword };
    }
  }
}
