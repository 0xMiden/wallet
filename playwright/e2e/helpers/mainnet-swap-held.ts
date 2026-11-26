import {
  expectedHeldAfter,
  isMainnetSwapCheckpoint,
  mainnetSwapRequestExpiresAt,
  swapHeldCost,
  type MainnetSwapCheckpoint,
  type SwapOrderEvidence
} from './mainnet-swap-checkpoint';
import type { MainnetSwapPaybackEvidence } from './mainnet-swap-claim';

/** The one audited first recovery return that no solver can fill; nothing else is ever closed this way. */
export const AUDITED_HELD_SWAP = { sourceRunId: '45634536470', returnAmount: '1732' } as const;

export interface SwapHeldLive {
  runId: string;
  now: number;
  balances: { offer: bigint; request: bigint; native: bigint };
  payback: MainnetSwapPaybackEvidence | undefined;
  orders: SwapOrderEvidence[];
  pendingWalletRows: number;
}

/**
 * Read-only closure of a granted first recovery return that was never signed or submitted and cannot be filled.
 * The held token stays in the wallet; the original checkpoint fields are kept. Mutates the checkpoint only when every
 * condition holds, otherwise the caller keeps failing closed.
 */
export function closeSwapHeldDust(state: MainnetSwapCheckpoint, live: SwapHeldLive): boolean {
  const authority = state.forwardRequestAuthority;
  const expected = expectedHeldAfter(state);
  const baseline = state.returnBaseline;
  const proof = live.payback;
  if (
    state.phase !== 'reverse-authorized' ||
    state.sourceRunId !== AUDITED_HELD_SWAP.sourceRunId ||
    state.returnAmount !== AUDITED_HELD_SWAP.returnAmount ||
    state.forwardReceived !== state.returnAmount ||
    state.forwardRefunded !== '0' ||
    !authority ||
    state.forwardOrderId !== authority.orderId ||
    state.recoveryReturnAuthorizedAt === undefined ||
    !state.authorizationRunId ||
    state.authorizationRunId === live.runId ||
    live.now < mainnetSwapRequestExpiresAt(state, 'reverse') ||
    [
      state.reverseOrderId,
      state.reverseRequestAuthority,
      state.reverseClaimAuthority,
      state.recoveryReturnReplacement,
      state.recoveryClaimNativeBefore
    ].some(field => field !== undefined) ||
    BigInt(state.paidFees) > BigInt(state.feeBudget) ||
    !expected ||
    !baseline ||
    JSON.stringify(baseline) !== JSON.stringify(expected) ||
    live.balances.offer.toString() !== expected.offer ||
    live.balances.request.toString() !== expected.request ||
    live.balances.native.toString() !== expected.native ||
    live.pendingWalletRows > 0 ||
    live.orders.some(
      row =>
        row.account === state.account &&
        row.initiatedAt >= Math.floor(Date.parse(state.createdAt) / 1000) - 30 &&
        !state.knownOrderIds.includes(row.orderId) &&
        row.orderId !== state.forwardOrderId
    ) ||
    !proof ||
    proof.claimedAtBlock === undefined ||
    proof.originalNoteId !== authority.noteId ||
    ![proof.orderId, proof.serialZeroOrderId].includes(authority.orderId) ||
    proof.amount !== BigInt(state.returnAmount)
  )
    return false;
  const closed: MainnetSwapCheckpoint = {
    ...state,
    phase: 'cancelled',
    realizedCostUsdMicros: swapHeldCost(state, expected).toString(),
    heldDust: {
      token: state.request.faucetId,
      amount: state.returnAmount,
      reason: 'no_return_liquidity',
      after: expected
    }
  };
  if (!isMainnetSwapCheckpoint(closed)) return false;
  Object.assign(state, closed);
  return true;
}
