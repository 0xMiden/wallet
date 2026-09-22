/**
 * SLIP-0010 key derivation, hardened only.
 *
 * This module derives the master key from a seed and derives hardened child
 * keys. The wallet uses no other part of SLIP-0010.
 *
 * SLIP-0010 RULE
 *
 * SLIP-0010 has one HMAC-SHA512 chain and two rules to make a child key from
 * the output `I`. The curve selects the rule:
 *
 * - secp256k1 and nist256p1: the child secret is `(I_L + k_parent) mod n`.
 *   The result must be in `[1, n)`. If it is not, the derivation retries.
 *   Only this rule has non-hardened derivation.
 * - ed25519 and curve25519: the child secret is `I_L`. Each 32-byte sequence
 *   is a valid secret, the all-zero sequence included. There is no check and
 *   no retry. This rule is hardened only.
 *
 * This module uses the second rule for each wallet key, on each curve. The
 * name is only a label. The module does not use the ed25519 curve.
 *
 * The reason is the use of the output. The derived 32 bytes are not a signing
 * key. They are a seed for an SDK key constructor (`AuthSecretKey.ecdsaWithRNG`
 * or `AuthSecretKey.rpoFalconWithRNG`). The SDK makes the key from that seed.
 * For ECDSA, the SDK reduces the seed into a valid secp256k1 scalar. For
 * Falcon, the seed feeds a lattice sampler, and `mod n` has no meaning. A
 * `mod n` addition and a retry loop on bytes that are not a scalar have no
 * effect that we want. They also tie one seed to one curve. The derivation
 * the wallet used before issue #918 (`@demox-labs/aleo-hd-key`) used the same
 * rule. The `legacy` scheme must keep it, or its golden vectors do not match.
 * With no retry, the derivation is a fixed number of HMAC calls.
 *
 * The cost is interoperability. A Miden ECDSA key is never equal to a BIP-32
 * wallet key for the same phrase. This is a decision (issue #918).
 *
 * The HMAC label is a parameter. SLIP-0010 uses the label only for domain
 * separation. A different label gives a different key tree for the same seed.
 * Do not change a label after a wallet ships with it.
 *
 * The code was checked against the audited MetaMask `key-tree` package to
 * make sure it does not repeat known bugs. This module also clears each
 * intermediate buffer after use.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha2';

/**
 * A SLIP-0010 extended private key: a 32-byte secret and a 32-byte chain code.
 *
 * Both parts come from one HMAC-SHA512 output. The first 32 bytes are the
 * secret. The last 32 bytes are the chain code (a BIP-32 term). The chain code
 * is the HMAC key for the next derivation step. Thus a child depends on both
 * parts of its parent. In BIP-32 the chain code also lets a public key derive
 * non-hardened child public keys. This package does not do that. Here the
 * chain code is only the intermediate state between path levels. The
 * derivation uses it to make the next child and then clears it. The wallet
 * keeps only the final `secret`, as an RNG seed for the SDK key constructors.
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
 * The seed must be 16 to 64 bytes long (128 to 512 bits, as SLIP-0010 requires).
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
 * Derive the hardened child at `index`. Give the index without the hardened
 * offset. `data = 0x00 || parent.secret || ser32(index + HARDENED_OFFSET)`.
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
 * Parse a hardened path such as `m/44'/0'` into its indices `[44, 0]`.
 * Each segment must end in `'`. A segment must not have a leading zero. Each
 * index must be below the hardened offset. The master path `m` gives an
 * empty list.
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
