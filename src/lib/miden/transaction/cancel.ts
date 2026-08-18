import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import * as Repo from 'lib/miden/repo';
import { hiddenSecondsSince } from 'lib/mobile/background-time';
import { isMobile } from 'lib/platform';

import {
  formatRawTransactionError,
  INVALID_NOTE_ERROR,
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
import { notifyBackgroundTransactionFailed } from '../back/background-notification';
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

  // Gap 6: a transaction that terminally failed while the user wasn't watching
  // used to be silent — the row went to Failed and nothing told them. Notify,
  // but NEVER for a user-initiated cancel or a startup/teardown interruption
  // (those aren't failures the user needs alerting to). The notifier itself
  // no-ops off the extension and when a wallet popup is already open, so this is
  // a safe unconditional call for a genuine failure.
  const isGenuineFailure =
    error !== USER_CANCELLED_TRANSACTION_REASON &&
    error !== TRANSACTION_INTERRUPTED_ON_STARTUP &&
    error !== TRANSACTION_INTERRUPTED_ERROR;
  if (isGenuineFailure) notifyBackgroundTransactionFailed();
};

export const cancelTransactionById = async (id: string, error: any) => {
  const tx = await Repo.transactions.where({ id }).first();
  if (tx) await cancelTransaction(tx, error);
};

/**
 * Seconds the app spent backgrounded since `processingStartedAt` that must NOT
 * count as processing time. On mobile the WebView main thread is frozen while
 * backgrounded, so frozen time is not real processing time (issue #473).
 * Desktop keeps running in background tabs, so there is nothing to discount —
 * the single `isMobile()` guard for the whole feature lives here.
 */
const hiddenSecondsForTx = (processingStartedAt: number): number =>
  isMobile() ? hiddenSecondsSince(processingStartedAt) : 0;

/**
 * Whole seconds a transaction has spent ACTIVELY processing since
 * `processingStartedAt`, i.e. wall-clock elapsed minus backgrounded time.
 */
const activeProcessingSeconds = (processingStartedAt: number, nowSeconds: number): number =>
  nowSeconds - processingStartedAt - hiddenSecondsForTx(processingStartedAt);

/**
 * Pure stuck-decision: a tx is stuck if it never started processing (crashed
 * mid-transition → `processingStartedAt` undefined) or its ACTIVE (foreground)
 * processing time has exceeded `maxWaitSeconds`. `hiddenSeconds` is the
 * backgrounded time to discount (0 on desktop).
 */
export function isTransactionStuck(
  processingStartedAt: number | undefined,
  nowSeconds: number,
  hiddenSeconds: number,
  maxWaitSeconds: number
): boolean {
  // Crashed before processing started — processingStartedAt is set atomically
  // with the status change, so undefined means the app crashed mid-transition.
  if (!processingStartedAt) return true;
  const activeElapsed = nowSeconds - processingStartedAt - hiddenSeconds;
  return activeElapsed > maxWaitSeconds;
}

/**
 * Cancel all of the transactions (& their transitions) that are taking too long to process
 */
export const cancelStuckTransactions = async () => {
  const transactions = await getTransactionsInProgress();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cancelTransactionUpdates = transactions
    .filter(tx => {
      const hidden = tx.processingStartedAt ? hiddenSecondsForTx(tx.processingStartedAt) : 0;
      return isTransactionStuck(tx.processingStartedAt, nowSeconds, hidden, MAX_WAIT_BEFORE_CANCEL);
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
 * InputNoteState values that indicate a note was consumed by THIS client's own
 * tracked transaction — provably "my consume landed": the local consuming tx is
 * recorded in the store, so the nullifier on chain is unambiguously ours.
 *
 * Deliberately EXCLUDES `ConsumedExternal`: there the nullifier is on chain but
 * the consuming tx was NOT submitted by this client, so it is NOT provably mine
 * (a reclaimable P2IDE the sender reclaimed lands in exactly that state). A killed
 * consume must never be shown as 'Received' on an external-consumed note, or the
 * user would be told they received funds a third party actually took.
 */
const LOCAL_CONSUMED_NOTE_STATES = [
  InputNoteState.ConsumedAuthenticatedLocal,
  InputNoteState.ConsumedUnauthenticatedLocal
];

// Minimum time a transaction must be in GeneratingTransaction status before we consider it "stuck"
// This prevents cancelling transactions that are actively being processed
const MIN_PROCESSING_TIME_BEFORE_STUCK = 60; // 1 minute (in seconds)

/**
 * The verdict of a node-authoritative check of whether a consume's input note
 * landed on chain as consumed:
 *   - `'landed-local'`    the note is in a LOCAL consumed state
 *                         (`ConsumedAuthenticatedLocal` / `ConsumedUnauthenticatedLocal`) —
 *                         provably consumed by THIS client's own tracked tx. The
 *                         ONLY verdict on which a killed consume may be marked
 *                         Completed / 'Received' (funds-visibility safe).
 *   - `'landed-external'` the note is `ConsumedExternal` — its nullifier is on
 *                         chain but the consuming tx was NOT submitted by this
 *                         client, so it is consumed by *someone* yet NOT provably
 *                         mine (a reclaimable P2IDE could have been reclaimed by
 *                         its sender). Ambiguous for funds-visibility.
 *   - `'invalid'`         the note is `Invalid` (e.g. nullifier reused / never
 *                         committed) — the consume can never land; fail fast.
 *   - `'not-landed'`      the note still exists and is not consumed (Committed /
 *                         Expected / Unverified) — the consume did NOT land.
 *   - `'unknown'`         no note row for the id, or the node query errored —
 *                         indeterminate (never treated as landed).
 */
export type ConsumeLandedVerdict = 'landed-local' | 'landed-external' | 'invalid' | 'not-landed' | 'unknown';

/**
 * Node-authoritative check of whether a consume's input note landed on chain.
 *
 * A consume's input `noteId` is known BEFORE the write executes (it is stamped on
 * the tx row), and the note's on-chain consumed-state is the source of truth for
 * whether the consume actually landed — so this stays authoritative even when a
 * local `TransactionResult` was lost (e.g. an offscreen write deadline-killed with
 * `OperationAbortedError`, issue #260 follow-up #3a).
 *
 * When `sync` is true, best-effort syncs first so the note state reflects the
 * latest chain head (a sync failure falls back to the last-synced state, which is
 * still authoritative for a consumed note — a consumed note never reverts). The
 * immediate killed-consume path passes `true` because it resolves ONE tx and wants
 * the freshest state before deciding; the background reaper passes `false` because
 * it runs alongside AutoSync and must NOT fire one sync per stuck consume (that
 * would be N syncs/cycle where the pre-#3a reaper did 0).
 *
 * Maps the node-backed note state to a {@link ConsumeLandedVerdict}. FUNDS-SAFETY:
 * only a LOCAL consumed state (provably this client's own tracked consume) yields
 * `'landed-local'`, the sole verdict a caller may treat as "my consume landed" and
 * surface as Completed / 'Received'. `ConsumedExternal` is reported separately as
 * `'landed-external'` (consumed, but not provably mine) so the caller decides; the
 * killed-consume path never marks it Received. A missing note or a thrown error
 * yields `'unknown'`; an error or any uncertainty NEVER yields `'landed-local'`, so
 * a false Received is impossible.
 */
export const verifyConsumeLanded = async (tx: ConsumeTransaction, sync: boolean): Promise<ConsumeLandedVerdict> => {
  try {
    if (sync) {
      // Best-effort fresh sync so the note state reflects the latest chain head. A
      // sync failure must not block the check: the last-synced state is still
      // authoritative for a consumed note (it cannot un-consume), and for a
      // not-yet-consumed note it can only under-report "landed" → a safe Fail.
      try {
        await withWasmClientLock(async () => midenClientProxy.syncState());
      } catch (syncError) {
        console.warn('[verifyConsumeLanded] sync failed; reading last-synced note state for tx', tx.id, syncError);
      }
    }

    const noteDetails = await withWasmClientLock(async () =>
      midenClientProxy.getInputNoteDetails({ ids: [tx.noteId] })
    );
    const note = noteDetails[0];
    if (!note) return 'unknown';
    if (LOCAL_CONSUMED_NOTE_STATES.includes(note.state)) return 'landed-local';
    if (note.state === InputNoteState.ConsumedExternal) return 'landed-external';
    if (note.state === InputNoteState.Invalid) return 'invalid';
    return 'not-landed';
  } catch (error) {
    console.error('[verifyConsumeLanded] error checking note state for tx', tx.id, error);
    return 'unknown';
  }
};

/**
 * The verdict of a node-authoritative check of whether a send/swap/execute
 * already landed on chain:
 *   - `'landed'`  the tx's captured `transactionId` is committed OR pending
 *                 (submitted) on the node — its effect already happened, so a
 *                 Retry must NOT resubmit it (that would be a double-send).
 *   - `'unknown'` no captured `transactionId`, or the node/client has no record
 *                 of it — INDETERMINATE. We cannot prove it landed, so the caller
 *                 keeps the funds-safe default (surface it, don't auto-complete).
 */
export type SendLandedVerdict = 'landed' | 'unknown';

/**
 * Node-authoritative idempotency check for the value-moving, output-producing
 * types (send / swap / bridged-send / execute), so a manual Retry never
 * resubmits a transaction whose original submit actually landed (double-send —
 * a real fund-loss). Keyed on the tx row's captured `transactionId` (stamped by
 * the completion path). A committed OR pending record → `'landed'` (the tx is on
 * chain or in the mempool; resending would duplicate it). No id, or an id the
 * client has no record of, → `'unknown'` (never treated as landed, but also
 * never proven not-landed — the caller must not silently complete it).
 *
 * Mirrors {@link verifyConsumeLanded} (which checks the INPUT note's consumed
 * state) but for the OUTPUT side, via the tx id. Best-effort syncs first for the
 * freshest node state; a sync failure falls back to the last-synced record.
 */
export const verifySendLanded = async (tx: { id: string; transactionId?: string }): Promise<SendLandedVerdict> => {
  if (!tx.transactionId) return 'unknown';
  const txId = tx.transactionId;
  try {
    try {
      await withWasmClientLock(async () => midenClientProxy.syncState());
    } catch (syncError) {
      console.warn('[verifySendLanded] sync failed; reading last-synced tx state for', tx.id, syncError);
    }
    const state = await withWasmClientLock(async () => midenClientProxy.getTransactionCommitState(txId));
    return state === 'committed' || state === 'pending' ? 'landed' : 'unknown';
  } catch (error) {
    console.error('[verifySendLanded] error checking tx state for', tx.id, error);
    return 'unknown';
  }
};

/**
 * Verify stuck transactions by checking note state from the node.
 * For consume transactions:
 * - If the note has been consumed on-chain, mark the transaction as completed
 * - If the note is invalid, mark as failed immediately
 * - If the note is still claimable AND the tx has been processing for > 1 minute, mark as failed
 *
 * IMPORTANT: Only checks GeneratingTransaction status, NOT Queued.
 * Queued transactions haven't started processing yet, so the note being claimable is expected.
 *
 * Delegates the per-tx node check to {@link verifyConsumeLanded} (the same
 * authority the killed-consume requeue uses, issue #260 follow-up #3a). Passes
 * `sync: false`: this reaper runs alongside AutoSync (which keeps note state
 * fresh), so it must NOT fire one sync per stuck consume — matching its pre-#3a
 * behavior of 0 syncs/cycle.
 *   - `'landed-local'` / `'landed-external'` → mark Completed. The reaper treats an
 *                      external-consumed note as landed too — a lower-exposure,
 *                      pre-existing behavior (the note IS consumed on chain, and
 *                      the reaper is not the funds-visibility-critical path). The
 *                      strict "provably mine" rule is enforced only on the immediate
 *                      killed-consume path (see tryCompleteKilledConsume).
 *   - `'invalid'`    → fail IMMEDIATELY with INVALID_NOTE_ERROR: an Invalid note can
 *                      never be consumed, so there is no reason to wait out the grace
 *                      window and surface the generic interrupted error instead.
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
    // sync: false — this reaper rides AutoSync; syncing per stuck consume would be
    // N syncs/cycle where the pre-#3a reaper did 0 (see verifyConsumeLanded).
    const verdict = await verifyConsumeLanded(tx, false);

    if (verdict === 'landed-local' || verdict === 'landed-external') {
      // Note has been consumed on-chain - mark transaction as completed. The reaper
      // (unlike the killed-consume path) treats an external-consumed note as landed
      // too: a lower-exposure, pre-existing behavior the #3a refactor must preserve.
      await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
        displayMessage: 'Received',
        completedAt: Math.floor(Date.now() / 1000)
      });
      resolvedCount++;
    } else if (verdict === 'invalid') {
      // Note is invalid - it can never be consumed, so fail immediately with the
      // specific reason instead of waiting out the grace window (restores the
      // fast-fail the #3a refactor accidentally collapsed into 'not-landed').
      await cancelTransaction(tx, INVALID_NOTE_ERROR);
      resolvedCount++;
    } else if (verdict === 'not-landed') {
      // Note still exists but is not consumed - only cancel if the tx has been
      // processing for a while, so we don't reap one that is actively processing.
      // Use ACTIVE (foreground) processing time so a consume that merely sat
      // backgrounded on mobile isn't reaped on resume (issue #473).
      const processingTime = tx.processingStartedAt
        ? activeProcessingSeconds(tx.processingStartedAt, Math.floor(Date.now() / 1000))
        : 0;
      if (processingTime > MIN_PROCESSING_TIME_BEFORE_STUCK) {
        await cancelTransaction(tx, TRANSACTION_INTERRUPTED_ERROR);
        resolvedCount++;
      }
    }
    // 'unknown' (no note row / node query error) → leave for a later cycle.
  }

  return resolvedCount;
};
