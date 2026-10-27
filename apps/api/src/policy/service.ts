/**
 * Policy service: keeps an in-memory snapshot of all Lego settings and the
 * scope tree, and answers decisions with the pure resolver from @np/policy.
 *
 * Freshness:
 *   - A dedicated connection LISTENs on "policy_changed" (sent by triggers on
 *     every settings table) and reloads within ~100 ms of a commit.
 *   - A full reload also runs every 60 s as a safety net, in case a
 *     notification is lost while the listener reconnects.
 *   - If no snapshot has ever loaded, every protected request fails closed
 *     with NP-POL-0003 (never "allow because we don't know").
 */
import pg from 'pg';
import type { Logger } from 'pino';
import { buildSnapshot, decide, type PolicyResult, type PolicySnapshot, type Principal, type SnapshotRows, type Toggle } from '@np/policy';
import type { Action, ModuleManifest, Realm, ScopeLevel } from '@np/shared';
import { AppError } from '../core/errors.js';
import type { AuthContext } from '../iam/sessions.js';

/** Cached scope node. */
export interface CachedNode {
  id: string;
  parentId: string | null;
  level: ScopeLevel;
  lgdCode: string | null;
  nameEn: string;
  nameHi: string;
  path: string[];
  active: boolean;
}

/** Everything loaded from the database in one consistent read. */
export interface PolicyState {
  rows: SnapshotRows;
  snapshot: PolicySnapshot;
  nodes: Map<string, CachedNode>;
  /** Children index for tree queries. */
  children: Map<string, string[]>;
  loadedAt: Date;
}

export class PolicyService {
  private state: PolicyState | undefined;
  private listener: pg.Client | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private intervalTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private reloading: Promise<void> | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly listenUrl: string,
    private readonly log: Logger
  ) {}

  /** Loads the first snapshot and starts LISTEN + periodic refresh. */
  async start(): Promise<void> {
    await this.reload('startup');
    await this.listen();
    this.intervalTimer = setInterval(() => void this.reload('interval'), 60_000);
    this.intervalTimer.unref();
  }

  /** Stops listening and timers (graceful shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.intervalTimer);
    clearTimeout(this.reloadTimer);
    await this.listener?.end().catch(() => undefined);
  }

  /** Current state, or NP-POL-0003 if none has loaded yet. */
  current(): PolicyState {
    if (!this.state) throw new AppError('NP-POL-0003', { reason: 'policy snapshot not loaded' });
    return this.state;
  }

  /** Opens the LISTEN connection; on error, reconnects with backoff. */
  private async listen(attempt = 0): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.listenUrl, application_name: 'np-api-policy-listen' });
    client.on('notification', () => this.scheduleReload());
    client.on('error', (err) => {
      this.log.error({ err, errCode: 'NP-POL-0003' }, 'policy listener connection error; reconnecting');
      void client.end().catch(() => undefined);
      this.listener = undefined;
      // Exponential backoff capped at 30 s; reload after reconnecting to catch missed changes.
      const delay = Math.min(30_000, 500 * 2 ** attempt);
      setTimeout(() => void this.listen(attempt + 1).then(() => this.reload('reconnect')), delay).unref();
    });
    try {
      await client.connect();
      await client.query('LISTEN policy_changed');
      this.listener = client;
      if (attempt > 0) this.log.info({ attempt }, 'policy listener reconnected');
    } catch (err) {
      this.log.error({ err, errCode: 'NP-POL-0003', attempt }, 'policy listener could not connect');
      await client.end().catch(() => undefined);
      const delay = Math.min(30_000, 500 * 2 ** attempt);
      setTimeout(() => void this.listen(attempt + 1), delay).unref();
    }
  }

  /** Coalesces bursts of notifications into one reload. */
  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload('notify'), 100);
  }

  /**
   * Reloads everything in a single REPEATABLE READ transaction so the snapshot
   * is internally consistent. Concurrent calls share one in-flight reload.
   */
  async reload(reason: string): Promise<void> {
    if (this.reloading) return this.reloading;
    this.reloading = (async () => {
      const started = Date.now();
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const mods = await client.query<{ manifest: ModuleManifest }>('SELECT manifest FROM platform.modules');
        const ms = await client.query<{ node_id: string; module_id: string; state: Toggle }>('SELECT node_id, module_id, state FROM platform.module_settings');
        const fs = await client.query<{ node_id: string; feature_code: string; state: Toggle }>('SELECT node_id, feature_code, state FROM platform.feature_settings');
        const rs = await client.query<{ node_id: string; realm: Realm; state: Toggle }>('SELECT node_id, realm, state FROM platform.realm_settings');
        const ps = await client.query<{ node_id: string; feature_code: string; role: string; actions: Action[] }>(
          'SELECT node_id, feature_code, role, actions FROM platform.permissions'
        );
        const ks = await client.query<{ module_id: string; path: string; expires_at: Date }>(
          `SELECT k.module_id, n.path::text AS path, k.expires_at
             FROM platform.kill_switches k JOIN platform.scope_nodes n ON n.id = k.node_id
            WHERE k.cleared_at IS NULL AND k.expires_at > now()`
        );
        const ns = await client.query<{
          id: string; parent_id: string | null; level: ScopeLevel; lgd_code: string | null; name_en: string; name_hi: string; path: string; active: boolean;
        }>('SELECT id, parent_id, level, lgd_code, name_en, name_hi, path::text AS path, active FROM platform.scope_nodes');
        await client.query('COMMIT');

        const rows: SnapshotRows = {
          manifests: mods.rows.map((r) => r.manifest),
          moduleSettings: ms.rows.map((r) => ({ nodeId: r.node_id, moduleId: r.module_id, state: r.state })),
          featureSettings: fs.rows.map((r) => ({ nodeId: r.node_id, featureCode: r.feature_code, state: r.state })),
          realmSettings: rs.rows.map((r) => ({ nodeId: r.node_id, realm: r.realm, state: r.state })),
          permissions: ps.rows.map((r) => ({ nodeId: r.node_id, featureCode: r.feature_code, role: r.role, actions: r.actions })),
          killSwitches: ks.rows.map((r) => ({ moduleId: r.module_id, path: r.path.split('.'), expiresAt: r.expires_at }))
        };
        const nodes = new Map<string, CachedNode>();
        const children = new Map<string, string[]>();
        for (const n of ns.rows) {
          nodes.set(n.id, {
            id: n.id, parentId: n.parent_id, level: n.level, lgdCode: n.lgd_code, nameEn: n.name_en, nameHi: n.name_hi, path: n.path.split('.'), active: n.active
          });
          if (n.parent_id) {
            const list = children.get(n.parent_id) ?? [];
            list.push(n.id);
            children.set(n.parent_id, list);
          }
        }
        this.state = { rows, snapshot: buildSnapshot(rows), nodes, children, loadedAt: new Date() };
        this.log.debug({ reason, ms: Date.now() - started, nodes: nodes.size, modules: rows.manifests.length }, 'policy snapshot loaded');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        // Keep serving the previous snapshot; log loudly. Startup failure propagates.
        this.log.error({ err, reason, errCode: 'NP-POL-0003' }, 'policy snapshot reload failed');
        if (!this.state) throw new AppError('NP-POL-0003', { reason: 'initial load failed' }, { cause: err });
      } finally {
        client.release();
        this.reloading = undefined;
      }
    })();
    return this.reloading;
  }

  /** Path for a node id, or NP-SCOPE-0001 if the node is unknown. */
  pathOf(nodeId: string): string[] {
    const n = this.current().nodes.get(nodeId);
    if (!n) throw new AppError('NP-SCOPE-0001', { nodeId });
    return n.path;
  }

  /** Converts a session into a resolver principal. */
  principalOf(auth: AuthContext): Principal {
    return {
      userId: auth.userId,
      mfaVerified: auth.mfaVerified,
      assignments: auth.assignments.map((a) => ({ role: a.role, path: a.path }))
    };
  }

  /** Full decision for a session at a node. */
  decide(auth: AuthContext, featureCode: string, action: Action, nodeId: string): PolicyResult {
    return decide(this.principalOf(auth), featureCode, action, this.pathOf(nodeId), this.current().snapshot);
  }

  /** Node ids in the subtree of `rootId` (breadth-first, including the root), capped at `limit`. */
  subtree(rootId: string, limit: number): string[] {
    const st = this.current();
    const out: string[] = [];
    const queue = [rootId];
    // Read pointer instead of shift() keeps the walk O(n).
    let head = 0;
    while (head < queue.length && out.length < limit) {
      const id = queue[head++]!;
      out.push(id);
      queue.push(...(st.children.get(id) ?? []));
    }
    return out;
  }
}
