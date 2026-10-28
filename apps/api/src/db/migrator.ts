import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 815_204_771; // arbitrary constant; one migrator at a time across all replicas

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies db/migrations/NNNN_name.sql in order, one transaction each.
 * - Refuses to run if an already-applied file was edited (checksum mismatch).
 * - Refuses gaps or duplicate numbers.
 * - Serialised with an advisory lock so concurrent deploys cannot race.
 */
export async function migrate(client: pg.Client, dir: string, log: (m: string) => void = () => {}): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const numbers = new Set<string>();
  for (const f of files) {
    const m = FILE.exec(f);
    if (!m) throw new Error(`migration file name not allowed: ${f}`);
    if (numbers.has(m[1]!)) throw new Error(`duplicate migration number ${m[1]}`);
    numbers.add(m[1]!);
  }
  files.forEach((f, i) => {
    if (Number(f.slice(0, 4)) !== i + 1) throw new Error(`migration numbering has a gap at ${f}`);
  });

  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM public.schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const result: MigrationResult = { applied: [], skipped: [] };

    for (const f of files) {
      const sql = await readFile(path.join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.get(f);
      if (prior) {
        if (prior !== sum) throw new Error(`migration ${f} was modified after it was applied; add a new migration instead`);
        result.skipped.push(f);
        continue;
      }
      log(`applying ${f}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)', [f, sum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`, { cause: e });
      }
      result.applied.push(f);
    }
    for (const v of applied.keys()) {
      if (!files.includes(v)) throw new Error(`database has migration ${v} that is not in the repository`);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}
