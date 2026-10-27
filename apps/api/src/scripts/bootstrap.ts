/**
 * First-run bootstrap (server CLI only; there is no web path to do this).
 *
 *   node dist/scripts/bootstrap.js --district ../../districts/UP-144/district.json \
 *     --user "governor1|Asha Verma|REALM_GOVERNOR|D144" \
 *     --user "governor2|Ravi Kumar|REALM_GOVERNOR|D144" \
 *     --user "sre1|Ops Team|PLATFORM_OPERATOR|D144"
 *
 * - Imports the district package's jurisdiction nodes.
 * - Refuses to run if any active role assignment already exists (one-time only;
 *   afterwards every role grant goes through quorum change requests).
 * - Requires enough Realm Governors at each node to meet that node's quorum,
 *   otherwise no change request could ever pass.
 * - Prints one-time passwords ONCE to stdout. Users must change them and enrol
 *   an authenticator at first sign-in.
 *
 * Uses MIGRATION_DATABASE_URL (the schema owner), because it writes both the
 * platform and iam schemas.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { getRole } from '@np/shared';
import { createLogger } from '../core/logger.js';
import { writeAudit } from '../audit/outbox.js';
import { importNodes, readDistrictPackage } from '../platform/district-package.js';
import { generateOneTimePassword, hashPassword } from '../security/crypto.js';

const log = createLogger('bootstrap');

/** Parsed --user argument. */
interface UserSpec {
  username: string;
  displayName: string;
  roles: string[];
  nodeId: string;
}

/** Parses "username|Display Name|ROLE1,ROLE2|NODEID". */
function parseUser(s: string): UserSpec {
  const [username, displayName, roles, nodeId] = s.split('|').map((x) => x.trim());
  if (!username || !/^[a-zA-Z0-9._-]{3,64}$/.test(username)) throw new Error(`bad username in "${s}"`);
  if (!displayName) throw new Error(`missing display name in "${s}"`);
  if (!roles) throw new Error(`missing roles in "${s}"`);
  if (!nodeId) throw new Error(`missing node id in "${s}"`);
  return { username, displayName, roles: roles.split(',').map((r) => r.trim()), nodeId };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { district: { type: 'string' }, user: { type: 'string', multiple: true } } });
  if (!values.district || !values.user?.length) {
    console.error('usage: bootstrap --district <package.json> --user "username|Display Name|ROLE[,ROLE]|NODE" [--user ...]');
    process.exit(2);
  }
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');

  const pkg = await readDistrictPackage(values.district);
  const users = values.user.map(parseUser);
  const client = new pg.Client({ connectionString: url, application_name: 'np-bootstrap' });
  await client.connect();
  const created: { username: string; oneTimePassword: string; roles: string }[] = [];
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const c = client as unknown as pg.PoolClient;
    const inserted = await importNodes(c, pkg);
    log.info({ packageId: pkg.packageId, version: pkg.version, inserted }, 'district package nodes imported');

    const existing = await client.query('SELECT 1 FROM iam.role_assignments WHERE revoked_at IS NULL LIMIT 1');
    if (existing.rowCount) throw new Error('role assignments already exist; bootstrap is one-time only. Use change requests.');

    // Validate roles, levels and governor quorum before writing anything.
    const levelOf = new Map<string, string>();
    for (const n of (await client.query<{ id: string; level: string }>('SELECT id, level FROM platform.scope_nodes')).rows) levelOf.set(n.id, n.level);
    const governorsAt = new Map<string, number>();
    for (const u of users) {
      const level = levelOf.get(u.nodeId);
      if (!level) throw new Error(`unknown node ${u.nodeId} for ${u.username}`);
      for (const r of u.roles) {
        const role = getRole(r);
        if (!role || !role.staff) throw new Error(`unknown staff role ${r}`);
        if (!(role.levels as readonly string[]).includes(level)) throw new Error(`role ${r} cannot be assigned at ${level}`);
        if (r === 'REALM_GOVERNOR') governorsAt.set(u.nodeId, (governorsAt.get(u.nodeId) ?? 0) + 1);
      }
    }
    if (governorsAt.size === 0) throw new Error('at least one node needs Realm Governors');
    for (const [nodeId, n] of governorsAt) {
      const q = await client.query<{ required: number }>('SELECT required FROM platform.quorum_config WHERE level = $1', [levelOf.get(nodeId)]);
      const required = q.rows[0]?.required ?? 2;
      if (n < required) throw new Error(`node ${nodeId} has ${n} Realm Governor(s) but its quorum needs ${required}`);
    }

    for (const u of users) {
      const id = randomUUID();
      const oneTimePassword = generateOneTimePassword();
      await client.query(
        `INSERT INTO iam.users (id, username, display_name, password_hash, must_change_password, preferred_locale) VALUES ($1, $2, $3, $4, true, $5)`,
        [id, u.username, u.displayName, await hashPassword(oneTimePassword), pkg.defaultLocale]
      );
      await writeAudit(c, 'iam', { action: 'iam.bootstrap.user_created', targetType: 'user', targetId: id, detail: { username: u.username, packageId: pkg.packageId } });
      for (const r of u.roles) {
        await client.query('INSERT INTO iam.role_assignments (user_id, role, node_id) VALUES ($1, $2, $3)', [id, r, u.nodeId]);
        await writeAudit(c, 'iam', { action: 'iam.bootstrap.role_assigned', targetType: 'user', targetId: id, detail: { role: r, nodeId: u.nodeId } });
      }
      created.push({ username: u.username, oneTimePassword, roles: `${u.roles.join(',')}@${u.nodeId}` });
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
  log.info({ users: created.map((c) => c.username) }, 'bootstrap complete');
  // One-time passwords go to stdout only (not to the log stream).
  process.stdout.write('\nOne-time passwords (shown once; hand over securely):\n');
  for (const c of created) process.stdout.write(`  ${c.username.padEnd(24)} ${c.oneTimePassword}   ${c.roles}\n`);
}

main().catch((err) => {
  log.fatal({ err, errCode: 'NP-CFG-0001' }, 'bootstrap failed');
  process.exit(1);
});
