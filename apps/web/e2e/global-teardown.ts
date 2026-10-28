/** Stops the processes started by global-setup and drops the test database and roles. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export default async function globalTeardown(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const state = JSON.parse(readFileSync(path.join(here, '.tmp/state.json'), 'utf8')) as { pids: number[]; adminUrl: string; db: string };
  for (const pid of state.pids) {
    try {
      // Negative pid kills the whole process group (detached children).
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (process.env.KEEP_E2E_DB) return;
  const admin = new pg.Client({ connectionString: state.adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${state.db} WITH (FORCE)`);
  for (const r of ['platform', 'iam', 'audit', 'relay', 'registry', 'citizen', 'org']) await admin.query(`DROP ROLE IF EXISTS np_e2e_${r}`);
  await admin.end();
}
