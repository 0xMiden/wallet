import { earnWithdrawalRetryKind } from 'lib/epoch/earn-withdraw-policy';
import { inVerdictTurn } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';

import { pipelineMayStillBeRunning, verifySendLanded } from './cancel';
import {
  guardianHoldRetryMessage,
  TRANSACTION_BEING_CHECKED_RETRY_ERROR,
  TRANSACTION_LANDING_PENDING_RETRY_ERROR,
  TRANSACTION_RETRY_UNSAFE_ERROR,
  isSubmitOutcomeUnknown
} from './constants';
import { completeVerifiedLandedTransaction, verifiedLandingRowFields } from './helper';
import { latestEndMayStillRun } from './reconcile-judge';
import { checkEvidenceForRetry } from './reconcile-unconfirmed';
import { awaitingVerdict, evidenceKey, isUnresolvedEntry, keptCandidateHoldUntil, nowSeconds } from './verdict-rules';
import {
  IBridgeProvider,
  IBridgedSendExtraInputs,
  ICON_BY_TYPE,
  ITransaction,
  ITransactionStage,
  ITransactionStatus,
  ITransactionType,
  nextQueuedSeq,
  STRUCTURAL_GUARDIAN_TYPES
} from '../db/types';

/**
 * Types whose failed row can simply be re-queued through the FIFO loop.
 * Structural Guardian ops (replace-hot-key / switch-guardian /
 * update-procedure-threshold) are deliberately excluded - re-running them
 * blind can mint orphan hardware keys or re-register a stale guardian; the
 * user re-initiates those from Settings instead.
 *
 * `earn-deposit` is ALSO excluded, and for a different reason. The row is only
 * the Miden half of an Epoch lending deposit: `openEarnPosition` quotes the
 * intent, then `solveIntent` calls back into `createEarnP2IDENote`, which queues
 * this row and BLOCKS on it before the intent is submitted. So when the row
 * fails, the surrounding intent has already been abandoned (there is no
 * allocator-side mandate left to satisfy). Re-queueing would re-run only the
 * Miden send - minting a fresh P2IDE collateral note to the allocator with no
 * quote and no intent behind it, i.e. locking the user's collateral in an
 * orphaned note until its reclaim height. A dedicated retry would have to redo
 * the whole flow (new quote → new intent → new row), and that flow needs the
 * caller-supplied `BridgeNoteDeps` (`signTransaction` + guardian provider) that
 * only the earn screens hold - it is not reconstructible from this entry point.
 * Failed earn deposits are therefore non-retryable; the user re-initiates from
 * the Earn flow, and the orphaned note (if any) reclaims itself.
 *
 * How the other two "retry-ish" paths treat `earn-deposit` - different lists,
 * different reasoning, both deliberately unchanged:
 *
 *  - The pre-submit LOCKED-WALLET path in `generateTransactionsLoop` leaves the
 *    row `Queued` (never Failed) when the sign callback reports a locked vault.
 *    Nothing was abandoned there: `openEarnPosition` is still awaiting this row
 *    via `waitForTransactionCompletion`, and the quote/mandate are still live -
 *    so `earn-deposit` SHOULD keep participating, and it does.
 *  - `ApplyTransactionAfterSubmitFailed` marks the row `Failed`, not `Completed`,
 *    in both the Guardian catch and the loop catch: the note IS on chain, but no
 *    `TransactionResult` survives, and a Completed row without one would leave the
 *    awaiting `createEarnP2IDENote` waiting forever. The caller resolves through
 *    its error branch; the collateral note reclaims itself at its recall height.
 *
 * The first keeps a live intent's row queued and the second ends the row without
 * sending it again; only the terminal FIFO requeue, which reruns a send whose
 * intent is gone, has to exclude it.
 *
 * An Epoch (Fast) `bridged-send` is excluded for EXACTLY the earn-deposit reason,
 * and is gated separately below because the type alone doesn't say which route the
 * row took. Agglayer (Slow) rows carry a self-contained, pre-built B2AGG
 * `requestBytes`, so replaying one is meaningful. Epoch rows carry no request at
 * all: they are a recallable P2IDE collateral note sent to the allocator, whose
 * only meaning comes from an out-of-band Epoch intent that `bridgeEpochSend`
 * already abandoned when the row failed (it throws at that point, and
 * `markBridgedSendFailed` demotes an already-Completed row when the allocator
 * rejects the intent after the note committed). Re-queueing would mint a SECOND
 * collateral note with no quote and no intent, lock that amount until its reclaim
 * height, and then report "Bridged to EVM" - so the user must re-initiate from the
 * bridge flow instead.
 */
const REQUEUEABLE_TYPES: ITransactionType[] = ['send', 'consume', 'swap', 'bridged-send', 'execute'];

/** `bridged-send` route whose failed row must NOT be re-queued (see above). */
const NON_REQUEUEABLE_BRIDGE_PROVIDER: IBridgeProvider = 'epoch';

/** Reads `provider` off a `bridged-send` row; `undefined` for every other type. */
export const bridgeProviderOf = (tx: Pick<ITransaction, 'type' | 'extraInputs'>): IBridgeProvider | undefined => {
  if (tx.type !== 'bridged-send') return undefined;
  const extra: IBridgedSendExtraInputs | undefined = tx.extraInputs;
  return extra?.provider;
};

/**
 * Whether a Failed row can be retried by re-queueing it through the loop.
 *
 * `bridgeProvider` is the row's `extraInputs.provider` for a `bridged-send`
 * (callers that hold the raw row can pass `bridgeProviderOf(tx)`; UI callers pass
 * the value they already projected). It is required to tell the replayable
 * Agglayer route from the non-replayable Epoch one - see `REQUEUEABLE_TYPES`.
 *
 * A row restored from a backup is excluded no matter how retryable its type
 * looks. Requeueing signs and broadcasts whatever the row says - recipient,
 * amount, `requestBytes` - and for an imported row all of that was authored by
 * whoever supplied the file, not by the user. Without this clause, landing
 * imported rows in `Failed` would only move an unattended signature one tap
 * away, since Retry asks for no confirmation of what it is about to send.
 *
 * Deliberately does NOT decide the double-send question, which is a different
 * kind of doubt and gets a different answer. There the row IS the user's own
 * instruction and only its outcome is unknown, so the affordance must still
 * appear: the refusal comes from `requeueFailedTransaction`, which can explain
 * itself and take the user's acknowledgement (see `UnverifiableSendRetryError`).
 * Hiding the button instead leaves those rows with no exit at all, which is what
 * makes people re-send by hand - the double payment the guard exists to prevent.
 * An imported row has no such exit to offer, because there is no user intent
 * behind it to confirm; hence the hard exclusion above.
 *
 * Unconfirmed too: Retry is the exit while no verdict exists (#1081).
 */
export const isRequeueableTransaction = (tx: {
  status?: ITransactionStatus;
  type: ITransactionType;
  bridgeProvider?: IBridgeProvider;
  restoredFromBackup?: boolean;
}): boolean => {
  if (tx.status !== ITransactionStatus.Failed && tx.status !== ITransactionStatus.Unconfirmed) return false;
  if (tx.restoredFromBackup) return false;
  if (!REQUEUEABLE_TYPES.includes(tx.type)) return false;
  if (tx.type === 'bridged-send' && tx.bridgeProvider === NON_REQUEUEABLE_BRIDGE_PROVIDER) return false;
  return true;
};

/**
 * Structural account operations. None of them is requeueable (see
 * `REQUEUEABLE_TYPES`): the user re-initiates them from Settings.
 */
const STRUCTURAL_TYPES = STRUCTURAL_GUARDIAN_TYPES;

/**
 * Whether the UI should still offer Cancel on an in-flight row.
 *
 * Cancel has never aborted anything - it marks the row Failed and the pipeline
 * runs on (see `cancelWhilePipelineMayStillRun`). For a value transfer that is
 * an honest deal: the retry machinery is built around the resulting ambiguity,
 * and the user gets an exit for a row that would otherwise hang.
 *
 * A structural op that has been PICKED UP offers neither half of that deal. Its
 * tail is long - the direct guardian switch waits for the commit and then
 * retries registration up to eight times with backoff, minutes in the worst case
 * - and everything in it happens after the `update_guardian` write is already on
 * chain. Cancelling there does not stop the rotation, it cannot be retried, and
 * the completion's terminal write is refused because the row went terminal
 * first: the account's guardian has moved, the endpoint has been persisted, and
 * the only thing the user is left with is a row that says the whole thing
 * failed. That is strictly worse than no button.
 *
 * Queued is different and stays cancellable: nothing has been picked up, so
 * failing the row genuinely does prevent the rotation.
 */
export const isCancellableTransaction = (tx: { status?: ITransactionStatus; type: ITransactionType }): boolean => {
  if (tx.status !== ITransactionStatus.Queued && tx.status !== ITransactionStatus.GeneratingTransaction) return false;
  return !(STRUCTURAL_TYPES.includes(tx.type) && tx.status === ITransactionStatus.GeneratingTransaction);
};

/** Output-producing types whose Retry must first node-verify it didn't already
 *  land (double-send guard). Consume is excluded - it has its own input-note
 *  landed check (verifyConsumeLanded) on the kill/reaper path. */
const NODE_VERIFIED_RETRY_TYPES: ITransactionType[] = ['send', 'swap', 'bridged-send', 'execute'];

/**
 * The types whose request is REBUILT from scratch on every attempt, so a second
 * submit produces a genuinely NEW output note (new serial) that the node has no
 * reason to reject - i.e. the ones where a resubmit of an already-landed tx is a
 * real double-send of the user's funds. Guardian sends/swaps are `send`/`swap`
 * rows too, and each retry builds a fresh proposal, so they are covered here.
 *
 * `bridged-send` (Agglayer) is excluded: it replays the `requestBytes` persisted
 * on the row, whose output notes are fixed and which runs no custom script, so a
 * duplicate submit re-creates the IDENTICAL note and the node rejects it. An
 * `execute` is excluded from the rebuild but not from the doubt: `newTransaction`
 * re-executes its request against the account's current state, so a script that
 * reads the vault can pay a different amount, and an execute that may have
 * submitted meets the acknowledgeable refusal on its own rule
 * (`executeMayHaveSubmitted`, #1081).
 * (`consume` is excluded for the same reason its Retry needs no node check - its
 * input note's nullifier makes a duplicate unusable.)
 *
 * Why these need a guard beyond `verifySendLanded`: that check is keyed on
 * `ITransaction.transactionId`, which is written only once a row landed. A row
 * that failed before that reaches Retry with `transactionId === undefined`, where
 * `verifySendLanded` short-circuits to `'unknown'`. The id the attempt submitted is
 * recorded at the stamped crossing instead, on the attempt's evidence entry, and
 * Retry's tap-time check judges it against the node (#1081). An attempt that check
 * cannot prove falls back to the one durable fact that IS on the row - did it ever
 * leave the queue - and the replay is refused whenever the answer is yes
 * (`isSubmitOutcomeUnknown`).
 *
 * That is deliberately conservative: it also refuses a send that failed provably
 * pre-submit (say, insufficient funds during execute), because nothing durable
 * distinguishes that from a submit whose reply was lost. Which is why the refusal
 * is acknowledgeable rather than final - the user can tell the two apart from
 * their own balance, so see `RetryOptions.acknowledged`.
 */
const REBUILT_REQUEST_TYPES: ITransactionType[] = ['send', 'swap'];

/**
 * Stages a Failed row can hold that PROVE nothing was broadcast, so its cached
 * request may be safely rebuilt (see the `requestBytes` clear below).
 *
 * A Failed row keeps the stage it died in - `updateTransactionStatus` preserves
 * it precisely because it records WHERE the failure happened - so this reads as
 * "how far did the last attempt get".
 *
 * Deliberately excludes 'sending', which is NOT pre-submit despite sitting
 * before the submit stamps in the stage list. It is stamped at pickup
 * (`generateTransaction`) and again just before the guardian leaf runs. The
 * inline leaf narrows it as it goes; the offscreen leaf takes `stageStampFor` too,
 * but its stamps are replayed late and are unreliable (`reliable: false`, #1081),
 * so a realm torn down mid-op can leave the row at 'sending' after a submit. Offscreen
 * routing is the DEFAULT (`MIDEN_USE_OFFSCREEN_CLIENT` defaults to 'true') and
 * `send` is offscreen-routable, so on the shipping path a submit that landed
 * before the realm was torn down leaves exactly this stage. The sibling requeue
 * gate reached the same conclusion independently - "a 429 at or after 'sending'
 * must NOT requeue".
 *
 * The cut is therefore `provenTx.submit()` OR any stage that could span it:
 * 'submitting' is stamped immediately before that call, and 'sending' may
 * enclose it.
 *
 * A missing stage is deliberately NOT in this set, because for a row that has
 * cached bytes it proves the opposite of what it looks like. Pickup stamps
 * 'syncing' then 'sending' before any request is built, so a row can only hold
 * bytes if it got past those - a missing stage on such a row therefore means
 * the stage was RESET by a requeue, not that nothing ever ran, and the history
 * it was reset from is exactly what is unknown. (A row that genuinely never
 * reached the loop has no bytes, so excluding it costs nothing: the clear it
 * misses is a no-op.) This matters for rows written by an older build, which
 * carry no `mayHaveSubmitted` at all: `cancelTransaction` fails a row without
 * writing a stage, so `cancelStaleQueuedTransactions` reaping a requeued row
 * leaves Failed + no stage + bytes, and reading that as pre-submit would
 * rebuild the note id of a transfer that may already have landed.
 *
 * None of the above makes the stage TRUSTWORTHY on its own, which is why
 * `mayHaveSubmitted` - not this set - is the primary guard. A Failed row's stage
 * says where the pipeline was when the row went terminal, and for an
 * out-of-band cancel that is not where the pipeline ENDED: nothing aborts the
 * leaf, `setTransactionStage` refuses to advance a terminal row, and the submit
 * still happens. The stage would then read 'proving' forever on a transfer
 * that landed. The leaves therefore stamp `mayHaveSubmitted` themselves at the
 * submit crossing (`markMayHaveSubmitted`, which the terminal guard does not
 * apply to), and this set only decides the case where no leaf ever got that far.
 */
const PRE_SUBMIT_STAGES: ReadonlySet<ITransactionStage> = new Set<ITransactionStage>([
  'syncing',
  'creating-proposal',
  'signing-proposal',
  // The direct switch's local hot+cold signing, which happens while the request
  // is still being BUILT - strictly earlier than `signing-proposal`, so it
  // belongs here for the same reason.
  'signing-locally',
  'executing',
  'proving'
]);

/** How long Retry waits for a reconciler pass that holds the row's verdict lock (#1081). */
export const RETRY_VERDICT_WAIT_MS = 10_000;

/**
 * Retry's refusals (#1081), English rendered verbatim, passed as the error's message so the class and the "Retry
 * anyway" gate that reads it stay. The acknowledgeable copy follows whether the reconciler still judges the row; the
 * liveness copy for a proven row says the attempt is proven dead, so it never contradicts "It is safe to retry".
 */
export const RETRY_REFUSAL_COPY = {
  sendStopped:
    'This send may already have reached the network, and there is no way to confirm it. Retrying could send it twice. Check your balance first - if it did not go through, you can retry anyway.',
  sendChecking:
    'The wallet is still checking whether this went through. Retrying now could send it twice. Check your balance: if it did not go through, you can retry anyway.',
  swapChecking:
    'The wallet is still checking whether this swap went through. Retrying now could place it twice. Check your balance: if it did not go through, you can retry anyway.',
  swapStopped:
    'This swap may already have reached the network, and there is no way to confirm it. Retrying could place it twice. Check your balance first: if it did not go through, you can retry anyway.',
  executeChecking:
    'The wallet is still checking whether this went through. Retrying would run it again, and the result can differ. If you know it did not go through, you can retry anyway.',
  executeStopped:
    'This transaction may already have reached the network, and there is no way to confirm it. Retrying would run it again, and the result can differ. Check with the app that requested it: if it did not go through, you can retry anyway.',
  sendLive:
    'This send may still be finishing in the background, so retrying now could send it twice. Wait a few minutes, check your balance, and retry then.',
  swapLive:
    'This swap may still be finishing in the background, so retrying now could place it twice. Wait a few minutes, check your balance, and retry then.',
  executeLive:
    'This transaction may still be finishing in the background, so retrying now could run it twice. Wait a few minutes and retry then.',
  sendLiveProven:
    'The network confirmed this send never went through, but a cancelled run of it may still be finishing in the background, so retrying now could send it twice. Wait a few minutes and retry then.',
  swapLiveProven:
    'The network confirmed this swap never went through, but a cancelled run of it may still be finishing in the background, so retrying now could place it twice. Wait a few minutes and retry then.',
  executeLiveProven:
    'The network confirmed this transaction never went through, but a cancelled run of it may still be finishing in the background, so retrying now could run it twice. Wait a few minutes and retry then.'
};

/**
 * Thrown when Retry cannot rule out that the row already went through, or that a cancelled run of it is still
 * finishing. Its own class so the UI can offer the one thing that resolves the first kind: the user's word, given for
 * the attempt the refusal names (`acknowledgeableAttemptId`, #1081). The liveness refusal carries no attempt id, and
 * no surface offers "Retry anyway" for it.
 */
export class UnverifiableSendRetryError extends Error {
  /** The attempt an acknowledgeable refusal is about: the row's `attemptId`, or null for a row that has none. */
  readonly acknowledgeableAttemptId?: string | null;

  constructor(message: string = RETRY_REFUSAL_COPY.sendStopped, acknowledgeableAttemptId?: string | null) {
    super(message);
    this.name = 'UnverifiableSendRetryError';
    if (acknowledgeableAttemptId !== undefined) this.acknowledgeableAttemptId = acknowledgeableAttemptId;
  }
}

/**
 * Matched by `name`, not `instanceof`: the retry can be driven from the UI bundle
 * or the service worker, which do not share a class identity.
 */
export const isUnverifiableSendRetryError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'UnverifiableSendRetryError';

/** The acknowledgement a rendered refusal offers, kept exactly as rendered; null when it offers none (#1081). */
export const acknowledgementOf = (error: unknown): { attemptId: string | null } | null => {
  if (!isUnverifiableSendRetryError(error) || typeof error !== 'object' || error === null) return null;
  if (!('acknowledgeableAttemptId' in error)) return null;
  const attemptId = error.acknowledgeableAttemptId;
  return typeof attemptId === 'string' || attemptId === null ? { attemptId } : null;
};

export interface RetryOptions {
  /**
   * The user confirmed that the attempt the refusal named did not go through (#1081): the `acknowledgeableAttemptId`
   * that refusal carried, `null` included. The lock cannot cover an acknowledgement, which is given before the call
   * starts, so Retry honours it only while it still names the row's attempt; one given before another surface's
   * Retry ran a newer attempt counts as absent. Taken as the premise being false, so both crossing markers are
   * cleared in the requeue write rather than stepped over.
   */
  acknowledged?: { attemptId: string | null };
}

const acknowledgeableCopy = (tx: ITransaction, nowSec: number): string => {
  const checking = awaitingVerdict(tx, nowSec);
  if (tx.type === 'swap') return checking ? RETRY_REFUSAL_COPY.swapChecking : RETRY_REFUSAL_COPY.swapStopped;
  if (tx.type === 'execute') return checking ? RETRY_REFUSAL_COPY.executeChecking : RETRY_REFUSAL_COPY.executeStopped;
  return checking ? RETRY_REFUSAL_COPY.sendChecking : RETRY_REFUSAL_COPY.sendStopped;
};

const livenessCopy = (type: ITransactionType, proven: boolean): string => {
  if (type === 'swap') return proven ? RETRY_REFUSAL_COPY.swapLiveProven : RETRY_REFUSAL_COPY.swapLive;
  if (type === 'execute') return proven ? RETRY_REFUSAL_COPY.executeLiveProven : RETRY_REFUSAL_COPY.executeLive;
  return proven ? RETRY_REFUSAL_COPY.sendLiveProven : RETRY_REFUSAL_COPY.sendLive;
};

/** Every attempt replays the same inputs, so a replay after any landing fails on the spent input. */
const listsNullifier = (tx: ITransaction): boolean =>
  (tx.submitEvidence ?? []).some(entry => (entry.nullifiers?.length ?? 0) > 0);

/**
 * An execute that may have submitted (#1081): Unconfirmed, holding an entry not ruled out, or, for a row from before
 * this change (no attempt id), the send rule's own test. A run that may have crossed always leaves an entry, so a run
 * with an id and no entry provably ended before its submit. A replay of `requestBytes` re-executes against the
 * account's current state, so a script that reads the vault can pay a different amount: an execute is not exempt.
 */
const executeMayHaveSubmitted = (tx: ITransaction): boolean =>
  tx.status === ITransactionStatus.Unconfirmed ||
  (tx.submitEvidence ?? []).some(isUnresolvedEntry) ||
  (tx.attemptId === undefined &&
    (tx.mayHaveSubmitted === true || pipelineMayStillBeRunning(tx.cancelledInFlightAt) || isSubmitOutcomeUnknown(tx)));

interface RequeuePlan {
  failedStage: ITransactionStage | undefined;
  clearFlags: boolean;
  proven: boolean;
  /** The entries' evidence as Retry judged and wrote them, never re-read. */
  baseline: string;
}

/** Steps 1 to 5: refuse, complete, or say how to requeue. Undefined when the row was completed instead. */
const planRequeue = async (
  tx: ITransaction,
  acknowledged: RetryOptions['acknowledged']
): Promise<RequeuePlan | undefined> => {
  // Pass the WHOLE row: the gate reads the bridge provider off `extraInputs`.
  if (!isRequeueableTransaction({ ...tx, bridgeProvider: bridgeProviderOf(tx) })) {
    throw new Error(`Transaction ${tx.id} (${tx.type}) is not retryable`);
  }
  const nowSec = nowSeconds();
  // The next proposal would meet the kept candidate: the 409 arm for most types, an outright failure for a
  // bridged-send. Proven or not, and acknowledged or not, the row waits for the Guardian's own discard.
  const holdUntil = keptCandidateHoldUntil(tx, nowSec);
  if (holdUntil !== undefined) throw new Error(guardianHoldRetryMessage(holdUntil));
  let proven = tx.neverCommittedAt !== undefined;
  let baseline = evidenceKey(tx.submitEvidence);
  let checked = false;
  if (!proven && awaitingVerdict(tx, nowSec)) {
    const check = await checkEvidenceForRetry(tx);
    checked = true;
    if (check.kind === 'landed') return undefined;
    // The row may already have landed, and a candidate note can still prove to be a sibling's: it must not reach the
    // acknowledgeable refusal below, where a plain send could pay twice.
    if (check.kind === 'landing-pending') throw new Error(TRANSACTION_LANDING_PENDING_RETRY_ERROR);
    proven = check.kind === 'proven';
    baseline = check.baseline;
  }

  // Idempotency guard (resilience gap 2): a send/swap can be marked Failed by an
  // ambiguous post-submit abort even though its original submit actually LANDED.
  // Blindly re-queueing it through the loop would broadcast a SECOND send - a
  // real double-spend of the user's funds. So node-verify first: if the tx is
  // provably on chain (committed) or in the mempool (pending), complete the row
  // instead of resubmitting. An indeterminate result keeps the resubmit path (no
  // captured id / no record → we couldn't confirm it landed).
  if (!proven && NODE_VERIFIED_RETRY_TYPES.includes(tx.type)) {
    const verdict = await verifySendLanded(tx);
    if (verdict === 'landed') {
      // Completed as the landed catches complete a row (#1233). Only `completeSendTransaction`
      // relays a private send's note, and with no delivery recorded that relay never ran.
      const completedAt = Math.floor(Date.now() / 1000);
      // Not `updateTransactionStatus`: its terminal guard rejects the Failed row
      // this function is defined over, so this branch used to throw rather than
      // complete and the guard's only success path never once worked.
      await completeVerifiedLandedTransaction(tx.id, fresh => ({ ...verifiedLandingRowFields(fresh), completedAt }));
      return undefined;
    }
    // Not provably landed. For a row that executed, `'unknown'` means "we could
    // not confirm", NOT "it did not land" - and for a rebuilt-request type a
    // resubmit would broadcast a SECOND send. This covers the row that HAS a
    // captured id the node has no record of, which the acknowledgeable refusal
    // below deliberately does not: an id proves the submit call was reached, so
    // there is nothing for the user to rule out from their balance.
    if (REBUILT_REQUEST_TYPES.includes(tx.type) && tx.transactionId !== undefined && isSubmitOutcomeUnknown(tx)) {
      throw new Error(TRANSACTION_RETRY_UNSAFE_ERROR);
    }
  }

  // A send or swap that caches no bytes rebuilds its request with a fresh note serial, so the chain has no reason to
  // reject a second submit. It is refused while a submit cannot be ruled out: a recorded crossing (`mayHaveSubmitted`,
  // a live cancel) or the coarse reading that the row left the queue at all. The coarse one also catches failures that
  // were provably pre-submit, which is why the refusal is acknowledgeable: the user can tell the two apart from their
  // balance, and a refusal with no exit is what makes people re-send by hand.
  const live =
    pipelineMayStillBeRunning(tx.cancelledInFlightAt) ||
    ((tx.type === 'execute' || tx.type === 'swap') && latestEndMayStillRun(tx));
  const rebuiltWithoutBytes =
    REBUILT_REQUEST_TYPES.includes(tx.type) && tx.requestBytes === undefined && tx.transactionId === undefined;
  const sendOrSwapInDoubt =
    rebuiltWithoutBytes && (proven || tx.mayHaveSubmitted === true || live || isSubmitOutcomeUnknown(tx));
  const executeInDoubt = tx.type === 'execute' && !listsNullifier(tx) && (proven || executeMayHaveSubmitted(tx));

  // An acknowledgement can rule out the past, not the future: while a cancelled or abandoned run may still submit,
  // even a proven row waits. An Agglayer bridge never meets this: its bytes rebuild the identical note.
  if ((sendOrSwapInDoubt || executeInDoubt) && live) {
    throw new UnverifiableSendRetryError(livenessCopy(tx.type, proven));
  }
  let clearFlags = proven;
  if (!proven && (sendOrSwapInDoubt || executeInDoubt)) {
    const attemptId = tx.attemptId ?? null;
    if (acknowledged === undefined || acknowledged.attemptId !== attemptId) {
      // The copy only: the check may have just ended the reconciler's interest (an 'unresolvable' verdict), and the
      // refusal must not say the wallet is still checking a row whose hint says it is not.
      const asLeft = checked ? ((await Repo.transactions.where({ id: tx.id }).first()) ?? tx) : tx;
      throw new UnverifiableSendRetryError(acknowledgeableCopy(asLeft, nowSeconds()), attemptId);
    }
    clearFlags = true;
  }
  // Read off the pre-reset row: the requeue write clears `stage`.
  return { failedStage: tx.stage, clearFlags, proven, baseline };
};

type RequeueWrite = 'written' | 'declined' | 'evidence-changed';

/**
 * Step 6, one Dexie write that also takes the flag clear (once a separate write). Today's guard, widened to
 * Unconfirmed, plus the entries' evidence against what Retry judged and wrote: pipeline stamps stay outside the lock,
 * so a stamp that lands after the judging read counts as a change.
 */
const writeRequeue = async (txId: string, plan: RequeuePlan): Promise<RequeueWrite> => {
  let result: RequeueWrite = 'declined';
  await Repo.transactions.where({ id: txId }).modify((dbTx: ITransaction) => {
    // Re-checked against what the plan was made from: a write outside the verdict lock (a completion, a pipeline's
    // stamp) can move the row after Retry read it. `false`, so Dexie skips the put rather than re-writing the
    // unchanged clone.
    if (
      (dbTx.status !== ITransactionStatus.Failed && dbTx.status !== ITransactionStatus.Unconfirmed) ||
      dbTx.stage !== plan.failedStage
    ) {
      return false;
    }
    if (evidenceKey(dbTx.submitEvidence) !== plan.baseline) {
      result = 'evidence-changed';
      return false;
    }
    // Cleared first, so the send branch below reads them as it always has.
    if (plan.clearFlags) {
      dbTx.mayHaveSubmitted = undefined;
      dbTx.cancelledInFlightAt = undefined;
    }
    dbTx.status = ITransactionStatus.Queued;
    dbTx.initiatedAt = Math.floor(Date.now() / 1000);
    // Re-stamped with the timestamp, not left at the original. `initiatedAt` is
    // whole SECONDS, so the processing loop breaks ties on `queuedSeq` - and a
    // requeued row keeping its old (smaller) sequence would sort AHEAD of a
    // transaction queued in the same second, which is the opposite of the FIFO
    // order the tie-break exists to impose.
    dbTx.queuedSeq = nextQueuedSeq();
    dbTx.processingStartedAt = undefined;
    dbTx.attemptId = undefined;
    dbTx.completedAt = undefined;
    dbTx.stage = undefined;
    // Clear the stage stamps with the stage. `setTransactionStage` is
    // first-entry-wins (#524), so leaving the FAILED attempt's boundaries behind
    // would make the retried attempt's steps render that attempt's durations -
    // and only `complete` would be re-stamped. This matters now that the retry
    // footer (#483) is reachable at all: #507 removed the receipt auto-close, so
    // a failed receipt stays up until the user acts on it.
    dbTx.stageTimestamps = undefined;
    dbTx.nextEligibleAt = undefined;
    // A deliberate retry earns a fresh unauthorized-retry budget. Carrying the
    // spent deadline over would make the new attempt terminal on its FIRST
    // unauthorized failure, so a row that had exhausted its budget would behave
    // worse under Retry than an identical send the user initiated from scratch.
    dbTx.unauthorizedRetryUntil = undefined;
    // And a fresh guardian backoff: the retry's first requeue waits its arm's base cooldown, not one the failed
    // attempts had doubled (#1223).
    dbTx.requeueStreak = undefined;
    // And the Guardian-busy mark, so the retried row does not open on a wait it is not in (#312).
    dbTx.guardianBusy = undefined;
    dbTx.error = undefined;
    dbTx.rawError = undefined;
    dbTx.displayMessage = undefined;
    dbTx.displayIcon = ICON_BY_TYPE[dbTx.type];
    // The safe marker belongs to the attempts it judged; the evidence stays, so an earlier attempt can still land.
    dbTx.neverCommittedAt = undefined;
    // A proven row's attempts are all dead, so its send bytes may be rebuilt like a pre-submit failure's.
    const failedPreSubmit = plan.proven || (plan.failedStage !== undefined && PRE_SUBMIT_STAGES.has(plan.failedStage));
    // A `send` row's cached bytes only exist for a GUARDIAN recallable send
    // (`ensureGuardianRecallableSendRequestBytes`) - the non-guardian path
    // rebuilds its request on every call and never reads `requestBytes`. Those
    // bytes froze an absolute reclaim height and the outgoing asset as built at
    // first attempt, so a retry has to rebuild them to stand any chance of
    // succeeding. But they also pin the note id, which is the ONLY thing that
    // makes the chain reject a duplicate - hence the gate; see
    // `PRE_SUBMIT_STAGES` for what the stage does and does not prove.
    //
    // No other requeueable type may be cleared, whatever its stage. A swap's
    // bytes must be reused byte-identically (the PSWAP flow requires it). A
    // `bridged-send` carries a pre-built note whose attachment this builder
    // cannot reproduce - the Epoch mandate binding, or the AggLayer B2AGG
    // destination - and behind an Epoch row the intent is already spent, so the
    // answer for a broken one is a new intent, not a fresh note.
    //
    // Scoped to `send` on both arms because `send` is the only type whose bytes
    // this gate can drop; writing the flag onto a swap or bridged-send row would
    // persist a signal nothing reads and imply a guard those types don't have.
    if (dbTx.type === 'send') {
      // Read off the LIVE row rather than the snapshot taken at the top of this
      // function: `verifySendLanded` above makes a network round trip, and
      // `markMayHaveSubmitted` writes that field and nothing else, so a crossing
      // recorded during that window sails through the status/stage re-check
      // untouched. Deciding from the snapshot would clear the bytes of a send
      // that had just broadcast. IndexedDB serializes the two writes, so by the
      // time this callback runs the flag is committed and visible.
      const submitPossible =
        dbTx.mayHaveSubmitted === true || pipelineMayStillBeRunning(dbTx.cancelledInFlightAt) || !failedPreSubmit;

      if (!submitPossible) {
        dbTx.requestBytes = undefined;
      } else if (dbTx.requestBytes !== undefined && !failedPreSubmit) {
        // Persist the STAGE's verdict before the stage is forgotten, so the next
        // failure - which may land early and look pre-submit - still keeps these
        // bytes. Two conditions, and both are load-bearing:
        //
        //   - only when bytes EXIST. The flag's whole job is to protect them,
        //     and `mayHaveSubmitted` is permanent. Writing it to a byteless row
        //     protects nothing and instead manufactures a crossing that never
        //     happened, which the refusal above then reads as fact: a plain send
        //     is never stage-narrowed (its pipeline stamps 'sending' once, at
        //     pickup, and that is deliberately not pre-submit), so EVERY plain
        //     send would earn the flag on its first requeue and be refused on
        //     its second - the vault-slot failure this release fixes included.
        //     Nothing is lost by the scoping: bytes are persisted to the row
        //     before they are ever submitted (`ensureGuardianRecallableSend-
        //     RequestBytes`), so a byteless attempt provably never broadcast.
        //   - only from the STAGE. A live `cancelledInFlightAt` also makes a
        //     submit possible, but it says "we don't know YET" and expires
        //     saying so (see its docstring); it also survives the reset below on
        //     its own, so it needs no persisting. Promoting it here would freeze
        //     an unresolved maybe into a permanent yes and pin the request -
        //     with it the frozen absolute reclaim height - for good, which is
        //     the bricking this field was split in two to avoid.
        dbTx.mayHaveSubmitted = true;
      }
    }
    result = 'written';
    return undefined;
  });
  return result;
};

/** Steps 1 to 6 under the row's verdict lock, judged at most twice. */
const retryUnderVerdictLock = async (txId: string, options: RetryOptions): Promise<void> => {
  let acknowledged = options.acknowledged;
  for (let judging = 0; judging < 2; judging += 1) {
    const tx = await Repo.transactions.where({ id: txId }).first();
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    const plan = await planRequeue(tx, acknowledged);
    if (plan === undefined) return;
    if ((await writeRequeue(txId, plan)) !== 'evidence-changed') return;
    // The evidence the user answered for has changed: judge the fresh row once more, without their word.
    acknowledged = undefined;
  }
  throw new Error(TRANSACTION_BEING_CHECKED_RETRY_ERROR);
};

/**
 * Retry a Failed or Unconfirmed row by resetting it to Queued (#1081). The whole call runs under the row's verdict
 * lock, so no reconciler pass judges or writes the row between Retry's read and its write, and a second Retry runs
 * after the first and reads its result. It waits at most `RETRY_VERDICT_WAIT_MS` for a pass. It never abandons a
 * Guardian candidate: it runs in the UI realm, which on the extension holds no Guardian service.
 */
export const requeueFailedTransaction = async (txId: string, options: RetryOptions = {}): Promise<void> => {
  const turn = await inVerdictTurn(txId, () => retryUnderVerdictLock(txId, options), {
    waitMs: RETRY_VERDICT_WAIT_MS
  });
  if (!turn.ran) throw new Error(TRANSACTION_BEING_CHECKED_RETRY_ERROR);
};

// NOTE: a failed `consume` of a bridged-in (EVM → Miden) note IS retryable via
// `requeueFailedTransaction` - the Miden-side claim is ours to re-run. What the
// wallet cannot replay are EVM-side failures (a reverted source tx, or a rejected
// Epoch intent). A rejected Epoch intent DOES leave a Failed Miden row - either the
// bridged-send row failed on its own and `bridgeEpochSend` threw, or
// `markBridgedSendFailed` demoted an already-Completed row after the allocator
// rejected the intent. That row is exactly the case `isRequeueableTransaction`
// excludes above: its collateral note is (or would be) on chain with no intent
// behind it, so it is reported Failed and left to reclaim at its recall height.

/** Retries the saved delivery, or a source withdrawal proven not to have been sent. */
export const retryEarnWithdrawReceive = async (txId: string): Promise<void> => {
  const tx = await Repo.transactions.where({ id: txId }).first();
  if (!tx || tx.type !== 'earn-withdraw') throw new Error(`Transaction ${txId} is not an earn-withdraw`);
  // Same rule as `isRequeueableTransaction`, and it matters more here: resubmit
  // signs EVM operations with the vault key using this row's own `evmOwner`,
  // `marketUid` and `sourceAmount`. An earn-withdraw row is born `Completed`
  // with its lifecycle in `extraInputs.phase`, so import leaves its status
  // untouched - the flag is the only thing marking it as not-ours.
  if (tx.restoredFromBackup) {
    throw new Error(`Transaction ${txId} was restored from a backup and cannot be resubmitted`);
  }
  if (!earnWithdrawalRetryKind(tx)) return;

  // Dynamic import: lib/epoch statically imports lib/miden/activity, which
  // re-exports this module, so the domain service is loaded only on Retry.
  const { retryEarnWithdrawal } = await import('lib/epoch');
  await retryEarnWithdrawal(txId);
};
