import { isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { compareAccountIds } from 'lib/miden/activity/utils';
import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { isUserCancelledTransaction } from 'lib/miden/transaction/constants';
import { holdsNotes } from 'lib/miden/transaction/verdict-rules';

/** Why a swap's payback claim keeps failing, as the swap row and its detail page name it. */
export type PaybackClaimStuckReason = 'fee' | 'guardian' | 'network' | 'other';

export type PaybackClaimState =
  | { stuck: false }
  | { stuck: true; failedClaimId: string; reason: PaybackClaimStuckReason };

/** What the account's other consumes say about one note: claimed by a Completed one, held by a live one, or neither. */
export type NoteCoverage = (noteId: string) => 'claimed' | 'held' | 'open';

const NOT_STUCK: PaybackClaimState = { stuck: false };

const noteIdsOf = (tx: ITransaction): string[] => tx.noteIds ?? (tx.noteId ? [tx.noteId] : []);

/** The claim dedup's rule (`noteClaimCoverage`): live, Unconfirmed, or Failed while the reconciler still judges it. */
const isInFlight = (tx: ITransaction): boolean =>
  (tx.status !== ITransactionStatus.Completed && tx.status !== ITransactionStatus.Failed) || holdsNotes(tx);

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

const isCompletedSwap = (swap: ITransaction): boolean =>
  swap.type === 'swap' && swap.status === ITransactionStatus.Completed;

const isPaybackClaimOf = (swap: ITransaction, row: ITransaction): boolean =>
  row.type === 'consume' &&
  row.extraInputs?.swapOrderTxId === swap.id &&
  row.extraInputs?.swapSettleKind !== 'reclaim' &&
  !isUserCancelledTransaction(row.error) &&
  !row.restoredFromBackup;

/**
 * A completed swap reads stuck while no payout claim is live and every note a failed payout claim names is still
 * open: no other consume of the account has claimed or holds it. Retry replays that row whole and a transaction is
 * atomic, so a chunk with one note already claimed is left to settlement, which re-queues only its open notes. Settlement claims are hidden from Activity
 * (`suppressedLinkedConsumeIds`), so this is the only place a failing payout shows. Neither the latest row nor a
 * stamp can say it: settlement queues one claim per chunk, and the stamp repair writes `settledAt` or `reclaimedAt`
 * while a failed chunk remains. The daily retry (#313) keeps running; a claim that lands clears it.
 */
export function paybackClaimStateFrom(
  swap: ITransaction,
  linkedRows: ITransaction[],
  coverage: NoteCoverage
): PaybackClaimState {
  if (!isCompletedSwap(swap)) return NOT_STUCK;
  const claims = linkedRows.filter(row => isPaybackClaimOf(swap, row));
  if (claims.some(isInFlight)) return NOT_STUCK;
  const unclaimed = claims.filter(
    row => row.status === ITransactionStatus.Failed && noteIdsOf(row).every(noteId => coverage(noteId) === 'open')
  );
  const latest = unclaimed.reduce<ITransaction | undefined>(
    (newest, row) => (newest === undefined || row.initiatedAt > newest.initiatedAt ? row : newest),
    undefined
  );
  return latest ? { stuck: true, failedClaimId: latest.id, reason: classifyPaybackClaimFailure(latest) } : NOT_STUCK;
}

/**
 * Every swap's state from one linked-claim read and one note read, so a history refresh costs two queries however
 * many swaps it lists. The note read follows the claim dedup's rule (`queueConsumeRows`): a consume of the same
 * account covers a note, Completed or still live, and a row restored from a backup covers nothing.
 */
export async function getPaybackClaimStates(swaps: ITransaction[]): Promise<Map<string, PaybackClaimState>> {
  const states = new Map<string, PaybackClaimState>();
  const completed = swaps.filter(isCompletedSwap);
  if (completed.length === 0) return states;
  const linked = await Repo.transactions
    .where('extraInputs.swapOrderTxId')
    .anyOf(completed.map(swap => swap.id))
    .toArray();
  const failedNoteIds = [...new Set(linked.filter(row => row.status === ITransactionStatus.Failed).flatMap(noteIdsOf))];
  const [byScalar, byBatch] =
    failedNoteIds.length === 0
      ? [[], []]
      : await Promise.all([
          Repo.transactions.where('noteId').anyOf(failedNoteIds).toArray(),
          Repo.transactions.where('noteIds').anyOf(failedNoteIds).toArray()
        ]);
  const coveringByNote = new Map<string, ITransaction[]>();
  const seen = new Set<string>();
  for (const row of [...byScalar, ...byBatch]) {
    if (seen.has(row.id) || row.type !== 'consume' || row.restoredFromBackup) continue;
    if (row.status !== ITransactionStatus.Completed && !isInFlight(row)) continue;
    seen.add(row.id);
    for (const noteId of noteIdsOf(row)) coveringByNote.set(noteId, [...(coveringByNote.get(noteId) ?? []), row]);
  }
  const linkedByOrder = new Map<string, ITransaction[]>();
  for (const row of linked) {
    const order = row.extraInputs?.swapOrderTxId;
    if (typeof order === 'string') linkedByOrder.set(order, [...(linkedByOrder.get(order) ?? []), row]);
  }
  for (const swap of completed) {
    const coverage: NoteCoverage = noteId => {
      const rows = (coveringByNote.get(noteId) ?? []).filter(row => compareAccountIds(row.accountId, swap.accountId));
      if (rows.some(row => row.status === ITransactionStatus.Completed)) return 'claimed';
      return rows.length > 0 ? 'held' : 'open';
    };
    states.set(swap.id, paybackClaimStateFrom(swap, linkedByOrder.get(swap.id) ?? [], coverage));
  }
  return states;
}

export async function getPaybackClaimState(swap: ITransaction): Promise<PaybackClaimState> {
  return (await getPaybackClaimStates([swap])).get(swap.id) ?? NOT_STUCK;
}

/** The history entry's field: the failed claim and its reason while stuck, else nothing. */
export const stuckPaybackClaim = (
  state: PaybackClaimState | undefined
): { failedClaimId: string; reason: PaybackClaimStuckReason } | undefined =>
  state?.stuck ? { failedClaimId: state.failedClaimId, reason: state.reason } : undefined;
