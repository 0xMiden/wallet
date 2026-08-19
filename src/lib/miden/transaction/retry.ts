import * as Repo from 'lib/miden/repo';

import { verifySendLanded } from './cancel';
import { isSubmitOutcomeUnknown, TRANSACTION_RETRY_UNSAFE_ERROR } from './constants';
import {
  IBridgeProvider,
  IBridgedSendExtraInputs,
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
 *
 * `earn-deposit` is ALSO excluded, and for a different reason. The row is only
 * the Miden half of an Epoch lending deposit: `openEarnPosition` quotes the
 * intent, then `solveIntent` calls back into `createEarnP2IDNote`, which queues
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
 *    `createEarnP2IDNote` read it back, not to re-send. `earn-deposit` belongs
 *    in that type-agnostic path too, and stays there.
 *
 * Both of those cover cases where the intent is still valid; only the terminal
 * FIFO requeue, which reruns a send whose intent is gone, has to exclude it.
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
 * height, and then report "Bridged to EVM" — so the user must re-initiate from the
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
 * `bridgeProvider` is the row's `extraInputs.provider` for a `bridged-send`
 * (callers that hold the raw row can pass `bridgeProviderOf(tx)`; UI callers pass
 * the value they already projected). It is required to tell the replayable
 * Agglayer route from the non-replayable Epoch one — see `REQUEUEABLE_TYPES`.
 *
 * `transactionId` and `processingStartedAt` feed the double-send guard below;
 * the failure REASON is deliberately not an input (see `isSubmitOutcomeUnknown`).
 */
export const isRequeueableTransaction = (tx: {
  status?: ITransactionStatus;
  type: ITransactionType;
  bridgeProvider?: IBridgeProvider;
  transactionId?: string;
  processingStartedAt?: number;
}): boolean => {
  if (tx.status !== ITransactionStatus.Failed) return false;
  if (!REQUEUEABLE_TYPES.includes(tx.type)) return false;
  if (tx.type === 'bridged-send' && tx.bridgeProvider === NON_REQUEUEABLE_BRIDGE_PROVIDER) return false;
  // Double-send guard: a rebuilt-request type that demonstrably left the queue
  // (`processingStartedAt`) yet carries no `transactionId` for the node check is
  // NOT retryable — nothing on the row can rule out a landed submit, and nothing
  // is left to ask the node about. See REBUILT_REQUEST_TYPES.
  if (REBUILT_REQUEST_TYPES.includes(tx.type) && !tx.transactionId && isSubmitOutcomeUnknown(tx)) return false;
  return true;
};

/**
 * Retry a Failed transaction by resetting its row to `Queued` so the FIFO
 * processing loop picks it up again. The row keeps its id (and, for swaps,
 * its persisted `requestBytes` — the retry reuses the exact same request,
 * which the PSWAP flow requires). `initiatedAt` is refreshed so the
 * stale-queued TTL doesn't cancel the retry on sight, and `nextEligibleAt`
 * is cleared so a stale requeue-backoff can't delay the user's explicit retry.
 */
/** Output-producing types whose Retry must first node-verify it didn't already
 *  land (double-send guard). Consume is excluded — it has its own input-note
 *  landed check (verifyConsumeLanded) on the kill/reaper path. */
const NODE_VERIFIED_RETRY_TYPES: ITransactionType[] = ['send', 'swap', 'bridged-send', 'execute'];

/**
 * The types whose request is REBUILT from scratch on every attempt, so a second
 * submit produces a genuinely NEW output note (new serial) that the node has no
 * reason to reject — i.e. the ones where a resubmit of an already-landed tx is a
 * real double-send of the user's funds. Guardian sends/swaps are `send`/`swap`
 * rows too, and each retry builds a fresh proposal, so they are covered here.
 *
 * `bridged-send` (Agglayer) and `execute` are excluded: both replay the
 * `requestBytes` persisted on the row, so a duplicate submit re-creates the
 * IDENTICAL note and the node rejects it rather than moving funds twice.
 * (`consume` is excluded for the same reason its Retry needs no node check — its
 * input note's nullifier makes a duplicate unusable.)
 *
 * Why these need a guard beyond `verifySendLanded`: that check is keyed on
 * `ITransaction.transactionId`, and the only writers of that field are the
 * completion handlers in `complete.ts` — the SUCCESS path — plus
 * `updateBridgedReceivePhase`. A row that failed before any completion handler
 * ran therefore reaches Retry with `transactionId === undefined`, where
 * `verifySendLanded` short-circuits to `'unknown'` and the resubmit would proceed
 * unguarded. Stamping the id pre-submit is not available today: under
 * `MIDEN_USE_OFFSCREEN_CLIENT` the write runs in the offscreen realm, whose DTOs
 * deliberately do not carry the row id (the op_id is the whole correspondence),
 * so there is nothing there to stamp it onto. So the guard falls back to the one
 * durable in-realm fact that IS on the row — did it ever leave the queue — and
 * refuses the replay whenever the answer is yes (`isSubmitOutcomeUnknown`).
 *
 * That is deliberately conservative: it also hides Retry for a send that failed
 * provably pre-submit (say, insufficient funds during execute), because nothing
 * durable distinguishes that from a submit whose reply was lost. The user
 * re-initiates from the send/swap flow instead, which is the same rebuilt request
 * made with full context rather than a one-tap replay the wallet cannot vouch for.
 */
const REBUILT_REQUEST_TYPES: ITransactionType[] = ['send', 'swap'];

export const requeueFailedTransaction = async (txId: string): Promise<void> => {
  const tx = await Repo.transactions.where({ id: txId }).first();
  if (!tx) throw new Error(`Transaction ${txId} not found`);
  // Pass the WHOLE row, not just its type: the double-send guard inside
  // `isRequeueableTransaction` reads `transactionId` and `processingStartedAt`.
  if (!isRequeueableTransaction({ ...tx, bridgeProvider: bridgeProviderOf(tx) })) {
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
      // Write the terminal state DIRECTLY. `updateTransactionStatus` refuses to
      // touch a row that is already Failed or Completed, and this function only
      // ever runs on a Failed row (`isRequeueableTransaction` requires it) — so
      // routing the reconcile through it threw `Transaction already in a
      // finalized state` on 100% of executions. The exception propagated to the
      // Retry button as "Something went wrong" and the row stayed Failed forever
      // even though the funds had left the account. Same reason
      // `markBridgedSendFailed` writes the row directly.
      await Repo.transactions.where({ id: txId }).modify((dbTx: ITransaction) => {
        dbTx.status = ITransactionStatus.Completed;
        dbTx.displayMessage = 'Completed';
        dbTx.completedAt = Math.floor(Date.now() / 1000);
        dbTx.error = undefined;
        dbTx.rawError = undefined;
      });
      return;
    }
    // Not provably landed. For a row that executed, `'unknown'` means "we could
    // not confirm", NOT "it did not land" — and for a rebuilt-request type a
    // resubmit would broadcast a SECOND send. `isRequeueableTransaction` already
    // hides the Retry affordance for the no-`transactionId` case; this is the
    // backstop for a row that HAS an id the node has no record of, and for any
    // caller that skipped the UI.
    if (REBUILT_REQUEST_TYPES.includes(tx.type) && isSubmitOutcomeUnknown(tx)) {
      throw new Error(TRANSACTION_RETRY_UNSAFE_ERROR);
    }
  }

  await Repo.transactions.where({ id: txId }).modify((dbTx: ITransaction) => {
    dbTx.status = ITransactionStatus.Queued;
    dbTx.initiatedAt = Math.floor(Date.now() / 1000);
    dbTx.processingStartedAt = undefined;
    dbTx.completedAt = undefined;
    dbTx.stage = undefined;
    // Clear the stage stamps with the stage. `setTransactionStage` is
    // first-entry-wins (#524), so leaving the FAILED attempt's boundaries behind
    // would make the retried attempt's steps render that attempt's durations —
    // and only `complete` would be re-stamped. This matters now that the retry
    // footer (#483) is reachable at all: #507 removed the receipt auto-close, so
    // a failed receipt stays up until the user acts on it.
    dbTx.stageTimestamps = undefined;
    dbTx.nextEligibleAt = undefined;
    dbTx.error = undefined;
    dbTx.rawError = undefined;
    dbTx.displayMessage = undefined;
    dbTx.displayIcon = ICON_BY_TYPE[dbTx.type] ?? 'DEFAULT';
  });
};

// NOTE: a failed `consume` of a bridged-in (EVM → Miden) note IS retryable via
// `requeueFailedTransaction` — the Miden-side claim is ours to re-run. What the
// wallet cannot replay are EVM-side failures (a reverted source tx, or a rejected
// Epoch intent). A rejected Epoch intent DOES leave a Failed Miden row — either the
// bridged-send row failed on its own and `bridgeEpochSend` threw, or
// `markBridgedSendFailed` demoted an already-Completed row after the allocator
// rejected the intent. That row is exactly the case `isRequeueableTransaction`
// excludes above: its collateral note is (or would be) on chain with no intent
// behind it, so it is reported Failed and left to reclaim at its recall height.

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
