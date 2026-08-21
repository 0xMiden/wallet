import * as Repo from 'lib/miden/repo';

import { verifySendLanded } from './cancel';
import { updateTransactionStatus } from './helper';
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
      await updateTransactionStatus(txId, ITransactionStatus.Completed, {
        displayMessage: 'Completed',
        completedAt: Math.floor(Date.now() / 1000)
      });
      return;
    }
  }

  await Repo.transactions.where({ id: txId }).modify((dbTx: ITransaction) => {
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
