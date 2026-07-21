import * as Repo from 'lib/miden/repo';

import {
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionIcon,
  ITransactionStatus,
  ITransactionType
} from '../db/types';

/**
 * Types whose failed row can simply be re-queued through the FIFO loop.
 * Structural Guardian ops (replace-hot-key / switch-guardian /
 * update-procedure-threshold) are deliberately excluded — re-running them
 * blind can mint orphan hardware keys or re-register a stale guardian; the
 * user re-initiates those from Settings instead.
 */
const REQUEUEABLE_TYPES: ITransactionType[] = ['send', 'consume', 'swap', 'bridged-send', 'earn-deposit', 'execute'];

/** Pre-failure display icon per type (mirrors the Transaction subclass constructors). */
const ICON_BY_TYPE: Partial<Record<ITransactionType, ITransactionIcon>> = {
  send: 'SEND',
  consume: 'RECEIVE',
  swap: 'SWAP',
  'bridged-send': 'SEND',
  'earn-deposit': 'DEFAULT',
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
 * stale-queued TTL doesn't cancel the retry on sight.
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
    dbTx.error = undefined;
    dbTx.rawError = undefined;
    dbTx.displayMessage = undefined;
    dbTx.displayIcon = ICON_BY_TYPE[dbTx.type] ?? 'DEFAULT';
  });
};

/**
 * Retry the RECEIVE side of a failed Smart Withdraw: the redeem intent is
 * already on Epoch (nonce recorded), so flip the row back to non-terminal and
 * let `resumeEarnWithdrawal` re-register the bridge-in and restart delivery
 * polling. Only meaningful when the intent nonce exists — a row that failed
 * before submission has nothing on the EVM side to wait for.
 */
export const retryEarnWithdrawReceive = async (txId: string): Promise<void> => {
  const tx = await Repo.transactions.where({ id: txId }).first();
  if (!tx || tx.type !== 'earn-withdraw') throw new Error(`Transaction ${txId} is not an earn-withdraw`);
  const ei = tx.extraInputs as IEarnWithdrawExtraInputs;
  if (ei.phase !== 'failed') return;
  if (!ei.withdrawIntentNonce) {
    throw new Error('The withdrawal never reached Epoch — retry is not possible; start a new withdrawal.');
  }

  await Repo.transactions.where({ id: txId }).modify((dbTx: ITransaction) => {
    const inputs = dbTx.extraInputs as IEarnWithdrawExtraInputs;
    dbTx.extraInputs = { ...inputs, phase: 'redeeming', error: undefined };
    dbTx.error = undefined;
  });

  // Re-registers the bridge-in (idempotent) and restarts the delivery poll.
  // Dynamic import: lib/epoch statically imports lib/miden/activity, which
  // re-exports this module — a static import here would be circular.
  const { resumeEarnWithdrawal } = await import('lib/epoch');
  await resumeEarnWithdrawal(txId);
};

// NOTE: a failed `bridged-receive` (EVM → Miden) is deliberately NOT retryable:
// its failure modes are EVM-side (reverted source tx, failed Epoch intent) or a
// pre-submit interruption — nothing the wallet can replay. Miden → EVM bridges
// (`bridged-send`) ARE retryable via `requeueFailedTransaction` above, since the
// Miden-side send is ours to re-run.
