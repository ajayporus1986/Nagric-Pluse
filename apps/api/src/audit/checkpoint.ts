/**
 * Audit checkpoint signing format, shared by the worker (signs) and the API
 * (verifies). A checkpoint commits to the ledger hash at a sequence number:
 *
 *   message = "np-audit-checkpoint|v1|<up_to_seq>|<ledger hash hex>"
 *   signature = Ed25519(private key, message)
 *
 * Because each ledger hash chains over all earlier rows, one valid checkpoint
 * proves the entire ledger up to that point is unchanged.
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/** Canonical message for a checkpoint. */
export function checkpointMessage(upToSeq: string | number | bigint, ledgerHash: Buffer): Buffer {
  return Buffer.from(`np-audit-checkpoint|v1|${String(upToSeq)}|${ledgerHash.toString('hex')}`, 'utf8');
}

/** Signs a checkpoint with an Ed25519 private key. */
export function signCheckpoint(privateKey: KeyObject, upToSeq: string | number | bigint, ledgerHash: Buffer): Buffer {
  // Ed25519 takes no digest algorithm (null).
  return sign(null, checkpointMessage(upToSeq, ledgerHash), privateKey);
}

/** Verifies a checkpoint signature with a PEM public key. */
export function verifyCheckpoint(publicKeyPem: string, upToSeq: string | number | bigint, ledgerHash: Buffer, signature: Buffer): boolean {
  try {
    return verify(null, checkpointMessage(upToSeq, ledgerHash), createPublicKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}

/** Key id = first 16 hex chars of SHA-256 over the SPKI DER public key. */
export function keyIdOf(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}
