/**
 * JS fallback for the secure-hot-key facade. Used by extension and desktop
 * (Tauri reuses this for now; desktop SE work deferred per Phase 4 scope).
 *
 * In this fallback the "ciphertext" is the serialized AuthSecretKey blob —
 * the per-key wrap that mobile gets via Secure Enclave / StrongBox is replaced
 * by the vault-key envelope the caller applies on top before persisting. This
 * means hot-key isolation on extension is only as strong as the vault password
 * (acknowledged in the migration plan, Risks §6).
 */

import { AuthSecretKey } from '@miden-sdk/miden-sdk/lazy';
import { Buffer } from 'buffer';

export type GeneratedHotKey = {
  ciphertext: string;
  // SDK serialize().slice(1) form — matches the storage-key convention used by
  // the rest of the wallet so vault.signWord can lookup by this hex directly.
  publicKeyHex: string;
  // Multisig commitment (toCommitment().toHex()) — what MultisigClient.create
  // expects in `signerCommitments`.
  commitmentHex: string;
};

export async function generateHotKey(): Promise<GeneratedHotKey> {
  const rawSeed = crypto.getRandomValues(new Uint8Array(32));
  const sk = AuthSecretKey.ecdsaWithRNG(rawSeed);
  const ciphertext = Buffer.from(sk.serialize()).toString('hex');
  const publicKey = sk.publicKey();
  const publicKeyHex = Buffer.from(publicKey.serialize().slice(1)).toString('hex');
  const commitmentHex = publicKey.toCommitment().toHex();
  return { ciphertext, publicKeyHex, commitmentHex };
}

export async function signHotDigest(ciphertext: string, wordHex: string): Promise<string> {
  const { Word } = await import('@miden-sdk/miden-sdk/lazy');
  const sk = AuthSecretKey.deserialize(new Uint8Array(Buffer.from(ciphertext, 'hex')));
  const word = Word.fromHex(wordHex);
  const signature = sk.sign(word);
  return `0x${Buffer.from(signature.serialize().slice(1)).toString('hex')}`;
}

export async function deleteHotKey(_ciphertext: string): Promise<void> {
  // No-op in the JS fallback: the vault-wrapped blob is removed by the caller
  // when it deletes the account record. There's no native handle to release.
}
