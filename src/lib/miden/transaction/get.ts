import { PswapLineageState } from '@miden-sdk/miden-sdk/lazy';

import * as Repo from 'lib/miden/repo';

import { compareAccountIds } from '../activity/utils';
import { ITransaction, ITransactionStatus, Transaction } from '../db/types';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

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

/**
 * Lifecycle state of a swap order's PSWAP-note lineage, surfaced to the UI as
 * a stable string so the activity layer doesn't leak the wasm
 * `PswapLineageState` enum into React components:
 *   - active    : still fillable / reclaimable
 *   - filled    : fully filled (terminal)
 *   - reclaimed : reclaimed by the creator (terminal)
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
 * yet). Reads IndexedDB via the wasm client, so it takes the client lock.
 */
export const trackOrderId = async (orderId: string | bigint): Promise<SwapOrderTracking | null> => {
  return withWasmClientLock(async () => {
    const client = await getMidenClient();
    const lineage = await client.client.pswap.lineage(orderId);
    if (!lineage) return null;
    return {
      orderId: lineage.orderId(),
      state: pswapStateToOrderState(lineage.state()),
      currentDepth: lineage.currentDepth(),
      remainingOffered: lineage.remainingOffered(),
      remainingRequested: lineage.remainingRequested()
    };
  });
};
