import {
  epochRealizedCost,
  parseMainnetEpochCheckpoint,
  type EpochEvmTransaction,
  type MainnetEpochCheckpoint
} from './mainnet-epoch-checkpoint';

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

/**
 * Read-only resolution for an original deposit that was signed and journaled but never reached the chain.
 * `approvals` is the journal prefix already reconciled against its receipts and original authority.
 * Mutates the checkpoint only when every condition holds; otherwise the caller keeps failing closed.
 */
export function closeEpochUnminedDeposit(
  state: MainnetEpochCheckpoint,
  approvals: { transactions: EpochEvmTransaction[]; paidEvmFees: string },
  live: EpochUnminedLive
): boolean {
  const journal = state.transactions;
  const deposit = journal?.[journal.length - 1];
  if (
    !journal ||
    !deposit ||
    deposit.kind !== 'deposit' ||
    state.phase !== 'recovery-required' ||
    state.forwardReceived === undefined ||
    state.consumeAuthority ||
    state.returnMidenTxId ||
    approvals.transactions.length !== journal.length - 1 ||
    approvals.transactions.some((tx, index) => tx.kind === 'deposit' || tx.hash !== journal[index]?.hash) ||
    live.depositTransaction != null ||
    live.depositReceipt != null ||
    live.latestNonce !== deposit.nonce ||
    live.pendingNonce !== deposit.nonce ||
    !Array.isArray(live.reverseStatus) ||
    live.reverseStatus.some(
      leg =>
        typeof leg !== 'object' ||
        leg === null ||
        ['success', 'completed'].includes(String(Reflect.get(leg, 'status'))) ||
        Reflect.get(leg, 'midenNoteId') !== undefined
    )
  )
    return false;
  const paid = BigInt(approvals.paidEvmFees);
  const after = {
    native: live.nativeVault.toString(),
    evmToken: live.tokenBalance.toString(),
    evmNative: live.nativeBalance.toString()
  };
  if (
    BigInt(state.paidEvmFees) > paid ||
    live.tokenBalance !== BigInt(state.evm.tokenBalance) + BigInt(state.forwardReceived) ||
    live.nativeBalance !== BigInt(state.evm.nativeBalance) - paid ||
    live.nativeVault !== BigInt(state.native.balance) - BigInt(state.principal) - BigInt(state.paidMidenFees)
  )
    return false;
  const closed: MainnetEpochCheckpoint = {
    ...state,
    phase: 'cancelled',
    paidEvmFees: paid.toString(),
    transactions: [...approvals.transactions, { ...deposit, feeWei: '0' }],
    unminedDeposit: { hash: deposit.hash, nonce: deposit.nonce },
    after,
    realizedCostUsdMicros: epochRealizedCost(state, after).toString()
  };
  parseMainnetEpochCheckpoint(closed);
  Object.assign(state, closed);
  return true;
}
