/**
 * Audit signing key management (server CLI).
 *
 *   audit-key generate <private-key-out.pem>   create an Ed25519 key pair and register the public key
 *   audit-key register <private-key.pem>       register the public key of an existing private key
 *   audit-key retire <key-id>                  mark a key retired (old checkpoints still verify)
 *
 * The private key file is written with mode 0600 and must live only on the
 * worker host (or in a KMS). The database stores only public keys.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { keyIdOf } from '../audit/checkpoint.js';

async function register(client: pg.Client, privatePem: string): Promise<string> {
  const pub = createPublicKey(createPrivateKey(privatePem));
  const keyId = keyIdOf(pub);
  await client.query('INSERT INTO audit.signing_keys (key_id, public_key) VALUES ($1, $2) ON CONFLICT (key_id) DO NOTHING', [
    keyId,
    pub.export({ type: 'spki', format: 'pem' }).toString()
  ]);
  return keyId;
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url || !cmd || !arg) {
    console.error('usage: audit-key generate <out.pem> | register <key.pem> | retire <key-id>   (needs MIGRATION_DATABASE_URL)');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url, application_name: 'np-audit-key' });
  await client.connect();
  try {
    if (cmd === 'generate') {
      const { privateKey } = generateKeyPairSync('ed25519');
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      // 'wx' fails if the file exists, so an existing key is never overwritten.
      await writeFile(arg, pem, { mode: 0o600, flag: 'wx' });
      console.warn(`generated key ${await register(client, pem)} -> ${arg}`);
    } else if (cmd === 'register') {
      console.warn(`registered key ${await register(client, await readFile(arg, 'utf8'))}`);
    } else if (cmd === 'retire') {
      const r = await client.query('UPDATE audit.signing_keys SET retired_at = now() WHERE key_id = $1 AND retired_at IS NULL', [arg]);
      console.warn(r.rowCount ? `retired ${arg}` : `no active key ${arg}`);
    } else {
      throw new Error(`unknown command ${cmd}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`NP-CFG-0002 audit-key failed: ${(err as Error).message}`);
  process.exit(1);
});
