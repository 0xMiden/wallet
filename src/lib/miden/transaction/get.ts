import { PswapLineageState } from '@miden-sdk/miden-sdk/lazy';

import * as Repo from 'lib/miden/repo';

import { compareAccountIds } from '../activity/utils';
import { midenClientProxy } from '../back/miden-client-proxy';
import { ITransaction, ITransactionStatus, Transaction } from '../db/types';
import { withWasmClientLock } from '../sdk/miden-client';

/**
 * Token-scoped history filter. A swap row belongs to BOTH sides' token views:
 * it is filed under the offered `faucetId`, but it also delivers the requested
 * faucet — and the consume that settles that delivery is suppressed in history
 * (the swap row is the order's single trace), so without the requested-side
 * match the received funds would appear in no row of that token's history.
 */
const matchesTokenId = (tx: ITransaction, tokenId: string): boolean =>
  tx.faucetId === tokenId || (tx.type === 'swap' && tx.extraInputs?.requestedFaucetId === tokenId);

export const hasQueuedTransactions = async () => {
  const tx = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.Queued).toArray();
  return tx.length > 0;
};

export const getUncompletedTransactions = async (address: string, tokenId?: string) => {
  const statuses = [ITransactionStatus.Queued, ITransactionStatus.GeneratingTransaction];
  return await getTransactionsInStatuses(statuses, address, tokenId);
};

const getTransactionsInStatuses = async (statuses: ITransactionStatus[], accountId: string, tokenId?: string) => {
  let txs = await Repo.transactions.filter(rec => statuses.includes(rec.status)).toArray();
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  txs = txs.filter(tx => compareAccountIds(tx.accountId, accountId));
  if (tokenId) {
    txs = txs.filter(tx => matchesTokenId(tx, tokenId));
  }

  return txs;
};

export const getTransactionsInProgress = async (): Promise<Transaction[]> => {
  const txs = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.GeneratingTransaction).toArray();
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return txs;
};

export const getAllUncompletedTransactions = async () => {
  const txs = await Repo.transactions
    .filter(rec => rec.status === ITransactionStatus.GeneratingTransaction || rec.status === ITransactionStatus.Queued)
    .toArray();
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return txs;
};

export const getFailedTransactions = async () => {
  const transactions = await Repo.transactions.filter(tx => tx.status === ITransactionStatus.Failed).toArray();
  transactions.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return transactions;
};

export const getCompletedTransactions = async (
  accountId: string,
  offset?: number,
  limit?: number,
  includeFailed: boolean = false,
  tokenId?: string
) => {
  let transactions = await Repo.transactions.filter(tx => tx.status === ITransactionStatus.Completed).toArray();
  if (includeFailed) {
    const failedTransactions = await getFailedTransactions();
    transactions = transactions.concat(failedTransactions);
  }
  transactions.sort((tx1, tx2) => (tx1.completedAt || tx1.initiatedAt) - (tx2.completedAt || tx2.initiatedAt));
  // Compare ignoring note tag suffix since stored vs queried account IDs may differ
  transactions = transactions.filter(tx => compareAccountIds(tx.accountId, accountId));
  if (tokenId) {
    transactions = transactions.filter(tx => matchesTokenId(tx, tokenId));
  }
  return transactions.slice(offset, limit);
};

export const getTransactionById = async (id: string) => {
  const tx = await Repo.transactions.where({ id }).first();
  if (!tx) throw new Error('Transaction not found');
  return tx;
};

/** One completed consume transaction belonging to a swap-order settlement. */
export interface SwapSettlementTransaction {
  /** Local wallet transaction id, always available. */
  id: string;
  /** Submitted Miden transaction id, available after completion. */
  transactionId?: string;
  noteIds: string[];
  amount?: bigint;
  faucetId?: string;
  completedAt?: number;
}

/** Notes a swap order settled, grouped by how the settlement consume claimed them. */
export interface SwapSettlementNotes {
  /** Payback notes claimed on a fill — the requested funds arriving. */
  settled: string[];
  /** Remainder notes reclaimed after expiry — the unfilled tip coming back. */
  reclaimed: string[];
  /** Completed payback-consume transactions, used by the swap receipt. */
  settledTransactions: SwapSettlementTransaction[];
  /** Completed reclaim-consume transactions, used by the swap receipt. */
  reclaimedTransactions: SwapSettlementTransaction[];
}

/**
 * Note ids and completed-consume metadata belonging to a swap order.
 *
 * Those consume rows are suppressed in the history list (`suppressLinkedConsumes`
 * in `History.tsx`) so the order reads as a single swap row — which would
 * otherwise make their notes invisible. The detail page surfaces them here
 * instead. The receipt also needs each consume's amount, completion time and
 * submitted transaction id, so those fields stay grouped by consume alongside
 * the deduplicated note-id buckets. Rows are linked by
 * `extraInputs.swapOrderTxId`, tagged at queue time by
 * `reconcileSwapOrderNotes`; `swapSettleKind` splits payback claims from expiry
 * reclaims. Only completed consumes count — a queued or failed one has claimed
 * nothing yet.
 */
export const getSwapSettlementNotes = async (swapTxId: string): Promise<SwapSettlementNotes> => {
  const consumes = await Repo.transactions
    .filter(
      tx =>
        tx.type === 'consume' &&
        tx.status === ITransactionStatus.Completed &&
        tx.extraInputs?.swapOrderTxId === swapTxId
    )
    .toArray();

  const settled = new Set<string>();
  const reclaimed = new Set<string>();
  const settledTransactions: SwapSettlementTransaction[] = [];
  const reclaimedTransactions: SwapSettlementTransaction[] = [];
  // The receipt numbers fill rows by position, so the order has to be the order
  // they settled in — the Dexie scan yields rows by uuid, which would number a
  // multi-fill order arbitrarily and renumber it when a later fill lands. A row
  // without a completion stamp sorts last rather than first.
  // `completedAt` is a one-second local stamp and auto-consume settles batches
  // within a single tick, so ties are the common case rather than the edge. With
  // no tie-break the order fell through to the Dexie scan's primary-key order —
  // row UUIDs — so two fills in the same second were numbered arbitrarily, and
  // differently on every device. Break on the submitted chain id, which every
  // device agrees on.
  consumes.sort(
    (a, b) =>
      (a.completedAt ?? Infinity) - (b.completedAt ?? Infinity) ||
      (a.transactionId ?? a.id).localeCompare(b.transactionId ?? b.id)
  );
  // A note must be attributed to exactly one consume. Two completed rows can
  // name the same note — a broader batch overlapping an earlier claim — and
  // deduplicating only the id sets left the per-transaction arrays disagreeing
  // with them: the receipt drew the note twice, and a caller summing the rows'
  // amounts to infer the fill counted the same funds twice. The sort above is
  // deterministic, so "the earlier consume owns it" is a stable rule. A row
  // whose notes were all claimed earlier is that same claim seen again and is
  // dropped, rather than contributing its amount a second time.
  const claimed = new Set<string>();

  for (const tx of consumes) {
    const rawNoteIds = tx.noteIds ?? (tx.noteId != null ? [tx.noteId] : []);
    const noteIds = rawNoteIds.filter(noteId => !claimed.has(noteId));
    if (rawNoteIds.length > 0 && noteIds.length === 0) continue;
    for (const noteId of noteIds) claimed.add(noteId);

    // `amount` is an aggregate over every note on the row sharing the first
    // note's faucet (see the ConsumeTransaction constructor), so it is only a
    // fact about the row's WHOLE note list. Once part of that list has been
    // attributed to an earlier consume, the aggregate no longer describes what
    // is left, and reporting it anyway overstated the money: rows
    // `[n1] = 400` and `[n1,n2] = 600` were emitted as `[n1] = 400` and
    // `[n2] = 600`, so a caller summing them read 1000 where 600 arrived.
    // There is no per-note breakdown to split it with, so the honest value for
    // a partially attributed row is "unknown".
    const partiallyAttributed = noteIds.length !== rawNoteIds.length;
    const transaction = {
      id: tx.id,
      transactionId: tx.transactionId,
      noteIds,
      amount: partiallyAttributed ? undefined : tx.amount,
      faucetId: tx.faucetId,
      completedAt: tx.completedAt
    };
    const isReclaim = tx.extraInputs?.swapSettleKind === 'reclaim';
    const bucket = isReclaim ? reclaimed : settled;
    for (const noteId of noteIds) bucket.add(noteId);
    if (isReclaim) {
      reclaimedTransactions.push(transaction);
    } else {
      settledTransactions.push(transaction);
    }
  }

  return {
    settled: [...settled],
    reclaimed: [...reclaimed],
    settledTransactions,
    reclaimedTransactions
  };
};

/**
 * Lifecycle state of a swap order's PSWAP-note lineage, surfaced to the UI as
 * a stable string so the activity layer doesn't leak the wasm
 * `PswapLineageState` enum into React components:
 *   - active    : still fillable / reclaimable
 *   - filled    : fully filled (terminal)
 *   - reclaimed : reclaimed by the creator (terminal)
 *
 * From a live lineage, 'filled' means FULLY filled. The swap receipt reuses the
 * same values for a locally-inferred state when no lineage is resolvable, where
 * 'filled' is only "this wallet consumed a settlement note" — a weaker claim,
 * since an expiry batch carrying a partial payback is also tagged 'settle'. Any
 * reader of an inferred state must qualify it with the fill amount; see
 * `deriveSwapReceipt`, which is the only place that mixes the two.
 */
export type SwapOrderState = 'active' | 'filled' | 'reclaimed';

export interface SwapOrderTracking {
  /** Stable order id shared by every note in the lineage (decimal string). */
  orderId: string;
  state: SwapOrderState;
  /** 0 for the original PSWAP note, +1 per fill round. */
  currentDepth: number;
  /** Offered amount still unfilled on the current tip, in base units. */
  remainingOffered: bigint;
  /** Requested amount still outstanding on the current tip, in base units. */
  remainingRequested: bigint;
}

const pswapStateToOrderState = (state: PswapLineageState): SwapOrderState => {
  switch (state) {
    case PswapLineageState.FullyFilled:
      return 'filled';
    case PswapLineageState.Reclaimed:
      return 'reclaimed';
    default:
      return 'active';
  }
};

/**
 * Look up the live PSWAP lineage for a swap order so the activity detail page
 * can show how far the order has been filled. `orderId` is the value persisted
 * on the swap transaction's `extraInputs.orderId` by `completeSwapTransaction`.
 * Returns `null` when this client isn't tracking the order (e.g. not synced
 * yet).
 *
 * Routed through `midenClientProxy.getPswapLineage` (issue #260, slice 7a) so
 * flag-ON it reads the OFFSCREEN client's canonical synced lineage (the SW client
 * is dormant then and would report stale fill progress); flag-OFF is the
 * byte-identical inline `client.client.pswap.lineage` reduction under the caller
 * lock. The DTO's decimal-string amounts are re-widened to BigInt here.
 */
export const trackOrderId = async (orderId: string | bigint): Promise<SwapOrderTracking | null> => {
  return withWasmClientLock(async () => {
    const lineage = await midenClientProxy.getPswapLineage(orderId);
    if (!lineage) return null;
    return {
      orderId: lineage.orderId,
      state: pswapStateToOrderState(lineage.state as PswapLineageState),
      currentDepth: lineage.currentDepth,
      remainingOffered: BigInt(lineage.remainingOffered),
      remainingRequested: BigInt(lineage.remainingRequested)
    };
  });
};
