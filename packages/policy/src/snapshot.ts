import type { Action, ModuleManifest, Realm } from '@np/shared';
import type { KillSwitch, PolicySnapshot, Toggle } from './resolver.js';

export interface SnapshotRows {
  manifests: ModuleManifest[];
  moduleSettings: { nodeId: string; moduleId: string; state: Toggle }[];
  featureSettings: { nodeId: string; featureCode: string; state: Toggle }[];
  realmSettings: { nodeId: string; realm: Realm; state: Toggle }[];
  permissions: { nodeId: string; featureCode: string; role: string; actions: Action[] }[];
  killSwitches: KillSwitch[];
}

function nest<K, V>(rows: { nodeId: string; key: K; value: V }[]): Map<string, Map<K, V>> {
  const m = new Map<string, Map<K, V>>();
  for (const r of rows) {
    let inner = m.get(r.nodeId);
    if (!inner) m.set(r.nodeId, (inner = new Map()));
    inner.set(r.key, r.value);
  }
  return m;
}

/** Builds an immutable snapshot from database rows. */
export function buildSnapshot(rows: SnapshotRows): PolicySnapshot {
  const modules = new Map(rows.manifests.map((m) => [m.id, m]));
  const features = new Map<string, { module: ModuleManifest; feature: ModuleManifest['features'][number] }>();
  for (const m of rows.manifests) for (const f of m.features) features.set(f.code, { module: m, feature: f });

  const permissions = new Map<string, Map<string, Map<string, readonly Action[]>>>();
  for (const p of rows.permissions) {
    let byFeature = permissions.get(p.nodeId);
    if (!byFeature) permissions.set(p.nodeId, (byFeature = new Map()));
    let byRole = byFeature.get(p.featureCode);
    if (!byRole) byFeature.set(p.featureCode, (byRole = new Map()));
    byRole.set(p.role, Object.freeze([...p.actions]));
  }

  return {
    modules,
    features,
    moduleSettings: nest(rows.moduleSettings.map((r) => ({ nodeId: r.nodeId, key: r.moduleId, value: r.state }))),
    featureSettings: nest(rows.featureSettings.map((r) => ({ nodeId: r.nodeId, key: r.featureCode, value: r.state }))),
    realmSettings: nest(rows.realmSettings.map((r) => ({ nodeId: r.nodeId, key: r.realm, value: r.state }))),
    permissions,
    killSwitches: rows.killSwitches.map((k) => ({ ...k, path: [...k.path] }))
  };
}
