import type { EpochEvmTransaction, MainnetEpochCheckpoint } from './mainnet-epoch-checkpoint';

export interface EpochUnminedLive {
  /** What the public RPC returned for the journaled deposit hash; both must be absent. */
  depositTransaction: unknown;
  depositReceipt: unknown;
  latestNonce: number;
  pendingNonce: number;
  tokenBalance: bigint;
  nativeBalance: bigint;
  nativeVault: bigint;
  /** Provider status of the original reverse intent. */
  reverseStatus: unknown;
}

export function closeEpochUnminedDeposit(
  _state: MainnetEpochCheckpoint,
  _approvals: { transactions: EpochEvmTransaction[]; paidEvmFees: string },
  _live: EpochUnminedLive
): boolean {
  return false;
}
