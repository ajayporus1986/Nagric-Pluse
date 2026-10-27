import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../db/migrator.js';

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL (or DATABASE_URL) is required');
  process.exit(2);
}
const dir = process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');

const client = new pg.Client({ connectionString: url, application_name: 'np-migrate' });
await client.connect();
try {
  const r = await migrate(client, dir, (m) => console.warn(m));
  console.warn(`migrations: ${r.applied.length} applied, ${r.skipped.length} already present`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
