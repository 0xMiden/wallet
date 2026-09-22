/**
 * SLIP-0010 key derivation, hardened-only.
 *
 * This module implements the part of SLIP-0010 that the wallet uses: the
 * master key from a seed and hardened child keys. It uses the ed25519 rule
 * of the specification: the child secret is I_L, with no curve arithmetic
 * and no retry step. Every 32-byte sequence is a valid secret. The derived
 * secret is a seed for a key constructor, not a curve scalar.
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
import { sha512 } from '@noble/hashes/sha512';

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
