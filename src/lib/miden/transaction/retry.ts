import * as Repo from 'lib/miden/repo';

import { verifySendLanded } from './cancel';
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

/** Whether a Failed row can be retried by re-queueing it through the loop. */
export const isRequeueableTransaction = (tx: { status?: ITransactionStatus; type: ITransactionType }): boolean =>
  tx.status === ITransactionStatus.Failed && REQUEUEABLE_TYPES.includes(tx.type);

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
export const requeueFailedTransaction = async (txId: string): Promise<void> => {
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

  // Read off the pre-reset row: the modify callback below clears `stage` as part
  // of returning the row to Queued, so it cannot be consulted from in there.
  const failedStage = tx.stage;
  const failedPreSubmit = failedStage !== undefined && PRE_SUBMIT_STAGES.has(failedStage);
  // Sticky OR: once any attempt got far enough that a submit can't be ruled out,
  // every later attempt inherits that. Without the persisted half, the signal
  // died with the `stage` reset below and the NEXT failure — at, say, 'syncing'
  // — would clear bytes this retry just protected.
  const mayHaveSubmitted = tx.mayHaveSubmitted === true || !failedPreSubmit;

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
      if (mayHaveSubmitted) {
        // Persist BEFORE the stage is forgotten, so the next failure — which may
        // land on an early stage and look pre-submit — still sees it.
        dbTx.mayHaveSubmitted = true;
      } else {
        dbTx.requestBytes = undefined;
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
  const inputs: IEarnWithdrawExtraInputs = tx.extraInputs;
  if (inputs.phase !== 'failed') return;

  // Dynamic import: lib/epoch statically imports lib/miden/activity, which
  // re-exports this module — a static import here would be circular.
  const { resubmitEarnWithdrawal } = await import('lib/epoch');
  await resubmitEarnWithdrawal(txId);
};
