import * as Repo from 'lib/miden/repo';

import { pipelineMayStillBeRunning, verifySendLanded } from './cancel';
import { completeVerifiedLandedTransaction } from './helper';
import {
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionIcon,
  ITransactionStage,
  ITransactionStatus,
  ITransactionType
} from '../db/types';

/**
 * Types whose failed row can simply be re-queued through the FIFO loop.
 * Structural Guardian ops (replace-hot-key / switch-guardian /
 * update-procedure-threshold) are deliberately excluded — re-running them
 * blind can mint orphan hardware keys or re-register a stale guardian; the
 * user re-initiates those from Settings instead.
 *
 * `earn-deposit` is ALSO excluded, and for a different reason. The row is only
 * the Miden half of an Epoch lending deposit: `openEarnPosition` quotes the
 * intent, then `solveIntent` calls back into `createEarnP2IDENote`, which queues
 * this row and BLOCKS on it before the intent is submitted. So when the row
 * fails, the surrounding intent has already been abandoned (there is no
 * allocator-side mandate left to satisfy). Re-queueing would re-run only the
 * Miden send — minting a fresh P2IDE collateral note to the allocator with no
 * quote and no intent behind it, i.e. locking the user's collateral in an
 * orphaned note until its reclaim height. A dedicated retry would have to redo
 * the whole flow (new quote → new intent → new row), and that flow needs the
 * caller-supplied `BridgeNoteDeps` (`signTransaction` + guardian provider) that
 * only the earn screens hold — it is not reconstructible from this entry point.
 * Failed earn deposits are therefore non-retryable; the user re-initiates from
 * the Earn flow, and the orphaned note (if any) reclaims itself.
 *
 * How the other two "retry-ish" paths treat `earn-deposit` — different lists,
 * different reasoning, both deliberately unchanged:
 *
 *  - The pre-submit LOCKED-WALLET path in `generateTransactionsLoop` leaves the
 *    row `Queued` (never Failed) when the sign callback reports a locked vault.
 *    Nothing was abandoned there: `openEarnPosition` is still awaiting this row
 *    via `waitForTransactionCompletion`, and the quote/mandate are still live —
 *    so `earn-deposit` SHOULD keep participating, and it does.
 *  - `ApplyTransactionAfterSubmitFailed` marks the row `Completed` rather than
 *    Failed: the note IS on chain, so the correct move is to let the awaiting
 *    `createEarnP2IDENote` read it back, not to re-send. `earn-deposit` belongs
 *    in that type-agnostic path too, and stays there.
 *
 * Both of those cover cases where the intent is still valid; only the terminal
 * FIFO requeue, which reruns a send whose intent is gone, has to exclude it.
 */
const REQUEUEABLE_TYPES: ITransactionType[] = ['send', 'consume', 'swap', 'bridged-send', 'execute'];

/** Pre-failure display icon per type (mirrors the Transaction subclass constructors). */
const ICON_BY_TYPE: Partial<Record<ITransactionType, ITransactionIcon>> = {
  send: 'SEND',
  consume: 'RECEIVE',
  swap: 'SWAP',
  'bridged-send': 'SEND',
  execute: 'DEFAULT'
};

/**
 * Whether a Failed row can be retried by re-queueing it through the loop.
 *
 * A row restored from a backup is excluded no matter how retryable its type
 * looks. Requeueing signs and broadcasts whatever the row says — recipient,
 * amount, `requestBytes` — and for an imported row all of that was authored by
 * whoever supplied the file, not by the user. Without this clause, landing
 * imported rows in `Failed` would only move an unattended signature one tap
 * away, since Retry asks for no confirmation of what it is about to send.
 */
export const isRequeueableTransaction = (tx: {
  status?: ITransactionStatus;
  type: ITransactionType;
  restoredFromBackup?: boolean;
}): boolean => tx.status === ITransactionStatus.Failed && !tx.restoredFromBackup && REQUEUEABLE_TYPES.includes(tx.type);

/** Output-producing types whose Retry must first node-verify it didn't already
 *  land (double-send guard). Consume is excluded — it has its own input-note
 *  landed check (verifyConsumeLanded) on the kill/reaper path. */
const NODE_VERIFIED_RETRY_TYPES: ITransactionType[] = ['send', 'swap', 'bridged-send', 'execute'];

/**
 * Stages a Failed row can hold that PROVE nothing was broadcast, so its cached
 * request may be safely rebuilt (see the `requestBytes` clear below).
 *
 * A Failed row keeps the stage it died in — `updateTransactionStatus` preserves
 * it precisely because it records WHERE the failure happened — so this reads as
 * "how far did the last attempt get".
 *
 * Deliberately excludes 'sending', which is NOT pre-submit despite sitting
 * before the submit stamps in the stage list. It is stamped at pickup
 * (`generateTransaction`) and again just before the guardian leaf runs, and only
 * the INLINE leaf then narrows it: `runGuardianPipeline` stamps
 * 'executing'/'proving'/'submitting' as it goes, but `dispatchGuardianPipeline`
 * takes no stage callback at all, so the offscreen leaf runs
 * execute → prove → submit → apply with the row frozen at 'sending'. Offscreen
 * routing is the DEFAULT (`MIDEN_USE_OFFSCREEN_CLIENT` defaults to 'true') and
 * `send` is offscreen-routable, so on the shipping path a submit that landed
 * before the realm was torn down leaves exactly this stage. The sibling requeue
 * gate reached the same conclusion independently — "a 429 at or after 'sending'
 * must NOT requeue".
 *
 * The cut is therefore `provenTx.submit()` OR any stage that could span it:
 * 'submitting' is stamped immediately before that call, and 'sending' may
 * enclose it.
 *
 * A missing stage is deliberately NOT in this set, because for a row that has
 * cached bytes it proves the opposite of what it looks like. Pickup stamps
 * 'syncing' then 'sending' before any request is built, so a row can only hold
 * bytes if it got past those — a missing stage on such a row therefore means
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
 * `mayHaveSubmitted` — not this set — is the primary guard. A Failed row's stage
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
  'executing',
  'proving'
]);

/**
 * Retry a Failed transaction by resetting its row to `Queued` so the FIFO
 * processing loop picks it up again. The row keeps its id (and, for swaps, its
 * persisted `requestBytes` — the retry reuses the exact same request, which the
 * PSWAP flow requires; a `send`'s bytes are dropped only while no attempt on the
 * row could have submitted, see below). `initiatedAt` is refreshed so the
 * stale-queued TTL doesn't cancel
 * the retry on sight, and `nextEligibleAt` is cleared so a stale
 * requeue-backoff can't delay the user's explicit retry.
 */
/**
 * Thrown when a send cannot be retried safely and the wallet has no way to find
 * out whether it landed. Its own class, rather than a bare `Error`, so the UI can
 * tell this apart from an ordinary retry failure and offer the one thing that can
 * actually resolve it — see `RetryOptions.acknowledgeUnverifiedSend`.
 */
export class UnverifiableSendRetryError extends Error {
  constructor() {
    super(
      'This send may already have reached the network, and there is no way to confirm it. ' +
        'Retrying could send it twice. Check your balance first — if it did not go through, you can retry anyway.'
    );
    this.name = 'UnverifiableSendRetryError';
  }
}

/**
 * Matched by `name`, not `instanceof`: the retry can be driven from the UI bundle
 * or the service worker, which do not share a class identity.
 */
export const isUnverifiableSendRetryError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'UnverifiableSendRetryError';

export interface RetryOptions {
  /**
   * Proceed even though a submit cannot be ruled out, because the USER has
   * confirmed it did not happen.
   *
   * The refusal exists because the wallet cannot distinguish "failed before
   * submitting" from "submitted and then lost the answer" on a plain send. The
   * user can: the funds either left their balance or they did not. Without this
   * the guard has no exit at all — nothing clears `mayHaveSubmitted`, and the
   * Retry button stays on screen throwing the same error forever, which is the
   * kind of dead end people work around by sending again by hand, i.e. the exact
   * double payment the guard is for.
   *
   * Taking it as a signal that the premise is FALSE, so both markers are cleared
   * rather than merely bypassed: a later failure on this row must be judged on its
   * own evidence, not on a crossing the user has just ruled out.
   */
  acknowledgeUnverifiedSend?: boolean;
}

export const requeueFailedTransaction = async (txId: string, options: RetryOptions = {}): Promise<void> => {
  const tx = await Repo.transactions.where({ id: txId }).first();
  if (!tx) throw new Error(`Transaction ${txId} not found`);
  if (!isRequeueableTransaction(tx)) {
    throw new Error(`Transaction ${txId} (${tx.type}) is not retryable`);
  }

  // Idempotency guard (resilience gap 2): a send/swap can be marked Failed by an
  // ambiguous post-submit abort even though its original submit actually LANDED.
  // Blindly re-queueing it through the loop would broadcast a SECOND send — a
  // real double-spend of the user's funds. So node-verify first: if the tx is
  // provably on chain (committed) or in the mempool (pending), complete the row
  // instead of resubmitting. An indeterminate result keeps the resubmit path (no
  // captured id / no record → we couldn't confirm it landed).
  if (NODE_VERIFIED_RETRY_TYPES.includes(tx.type)) {
    const verdict = await verifySendLanded(tx);
    if (verdict === 'landed') {
      // Not `updateTransactionStatus`: its terminal guard rejects the Failed row
      // this function is defined over, so this branch used to throw rather than
      // complete and the guard's only success path never once worked.
      await completeVerifiedLandedTransaction(txId, {
        displayMessage: 'Completed',
        completedAt: Math.floor(Date.now() / 1000)
      });
      return;
    }
  }

  // Last line: refuse rather than gamble.
  //
  // Everything above and below assumes ONE of two things makes a retry safe —
  // either the node can say the original landed, or the cached request pins the
  // note id so the chain rejects the duplicate. A plain (non-guardian) `send`
  // can end up with neither. It never caches a request (the guardian recallable
  // path is the only producer of a send's bytes), and a row failed from outside
  // its pipeline never captures a `transactionId`, because the completion write
  // that would stamp it is refused on a row that is already terminal. If a
  // submit is nonetheless plausible for such a row, requeueing rebuilds the
  // request with a fresh note serial and the chain has no reason to reject
  // it — the recipient is paid twice, silently.
  //
  // So where a crossing is actually RECORDED, say so instead of gambling. All
  // four conditions have to hold, and the case this whole change exists for — a
  // send that failed executing against the wrong vault slot — satisfies neither
  // of the last two, so it still rebuilds and retries normally.
  //
  // Which is also the limit of this guard, stated plainly because the shape of it
  // invites over-reading: it fires on a recorded crossing, not on the mere
  // possibility of one. A plain send has no submit crossing to record. Its
  // pipeline stamps 'sending' once at pickup and never narrows, so an ordinary
  // ambiguous failure at or after the submit is indistinguishable from one before
  // it, and the first Retry of such a row still rebuilds and can pay twice. The
  // two producers that DO leave a record are covered — an offscreen wedge-kill
  // (`cancelTransactionAfterPipelineStopped`) and a Cancel racing a live pipeline
  // (`cancelledInFlightAt`) — and closing the rest needs a captured transaction id
  // to verify against, or bytes to pin the note id, neither of which this path
  // has. That is the recovery work `PRE_SUBMIT_STAGES` names as its prerequisite,
  // and it is not this change. Widening the condition to "not provably
  // pre-submit" is NOT the fix: for a plain send that is always true, so it would
  // refuse every retry, vault-slot failures first.
  if (
    tx.type === 'send' &&
    tx.requestBytes === undefined &&
    tx.transactionId === undefined &&
    (tx.mayHaveSubmitted === true || pipelineMayStillBeRunning(tx.cancelledInFlightAt))
  ) {
    if (!options.acknowledgeUnverifiedSend) {
      throw new UnverifiableSendRetryError();
    }
    // The user has ruled the crossing out, so retract it rather than stepping
    // over it — see `RetryOptions.acknowledgeUnverifiedSend`. Before the requeue
    // below, since that reads both fields to decide what to keep.
    await Repo.transactions.where({ id: txId }).modify(dbTx => {
      dbTx.mayHaveSubmitted = undefined;
      dbTx.cancelledInFlightAt = undefined;
    });
  }

  // Read off the pre-reset row: the modify callback below clears `stage` as part
  // of returning the row to Queued, so it cannot be consulted from in there.
  const failedStage = tx.stage;
  const failedPreSubmit = failedStage !== undefined && PRE_SUBMIT_STAGES.has(failedStage);

  await Repo.transactions.where({ id: txId }).modify((dbTx: ITransaction) => {
    // `verifySendLanded` above makes a network round trip, so the row read at the
    // top of this function can be arbitrarily stale by now. Re-check what the
    // decision below was made from: if a concurrent retry already requeued this
    // row and the loop advanced the new attempt, writing here would reset a
    // live transaction to Queued and — worse — clear the NEW attempt's
    // `requestBytes` on the strength of the OLD attempt's stage, dropping the
    // double-send guard for a submit that may since have landed.
    if (dbTx.status !== ITransactionStatus.Failed || dbTx.stage !== failedStage) return;
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
    // A `send` row's cached bytes only exist for a GUARDIAN recallable send
    // (`ensureGuardianRecallableSendRequestBytes`) — the non-guardian path
    // rebuilds its request on every call and never reads `requestBytes`. Those
    // bytes froze an absolute reclaim height and the outgoing asset as built at
    // first attempt, so a retry has to rebuild them to stand any chance of
    // succeeding. But they also pin the note id, which is the ONLY thing that
    // makes the chain reject a duplicate — hence the gate; see
    // `PRE_SUBMIT_STAGES` for what the stage does and does not prove.
    //
    // No other requeueable type may be cleared, whatever its stage. A swap's
    // bytes must be reused byte-identically (the PSWAP flow requires it). A
    // `bridged-send` carries a pre-built note whose attachment this builder
    // cannot reproduce — the Epoch mandate binding, or the AggLayer B2AGG
    // destination — and behind an Epoch row the intent is already spent, so the
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
        // failure — which may land early and look pre-submit — still keeps these
        // bytes. Two conditions, and both are load-bearing:
        //
        //   - only when bytes EXIST. The flag's whole job is to protect them,
        //     and `mayHaveSubmitted` is permanent. Writing it to a byteless row
        //     protects nothing and instead manufactures a crossing that never
        //     happened, which the refusal above then reads as fact: a plain send
        //     is never stage-narrowed (its pipeline stamps 'sending' once, at
        //     pickup, and that is deliberately not pre-submit), so EVERY plain
        //     send would earn the flag on its first requeue and be refused on
        //     its second — the vault-slot failure this release fixes included.
        //     Nothing is lost by the scoping: bytes are persisted to the row
        //     before they are ever submitted (`ensureGuardianRecallableSend-
        //     RequestBytes`), so a byteless attempt provably never broadcast.
        //   - only from the STAGE. A live `cancelledInFlightAt` also makes a
        //     submit possible, but it says "we don't know YET" and expires
        //     saying so (see its docstring); it also survives the reset below on
        //     its own, so it needs no persisting. Promoting it here would freeze
        //     an unresolved maybe into a permanent yes and pin the request —
        //     with it the frozen absolute reclaim height — for good, which is
        //     the bricking this field was split in two to avoid.
        dbTx.mayHaveSubmitted = true;
      }
    }
  });
};

// NOTE: a failed `consume` of a bridged-in (EVM → Miden) note IS retryable via
// `requeueFailedTransaction` — the Miden-side claim is ours to re-run. What the
// wallet cannot replay are EVM-side failures (reverted source tx, failed Epoch
// intent); those never produce a Failed Miden row in the first place.

/**
 * Retry a failed Smart Withdraw.
 *
 * This used to flip the phase back to `redeeming` and re-run
 * `resumeEarnWithdrawal`, which just re-polls the SAME Epoch nonce. But
 * `phase === 'failed'` is set precisely because Epoch reported that intent
 * terminally failed/expired — repolling it can only ever fail again, so the
 * button was a no-op dressed as a retry.
 *
 * The position was never redeemed, and `IEarnWithdrawExtraInputs` persists
 * everything needed to rebuild the request (`evmOwner`, `marketUid`,
 * `sourceAmount`; Miden destination = `accountId`; underlying pinned to the one
 * supported market). So the retry now submits a genuinely NEW intent with a new
 * nonce, reusing the same row — see `resubmitEarnWithdrawal`.
 *
 * This covers BOTH terminal cases: an intent that failed on Epoch, and one that
 * never reached Epoch at all (no nonce recorded) — the latter has nothing to
 * resume but is perfectly resubmittable.
 */
export const retryEarnWithdrawReceive = async (txId: string): Promise<void> => {
  const tx = await Repo.transactions.where({ id: txId }).first();
  if (!tx || tx.type !== 'earn-withdraw') throw new Error(`Transaction ${txId} is not an earn-withdraw`);
  // Same rule as `isRequeueableTransaction`, and it matters more here: resubmit
  // signs EVM operations with the vault key using this row's own `evmOwner`,
  // `marketUid` and `sourceAmount`. An earn-withdraw row is born `Completed`
  // with its lifecycle in `extraInputs.phase`, so import leaves its status
  // untouched — the flag is the only thing marking it as not-ours.
  if (tx.restoredFromBackup) {
    throw new Error(`Transaction ${txId} was restored from a backup and cannot be resubmitted`);
  }
  const inputs: IEarnWithdrawExtraInputs = tx.extraInputs;
  if (inputs.phase !== 'failed') return;

  // Dynamic import: lib/epoch statically imports lib/miden/activity, which
  // re-exports this module — a static import here would be circular.
  const { resubmitEarnWithdrawal } = await import('lib/epoch');
  await resubmitEarnWithdrawal(txId);
};
