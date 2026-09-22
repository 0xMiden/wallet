/**
 * SLIP-0010 key derivation, hardened-only.
 *
 * This module implements the part of SLIP-0010 that the wallet uses: the
 * master key from a seed and hardened child keys.
 *
 * WHICH SLIP-0010 RULE, AND WHY
 *
 * SLIP-0010 has one HMAC-SHA512 chain and two rules to turn its output `I`
 * into a child key, selected by curve:
 *
 * - secp256k1 / nist256p1: child secret = (I_L + k_parent) mod n. The result
 *   must be in [1, n); if it is not, re-HMAC with `0x01 || I_R || ser32(i)`
 *   and retry. The master key retries the same way with `I` as the new seed.
 *   Non-hardened (public) derivation exists only under this rule.
 * - ed25519 / curve25519: child secret = I_L, unchanged. Every 32-byte
 *   sequence is a valid secret, even all zeros, so there is no validity check
 *   and no retry. Hardened-only.
 *
 * This module uses the SECOND rule, for every wallet key, whatever curve the
 * key ends up on. The name is only shorthand: nothing here touches the
 * ed25519 curve. The reason is what the output is used for. The derived 32
 * bytes are NOT a signing key. They are a seed for an SDK key constructor
 * (`AuthSecretKey.ecdsaWithRNG`, `AuthSecretKey.rpoFalconWithRNG`), which
 * runs its own key generation from that seed: the SDK reduces it into a
 * valid secp256k1 scalar itself, and for Falcon the seed feeds a lattice
 * sampler where "mod n" has no meaning. A `mod n` addition and a retry loop
 * on bytes that are not a scalar would be meaningless work, and would tie
 * one seed to one curve. The pre-#918 derivation the wallet shipped with
 * (`@demox-labs/aleo-hd-key`) used this same rule, so the `legacy` scheme
 * has to as well or its golden vectors would not reproduce. A derivation
 * with no rejection path is also a fixed number of HMAC calls with no
 * data-dependent branching.
 *
 * What this gives up is interoperability: a Miden ECDSA key will never equal
 * a BIP-32 wallet's key for the same phrase. That is deliberate (issue #918).
 *
 * The HMAC label is a parameter. SLIP-0010 uses the label only for domain
 * separation, so a different label gives a disjoint key tree for the same
 * seed. A label must never change after a wallet ships with it.
 *
 * Reference: MetaMask key-tree v10.1.1 (audited by Cure53, 2023-02 and
 * 2024-04). The checks below follow audit findings MM-02-003 (seed length),
 * MM-02-004 (master key bounds) and MM-02-007 (the all-zero ed25519 key is
 * valid). Unlike key-tree this module also clears intermediate buffers.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha2';

/**
 * A SLIP-0010 extended private key: a 32-byte secret and a 32-byte chain code.
 *
 * Both halves come from one HMAC-SHA512 output: the first 32 bytes are the
 * secret, the last 32 bytes are the chain code (BIP-32 terms). The chain code
 * is the HMAC key for the next derivation step, so a child depends on both
 * halves of its parent. In BIP-32 it also lets a public key derive
 * non-hardened child public keys; this package never does that. Here the
 * chain code is only the intermediate state between path levels: it is
 * consumed to derive the next child and then cleared. The wallet keeps only
 * the final `secret`, as an RNG seed for the SDK key constructors.
 */
export interface ExtendedKey {
  readonly secret: Uint8Array;
  readonly chainCode: Uint8Array;
}

export const HARDENED_OFFSET = 0x80000000;
export const MIN_SEED_LENGTH = 16;
export const MAX_SEED_LENGTH = 64;
const KEY_LENGTH = 32;

const HARDENED_PATH_PATTERN = /^m(\/\d+')*$/u;
const LEADING_ZERO_PATTERN = /^0\d/u;

const textEncoder = new TextEncoder();

function splitHmacOutput(output: Uint8Array): ExtendedKey {
  const secret = output.slice(0, KEY_LENGTH);
  const chainCode = output.slice(KEY_LENGTH);
  output.fill(0);
  return Object.freeze({ secret, chainCode });
}

function assertExtendedKey(node: ExtendedKey): void {
  if (node.secret.length !== KEY_LENGTH) {
    throw new Error(`Invalid extended key: the secret must be ${KEY_LENGTH} bytes long.`);
  }
  if (node.chainCode.length !== KEY_LENGTH) {
    throw new Error(`Invalid extended key: the chain code must be ${KEY_LENGTH} bytes long.`);
  }
}

/**
 * Compute the master extended key: `I = HMAC-SHA512(key = label, data = seed)`.
 * The seed must be 16 to 64 bytes long (128 to 512 bits, SLIP-0010).
 */
export function masterKeyFromSeed(seed: Uint8Array, label: string): ExtendedKey {
  if (seed.length < MIN_SEED_LENGTH || seed.length > MAX_SEED_LENGTH) {
    throw new Error(`Invalid seed: the seed must be between ${MIN_SEED_LENGTH} and ${MAX_SEED_LENGTH} bytes long.`);
  }
  if (label.length === 0) {
    throw new Error('Invalid label: the label must not be empty.');
  }
  return splitHmacOutput(hmac(sha512, textEncoder.encode(label), seed));
}

/**
 * Derive the hardened child at `index` (the index without the hardened offset).
 * `data = 0x00 || parent.secret || ser32(index + HARDENED_OFFSET)`.
 */
export function deriveHardenedChild(parent: ExtendedKey, index: number): ExtendedKey {
  assertExtendedKey(parent);
  if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
    throw new Error(`Invalid index: the index must be an integer from 0 to ${HARDENED_OFFSET - 1}.`);
  }
  const data = new Uint8Array(1 + KEY_LENGTH + 4);
  data.set(parent.secret, 1);
  new DataView(data.buffer).setUint32(1 + KEY_LENGTH, index + HARDENED_OFFSET, false);
  const output = hmac(sha512, parent.chainCode, data);
  data.fill(0);
  return splitHmacOutput(output);
}

/**
 * Parse a hardened-only path such as `m/44'/0'` into its indices `[44, 0]`.
 * Every segment must end in `'`, must not have a leading zero, and must be
 * below the hardened offset. The master path `m` gives an empty list.
 */
export function parseHardenedPath(path: string): number[] {
  if (!HARDENED_PATH_PATTERN.test(path)) {
    throw new Error("Invalid derivation path: expected the form m/i'/j' with hardened segments only.");
  }
  return path
    .split('/')
    .slice(1)
    .map(segment => {
      const digits = segment.slice(0, -1);
      if (LEADING_ZERO_PATTERN.test(digits)) {
        throw new Error('Invalid derivation path: an index must not have a leading zero.');
      }
      const index = Number(digits);
      if (!Number.isSafeInteger(index) || index >= HARDENED_OFFSET) {
        throw new Error(`Invalid derivation path: an index must be below ${HARDENED_OFFSET}.`);
      }
      return index;
    });
}

/** Derive the extended key at `path` from `seed` under `label`. */
export function deriveHardenedPath(seed: Uint8Array, label: string, path: string): ExtendedKey {
  const indices = parseHardenedPath(path);
  let node = masterKeyFromSeed(seed, label);
  for (const index of indices) {
    const child = deriveHardenedChild(node, index);
    node.secret.fill(0);
    node.chainCode.fill(0);
    node = child;
  }
  return node;
}
