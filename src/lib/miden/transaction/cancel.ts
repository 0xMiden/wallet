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
import { clearCancelledInFlight, markCancelledInFlight, markMayHaveSubmitted, updateTransactionStatus } from './helper';
import { notifyBackgroundTransactionFailed } from '../back/background-notification';
import { midenClientProxy } from '../back/miden-client-proxy';
import { isOperationAbortedError } from '../back/offscreen-codec';
import { ConsumeTransaction, ITransactionStatus, Transaction } from '../db/types';
import { withWasmClientLock } from '../sdk/miden-client';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';

// On mobile, use a shorter timeout since there's no background processing
// On desktop extension, transactions can run in background tabs
export const MAX_WAIT_BEFORE_CANCEL = isMobile() ? 2 * 60 : 30 * 60; // 2 mins on mobile, 30 mins on desktop (in seconds)

// Maximum age for a queued transaction before it's considered stale and cancelled
export const MAX_QUEUED_AGE = 30 * 60; // 30 minutes (seconds)

/**
 * Returns whether the row was actually failed. `false` means a concurrent writer
 * moved it out from under this call, so the caller's own account of what it did
 * — a log line, a notification — should not claim the row was failed.
 *
 * @param onlyIfStatus When given, the row is failed ONLY if it still holds this
 * status at write time, checked inside the Dexie `modify` so the check and the
 * write cannot be interleaved. The `existing` read below is a separate
 * transaction from that write, which is enough to reject a row that was ALREADY
 * terminal, but says nothing about one that becomes terminal in between. A
 * caller holding the loop lock excludes the other loop DRIVERS — not a user
 * cancel, which takes no lock — and the requeue wake's ceiling holds nothing at
 * all: it can have a Queued row picked up and advanced to
 * `GeneratingTransaction` in the gap, and failing THAT row would report a
 * failure for a pipeline still running, which can still submit.
 *
 * The terminal check is re-run at write time for EVERY caller, gated or not,
 * because the same gap runs the other way: a pipeline that commits `Completed`
 * between the read and the write would otherwise be overwritten with `Failed`,
 * turning a settled send into a reported failure. That direction needs no opt-in
 * — no caller has a reason to fail a row that finished.
 */
export const cancelTransaction = async (
  transaction: Transaction,
  error: any,
  displayMessage: string = 'Failed',
  onlyIfStatus?: ITransactionStatus
) => {
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
    return false;
  }

  // The stage the tx died in (persisted by setTransactionStage) disambiguates
  // otherwise-opaque SDK errors, e.g. a prover timeout during 'proving'.
  const failedStage = existing?.stage;
  const rawError = formatRawTransactionError(error);
  const displayError =
    error === USER_CANCELLED_TRANSACTION_REASON || error === TRANSACTION_INTERRUPTED_ON_STARTUP
      ? error
      : resolveTransactionErrorMessage(error, failedStage, transaction.delegateTransaction);
  let applied = false;
  let racedTerminal = false;
  await Repo.transactions.where({ id: transaction.id }).modify(dbTx => {
    // `false`, not a bare return: Dexie treats `undefined` as "modified" and
    // issues a put of the unchanged clone, which is a pointless write and a
    // spurious event for anything observing the table.
    if (dbTx.status === ITransactionStatus.Completed || dbTx.status === ITransactionStatus.Failed) {
      racedTerminal = true;
      return false;
    }
    if (onlyIfStatus !== undefined && dbTx.status !== onlyIfStatus) return false;
    applied = true;
    dbTx.completedAt = Math.floor(Date.now() / 1000); // Convert to seconds
    dbTx.status = ITransactionStatus.Failed;
    dbTx.error = displayError;
    // Keep the untouched thrown error around when the display message rewrote it.
    if (displayError !== rawError) dbTx.rawError = rawError;
    dbTx.displayMessage = displayMessage;
    dbTx.displayIcon = 'FAILED';
    return undefined;
  });
  if (racedTerminal) {
    console.warn(
      `[cancelTransaction] ignored — tx ${transaction.id} went terminal between this call's ` +
        'read and its write; suppressed error:',
      error
    );
    return false;
  }
  if (!applied) {
    // The reason is branched because this line is the ONLY record of a row that
    // vanished. For an ungated caller that is the only way to get here at all,
    // and reporting it as "no longer undefined" says nothing about what
    // happened. Either way the call failed nothing and notified no one.
    console.warn(
      `[cancelTransaction] skipped — tx ${transaction.id} ` +
        (onlyIfStatus === undefined
          ? 'was absent when the write ran'
          : `was no longer ${onlyIfStatus}, or was absent, when the guarded write ran`) +
        '; the row was not failed and no notification was raised. Suppressed error:',
      error
    );
    return false;
  }

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
  return true;
};

/**
 * Fail a row from OUTSIDE its pipeline, noting that the pipeline is still
 * running and may yet submit.
 *
 * A cancel marks the row; it does not abort the work in flight. The pipeline
 * runs on and can still submit, and both writes that would have recorded that
 * are refused because the row is now terminal: the `setStage('submitting')` the
 * retry guard reads, and the completion write that captures the transaction id.
 * The row is left frozen at whichever pre-submit stage the cancel caught it in,
 * and Retry reads exactly that as proof nothing was broadcast — then rebuilds
 * the request with a fresh note serial and pays the recipient twice.
 *
 * The GUARDIAN leaves stamp `mayHaveSubmitted` before submitting, through the
 * terminal row, so a crossing that happens there IS recorded — but only from the
 * moment the leaf reaches it: a cancel during execute or prove lands earlier, and
 * Retry is one tap away on the same screen. `cancelledInFlightAt` covers that
 * window and then expires — see its docstring for why a sticky flag here was
 * wrong.
 *
 * Read that scope literally. A send from a NON-guardian account stamps nothing at
 * all: its leaf calls straight through to the proxy, and the row it leaves behind
 * is frozen at the 'sending' its pipeline stamped once at pickup. For those rows
 * this marker is not a supplement to a recorded crossing, it is the only signal
 * there is, which is why `requeueFailedTransaction` refuses on it rather than
 * merely holding bytes, and why the residual gap documented there is the shape it
 * is.
 *
 * Deliberately NOT used by the pipeline's own catch handlers, which instead
 * CLEAR the marker: by the time those run the pipeline has stopped. That
 * asymmetry is what still lets a genuine execute or prove failure rebuild its
 * request — the rebuild this guard exists to gate, not to prevent.
 */
const cancelWhilePipelineMayStillRun = async (tx: Transaction, error: any) => {
  // Only a `send` reaches the retry path this protects. The in-flight half of the
  // condition — that there is a pipeline to outlive the cancel at all, rather
  // than a Queued row never picked up — is re-tested inside
  // `markCancelledInFlight` against the committed row, because deciding it from
  // this snapshot can strand a marker on a pipeline that has already stopped.
  if (tx.type === 'send') {
    // Before the cancel: if that throws, the row is still guarded.
    await markCancelledInFlight(tx.id);
  }
  await cancelTransaction(tx, error);
};

/**
 * Fail a row from INSIDE its pipeline's catch. The pipeline has stopped, so a
 * submit is no longer merely possible — resolve the in-flight marker a
 * concurrent Cancel may have left, and let the request be rebuilt.
 *
 * Safe on the guardian paths because the ordering there is one-way: those leaves
 * stamp `mayHaveSubmitted` before they submit, so any attempt that got that far
 * is already recorded on a field this does not touch.
 *
 * A plain send has no such stamp — it is not that the marker is redundant there,
 * it is that nothing else exists — so clearing it returns the row to "no evidence
 * either way", which is what lets the vault-slot failure rebuild and is also the
 * limit `requeueFailedTransaction` documents.
 *
 * With ONE exception, and it is the reason this takes the error rather than just
 * the row. An offscreen wedge-kill does not report a failure — it destroys the
 * realm mid-operation and rejects whatever was in flight. The whole of
 * execute → prove → submit → apply is one killable op there, so a kill says
 * nothing about which side of the submit it landed on, and the result that would
 * have carried the transaction id died with the realm. For a `send` that is the
 * one shape that reaches Retry with neither a cached request pinning the note id
 * nor an id to ask the node about, so it is recorded as a real crossing —
 * permanently, because the ambiguity never resolves — and `requeueFailedTransaction`
 * refuses it rather than rebuilding a second payment. Narrow by construction: an
 * ordinary failure, including the vault-slot rejection this release fixes, is not
 * an aborted op and still rebuilds.
 */
/**
 * Stages a row can be in where NO write has been built yet, so an abandoned
 * pipeline provably cannot submit (issue #775).
 *
 * `generateTransaction`'s first act is a locked `syncState()`, taken while the
 * row still reads 'syncing' — 'sending' is only stamped once that sync returns.
 * That sync has no JS-level timeout, which makes it one of the likeliest places
 * for a watchdog eviction to land, and it is unambiguously pre-write.
 *
 * Deliberately a one-element list rather than a general "is this before submit"
 * test. `mayHaveSubmitted` is permanent and `requeueFailedTransaction` refuses
 * on it, so a wrong "cleared" is a double payment while a wrong "recorded" is
 * only a refused Retry. Every stage whose pre-write property is not provable
 * from the stage alone therefore keeps recording.
 */
const PRE_WRITE_STAGES: ReadonlySet<string> = new Set(['syncing']);

export const cancelTransactionAfterPipelineStopped = async (tx: Transaction, error: any) => {
  // A lock-recovery eviction (issue #775) is treated like an offscreen
  // wedge-kill: the pipeline was ABANDONED, not stopped — it may still reach
  // submit — so the crossing must be recorded, never cleared. EXCEPT where the
  // row never got as far as building a write: recording there would permanently
  // refuse Retry on a send that demonstrably never touched the chain, which is
  // the cost a false-positive eviction would otherwise impose.
  //
  // The stage comes from the COMMITTED row, not from `tx`: callers pass the
  // snapshot they picked the transaction up with, which still carries the stage
  // it held at pickup rather than the one the failure happened in.
  let abandonedPreWrite = false;
  if (isWasmClientPoisonedError(error)) {
    const committed = await Repo.transactions.where({ id: tx.id }).first();
    abandonedPreWrite = PRE_WRITE_STAGES.has(committed?.stage ?? '');
  }
  if (
    tx.type === 'send' &&
    !abandonedPreWrite &&
    (isOperationAbortedError(error) || isWasmClientPoisonedError(error))
  ) {
    await markMayHaveSubmitted(tx.id);
    if (isWasmClientPoisonedError(error)) {
      // A poison eviction ABANDONS the pipeline — unlike an offscreen kill it
      // may still submit AFTER this row is Failed, so the permanent crossing
      // above is not enough: the user's acknowledgement ("it never arrived")
      // can be true when given and wrong a minute later. Stamp the TIME-BOUNDED
      // liveness marker too; the retry guard refuses even an acknowledged retry
      // until the pipeline provably cannot still be running. Ordered before
      // `cancelTransaction` below, while the row is still in-flight, because
      // this marker's writer refuses terminal rows.
      await markCancelledInFlight(tx.id);
    }
  } else {
    await clearCancelledInFlight(tx.id);
  }
  await cancelTransaction(tx, error);
};

export const cancelTransactionById = async (id: string, error: any) => {
  const tx = await Repo.transactions.where({ id }).first();
  if (tx) await cancelWhilePipelineMayStillRun(tx, error);
};

/**
 * Seconds the app spent backgrounded since `sinceSeconds` that must NOT count as
 * elapsed pipeline time. On mobile the WebView main thread is frozen while
 * backgrounded, so frozen time is not real processing time (issue #473).
 * Desktop keeps running in background tabs, so there is nothing to discount —
 * the single `isMobile()` guard for the whole feature lives here.
 *
 * Used against two different marks — a row's `processingStartedAt` and its
 * `cancelledInFlightAt` — because both are compared against the same
 * `MAX_WAIT_BEFORE_CANCEL` and so must be measured on the same clock.
 */
const hiddenSecondsForTx = (sinceSeconds: number): number => (isMobile() ? hiddenSecondsSince(sinceSeconds) : 0);

/**
 * True while `cancelledInFlightAt` still means "the pipeline might submit".
 *
 * Bounded by the same threshold the stuck reaper uses, which is the app's own
 * statement of the longest a pipeline can plausibly still be alive — and
 * therefore measured on the same clock the reaper measures it on. That is not
 * wall clock. On mobile the WebView main thread is frozen while backgrounded, so
 * the reaper discounts hidden time and `MAX_WAIT_BEFORE_CANCEL` is a bound on
 * ACTIVE seconds; a pipeline's wall-clock age is, as `background-time.ts` puts
 * it, "effectively unbounded on mobile". Comparing wall clock against an
 * active-time bound made the two disagree about the very same row: cancel a send
 * on a phone, background the app for ten minutes, and the marker lapsed while the
 * suspended pipeline was still there to resume and submit — so Retry rebuilt with
 * a fresh note serial and paid the recipient twice, which is the whole failure
 * this marker exists to prevent.
 *
 * The magnitude of the discrepancy is what is bounded, not its sign. A stamp
 * cannot be written in the future, so a future one means the clock moved
 * backwards afterwards (or the row was restored from elsewhere): a small skew
 * stays live, erring toward funds safety, while a wildly inconsistent stamp is
 * treated as telling us nothing rather than as "live forever", which would refuse
 * the row's retries for the entire span of the discrepancy.
 */
export const pipelineMayStillBeRunning = (cancelledInFlightAt: number | undefined): boolean => {
  if (cancelledInFlightAt === undefined) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const activeElapsed = nowSeconds - cancelledInFlightAt - hiddenSecondsForTx(cancelledInFlightAt);
  return Math.abs(activeElapsed) <= MAX_WAIT_BEFORE_CANCEL;
};

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
    // Marked in-flight like any other cancel from outside the pipeline, because
    // that is what this is. `MAX_WAIT_BEFORE_CANCEL` is the app's threshold for
    // "waited long enough to stop showing the user a spinner", NOT for "no
    // pipeline can still be alive" — nothing here aborts the work, a prove can
    // legitimately run past it (mobile writes have no deadline at all), and the
    // reaper's own arithmetic is what defines the threshold as ACTIVE seconds, so
    // a row it takes may have been running for far longer in wall-clock terms and
    // still be running now. This used to skip the marker on the strength of that
    // premise, which left the widest version of the very window the marker exists
    // for: reaped, still submitting, and retried as though nothing had been sent.
    //
    // Skipping it was safe only under a second claim — that a submit this row DID
    // reach is on `mayHaveSubmitted` — and that one holds for the guardian leaves
    // but not for a plain send, which stamps nothing (see
    // `cancelTransactionAfterPipelineStopped`). Marking costs little now that the
    // marker expires and is scoped to rows with something to protect: Retry waits
    // out the window instead of being refused for good.
    .map(async tx => cancelWhilePipelineMayStillRun(tx, TRANSACTION_STUCK_ERROR));

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

/**
 * The two states miden-client writes in `apply_transaction`, i.e. AFTER a
 * consuming transaction of ours was submitted and applied locally but before its
 * block is committed. They mean the OPPOSITE of "not consumed", so they must
 * never reach the `'not-landed'` catch-all — a caller that terminal-fails on
 * `'not-landed'` would fail a claim whose submit already reached the node.
 */
const PROCESSING_NOTE_STATES = [InputNoteState.ProcessingAuthenticated, InputNoteState.ProcessingUnauthenticated];

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
 *   - `'processing'`      the note is `ProcessingAuthenticated` /
 *                         `ProcessingUnauthenticated` — a consuming transaction of
 *                         OURS was submitted and applied locally, and its block is
 *                         not committed yet. In flight, not failed: within a few
 *                         blocks it becomes a consumed state or reverts to
 *                         `Committed`, so the caller must leave the row alone and
 *                         re-ask, never terminal-fail it.
 *   - `'not-landed'`      the note still exists and is not consumed or in flight
 *                         (Committed / Expected / Unverified) — the consume did
 *                         NOT land.
 *   - `'unknown'`         no note row for the id, or the node query errored —
 *                         indeterminate (never treated as landed).
 */
export type ConsumeLandedVerdict =
  | 'landed-local'
  | 'landed-external'
  | 'invalid'
  | 'processing'
  | 'not-landed'
  | 'unknown';

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
 * `'landed-external'` (consumed, but not provably mine) so the caller decides; no
 * caller marks it Received — neither the killed-consume path nor the stuck-consume
 * reaper. A missing note or a thrown error yields `'unknown'`; an error or any
 * uncertainty NEVER yields `'landed-local'`, so a false Received is impossible.
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
    // Checked BEFORE the catch-all: a Processing* note is mid-flight, not unspent.
    if (PROCESSING_NOTE_STATES.includes(note.state)) return 'processing';
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
 *
 * COVERAGE LIMIT — read before relying on this as the only double-send guard.
 * `ITransaction.transactionId` is written ONLY by the completion handlers in
 * `complete.ts` (the success path) and by `updateBridgedReceivePhase`. A row
 * failed by a route that killed it from OUTSIDE its own write pipeline — the
 * stuck reaper, the cold-start sweep, an offscreen deadline kill, a user Cancel
 * mid-flight — therefore arrives here with no id at all and short-circuits to
 * `'unknown'`, i.e. this check is INERT on exactly the rows whose submit outcome
 * is in doubt. Stamping the id pre-submit is not currently possible under
 * `MIDEN_USE_OFFSCREEN_CLIENT`: the write runs in the offscreen realm and its
 * DTOs carry no row id. `isSubmitOutcomeUnknown` (constants.ts) is what closes
 * that gap, by refusing the retry outright for the rebuilt-request types.
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
 *   - `'landed-local'` → mark Completed. FUNDS-SAFETY: this is the ONLY verdict that
 *                      may become a 'Received' row, exactly as on the killed-consume
 *                      path (see tryCompleteKilledConsume). This reaper is the sole
 *                      consume reconciler on mobile and desktop — its one caller
 *                      returns early on `isExtension()` and `tryCompleteKilledConsume`
 *                      fires only on the Chrome-offscreen `OperationAbortedError` — so
 *                      a lenient rule here would be the ONLY rule those platforms run.
 *   - `'landed-external'` → the note is consumed on chain but NOT provably by us (a
 *                      recallable P2IDE the sender recalled, or another consumer of
 *                      the same public note, lands in that state). Treated exactly
 *                      like `'not-landed'`: failed after the processing grace window,
 *                      never Completed. The residual is a SAFE false-Failed — a
 *                      re-consume harmlessly collides on the spent nullifier and the
 *                      next sync reconciles — instead of a false 'Received' telling
 *                      the user they got funds a third party actually took.
 *   - `'invalid'`    → fail IMMEDIATELY with INVALID_NOTE_ERROR: an Invalid note can
 *                      never be consumed, so there is no reason to wait out the grace
 *                      window and surface the generic interrupted error instead.
 *   - `'processing'` → a consuming tx of ours is submitted and applied locally but
 *                      not committed yet → skip (leave for a later cycle). Failing
 *                      it would terminal-fail a claim that already reached the
 *                      node — and on a Guardian account that is the COMMON path,
 *                      because `runGuardianPipeline` releases the WASM lock after
 *                      `submit()`/`apply()` and only then runs a multi-second
 *                      `service.sync()`, leaving the row `GeneratingTransaction`
 *                      and this reaper free to read the note mid-window.
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

    if (verdict === 'landed-local') {
      // The node confirms the note is consumed on chain by THIS client's own tracked
      // tx - mark the transaction completed. 'landed-external' deliberately does NOT
      // reach here (see the funds-safety note above).
      //
      // Wrapped because `updateTransactionStatus` throws on a row that is already
      // terminal, including one a concurrent writer finalized mid-loop. This
      // reaper is the only consume reconciler off-extension and runs on a 3s
      // interval whose caller does not catch, so an unhandled throw here both
      // abandons the remaining rows for the cycle and surfaces as an unhandled
      // rejection. A row someone else already settled needs no reconciling.
      try {
        await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
          displayMessage: 'Received',
          completedAt: Math.floor(Date.now() / 1000)
        });
        resolvedCount++;
      } catch (e) {
        // Deliberately not diagnosed as "no longer in progress": the throw is
        // also what a deleted row ('No transaction found to update') and a real
        // Dexie failure produce, and this line has not checked which. Naming a
        // cause it does not have is the defect the ceiling's log was fixed for.
        console.warn(`[verifyStuckTransactions] could not complete ${tx.id}; it may have been settled or removed`, e);
      }
    } else if (verdict === 'invalid') {
      // Note is invalid - it can never be consumed, so fail immediately with the
      // specific reason instead of waiting out the grace window (restores the
      // fast-fail the #3a refactor accidentally collapsed into 'not-landed').
      // Counted only if the row was actually failed. `resolvedCount` is what
      // this function returns and what `useClaimNotes` reports, so counting a
      // refused write — a row a concurrent driver already settled — overstates
      // what the reaper did.
      if (await cancelTransaction(tx, INVALID_NOTE_ERROR)) resolvedCount++;
    } else if (verdict === 'not-landed' || verdict === 'landed-external') {
      // Either the note is not consumed at all, or it is consumed by someone who is
      // not provably us ('landed-external'). Both mean this consume did not
      // demonstrably land, so only cancel once the tx has been processing for a
      // while, so we don't reap one that is actively processing.
      // Use ACTIVE (foreground) processing time so a consume that merely sat
      // backgrounded on mobile isn't reaped on resume (issue #473).
      const processingTime = tx.processingStartedAt
        ? activeProcessingSeconds(tx.processingStartedAt, Math.floor(Date.now() / 1000))
        : 0;
      if (processingTime > MIN_PROCESSING_TIME_BEFORE_STUCK) {
        if (await cancelTransaction(tx, TRANSACTION_INTERRUPTED_ERROR)) resolvedCount++;
      }
    }
    // 'unknown' (no note row / node query error) and 'processing' (our own consume
    // is submitted and applied locally, awaiting commit) both fall through here →
    // leave for a later cycle. Do NOT fold 'processing' into the 'not-landed' arm:
    // that note IS spent by a transaction of ours that reached the node.
  }

  return resolvedCount;
};
