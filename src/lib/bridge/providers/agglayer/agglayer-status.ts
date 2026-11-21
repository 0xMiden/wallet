// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/{agglayer-status,status-schema}.ts (MIT).
import { isHash, parseUnits } from 'viem';

import { midenAddrToEvmAddr } from 'lib/agglayer/contract';
import { sameTxHash, type AgglayerDeposit } from 'lib/agglayer/status';
import type { BridgeOperationSnapshot } from 'lib/bridge/operation';
import type { AgglayerRecoveryConfig } from 'lib/remote-config/schema';

/** Indexer readiness is destination evidence only for the original exact deposit, never local spendability. */
export function matchesAgglayerReceiveDeposit(
  deposit: AgglayerDeposit,
  operation: BridgeOperationSnapshot,
  route: AgglayerRecoveryConfig
): boolean {
  try {
    const { review, sourceAttempt } = operation;
    const source = review.route.source;
    const token = source.kind === 'erc20' ? source.address : '0x0000000000000000000000000000000000000000';
    return (
      source.kind !== 'miden' &&
      sourceAttempt?.phase === 'known' &&
      typeof sourceAttempt.hash === 'string' &&
      isHash(sourceAttempt.hash) &&
      review.amount === review.quote?.request.amount &&
      deposit.leaf_type === 0 &&
      sameTxHash(deposit.tx_hash, sourceAttempt.hash) &&
      deposit.network_id === route.evmNetworkId &&
      deposit.orig_net === route.evmNetworkId &&
      deposit.dest_net === route.rollupId &&
      deposit.dest_addr.toLowerCase() === midenAddrToEvmAddr(review.accounts.midenAccount).toLowerCase() &&
      deposit.orig_addr.toLowerCase() === token.toLowerCase() &&
      /^\d+$/.test(deposit.amount) &&
      BigInt(deposit.amount) === parseUnits(review.amount, source.decimals)
    );
  } catch {
    return false;
  }
}
