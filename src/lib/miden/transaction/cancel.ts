import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import * as Repo from 'lib/miden/repo';
import { isMobile } from 'lib/platform';

import {
  formatRawTransactionError,
  INVALID_NOTE_ERROR,
  resolveTransactionErrorMessage,
  TRANSACTION_EXPIRED_ERROR,
  TRANSACTION_FORCE_CANCELLED_ERROR,
  TRANSACTION_INTERRUPTED_ERROR,
  TRANSACTION_STUCK_ERROR,
  USER_CANCELLED_TRANSACTION_REASON
} from './constants';
import { getTransactionsInProgress } from './get';
import { updateTransactionStatus } from './helper';
import { ConsumeTransaction, ITransactionStatus, Transaction } from '../db/types';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

// On mobile, use a shorter timeout since there's no background processing
// On desktop extension, transactions can run in background tabs
export const MAX_WAIT_BEFORE_CANCEL = isMobile() ? 2 * 60 : 30 * 60; // 2 mins on mobile, 30 mins on desktop (in seconds)

// Maximum age for a queued transaction before it's considered stale and cancelled
export const MAX_QUEUED_AGE = 30 * 60; // 30 minutes (seconds)

export const cancelTransaction = async (transaction: Transaction, error: any) => {
  // Refuse to downgrade a finalized transaction. A late error fired AFTER
  // completeXxxTransaction has already marked the tx Completed (most often
  // a transient guardian-canonicalization sync error) would otherwise flip
  // a perfectly-successful transaction to Failed and confuse the user.
  const existing = await Repo.transactions.where({ id: transaction.id }).first();
  if (existing && (existing.status === ITransactionStatus.Completed || existing.status === ITransactionStatus.Failed)) {
    console.warn(
      `[cancelTransaction] ignored — tx ${transaction.id} is already ${existing.status}; suppressed error:`,
      error
    );
    return;
  }

  // The stage the tx died in (persisted by setTransactionStage) disambiguates
  // otherwise-opaque SDK errors, e.g. a prover timeout during 'proving'.
  const failedStage = existing?.stage;
  const rawError = formatRawTransactionError(error);
  const displayError =
    error === USER_CANCELLED_TRANSACTION_REASON ? error : resolveTransactionErrorMessage(error, failedStage);
  await Repo.transactions.where({ id: transaction.id }).modify(dbTx => {
    dbTx.completedAt = Math.floor(Date.now() / 1000); // Convert to seconds
    dbTx.status = ITransactionStatus.Failed;
    dbTx.error = displayError;
    // Keep the untouched thrown error around when the display message rewrote it.
    if (displayError !== rawError) dbTx.rawError = rawError;
    dbTx.displayMessage = 'Failed';
    dbTx.displayIcon = 'FAILED';
  });
};

export const cancelTransactionById = async (id: string, error: any) => {
  const tx = await Repo.transactions.where({ id }).first();
  if (tx) await cancelTransaction(tx, error);
};

/**
 * Cancel all of the transactions (& their transitions) that are taking too long to process
 */
export const cancelStuckTransactions = async () => {
  const transactions = await getTransactionsInProgress();
  const cancelTransactionUpdates = transactions
    .filter(tx => {
      // Crashed before processing started — processingStartedAt is set atomically
      // with the status change, so undefined means the app crashed mid-transition
      if (!tx.processingStartedAt) return true;
      return Math.floor(Date.now() / 1000) - tx.processingStartedAt > MAX_WAIT_BEFORE_CANCEL;
    })
    .map(async tx => cancelTransaction(tx, TRANSACTION_STUCK_ERROR));

  await Promise.all(cancelTransactionUpdates);
};

/**
 * Cancel queued transactions that have been waiting too long (TTL expired)
 */
export const cancelStaleQueuedTransactions = async () => {
  const queued = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.Queued).toArray();
  const stale = queued.filter(tx => Math.floor(Date.now() / 1000) - tx.initiatedAt > MAX_QUEUED_AGE);
  await Promise.all(stale.map(tx => cancelTransaction(tx, TRANSACTION_EXPIRED_ERROR)));
};

/**
 * TEMPORARY: Force cancel ALL in-progress transactions regardless of time.
 * Used for debugging stuck transactions on mobile.
 */
export const forceCaneclAllInProgressTransactions = async () => {
  const transactions = await getTransactionsInProgress();
  const cancelTransactionUpdates = transactions.map(async tx =>
    cancelTransaction(tx, TRANSACTION_FORCE_CANCELLED_ERROR)
  );
  await Promise.all(cancelTransactionUpdates);
};

/**
 * InputNoteState values that indicate a note has been consumed
 */
const CONSUMED_NOTE_STATES = [
  InputNoteState.ConsumedAuthenticatedLocal,
  InputNoteState.ConsumedUnauthenticatedLocal,
  InputNoteState.ConsumedExternal
];

// Minimum time a transaction must be in GeneratingTransaction status before we consider it "stuck"
// This prevents cancelling transactions that are actively being processed
const MIN_PROCESSING_TIME_BEFORE_STUCK = 60; // 1 minute (in seconds)

/**
 * Verify stuck transactions by checking note state from the node.
 * For consume transactions:
 * - If the note has been consumed on-chain, mark the transaction as completed
 * - If the note is invalid, mark as failed
 * - If the note is still claimable AND the tx has been processing for > 1 minute, mark as failed
 *
 * IMPORTANT: Only checks GeneratingTransaction status, NOT Queued.
 * Queued transactions haven't started processing yet, so the note being claimable is expected.
 *
 * Returns the number of transactions that were resolved.
 */
export const verifyStuckTransactionsFromNode = async (): Promise<number> => {
  // Only check GeneratingTransaction status - NOT Queued
  // Queued transactions haven't started processing yet, so the note being claimable is expected
  const inProgressTransactions = await getTransactionsInProgress();
  if (inProgressTransactions.length === 0) return 0;

  // Filter to only consume transactions with a noteId
  const consumeTransactions = inProgressTransactions.filter(
    (tx): tx is ConsumeTransaction => tx.type === 'consume' && !!(tx as ConsumeTransaction).noteId
  );

  if (consumeTransactions.length === 0) return 0;

  let resolvedCount = 0;

  // Check each stuck consume transaction (AutoSync handles syncState separately)
  for (const tx of consumeTransactions) {
    try {
      const noteDetails = await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        return await midenClient.getInputNoteDetails({ ids: [tx.noteId] });
      });

      const note = noteDetails[0];
      if (!note) {
        continue;
      }

      if (CONSUMED_NOTE_STATES.includes(note.state)) {
        // Note has been consumed on-chain - mark transaction as completed
        await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
          displayMessage: 'Received',
          completedAt: Math.floor(Date.now() / 1000)
        });
        resolvedCount++;
      } else if (note.state === InputNoteState.Invalid) {
        // Note is invalid - mark transaction as failed
        await cancelTransaction(tx, INVALID_NOTE_ERROR);
        resolvedCount++;
      } else if (
        note.state === InputNoteState.Committed ||
        note.state === InputNoteState.Expected ||
        note.state === InputNoteState.Unverified
      ) {
        // Note is still claimable - only cancel if tx has been processing for a while
        // This prevents cancelling transactions that are actively being processed
        const processingTime = tx.processingStartedAt ? Math.floor(Date.now() / 1000) - tx.processingStartedAt : 0;
        if (processingTime > MIN_PROCESSING_TIME_BEFORE_STUCK) {
          await cancelTransaction(tx, TRANSACTION_INTERRUPTED_ERROR);
          resolvedCount++;
        }
      }
    } catch (err) {
      console.error('[verifyStuckTransactionsFromNode] Error checking tx:', tx.id, err);
    }
  }

  return resolvedCount;
};
