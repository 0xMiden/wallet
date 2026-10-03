import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import { isGuardianWriteDiscardedError } from 'lib/miden/guardian/direct-switch';
import * as Repo from 'lib/miden/repo';
import { syncBeforeVerdict } from 'lib/miden/sync-lock';
import { hiddenSecondsSince } from 'lib/mobile/background-time';
import { isMobile } from 'lib/platform';
import { classifyError } from 'lib/telemetry/classify';
import { reportOperation } from 'lib/telemetry/report-operation';
import { elapsedMsSince, operationOfType, stepOfStage } from 'lib/telemetry/transaction-operation';

import {
  formatRawTransactionError,
  INVALID_NOTE_ERROR,
  isUnconfirmedFailure,
  isUnconfirmedFailureReason,
  isWalletFailureReason,
  resolveTransactionErrorMessage,
  TRANSACTION_EXPIRED_ERROR,
  TRANSACTION_FORCE_CANCELLED_ERROR,
  TRANSACTION_INTERRUPTED_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  TRANSACTION_STUCK_ERROR,
  USER_CANCELLED_TRANSACTION_REASON
} from './constants';
import { getTransactionsInProgress } from './get';
import {
  clearCancelledInFlight,
  markCancelledInFlight,
  markMayHaveSubmitted,
  recordKillEnd,
  recordOutOfBandEnd,
  updateTransactionStatus
} from './helper';
import { canAwaitVerdict, upsertEvidenceEntry } from './verdict-rules';
import {
  notifyBackgroundTransactionFailed,
  notifyBackgroundTransactionNotConfirmed
} from '../back/background-notification';
import { midenClientProxy } from '../back/miden-client-proxy';
import { ConsumeTransaction, hasLeftQueue, ITransaction, ITransactionStatus, Transaction } from '../db/types';
import { assertWasmHoldCurrent, withWasmClientLock } from '../sdk/miden-client';
import {
  indefiniteSubmitTransactionId,
  isIndefiniteSubmitOutcomeError,
  isKilledPipeline,
  isPoisonedPipeline
} from '../sdk/sdk-error-code';

// On mobile, use a shorter timeout since there's no background processing
// On desktop extension, transactions can run in background tabs
export const MAX_WAIT_BEFORE_CANCEL = isMobile() ? 2 * 60 : 30 * 60; // 2 mins on mobile, 30 mins on desktop (in seconds)

// Maximum age for a queued transaction before it's considered stale and cancelled
export const MAX_QUEUED_AGE = 30 * 60; // 30 minutes (seconds)

/**
 * The stored failure text for `error` on this row: the message the classifier writes (or a wallet reason verbatim)
 * and the untouched thrown text. Shared by `cancelTransaction` and the Unconfirmed write so one failure never reads
 * two ways (#1081).
 */
const describeFailure = (
  transaction: Pick<ITransaction, 'delegateTransaction'>,
  error: unknown,
  existing: ITransaction | undefined
): { displayError: string; rawError: string } => {
  // The stage the tx died in (persisted by setTransactionStage) disambiguates
  // otherwise-opaque SDK errors, e.g. a prover timeout during 'proving'.
  const failedStage = existing?.stage;
  const rawError = formatRawTransactionError(error);
  // The same structural pre-write finding `cancelTransactionAfterPipelineStopped` uses to
  // withhold the may-have-submitted crossing, re-derived HERE from the row the caller
  // already read, so the message and the crossing can never disagree: hedging "left in an
  // unknown state, check your activity" on a row whose Retry is provably safe is a
  // falsehood that costs the user the retry.
  const abandonedPreWrite =
    PRE_WRITE_STAGES.has(failedStage ?? '') && existing !== undefined && existing.processingStartedAt === undefined;
  // A reason the wallet itself wrote, final or unconfirmed, is stored exactly as written, whatever the row's
  // stage: running it through the stage classifier below would relabel it as prover copy (see 'proving' in
  // classifyTransactionError) and move the real reason to rawError, which is what let a stuck or interrupted
  // claim read as a completed failure instead of not confirmed.
  const displayError =
    typeof error === 'string' && (isWalletFailureReason(error) || isUnconfirmedFailureReason(error))
      ? error
      : resolveTransactionErrorMessage(error, failedStage, transaction.delegateTransaction, abandonedPreWrite);
  return { displayError, rawError };
};

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
  // An Unconfirmed row is refused too: a late reaper, sweep or cancel must not settle an unknown outcome (#1081).
  const existing = await Repo.transactions.where({ id: transaction.id }).first();
  if (existing && hasLeftQueue(existing)) {
    console.warn(
      `[cancelTransaction] ignored — tx ${transaction.id} is already ${existing.status}; suppressed error:`,
      error
    );
    return false;
  }

  const failedStage = existing?.stage;
  const { displayError, rawError } = describeFailure(transaction, error, existing);
  const nodeDiscarded = isGuardianWriteDiscardedError(error);
  let applied = false;
  let racedTerminal = false;
  let committed: ITransaction | undefined;
  await Repo.transactions.where({ id: transaction.id }).modify(dbTx => {
    // `false`, not a bare return: Dexie treats `undefined` as "modified" and
    // issues a put of the unchanged clone, which is a pointless write and a
    // spurious event for anything observing the table.
    if (hasLeftQueue(dbTx)) {
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
    // The node's verdict is recorded in the write that fails the row, so no reader sees it unmarked (#1233).
    if (nodeDiscarded) dbTx.extraInputs = { ...dbTx.extraInputs, nodeDiscarded: true };
    // Copied from the row this write is committing, not from the `existing` read
    // above it, so a submit stamp that lands between that read and this write is
    // seen by the notice below (#1250).
    committed = { ...dbTx };
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
  // used to be silent - the row went to Failed and nothing told them. Notify the
  // row the modify above committed, worded by the same rule every reader of a
  // Failed row shares (#1250): failed for certain, or outcome unknown (see
  // isUnconfirmedFailure). NEVER for a user-initiated cancel or the cold-start
  // sweep (TRANSACTION_INTERRUPTED_ON_STARTUP) - those aren't failures the user
  // needs alerting to - nor for the node check's not-landed consume
  // (TRANSACTION_INTERRUPTED_ERROR), excluded because the user cannot act on it,
  // not because it is a startup or teardown interruption. The notifier itself
  // no-ops off the extension and when a wallet popup is already open, so this is
  // a safe unconditional call for a genuine failure.
  const isGenuineFailure =
    error !== USER_CANCELLED_TRANSACTION_REASON &&
    error !== TRANSACTION_INTERRUPTED_ON_STARTUP &&
    error !== TRANSACTION_INTERRUPTED_ERROR;
  if (isGenuineFailure) {
    // Decided on the row the modify above committed, in the same Dexie write that
    // failed it, never from the `existing` read before it - so a submit stamp
    // committed between that read and this write is seen. `applied` guarantees
    // `committed` is set here; TypeScript cannot see that, hence the runtime
    // check. A stamp that commits AFTER this write cannot change a notice already
    // shown.
    if (committed !== undefined && isUnconfirmedFailure(committed)) notifyBackgroundTransactionNotConfirmed();
    else notifyBackgroundTransactionFailed();
  }

  // A NARROWER gate than the notification's, and the difference is the point.
  // A user-initiated cancel and the cold-start sweep genuinely are not failures,
  // and counting them would put a floor under the error rate that no amount of
  // fixing could lower.
  //
  // `TRANSACTION_INTERRUPTED_ERROR` is on the notification's list and must not be
  // on this one, because it is not an interruption - the name is a leftover from
  // the user-facing copy. Its single caller is `verifyStuckTransactionsFromNode`
  // below, which reaches it only after asking the node and being told the input
  // note is still unconsumed on a consume that has been processing past the grace
  // window. It is still reported as errored, because the node saw the input note
  // unconsumed when it checked - suppressing it would undercount `tx_receive`
  // failures by exactly the share the reaper resolves, the ones nothing else
  // reports either, since by definition no pipeline catch ran for them. The row's
  // outcome stays unknown rather than failed, because its caller fails a consume
  // without stopping it; that is why it is in UNCONFIRMED_FAILURE_REASONS and
  // readers show the row as not confirmed. Staying quiet in the notification tray
  // is a UX judgement about an outcome the user cannot act on; it says nothing
  // about whether the failure happened.
  //
  // The stage is why this is the right place to report from - by here the row has
  // recorded where it died, which is the difference between "the prover is down"
  // and "the node rejected it". `existing` also gates it: if the row was gone,
  // the `.modify` above matched nothing and no transaction was failed, so there
  // is no outcome to report.
  const isReportableFailure =
    error !== USER_CANCELLED_TRANSACTION_REASON && error !== TRANSACTION_INTERRUPTED_ON_STARTUP;
  if (isReportableFailure && existing !== undefined) {
    reportOperation({
      operation: operationOfType(transaction.type),
      result: 'errored',
      durationMs: elapsedMsSince(existing.initiatedAt),
      errorKind: classifyError(rawError),
      step: stepOfStage(failedStage)
    });
  }
  return true;
};

/**
 * Enter `Unconfirmed` (#1081): the submit came back without a definite outcome, so the row waits for the node's
 * verdict instead of failing. One `modify`, applied only while the row is still GeneratingTransaction (the race
 * `cancelTransaction` describes); a row already terminal keeps its state and only gains the attempt's entry. The
 * cancel-in-flight window ends on every path. Raises the not-confirmed notice and an `errored` report, as the Failed
 * write does for an unconfirmed row today.
 */
export const markTransactionUnconfirmed = async (tx: ITransaction, error: unknown): Promise<void> => {
  const existing = await Repo.transactions.where({ id: tx.id }).first();
  const { displayError, rawError } = describeFailure(tx, error, existing);
  const transactionId = indefiniteSubmitTransactionId(error);
  const nowSec = Math.floor(Date.now() / 1000);
  let entered = false;
  await Repo.transactions.where({ id: tx.id }).modify(row => {
    const attemptId = row.attemptId ?? tx.attemptId;
    const windowOpen = row.cancelledInFlightAt !== undefined;
    if (attemptId !== undefined) {
      row.submitEvidence = upsertEvidenceEntry(
        row.submitEvidence,
        attemptId,
        {
          source: 'error-text',
          evidence: transactionId === undefined ? undefined : { transactionId },
          fromExecute: row.type === 'execute'
        },
        nowSec
      );
    }
    // Every caller is the pipeline's own catch, so the pipeline has stopped even on a row a cancel already failed: a
    // window left open would refuse its Retry as possibly still running.
    row.cancelledInFlightAt = undefined;
    if (row.status !== ITransactionStatus.GeneratingTransaction) {
      return attemptId === undefined && !windowOpen ? false : undefined;
    }
    row.status = ITransactionStatus.Unconfirmed;
    row.completedAt = nowSec;
    row.mayHaveSubmitted = true;
    row.error = displayError;
    if (displayError !== rawError) row.rawError = rawError;
    entered = true;
    return undefined;
  });
  if (!entered) return;
  notifyBackgroundTransactionNotConfirmed();
  reportOperation({
    operation: operationOfType(tx.type),
    result: 'errored',
    durationMs: elapsedMsSince(existing?.initiatedAt ?? tx.initiatedAt),
    errorKind: classifyError(rawError),
    step: stepOfStage(existing?.stage)
  });
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
 * Read that scope literally. Every leaf of a row that can await a verdict stamps
 * its crossing with the attempt's evidence (#1081), but an offscreen stamp is
 * replayed late and can be lost with its realm, so until it lands this marker is
 * the only signal there is, which is why `requeueFailedTransaction` refuses on it
 * rather than merely holding bytes. The cancel also ends the attempt's entry
 * (`recordOutOfBandEnd`), which is what liveness reads for a swap or an execute.
 *
 * Deliberately NOT used by the pipeline's own catch handlers, which instead
 * CLEAR the marker: by the time those run the pipeline has stopped. That
 * asymmetry is what still lets a genuine execute or prove failure rebuild its
 * request — the rebuild this guard exists to gate, not to prevent.
 */
const cancelWhilePipelineMayStillRun = async (tx: Transaction, error: any) => {
  // Before the cancel, while the row is still in flight: liveness reads this end, never the source (#1081).
  await recordOutOfBandEnd(tx.id);
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
 * Safe because the ordering is one-way: every leaf of a row that can await a
 * verdict records its crossing on the attempt's evidence entry before it submits,
 * or, offscreen, gets an 'end' entry for a failure it cannot place before its
 * submit (#1081), so any attempt that got that far is on a field this does not
 * touch. A run that failed earlier returns to "no evidence either way", which is
 * what lets the vault-slot failure rebuild.
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
 * Its SDK call still carries no transport deadline, and the hold is now bounded
 * by the 2-minute sync watchdog rather than the 5-minute backstop, which together
 * make it one of the likeliest places for an eviction to land — and it is
 * unambiguously pre-write.
 *
 * Deliberately a one-element list rather than a general "is this before submit"
 * test. `mayHaveSubmitted` is permanent and `requeueFailedTransaction` refuses
 * on it, so a wrong "cleared" is a double payment while a wrong "recorded" is
 * only a refused Retry. Every stage whose pre-write property is not provable
 * from the stage alone therefore keeps recording.
 *
 * Membership here is necessary but not sufficient — the caller also requires
 * `processingStartedAt` to be absent, so the exemption rests on the write stamp
 * never having run rather than on this name alone. Note that is NOT the same as
 * "the FIFO has not picked the row up": the pre-flight sync runs after pickup,
 * with the row still `Queued` and the stamp still unset.
 */
const PRE_WRITE_STAGES: ReadonlySet<string> = new Set(['syncing']);

export const cancelTransactionAfterPipelineStopped = async (tx: Transaction, error: any) => {
  // An unknown submit outcome waits for the node's verdict instead of failing (#1081). Only an eligible row: the
  // rest keep today's Failed tail and #1250's derived label. A kill never classifies here (see the classifier).
  if (isIndefiniteSubmitOutcomeError(error) && canAwaitVerdict(tx)) {
    await markTransactionUnconfirmed(tx, error);
    return;
  }
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
  //
  // Applied to BOTH kill classifications, not just the eviction. The pre-flight
  // sync can end either way — a watchdog eviction locally, or an
  // `OperationAbortedError` when the offscreen realm's dispatch deadline fires —
  // and both arrive from the identical point, before any request exists. Gating
  // the exemption on the poison shape alone therefore recorded a permanent
  // crossing for one half of the same event, which is the mirror of the bug the
  // exemption exists to prevent: a send that demonstrably never touched the
  // chain, refusable only by an acknowledgement the user has no way to make
  // truthfully.
  //
  // `processingStartedAt` is checked alongside the stage to make the exemption
  // STRUCTURAL rather than conventional. What makes 'syncing' provably pre-write
  // is that it is only ever committed while the row has not been picked up:
  // `updateTransactionStatus` stamps `processingStartedAt` and stage 'sending'
  // in one Dexie `modify`, so `(GeneratingTransaction, 'syncing')` never lands.
  // That invariant is load-bearing but spread across four files, so any future
  // writer that stamps 'syncing' on a picked-up row would silently turn a
  // refused retry into a permitted one — a double payment. Re-deriving it here
  // costs nothing and fails in the safe direction (record, not clear).
  //
  // Both kill classifications read the whole cause chain: a caller wrapping the kill
  // does not stop the pipeline it abandoned (#1313).
  const killed = isKilledPipeline(error);
  let abandonedPreWrite = false;
  if (killed) {
    const committed = await Repo.transactions.where({ id: tx.id }).first();
    abandonedPreWrite = PRE_WRITE_STAGES.has(committed?.stage ?? '') && committed?.processingStartedAt === undefined;
  }
  // The kill route marks the attempt's end for every type (#1081): the abandoned pipeline may still submit, and the
  // live-sibling and liveness rules read this end. The send-only flag below is unchanged.
  if (killed && !abandonedPreWrite) await recordKillEnd(tx.id, tx.attemptId);
  if (tx.type === 'send' && !abandonedPreWrite && killed) {
    await markMayHaveSubmitted(tx.id);
    if (isPoisonedPipeline(error)) {
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
 *
 * Signed on purpose: a stamp ahead of the clock is never stuck here, so a clock
 * step back cannot reap a row that is still live, whoever started or drives it.
 * `cancelStuckTransactions` calls only this, so a far-future stamp is never
 * reaped there; only the cold-start sweep, `failInterruptedTransactions`, fails
 * one, through `hasUnexplainedFutureStamp`.
 */
export function isTransactionStuck(
  processingStartedAt: number | undefined,
  nowSeconds: number,
  hiddenSeconds: number,
  maxWaitSeconds: number
): boolean {
  // Crashed before processing started: processingStartedAt is set atomically
  // with the status change, so undefined means the app crashed mid-transition.
  if (!processingStartedAt) return true;
  const activeElapsed = nowSeconds - processingStartedAt - hiddenSeconds;
  return activeElapsed > maxWaitSeconds;
}

/**
 * Cancel all of the transactions (& their transitions) that are taking too long to process, per
 * `isTransactionStuck`'s signed comparison alone, as on main: a stamp ahead of the clock is never
 * reaped here, whoever started or drives the row. Only the cold-start sweep,
 * `failInterruptedTransactions`, fails a row on that basis, where a cold start leaves no other realm
 * running for the stamp to belong to; the trade-off is that a live row stamped ahead of the clock sits
 * here until the clock steps back past the threshold and catches back up to it. The clock is read
 * after the table read, as the sweep reads it.
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
    // pipeline can still be alive": nothing here aborts the work, a prove can
    // legitimately run past it (mobile writes have no deadline at all), and the
    // reaper's own arithmetic is what defines the threshold as ACTIVE seconds, so
    // a row it takes may have been running for far longer in wall-clock terms and
    // still be running now. This used to skip the marker on the strength of that
    // premise, which left the widest version of the very window the marker exists
    // for: reaped, still submitting, and retried as though nothing had been sent.
    //
    // Skipping it was safe only under a second claim (that a submit this row DID
    // reach is already recorded), and an offscreen stamp is replayed late and can
    // be lost with its realm, so the claim fails exactly when the reaper fires.
    // Marking costs little now that the marker expires and is scoped to rows with
    // something to protect: Retry waits out the window instead of being refused for
    // good. The attempt's out-of-band end is recorded before it (#1081).
    .map(async tx => cancelWhilePipelineMayStillRun(tx, TRANSACTION_STUCK_ERROR));

  await Promise.all(cancelTransactionUpdates);
};

/**
 * Cancel queued transactions that have been waiting too long (TTL expired)
 */
export const cancelStaleQueuedTransactions = async () => {
  const queued = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.Queued).toArray();
  const stale = queued.filter(
    tx => !tx.awaitingRecoverySeed && Math.floor(Date.now() / 1000) - tx.initiatedAt > MAX_QUEUED_AGE
  );
  await Promise.all(stale.map(tx => cancelTransaction(tx, TRANSACTION_EXPIRED_ERROR)));
};

/**
 * When this realm loaded the transaction module, in the whole seconds `processingStartedAt` uses.
 * `failInterruptedTransactions` spares, by id, the rows this realm started, whatever the clock does,
 * and spares any other row only when its stamp lies in a window from this cutoff to
 * `MAX_WAIT_BEFORE_CANCEL` past the sweep's own second, which covers the rows another realm of this
 * session started. `generateTransactionWithProvider` (index.ts, which imports this module) is the only
 * writer of the Queued to GeneratingTransaction transition and stamps `processingStartedAt` in that
 * write. For a row another realm started the stamp is all the sweep has. A stamp later than the sweep's
 * second means the clock moved backwards after it: within the reaper's threshold it may be a live row
 * another realm of this session stamped, so it is spared and left to the reaper, which reaps a dead one
 * within the skew plus the threshold (`isTransactionStuck`), the allowance `pipelineMayStillBeRunning`
 * gives `cancelledInFlightAt`. Beyond it the stamp tells nothing and the row fails here in the sweep
 * (`hasUnexplainedFutureStamp`): a trade-off, not a proof, since another realm's live row after a clock
 * step that large would fail too, accepted because no second realm stamps rows today. The reaper never
 * fails such a row, whoever started or drives it; it waits out a clock step back past the threshold
 * instead. A row an earlier process or browser session started is stamped before the cutoff unless it
 * was stamped in the second this realm loaded or the clock stepped back across the restart; such a row
 * inside the window is spared and falls to the age-gated reaper.
 */
export const SESSION_STARTED_AT = Math.floor(Date.now() / 1000);

// Keeps one id per row this realm started, for the realm's life: any sweep this realm runs must spare them.
// One sweep per realm is the norm (runtime.onStartup on the extension, the OrphanedTransactionRecovery latch
// elsewhere), and a second is documented as safe only because the ids stay. Pruning at terminal writes would
// couple the sweep to every status writer to save a few bytes per transaction.
const startedInThisRealm = new Set<string>();

/**
 * Records that this realm is driving the row `id`, so `failInterruptedTransactions` spares it whatever
 * the clock does. `generateTransactionWithProvider` calls it just before its GeneratingTransaction write.
 */
export const markStartedInThisRealm = (id: string): void => {
  startedInThisRealm.add(id);
};

/**
 * True for a row this realm did not start whose `processingStartedAt` lies more than
 * `MAX_WAIT_BEFORE_CANCEL` past `nowSeconds`, a clock the caller read after its table read. Used by
 * the cold-start sweep alone, `failInterruptedTransactions`, where a cold start leaves no other realm
 * running for the stamp to belong to; the steady-state reaper, `cancelStuckTransactions`, never calls
 * this, since a live row here could belong to another realm of the same session. A stamp is written at
 * its writer's "now", so one that far ahead means the clock stepped back after it, and it tells nothing
 * about a row this realm is not driving. That is a trade-off, not a proof: another realm's live row
 * after a clock step that large would be failed too, which is accepted because no second realm stamps
 * rows today (on the extension only the service worker stamps; elsewhere one realm runs the loop).
 */
const hasUnexplainedFutureStamp = (tx: Transaction, nowSeconds: number): boolean =>
  !startedInThisRealm.has(tx.id) &&
  tx.processingStartedAt !== undefined &&
  tx.processingStartedAt > nowSeconds + MAX_WAIT_BEFORE_CANCEL;

/**
 * Fail every transaction an earlier process or browser session left in `GeneratingTransaction`,
 * regardless of age.
 *
 * Called from the extension's `browser.runtime.onStartup` handler (a genuine browser or profile
 * cold start, never a service-worker idle-wake) and, off the extension, from
 * `OrphanedTransactionRecovery` once per app process. Whatever drove such a row died with that
 * process or session, so nothing will ever resume it. A row this realm started is live and is
 * spared by its id (`markStartedInThisRealm`), whatever the clock does, so the sweep is sound
 * whichever runs first: the unlock kick or the startup kick can move a Queued row before the sweep
 * reads the table. A row another realm of this session started is spared when stamped from
 * `SESSION_STARTED_AT` to `MAX_WAIT_BEFORE_CANCEL` past the second the sweep reads its clock, just
 * after it reads the table, so a row stamped during that read is judged by a clock at least as late
 * as its stamp. A later stamp means the clock moved backwards after it: within the reaper's threshold
 * the row may be live and is left to the reaper; further out the stamp tells nothing and the row fails
 * here, a trade-off stated at `hasUnexplainedFutureStamp`. The reaper never fails such a row on this
 * basis, whoever started or drives it. A row with no stamp predates the field and is treated as an
 * orphan.
 *
 * The steady-state `cancelStuckTransactions` reaper only ages these out after
 * `MAX_WAIT_BEFORE_CANCEL` (30 min on desktop) because `processingStartedAt` is
 * stamped to "now" at `generateTransaction`, so a send interrupted mid-prove
 * sits on "Sending" with no feedback for up to half an hour (issue #282).
 * Failing them immediately on startup closes that gap.
 *
 * We deliberately do NOT auto-retry. In the rare window where `submit()` landed
 * on chain but the browser died before the local apply/complete, the tx IS on
 * chain; resubmitting would trip the node's nullifier check. The next sync
 * reconciles that case, which is why the copy says "check your activity" rather
 * than promising nothing was submitted (the existing 30-min reaper already
 * marks that same edge case Failed, so this is not a new regression).
 */
export const failInterruptedTransactions = async () => {
  const inProgress = await getTransactionsInProgress();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const transactions = inProgress.filter(
    tx =>
      hasUnexplainedFutureStamp(tx, nowSeconds) ||
      (!startedInThisRealm.has(tx.id) &&
        (tx.processingStartedAt === undefined || tx.processingStartedAt < SESSION_STARTED_AT))
  );
  await Promise.all(
    transactions.map(async tx => {
      await recordOutOfBandEnd(tx.id);
      return cancelTransaction(
        tx,
        TRANSACTION_INTERRUPTED_ON_STARTUP,
        'Interrupted - check your activity after it syncs'
      );
    })
  );
};

/**
 * TEMPORARY: Force cancel ALL in-progress transactions regardless of time.
 * Used for debugging stuck transactions on mobile.
 */
export const forceCaneclAllInProgressTransactions = async () => {
  const transactions = await getTransactionsInProgress();
  const cancelTransactionUpdates = transactions.map(async tx => {
    await recordOutOfBandEnd(tx.id);
    return cancelTransaction(tx, TRANSACTION_FORCE_CANCELLED_ERROR);
  });
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
 * still authoritative for a consumed note, since a consumed note never reverts;
 * a watchdog eviction of that sync reads nothing and gives `'unknown'`, per
 * `syncBeforeVerdict`). The
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
    // Best-effort: after a failed sync the last-synced state is still authoritative for a consumed
    // note (it cannot un-consume) and can only under-report "landed" for the rest → a safe Fail.
    if (sync && !(await syncBeforeVerdict('consume-verdict-sync', `reading note ${tx.noteId}`))) return 'unknown';

    const noteDetails = await withWasmClientLock(async hold =>
      midenClientProxy.getInputNoteDetails({ ids: [tx.noteId] }, () =>
        assertWasmHoldCurrent(hold, 'inside the consume-landed note read, before the record reach-through')
      )
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
 *   - `'unknown'` no captured `transactionId`, the node/client has no record
 *                 of it, or its sync was evicted: INDETERMINATE. We cannot prove
 *                 it landed, so the caller keeps the funds-safe default (surface
 *                 it, don't auto-complete).
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
 * freshest node state; a sync failure falls back to the last-synced record, except
 * a watchdog eviction, which reads nothing and gives `'unknown'` (`syncBeforeVerdict`).
 *
 * COVERAGE LIMIT - read before relying on this as the only double-send guard.
 * `ITransaction.transactionId` is written only by the completion handlers in
 * `complete.ts` (the success path), by `updateBridgedReceivePhase`, by the
 * landed arms of a failed apply after submit (#1233), and by the reconciler's
 * landed write (#1081). A row failed from OUTSIDE its own write pipeline
 * therefore arrives here with no id and short-circuits to `'unknown'`. The id its
 * attempt submitted is on the attempt's evidence entry instead (`submitEvidence`,
 * recorded at the stamped crossing), where the reconciler and Retry's tap-time
 * check judge it against the node; `isSubmitOutcomeUnknown` (constants.ts) still
 * refuses the retry of a rebuilt-request type that neither can prove.
 */
export const verifySendLanded = async (tx: { id: string; transactionId?: string }): Promise<SendLandedVerdict> => {
  if (!tx.transactionId) return 'unknown';
  const txId = tx.transactionId;
  try {
    if (!(await syncBeforeVerdict('send-verdict-sync', `reading the node-side state of transaction ${txId}`))) {
      return 'unknown';
    }
    const state = await withWasmClientLock(async () => midenClientProxy.getTransactionCommitState(txId));
    // `'discarded'` is deliberately NOT `'landed'`: the node rejected the tx, so
    // its effect provably did not happen and calling it landed would assert the
    // opposite. It joins `'not-found'` in the indeterminate bucket, which is the
    // funds-safe answer here — `'unknown'` surfaces the row rather than
    // auto-completing OR auto-resubmitting it. (Before the state read reported
    // discards at all, a discarded tx had no block number and so read as
    // `'pending'`, i.e. as `'landed'`.)
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
const verifyStuckTransactions = async (): Promise<number> => {
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
      await recordOutOfBandEnd(tx.id);
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
        await recordOutOfBandEnd(tx.id);
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

// One run at a time: callers poll every few seconds, and a run still waiting on the WASM lock would otherwise have
// another queued behind it on every tick. A caller that arrives mid-run joins it.
let stuckVerification: Promise<number> | undefined;

/** {@link verifyStuckTransactions}, one run at a time. */
export const verifyStuckTransactionsFromNode = (): Promise<number> => {
  stuckVerification ??= verifyStuckTransactions().finally(() => {
    stuckVerification = undefined;
  });
  return stuckVerification;
};
