/**
 * E2E environment: fresh database, real per-module login roles, bootstrap via
 * the production CLI, API + worker + `vite preview` as child processes.
 * Child process output goes to e2e/.tmp/*.log for debugging failures.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const apiDist = path.join(root, 'apps/api/dist');
export const TMP = path.join(here, '.tmp');
const DB = 'np_e2e';

/** Waits until `url` answers 200 or the timeout expires. */
async function waitFor(url: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}`);
}

export default async function globalSetup(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL (superuser on a disposable server) is required for e2e');
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  // 1. Fresh database and login roles.
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  const pw = randomBytes(12).toString('hex');
  const roles = { platform: 'np_platform_rw', iam: 'np_iam_rw', audit: 'np_audit_reader', relay: 'np_audit_relay' } as const;
  const owner = new URL(adminUrl);
  owner.pathname = `/${DB}`;
  const env = { ...process.env, MIGRATION_DATABASE_URL: owner.toString(), LOG_LEVEL: 'info' };
  execFileSync('node', [path.join(apiDist, 'scripts/migrate.js')], { env, stdio: 'inherit' });
  const urls: Record<string, string> = {};
  for (const [name, group] of Object.entries(roles)) {
    await admin.query(`DROP ROLE IF EXISTS np_e2e_${name}`);
    await admin.query(`CREATE ROLE np_e2e_${name} LOGIN PASSWORD '${pw}' IN ROLE ${group}`);
    const u = new URL(owner.toString());
    u.username = `np_e2e_${name}`;
    u.password = pw;
    urls[name] = u.toString();
  }
  await admin.end();

  // 2. A switchable demo module, present only in this test database (not in product code).
  const o = new pg.Client({ connectionString: owner.toString() });
  await o.connect();
  await o.query(`INSERT INTO platform.modules (id, version, manifest) VALUES ('demo', '1.0.0', $1)`, [
    {
      id: 'demo', version: '1.0.0', name: { en: 'Demo services', hi: 'डेमो सेवाएँ' }, realm: 'GOVERNMENT', invariant: false, defaultEnabled: true, requires: [],
      features: [{ code: 'demo.items', name: { en: 'Items', hi: 'वस्तुएँ' }, actions: ['view'], invariant: false, auditedActions: [], defaultGrants: { OBSERVER: ['view'] } }]
    }
  ]);
  await o.end();

  // 3. Bootstrap through the production CLI; capture the one-time passwords it prints.
  const out = execFileSync(
    'node',
    [path.join(apiDist, 'scripts/bootstrap.js'), '--district', path.join(root, 'districts/UP-144/district.json'),
      '--user', 'gov1|Asha Verma|REALM_GOVERNOR|D144', '--user', 'gov2|Ravi Kumar|REALM_GOVERNOR|D144', '--user', 'sre1|Ops Team|PLATFORM_OPERATOR|D144'],
    { env }
  ).toString();
  const otps: Record<string, string> = {};
  for (const m of out.matchAll(/^\s+(\S+)\s+(\S{20})\s/gm)) otps[m[1]!] = m[2]!;
  if (Object.keys(otps).length !== 3) throw new Error(`bootstrap output not understood:\n${out}`);

  // 4. Audit signing key (private key in the temp dir only).
  const keyFile = path.join(TMP, 'audit.pem');
  execFileSync('node', [path.join(apiDist, 'scripts/audit-key.js'), 'generate', keyFile], { env });

  // 5. Start API, worker and the web preview.
  const common = {
    ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'debug', PORT: '8080', PUBLIC_ORIGIN: 'http://localhost:4173', COOKIE_SECURE: 'false',
    FIELD_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`, FIELD_ENCRYPTION_ACTIVE_KEY: 'v1',
    DATABASE_URL_PLATFORM: urls.platform, DATABASE_URL_IAM: urls.iam, DATABASE_URL_AUDIT: urls.audit, DATABASE_URL_AUDIT_RELAY: urls.relay,
    AUDIT_SIGNING_KEY_FILE: keyFile, CHECKPOINT_MIN_ROWS: '1', CHECKPOINT_TICK_MS: '2000', CHECKPOINT_MAX_AGE_MS: '10000', RELAY_INTERVAL_MS: '300'
  };
  const start = (name: string, cmd: string, args: string[], cwd: string) => {
    const log = openSync(path.join(TMP, `${name}.log`), 'a');
    const p = spawn(cmd, args, { cwd, env: common, stdio: ['ignore', log, log], detached: true });
    p.unref();
    return p.pid!;
  };
  const pids = [
    start('api', 'node', [path.join(apiDist, 'server.js')], root),
    start('worker', 'node', [path.join(apiDist, 'worker/main.js')], root),
    start('web', 'pnpm', ['exec', 'vite', 'preview'], path.resolve(here, '..'))
  ];
  writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({ pids, otps, adminUrl, db: DB }));
  await waitFor('http://127.0.0.1:8080/readyz');
  await waitFor('http://localhost:4173/');
}
