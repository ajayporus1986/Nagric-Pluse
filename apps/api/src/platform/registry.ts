/**
 * Module registration. On startup each API replica upserts the manifests it
 * was built with, so the registry always matches the deployed code. A newer
 * version never gets overwritten by an older replica during a rolling deploy.
 */
import type pg from 'pg';
import type { Logger } from 'pino';
import type { ModuleManifest } from '@np/shared';
import { withTx } from '../db/pools.js';
import { writeAudit } from '../audit/outbox.js';

/** Compares semantic versions "a.b.c". Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Upserts manifests; audits every registration or version change. */
export async function registerManifests(pool: pg.Pool, manifests: ModuleManifest[], log: Logger): Promise<void> {
  await withTx(pool, async (c) => {
    // Serialise registration across replicas starting at the same time.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('platform.modules.register'))`);
    for (const m of manifests) {
      const cur = await c.query<{ version: string }>('SELECT version FROM platform.modules WHERE id = $1', [m.id]);
      const existing = cur.rows[0]?.version;
      if (existing && compareVersions(existing, m.version) > 0) {
        log.warn({ moduleId: m.id, registered: existing, mine: m.version }, 'newer module version already registered; not downgrading');
        continue;
      }
      await c.query(
        `INSERT INTO platform.modules (id, version, manifest) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, manifest = EXCLUDED.manifest, updated_at = now()`,
        [m.id, m.version, m]
      );
      if (existing !== m.version) {
        await writeAudit(c, 'platform', { action: 'platform.module.registered', targetType: 'module', targetId: m.id, detail: { from: existing ?? null, to: m.version } });
        log.info({ moduleId: m.id, from: existing ?? null, to: m.version }, 'module registered');
      }
    }
  });
}
