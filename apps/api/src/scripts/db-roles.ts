/**
 * Creates (or updates the password of) one database LOGIN role per service,
 * each a member of exactly one group role created by the migrations:
 *
 *   np_platform   → np_platform_rw     (API platform module + worker expiry)
 *   np_iam        → np_iam_rw          (API identity module + worker cleanup)
 *   np_audit      → np_audit_reader    (API audit viewer)
 *   np_relay      → np_audit_relay     (worker audit relay + checkpoints)
 *   np_registry   → np_registry_rw     (API registry module: offices/posts/services)
 *   np_citizen    → np_citizen_rw      (API citizen module: mobile OTP identity/sessions)
 *   np_org        → np_org_rw          (API org directory module: departments/authorities/SPVs)
 *   np_intake     → np_intake_rw       (API grievance intake module)
 *
 * Passwords come from NP_DB_PASSWORD_PLATFORM / _IAM / _AUDIT / _RELAY / _REGISTRY / _CITIZEN / _ORG / _INTAKE.
 * Run with MIGRATION_DATABASE_URL (schema owner) after migrations.
 */
import pg from 'pg';

const ROLES = [
  { login: 'np_platform', group: 'np_platform_rw', env: 'NP_DB_PASSWORD_PLATFORM' },
  { login: 'np_iam', group: 'np_iam_rw', env: 'NP_DB_PASSWORD_IAM' },
  { login: 'np_audit', group: 'np_audit_reader', env: 'NP_DB_PASSWORD_AUDIT' },
  { login: 'np_relay', group: 'np_audit_relay', env: 'NP_DB_PASSWORD_RELAY' },
  { login: 'np_registry', group: 'np_registry_rw', env: 'NP_DB_PASSWORD_REGISTRY' },
  { login: 'np_citizen', group: 'np_citizen_rw', env: 'NP_DB_PASSWORD_CITIZEN' },
  { login: 'np_org', group: 'np_org_rw', env: 'NP_DB_PASSWORD_ORG' },
  { login: 'np_intake', group: 'np_intake_rw', env: 'NP_DB_PASSWORD_INTAKE' }
] as const;

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url, application_name: 'np-db-roles' });
  await client.connect();
  try {
    for (const r of ROLES) {
      const pw = process.env[r.env];
      if (!pw || pw.length < 16) throw new Error(`${r.env} must be set (at least 16 characters)`);
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r.login]);
      // Role names are constants above; the password is escaped as a literal by the driver.
      const lit = client.escapeLiteral(pw);
      if (exists.rowCount) await client.query(`ALTER ROLE ${r.login} WITH LOGIN PASSWORD ${lit}`);
      else await client.query(`CREATE ROLE ${r.login} WITH LOGIN PASSWORD ${lit}`);
      await client.query(`GRANT ${r.group} TO ${r.login}`);
      // Defensive: these service roles must never own objects or create schemas.
      await client.query(`ALTER ROLE ${r.login} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      console.warn(`role ${r.login} ready (member of ${r.group})`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`NP-CFG-0001 db-roles failed: ${(err as Error).message}`);
  process.exit(1);
});
