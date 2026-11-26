import { keccak256, stringToHex } from 'viem';

/**
 * The Calibur nonce key of the relay: the top 192 bits of `keccak256('miden.relay')`. Every relay batch of an
 * address uses this one key, whatever its calls do.
 */
export const RELAY_NONCE_KEY = BigInt(keccak256(stringToHex('miden.relay'))) >> 64n;

const SEQUENCE_LIMIT = 1n << 64n;

/** The Calibur batch nonce: `RELAY_NONCE_KEY << 64 | sequence`. `sequence` is `getSeq(RELAY_NONCE_KEY)` of the EOA. */
export function batchNonceOf(sequence: bigint): bigint {
  if (sequence < 0n || sequence >= SEQUENCE_LIMIT) throw new Error('The sequence must be a uint64');
  return (RELAY_NONCE_KEY << 64n) | sequence;
}

/** True when the key of the batch nonce is the relay key. */
export function isRelayNonce(batchNonce: bigint): boolean {
  return batchNonce >= 0n && batchNonce >> 64n === RELAY_NONCE_KEY;
}
