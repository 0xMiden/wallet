import { keccak256, stringToHex } from 'viem';

import { buildAgglayerDepositCalls, type AgglayerDepositConfig, type AgglayerDepositParams } from './agglayer-deposit';
import type { BatchCall } from './calibur';

/** The config and the parameters of each relay kind. A new kind adds an entry here and a case below. */
export interface RelayKindInputs {
  'agglayer-deposit': { config: AgglayerDepositConfig; params: AgglayerDepositParams };
}

/** A kind of relay batch. */
export type RelayKind = keyof RelayKindInputs;

/**
 * The Calibur nonce key of a relay kind: the top 192 bits of `keccak256('miden.relay.' + kind)`. Each kind has its
 * own key, so two kinds of one address never share a sequence.
 */
export function nonceKeyOf(kind: RelayKind): bigint {
  return BigInt(keccak256(stringToHex(`miden.relay.${kind}`))) >> 64n;
}

/** The Calibur batch nonce: `key << 64 | sequence`. `sequence` is `getSeq(key)` of the EOA. */
export function batchNonceOf(kind: RelayKind, sequence: bigint): bigint {
  if (sequence < 0n || sequence >= 1n << 64n) throw new Error('The sequence must be a uint64');
  return (nonceKeyOf(kind) << 64n) | sequence;
}

/** The calls of a relay batch of the given kind. Throws when a parameter is not valid. */
export function buildRelayCalls<K extends RelayKind>(
  kind: K,
  config: RelayKindInputs[K]['config'],
  params: RelayKindInputs[K]['params']
): BatchCall[] {
  switch (kind) {
    case 'agglayer-deposit':
      return buildAgglayerDepositCalls(config, params);
    default:
      throw new Error(`Unknown relay kind: ${kind}`);
  }
}
