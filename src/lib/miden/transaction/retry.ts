import * as Repo from 'lib/miden/repo';

import { ITransaction, ITransactionIcon, ITransactionStatus, ITransactionType } from '../db/types';

/**
 * Types whose failed row can simply be re-queued through the FIFO loop.
 * Structural Guardian ops (replace-hot-key / switch-guardian /
 * update-procedure-threshold) are deliberately excluded — re-running them
 * blind can mint orphan hardware keys or re-register a stale guardian; the
 * user re-initiates those from Settings instead.
 */
const REQUEUEABLE_TYPES: ITransactionType[] = ['send', 'consume', 'swap', 'execute'];

/** Pre-failure display icon per type (mirrors the Transaction subclass constructors). */
const ICON_BY_TYPE: Partial<Record<ITransactionType, ITransactionIcon>> = {
  send: 'SEND',
  consume: 'RECEIVE',
  swap: 'SWAP',
  execute: 'DEFAULT'
};

/** Whether a Failed row can be retried by re-queueing it through the loop. */
export const isRequeueableTransaction = (tx: { status?: ITransactionStatus; type: ITransactionType }): boolean =>
  tx.status === ITransactionStatus.Failed && REQUEUEABLE_TYPES.includes(tx.type);

/**
 * Retry a Failed transaction by resetting its row to `Queued` so the FIFO
 * processing loop picks it up again. The row keeps its id (and, for swaps,
 * its persisted `requestBytes` — the retry reuses the exact same request,
 * which the PSWAP flow requires). `initiatedAt` is refreshed so the
 * stale-queued TTL doesn't cancel the retry on sight, and `nextEligibleAt`
 * is cleared so a stale requeue-backoff can't delay the user's explicit retry.
 */
export const requeueFailedTransaction = async (txId: string): Promise<void> => {
  const tx = await Repo.transactions.where({ id: txId }).first();
  if (!tx) throw new Error(`Transaction ${txId} not found`);
  if (!isRequeueableTransaction(tx)) {
    throw new Error(`Transaction ${txId} (${tx.type}) is not retryable`);
  }

  await Repo.transactions.where({ id: txId }).modify((dbTx: ITransaction) => {
    dbTx.status = ITransactionStatus.Queued;
    dbTx.initiatedAt = Math.floor(Date.now() / 1000);
    dbTx.processingStartedAt = undefined;
    dbTx.completedAt = undefined;
    dbTx.stage = undefined;
    dbTx.nextEligibleAt = undefined;
    dbTx.error = undefined;
    dbTx.rawError = undefined;
    dbTx.displayMessage = undefined;
    dbTx.displayIcon = ICON_BY_TYPE[dbTx.type] ?? 'DEFAULT';
  });
};
