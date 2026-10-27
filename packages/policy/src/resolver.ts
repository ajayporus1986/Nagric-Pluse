import {
  type Action,
  type Decision,
  type FeatureManifest,
  type ModuleManifest,
  type Realm,
  SWITCHABLE_REALMS,
  getRole,
  isAncestorOrSelf,
  mostPermissive,
  strictest
} from '@np/shared';

/** ENABLED / DISABLED set explicitly at a scope node. Absence means "inherit". */
export type Toggle = 'ENABLED' | 'DISABLED';

export interface KillSwitch {
  moduleId: string;
  /** Scope node path the switch applies to (subtree). */
  path: string[];
  expiresAt: Date;
}

/**
 * Immutable view of everything the resolver needs. Built by the API from the
 * platform schema and cached; rebuilt on LISTEN/NOTIFY.
 */
export interface PolicySnapshot {
  modules: ReadonlyMap<string, ModuleManifest>;
  features: ReadonlyMap<string, { module: ModuleManifest; feature: FeatureManifest }>;
  /** nodeId -> moduleId -> toggle */
  moduleSettings: ReadonlyMap<string, ReadonlyMap<string, Toggle>>;
  /** nodeId -> featureCode -> toggle */
  featureSettings: ReadonlyMap<string, ReadonlyMap<string, Toggle>>;
  /** nodeId -> realm -> toggle (only switchable realms are honoured) */
  realmSettings: ReadonlyMap<string, ReadonlyMap<Realm, Toggle>>;
  /** nodeId -> featureCode -> roleCode -> granted actions (empty = revoked). Replaces the manifest default. */
  permissions: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, readonly Action[]>>>;
  killSwitches: readonly KillSwitch[];
}

export interface RoleAssignment {
  role: string;
  /** Path of the scope node the role was granted at. */
  path: string[];
}

export interface Principal {
  userId: string;
  assignments: readonly RoleAssignment[];
  /** True once the session has passed the second factor. Staff roles without it grant nothing. */
  mfaVerified: boolean;
}

/** Election overlay hook (Phase 4). Returns ALLOW when no order applies. */
export type ElectionOverlay = (featureCode: string, action: Action, path: readonly string[], now: Date) => { decision: Decision; reason: string };
export const NO_ELECTION_OVERLAY: ElectionOverlay = () => ({ decision: 'ALLOW', reason: 'no election order in force' });

export interface TraceStep {
  step: string;
  decision: Decision;
  detail: string;
}

export interface PolicyResult {
  decision: Decision;
  available: boolean;
  trace: TraceStep[];
}

interface Ctx {
  snapshot: PolicySnapshot;
  now: Date;
  overlay: ElectionOverlay;
}

/**
 * Explicit toggle lookup along a path. A DISABLED anywhere on the path is a
 * ceiling for the whole subtree; otherwise any ENABLED switches it on; otherwise
 * the default applies.
 */
function toggleOnPath<K>(
  settings: ReadonlyMap<string, ReadonlyMap<K, Toggle>>,
  key: K,
  path: readonly string[],
  dflt: boolean
): { on: boolean; at: string | null; how: 'ceiling' | 'nearest' | 'default' } {
  let enabledAt: string | null = null;
  for (const nodeId of path) {
    const t = settings.get(nodeId)?.get(key);
    if (t === 'DISABLED') return { on: false, at: nodeId, how: 'ceiling' };
    if (t === 'ENABLED') enabledAt = nodeId;
  }
  if (enabledAt) return { on: true, at: enabledAt, how: 'nearest' };
  return { on: dflt, at: null, how: 'default' };
}

function realmOn(snapshot: PolicySnapshot, realm: Realm, path: readonly string[]): { on: boolean; at: string | null } {
  if (!(SWITCHABLE_REALMS as readonly string[]).includes(realm)) return { on: true, at: null };
  const r = toggleOnPath(snapshot.realmSettings, realm, path, true);
  return { on: r.on, at: r.at };
}

function activeKill(snapshot: PolicySnapshot, moduleId: string, path: readonly string[], now: Date): KillSwitch | undefined {
  return snapshot.killSwitches.find((k) => k.moduleId === moduleId && k.expiresAt > now && isAncestorOrSelf(k.path, path));
}

/** Availability of a module at a node, including its transitive requirements. */
function moduleAvailable(ctx: Ctx, moduleId: string, path: readonly string[], trace: TraceStep[], seen = new Set<string>()): boolean {
  if (seen.has(moduleId)) return true;
  seen.add(moduleId);
  const m = ctx.snapshot.modules.get(moduleId);
  if (!m) {
    trace.push({ step: 'module', decision: 'BLOCK', detail: `module ${moduleId} is not registered` });
    return false;
  }
  if (m.invariant) {
    trace.push({ step: 'module', decision: 'ALLOW', detail: `${moduleId} is an invariant module and always available` });
  } else {
    const t = toggleOnPath(ctx.snapshot.moduleSettings, moduleId, path, m.defaultEnabled);
    if (!t.on) {
      trace.push({
        step: 'module',
        decision: 'BLOCK',
        detail: t.how === 'ceiling' ? `${moduleId} disabled at ${t.at} (applies to the whole subtree)` : `${moduleId} is off by default and not enabled on this path`
      });
      return false;
    }
    trace.push({ step: 'module', decision: 'ALLOW', detail: t.at ? `${moduleId} enabled at ${t.at}` : `${moduleId} on by default` });
    const kill = activeKill(ctx.snapshot, moduleId, path, ctx.now);
    if (kill) {
      trace.push({ step: 'kill_switch', decision: 'BLOCK', detail: `${moduleId} kill switch at ${kill.path.at(-1)} until ${kill.expiresAt.toISOString()}` });
      return false;
    }
    const realm = realmOn(ctx.snapshot, m.realm, path);
    if (!realm.on) {
      trace.push({ step: 'realm', decision: 'BLOCK', detail: `realm ${m.realm} switched off at ${realm.at}` });
      return false;
    }
  }
  for (const req of m.requires) {
    if (!moduleAvailable(ctx, req, path, trace, seen)) {
      trace.push({ step: 'requires', decision: 'BLOCK', detail: `${moduleId} requires ${req}, which is unavailable here` });
      return false;
    }
  }
  return true;
}

/** Feature availability at a node (step 1–6 of the resolution order, excluding authorization). */
export function featureAvailability(
  snapshot: PolicySnapshot,
  featureCode: string,
  path: readonly string[],
  now: Date,
  trace: TraceStep[] = []
): boolean {
  const entry = snapshot.features.get(featureCode);
  if (!entry) {
    trace.push({ step: 'feature', decision: 'BLOCK', detail: `feature ${featureCode} is not registered` });
    return false;
  }
  const { module: m, feature: f } = entry;
  if (f.invariant) {
    // Invariants override availability only. Required modules of an invariant module are invariant too (validated at registration).
    trace.push({ step: 'invariant', decision: 'ALLOW', detail: `${featureCode} is invariant and always available` });
    return true;
  }
  const ctx: Ctx = { snapshot, now, overlay: NO_ELECTION_OVERLAY };
  if (!moduleAvailable(ctx, m.id, path, trace)) return false;
  const t = toggleOnPath(snapshot.featureSettings, featureCode, path, true);
  if (!t.on) {
    trace.push({ step: 'feature', decision: 'BLOCK', detail: `${featureCode} disabled at ${t.at}` });
    return false;
  }
  trace.push({ step: 'feature', decision: 'ALLOW', detail: t.at ? `${featureCode} enabled at ${t.at}` : `${featureCode} on (inherits module)` });
  return true;
}

/**
 * Actions a role holds on a feature at a target node: the override at the
 * nearest node on the target path wins over the manifest default.
 */
export function grantedActions(snapshot: PolicySnapshot, feature: FeatureManifest, role: string, targetPath: readonly string[]): { actions: readonly Action[]; source: string } {
  for (let i = targetPath.length - 1; i >= 0; i--) {
    const nodeId = targetPath[i]!;
    const acts = snapshot.permissions.get(nodeId)?.get(feature.code)?.get(role);
    if (acts) return { actions: acts, source: `override at ${nodeId}` };
  }
  return { actions: feature.defaultGrants[role] ?? [], source: 'manifest default' };
}

function authorize(snapshot: PolicySnapshot, principal: Principal, feature: FeatureManifest, action: Action, path: readonly string[], trace: TraceStep[]): Decision {
  const results: Decision[] = [];
  for (const a of principal.assignments) {
    const role = getRole(a.role);
    if (!role) continue;
    if (!isAncestorOrSelf(a.path, path)) continue;
    if (role.staff && !principal.mfaVerified) {
      trace.push({ step: 'authz', decision: 'BLOCK', detail: `${a.role}: second factor not verified` });
      continue;
    }
    const realm = realmOn(snapshot, role.realm, path);
    if (!realm.on) {
      trace.push({ step: 'authz', decision: 'BLOCK', detail: `${a.role}: realm ${role.realm} switched off at ${realm.at}` });
      continue;
    }
    const g = grantedActions(snapshot, feature, a.role, path);
    if (g.actions.includes(action)) {
      const d: Decision = feature.auditedActions.includes(action) ? 'ALLOW_AUDITED' : 'ALLOW';
      trace.push({ step: 'authz', decision: d, detail: `${a.role} at ${a.path.at(-1)} grants ${action} (${g.source})` });
      results.push(d);
    }
  }
  const d = mostPermissive(...results);
  if (results.length === 0) trace.push({ step: 'authz', decision: 'BLOCK', detail: `no role covering this scope grants ${action}` });
  return d;
}

/**
 * Full decision for a principal performing `action` on `featureCode` at the
 * scope node `targetPath`. Strictest of availability, authorization and the
 * election overlay wins. Default deny.
 */
export function decide(
  principal: Principal,
  featureCode: string,
  action: Action,
  targetPath: readonly string[],
  snapshot: PolicySnapshot,
  opts: { now?: Date; overlay?: ElectionOverlay } = {}
): PolicyResult {
  const now = opts.now ?? new Date();
  const overlay = opts.overlay ?? NO_ELECTION_OVERLAY;
  const trace: TraceStep[] = [];
  const entry = snapshot.features.get(featureCode);
  if (!entry) {
    trace.push({ step: 'feature', decision: 'BLOCK', detail: `feature ${featureCode} is not registered` });
    return { decision: 'BLOCK', available: false, trace };
  }
  if (!entry.feature.actions.includes(action)) {
    trace.push({ step: 'feature', decision: 'BLOCK', detail: `${featureCode} has no action ${action}` });
    return { decision: 'BLOCK', available: false, trace };
  }
  const available = featureAvailability(snapshot, featureCode, targetPath, now, trace);
  if (!available) return { decision: 'BLOCK', available, trace };
  const authz = authorize(snapshot, principal, entry.feature, action, targetPath, trace);
  const ov = overlay(featureCode, action, targetPath, now);
  trace.push({ step: 'election_overlay', decision: ov.decision, detail: ov.reason });
  // Invariants override availability only: an election order cannot take away an invariant feature.
  const overlayDecision = entry.feature.invariant ? 'ALLOW' : ov.decision;
  return { decision: strictest(authz, overlayDecision), available, trace };
}

/** Capability map for the UI: every available feature at the node with the actions this principal may take. */
export function capabilityMap(
  principal: Principal,
  targetPath: readonly string[],
  snapshot: PolicySnapshot,
  opts: { now?: Date; overlay?: ElectionOverlay } = {}
): Record<string, Partial<Record<Action, Decision>>> {
  const out: Record<string, Partial<Record<Action, Decision>>> = {};
  for (const [code, { feature }] of snapshot.features) {
    const actions: Partial<Record<Action, Decision>> = {};
    for (const a of feature.actions) {
      const r = decide(principal, code, a, targetPath, snapshot, opts);
      if (r.decision !== 'BLOCK') actions[a] = r.decision;
    }
    if (Object.keys(actions).length > 0) out[code] = actions;
  }
  return out;
}

export interface AvailabilityChange {
  path: string[];
  featureCode: string;
  before: boolean;
  after: boolean;
}

/**
 * Impact preview for a proposed change: compares feature availability under
 * the current and proposed snapshots at each of the given nodes.
 */
export function impactPreview(before: PolicySnapshot, after: PolicySnapshot, paths: readonly string[][], now = new Date()): AvailabilityChange[] {
  const changes: AvailabilityChange[] = [];
  const codes = new Set([...before.features.keys(), ...after.features.keys()]);
  for (const path of paths) {
    for (const code of codes) {
      const b = featureAvailability(before, code, path, now);
      const a = featureAvailability(after, code, path, now);
      if (a !== b) changes.push({ path: [...path], featureCode: code, before: b, after: a });
    }
  }
  return changes;
}
