import { isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { isUserCancelledTransaction } from 'lib/miden/transaction/constants';

/** Why a swap's payback claim keeps failing, as the swap row and its detail page name it. */
export type PaybackClaimStuckReason = 'fee' | 'guardian' | 'network' | 'other';

export type PaybackClaimState = { stuck: false } | { stuck: true; failedClaimId: string; reason: PaybackClaimStuckReason };

const NOT_STUCK: PaybackClaimState = { stuck: false };

/**
 * Names a failed payback claim's cause from its own error text. The text is the only stable join key across the
 * SDK, the kernel and the Guardian (see `connectivity-classify.ts`), so the classes are coarse on purpose.
 */
export function classifyPaybackClaimFailure(claim: ITransaction): PaybackClaimStuckReason {
  const text = `${claim.rawError ?? ''} ${claim.error ?? ''}`;
  if (/\bfee\b/i.test(text)) return 'fee';
  if (claim.failureDiagnostics !== undefined || /guardian/i.test(text)) return 'guardian';
  if (isLikelyNetworkError(text)) return 'network';
  return 'other';
}

/**
 * A completed swap whose payout has not settled reads stuck while its latest payback claim failed and none is still
 * live or waiting on its verdict. Settlement claims are hidden from Activity (`suppressedLinkedConsumeIds`), so this
 * is the only place a failing payout shows. The daily retry (#313) keeps running; a later attempt clears it.
 */
export function paybackClaimStateFrom(swap: ITransaction, linkedRows: ITransaction[]): PaybackClaimState {
  if (swap.type !== 'swap' || swap.status !== ITransactionStatus.Completed) return NOT_STUCK;
  if (swap.extraInputs?.settledAt != null) return NOT_STUCK;
  const claims = linkedRows.filter(
    row =>
      row.type === 'consume' &&
      row.extraInputs?.swapOrderTxId === swap.id &&
      row.extraInputs?.swapSettleKind !== 'reclaim' &&
      !isUserCancelledTransaction(row.error) &&
      !row.restoredFromBackup
  );
  if (claims.some(row => row.status !== ITransactionStatus.Completed && row.status !== ITransactionStatus.Failed))
    return NOT_STUCK;
  const latest = claims.reduce<ITransaction | undefined>(
    (newest, row) => (newest === undefined || row.initiatedAt > newest.initiatedAt ? row : newest),
    undefined
  );
  if (latest?.status !== ITransactionStatus.Failed) return NOT_STUCK;
  return { stuck: true, failedClaimId: latest.id, reason: classifyPaybackClaimFailure(latest) };
}

export async function getPaybackClaimState(swap: ITransaction): Promise<PaybackClaimState> {
  if (swap.type !== 'swap' || swap.status !== ITransactionStatus.Completed || swap.extraInputs?.settledAt != null)
    return NOT_STUCK;
  const linked = await Repo.transactions.where('extraInputs.swapOrderTxId').equals(swap.id).toArray();
  return paybackClaimStateFrom(swap, linked);
}

/** The history entry's field: the failed claim and its reason while stuck, else nothing. */
export const stuckPaybackClaim = (
  state: PaybackClaimState
): { failedClaimId: string; reason: PaybackClaimStuckReason } | undefined =>
  state.stuck ? { failedClaimId: state.failedClaimId, reason: state.reason } : undefined;
