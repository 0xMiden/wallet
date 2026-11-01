/**
 * The sync key of the encrypted backup (wallet-api).
 *
 * The sync key is one secp256k1 key per recovery phrase. It signs the login
 * message and the storage-key message. It never signs a transaction.
 *
 * DERIVATION BRANCH
 *
 * HMAC label `miden sync`, path `m/44'/5063758'/1000'/0'`.
 *
 * The wallet uses these branches of the phrase today:
 * - Miden account seeds and Guardian cold seeds (`derive-seed.ts`): label `miden seed`,
 *   path `m/44'/5063758'/<walletType 0..2>'/<authScheme 0..1>'/<hdIndex>'`.
 * - EVM keys (`deriveEvmKeyPair` in `vault.ts`, viem BIP-32): label `Bitcoin seed`,
 *   path `m/44'/60'/<walletType>'/0/<hdIndex>`.
 * - Login keys (`lib/miden/login-key`): HKDF from an EVM key, not a path.
 *
 * The sync branch cannot collide with these, for two independent reasons:
 * 1. The label is different. SLIP-0010 keys the master HMAC with the label, so
 *    `miden sync` gives a different master key, and thus a different tree.
 * 2. Under any label, the third level `1000'` is out of the wallet-type range
 *    and the path has four levels, not five. No account path is equal to it.
 *
 * Thus a sync signature cannot be replayed as an account, Guardian or EVM
 * signature. Do not change the label or the path: each change gives a new
 * profile and makes the old backup unreachable.
 *
 * SCALAR RULE
 *
 * `@miden/hd-key` gives the 32-byte `I_L` of the last level with no `mod n`
 * step (see its README). This module uses those bytes as the secp256k1 secret
 * key directly. A value of 0 or at or above the curve order is refused. The
 * probability is near 2^-128, so the refusal is a guard, not a code path.
 *
 * Every function here is pure. The caller zeroes the secret after use.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { deriveHardenedPath, mnemonicToSeed } from '@miden/hd-key';

/** The SLIP-0010 HMAC label of the sync branch. No other deriver uses it. */
export const SYNC_KEY_LABEL = 'miden sync';

/** The SLIP-0010 path of the sync key, under {@link SYNC_KEY_LABEL}. */
export const SYNC_KEY_PATH = "m/44'/5063758'/1000'/0'";

const SYNC_SECRET_LENGTH = 32;
const COMPACT_SIGNATURE_LENGTH = 64;

/** Derive the 32-byte sync secret key from a BIP-39 phrase. The caller zeroes the result. */
export function deriveSyncSecretKey(mnemonic: string): Uint8Array {
  const masterSeed = mnemonicToSeed(mnemonic);
  try {
    const node = deriveHardenedPath(masterSeed, SYNC_KEY_LABEL, SYNC_KEY_PATH);
    node.chainCode.fill(0);
    if (!isValidSyncSecretKey(node.secret)) {
      node.secret.fill(0);
      throw new Error('The sync key derivation gave a value that is not a secp256k1 secret key');
    }
    return node.secret;
  } finally {
    masterSeed.fill(0);
  }
}

/** True when `secret` is 32 bytes and a valid secp256k1 scalar in [1, n). */
export function isValidSyncSecretKey(secret: Uint8Array): boolean {
  return secret.length === SYNC_SECRET_LENGTH && secp256k1.utils.isValidPrivateKey(secret);
}

/** The 33-byte compressed public key of `secret`, as lowercase hex. */
export function syncPublicKeyHex(secret: Uint8Array): string {
  return bytesToHex(secp256k1.getPublicKey(secret, true));
}

/**
 * Sign `message` with the sync key: SHA-256 of the UTF-8 bytes, then a
 * deterministic (RFC 6979) low-S ECDSA signature. Returns the 64-byte compact
 * form `r || s`. The same key and message always give the same bytes, which
 * the storage key needs.
 */
export function signSyncMessage(secret: Uint8Array, message: string): Uint8Array {
  const digest = sha256(utf8ToBytes(message));
  const signature = secp256k1.sign(digest, secret, { prehash: false, lowS: true }).toCompactRawBytes();
  if (signature.length !== COMPACT_SIGNATURE_LENGTH) {
    throw new Error('The sync key gave a signature that is not 64 bytes');
  }
  return signature;
}

/** The login message the server checks: `miden-sync:login:<nonce>:<publicKey>`. */
export function syncLoginMessage(nonce: string, publicKey: string): string {
  return `miden-sync:login:${nonce}:${publicKey}`;
}

/** The message whose signature is hashed into the storage key: `miden-sync:storage-key:<profileId>`. */
export function storageKeyMessage(profileId: string): string {
  return `miden-sync:storage-key:${profileId}`;
}
