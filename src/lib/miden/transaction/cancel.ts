import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import * as Repo from 'lib/miden/repo';
import { isMobile } from 'lib/platform';

import {
  formatRawTransactionError,
  resolveTransactionErrorMessage,
  TRANSACTION_EXPIRED_ERROR,
  TRANSACTION_FORCE_CANCELLED_ERROR,
  TRANSACTION_INTERRUPTED_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  TRANSACTION_STUCK_ERROR,
  USER_CANCELLED_TRANSACTION_REASON
} from './constants';
import { getTransactionsInProgress } from './get';
import { updateTransactionStatus } from './helper';
import { midenClientProxy } from '../back/miden-client-proxy';
import { ConsumeTransaction, ITransactionStatus, Transaction } from '../db/types';
import { withWasmClientLock } from '../sdk/miden-client';

// On mobile, use a shorter timeout since there's no background processing
// On desktop extension, transactions can run in background tabs
export const MAX_WAIT_BEFORE_CANCEL = isMobile() ? 2 * 60 : 30 * 60; // 2 mins on mobile, 30 mins on desktop (in seconds)

// Maximum age for a queued transaction before it's considered stale and cancelled
export const MAX_QUEUED_AGE = 30 * 60; // 30 minutes (seconds)

export const cancelTransaction = async (transaction: Transaction, error: any, displayMessage: string = 'Failed') => {
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
    error === USER_CANCELLED_TRANSACTION_REASON || error === TRANSACTION_INTERRUPTED_ON_STARTUP
      ? error
      : resolveTransactionErrorMessage(error, failedStage, transaction.delegateTransaction);
  await Repo.transactions.where({ id: transaction.id }).modify(dbTx => {
    dbTx.completedAt = Math.floor(Date.now() / 1000); // Convert to seconds
    dbTx.status = ITransactionStatus.Failed;
    dbTx.error = displayError;
    // Keep the untouched thrown error around when the display message rewrote it.
    if (displayError !== rawError) dbTx.rawError = rawError;
    dbTx.displayMessage = displayMessage;
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
 * Fail every transaction still in `GeneratingTransaction`, regardless of age.
 *
 * Called from the extension's `browser.runtime.onStartup` handler, which fires
 * ONLY on a genuine browser/profile cold-start — never on a service-worker
 * idle-wake. Any row still `GeneratingTransaction` at that point is
 * definitionally orphaned: the tab/SW that was driving it died when the browser
 * closed, so nothing will ever resume it. The steady-state
 * `cancelStuckTransactions` reaper only ages these out after
 * `MAX_WAIT_BEFORE_CANCEL` (30 min on desktop) because `processingStartedAt` is
 * stamped to "now" at `generateTransaction`, so a send interrupted mid-prove
 * sits on "Sending" with no feedback for up to half an hour (issue #282).
 * Failing them immediately on startup closes that gap.
 *
 * We deliberately do NOT auto-retry. In the rare window where `submit()` landed
 * on chain but the browser died before the local apply/complete, the tx IS on
 * chain; resubmitting would trip the node's nullifier check. The next sync
 * reconciles that case — which is why the copy says "check your activity" rather
 * than promising nothing was submitted (the existing 30-min reaper already
 * marks that same edge case Failed, so this is not a new regression).
 */
export const failInterruptedTransactions = async () => {
  const transactions = await getTransactionsInProgress();
  await Promise.all(
    transactions.map(async tx =>
      cancelTransaction(tx, TRANSACTION_INTERRUPTED_ON_STARTUP, 'Interrupted — check your activity after it syncs')
    )
  );
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
 * The verdict of a node-authoritative check of whether a consume's input note
 * landed on chain as consumed:
 *   - `'landed'`     the note is in a CONSUMED_* state — the consume DID land.
 *   - `'not-landed'` the note still exists and is NOT consumed (Committed /
 *                    Expected / Unverified / Invalid) — the consume did NOT land.
 *   - `'unknown'`    no note row for the id, or the node query errored —
 *                    indeterminate (never treated as landed).
 */
export type ConsumeLandedVerdict = 'landed' | 'not-landed' | 'unknown';

/**
 * Node-authoritative check of whether a consume's input note landed on chain.
 *
 * A consume's input `noteId` is known BEFORE the write executes (it is stamped on
 * the tx row), and the note's on-chain consumed-state is the source of truth for
 * whether the consume actually landed — so this stays authoritative even when a
 * local `TransactionResult` was lost (e.g. an offscreen write deadline-killed with
 * `OperationAbortedError`, issue #260 follow-up #3a).
 *
 * Syncs first (best-effort: a sync failure falls back to the last-synced state,
 * which is still authoritative for a CONSUMED note — a consumed note never
 * reverts), then reads the input-note state from the node-backed client. Only a
 * CONSUMED_* state returns `'landed'`; any other existing state returns
 * `'not-landed'`; a missing note or a thrown error returns `'unknown'`.
 *
 * FUNDS-SAFETY: an error or any uncertainty NEVER returns `'landed'`, so a caller
 * can only ever mark a killed consume Completed when the node POSITIVELY confirms
 * the note is consumed — a false Completed is impossible.
 */
export const verifyConsumeLanded = async (tx: ConsumeTransaction): Promise<ConsumeLandedVerdict> => {
  try {
    // Best-effort fresh sync so the note state reflects the latest chain head. A
    // sync failure must not block the check: the last-synced state is still
    // authoritative for a CONSUMED note (it cannot un-consume), and for a
    // not-yet-consumed note it can only under-report "landed" → a safe Fail.
    try {
      await withWasmClientLock(async () => midenClientProxy.syncState());
    } catch (syncError) {
      console.warn('[verifyConsumeLanded] sync failed; reading last-synced note state for tx', tx.id, syncError);
    }

    const noteDetails = await withWasmClientLock(async () =>
      midenClientProxy.getInputNoteDetails({ ids: [tx.noteId] })
    );
    const note = noteDetails[0];
    if (!note) return 'unknown';
    return CONSUMED_NOTE_STATES.includes(note.state) ? 'landed' : 'not-landed';
  } catch (error) {
    console.error('[verifyConsumeLanded] error checking note state for tx', tx.id, error);
    return 'unknown';
  }
};

/**
 * Verify stuck transactions by checking note state from the node.
 * For consume transactions:
 * - If the note has been consumed on-chain, mark the transaction as completed
 * - If the note is still claimable AND the tx has been processing for > 1 minute, mark as failed
 *
 * IMPORTANT: Only checks GeneratingTransaction status, NOT Queued.
 * Queued transactions haven't started processing yet, so the note being claimable is expected.
 *
 * Delegates the per-tx node check to {@link verifyConsumeLanded} (the same
 * authority the killed-consume requeue uses, issue #260 follow-up #3a):
 *   - `'landed'`     → mark Completed.
 *   - `'not-landed'` → the note exists but is not consumed; fail only after the
 *                      processing grace window so an actively-processing consume
 *                      isn't reaped mid-flight.
 *   - `'unknown'`    → no note / query error → skip (leave for a later cycle).
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

  for (const tx of consumeTransactions) {
    const verdict = await verifyConsumeLanded(tx);

    if (verdict === 'landed') {
      // Note has been consumed on-chain - mark transaction as completed
      await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
        displayMessage: 'Received',
        completedAt: Math.floor(Date.now() / 1000)
      });
      resolvedCount++;
    } else if (verdict === 'not-landed') {
      // Note still exists but is not consumed - only cancel if the tx has been
      // processing for a while, so we don't reap one that is actively processing.
      const processingTime = tx.processingStartedAt ? Math.floor(Date.now() / 1000) - tx.processingStartedAt : 0;
      if (processingTime > MIN_PROCESSING_TIME_BEFORE_STUCK) {
        await cancelTransaction(tx, TRANSACTION_INTERRUPTED_ERROR);
        resolvedCount++;
      }
    }
    // 'unknown' (no note row / node query error) → leave for a later cycle.
  }

  return resolvedCount;
};
