import {
  NoteType,
  type TransactionRequest,
  TransactionProver,
  type TransactionResult,
  WasmWebClient
} from '@miden-sdk/miden-sdk/lazy';
import { type Proposal } from '@openzeppelin/miden-multisig-client';

import {
  getOrCreateMultisigService,
  isGuardianAccount,
  type GuardianAccountProvider
} from 'lib/miden/front/guardian-manager';
import { MultisigService } from 'lib/miden/guardian';
import {
  guardianRetryAfterSec,
  isGuardianPendingConflict,
  isGuardianRateLimited,
  withGuardianAccountLock,
  withGuardianConflictRetry
} from 'lib/miden/guardian/serialize';
import { assertGuardianInSync } from 'lib/miden/guardian/sync-guard';
import * as Repo from 'lib/miden/repo';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { isMobile } from 'lib/platform';
import { logger } from 'shared/logger';

import {
  cancelStaleQueuedTransactions,
  cancelStuckTransactions,
  cancelTransactionAfterPipelineStopped,
  verifyConsumeLanded
} from './cancel';
import {
  completeBridgedSendTransaction,
  completeConsumeTransaction,
  completeCustomTransaction,
  completeEarnDepositTransaction,
  completeReplaceHotKeyTransaction,
  completeSendTransaction,
  completeSwapTransaction,
  completeSwitchGuardianTransaction,
  completeUpdateProcedureThresholdTransaction
} from './complete';
import { getAllUncompletedTransactions, getTransactionsInProgress } from './get';
import {
  isGuardianCanonicalizationError,
  isLockedError,
  markMayHaveSubmitted,
  readLastAuthReason,
  setTransactionStage,
  updateTransactionStatus
} from './helper';
import { bridgeProviderOf } from './retry';
import { markConnectivityIssue } from '../activity/connectivity-state';
import { importAllNotes } from '../activity/notes';
import { compareAccountIds } from '../activity/utils';
import { dispatchGuardianPipeline, midenClientProxy } from '../back/miden-client-proxy';
import { isOperationAbortedError } from '../back/offscreen-codec';
import { isOffscreenAvailable } from '../back/offscreen-prover';
import {
  BridgedSendTransaction,
  ConsumeTransaction,
  EarnDepositTransaction,
  IBridgeProvider,
  ITransaction,
  ITransactionStage,
  ITransactionStatus,
  ITransactionType,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwapTransaction,
  SwitchGuardianTransaction,
  Transaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import { isPrivateNoteType } from '../helpers';
import {
  accountIdStringToSdk,
  accountRefToSdk,
  buildPswapCreateRequest,
  buildSendTransactionRequest,
  canonicalWalletAccountId,
  sameWalletAccountId,
  walletAccountIdToSdk
} from '../sdk/helpers';
import { getMidenClient, withWasmClientLock, withWasmLockWatchdogPaused } from '../sdk/miden-client';
import { MidenClientCreateOptions } from '../sdk/miden-client-interface';
import { buildNativeProverCallback } from '../sdk/native-prover-mobile';
import { extractSdkErrorCode, isApplyAfterSubmitError } from '../sdk/sdk-error-code';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';

export * from './cancel';
export * from './complete';
export * from './constants';
export * from './get';
export * from './helper';
export * from './initiate';
export * from './retry';

// Transaction types whose proposal creator is side-effect-free and idempotent on
// a pending-delta 409, so returning the tx to the queue for a later cycle is safe.
// Structural ops are deliberately EXCLUDED: `replace-hot-key` mints a hardware hot
// key inside createReplaceHotKeyProposal BEFORE its proposal POST, so a requeue
// re-mints and orphans another key every cycle; `switch-guardian` /
// `update-procedure-threshold` create a proposal (and switch-guardian cold
// co-signs) whose re-run can register a duplicate delta and push the commitment
// past the guardian's expected single delta. Those fall through to cancelTransaction.
const REQUEUEABLE_ON_PENDING_CONFLICT: ReadonlySet<ITransactionType> = new Set<ITransactionType>([
  'send',
  'consume',
  'swap',
  'earn-deposit',
  'execute'
]);

// Guardian tx-types whose leaf pipeline is safe to run offscreen (issue #260).
// Slice 6a routed the four value-moving types (send / consume / swap / execute);
// slice 6b adds the three STRUCTURAL types (switch-guardian / replace-hot-key /
// update-procedure-threshold). All nine (6a/6b + the 7c bridged-send / earn-deposit
// below) cross the SAME serializable waist: by
// the time control reaches the leaf, `signAndCreateTransactionRequest` has folded
// every co-signature (hot + cold + guardian) into the `tr` advice map, which
// `TransactionRequest.serialize()` preserves (§4.0), so only `executeRequest →
// prove → submit → apply` moves. Everything the structural types add is SW-side
// and BEFORE/AFTER this leaf, unchanged flag-on vs flag-off: the switch-guardian
// cold co-sign and the replace-hot-key `persistNewHotKey` run before dispatch, and
// the post-pipeline `waitForTransactionCommit` (id re-derived from the round-tripped
// result) runs after. A killed structural leaf → Failed with NO auto-requeue (the
// slice-6a behavior; structural types are excluded from REQUEUEABLE_TYPES, so the
// only recovery is a user-initiated re-run that builds a fresh proposal against the
// post-change chain state — never a double-apply). Slice 7c adds the last two
// value-moving guardian types (bridged-send / earn-deposit): both are hot-bound
// custom-proposal sends whose `tr` reaches the leaf fully co-signed via the SAME
// `signAndCreateTransactionRequest` (no cold co-sign — they are not structural), so
// they cross the identical serializable waist as the recallable send / swap already
// routed here. Their completion handlers already consume an offscreen-round-tripped
// result flag-on (the non-guardian leaf moved offscreen in slice 7b feeds the same
// completeBridgedSend / completeEarnDeposit), and a wedge-kill →
// OperationAbortedError falls through the guardian catch to cancelTransaction →
// Failed with NO silent auto-requeue (earn-deposit and Epoch bridged-send are both
// excluded from REQUEUEABLE_TYPES, and bridged-send is user-tap-only — never
// auto-requeued — so a killed-then-retried send-style write can't double-spend), and
// a round-tripped apply-after-submit failure reaches the guardian classifier via the
// forwarded error TEXT (`isApplyAfterSubmitError`; → both Fail, byte-identical to
// their flag-off inline apply throw). An unknown type is not in the set, so it stays
// inline too.
const OFFSCREEN_ROUTABLE_GUARDIAN_TYPES: ReadonlySet<ITransactionType> = new Set<ITransactionType>([
  'send',
  'consume',
  'swap',
  'execute',
  'switch-guardian',
  'replace-hot-key',
  'update-procedure-threshold',
  'bridged-send',
  'earn-deposit'
]);

/**
 * Whether a row's caller BLOCKS on `waitForTransactionCompletion(txId)` and then
 * reads `resultBytes` / `outputNoteIds` back off the finished row:
 *
 *   - `earn-deposit`           → `createEarnP2IDNote` (lib/epoch/earn-note.ts)
 *   - `bridged-send` (EPOCH)   → `createBridgeP2IDNote` (lib/epoch/miden-note.ts)
 *
 * Both are the Miden half of an Epoch flow: a recallable P2IDE collateral note whose
 * id the caller needs before it can submit the surrounding intent.
 *
 * A post-submit failure (a local apply throw, or a guardian canonicalization race)
 * leaves NO `TransactionResult` to repopulate those fields from. Marking such a row
 * Completed would hand the waiter `TransactionResult.deserialize(undefined)`, which
 * throws inside the liveQuery observer AFTER `cleanup()` has already cleared the
 * timeout — the promise then never settles and the Epoch flow hangs forever while the
 * activity row claims success. So these rows must be marked Failed instead: the
 * caller resolves via the error branch, the flow can run its own failure handling
 * (`markBridgedSendFailed`), and the on-chain collateral note reclaims itself at its
 * recall height. Neither is blindly re-queued into a duplicate note — `earn-deposit`
 * and Epoch `bridged-send` are both excluded from `REQUEUEABLE_TYPES`.
 *
 * The gate is per-ROUTE, not per-type, because only ONE of the two `bridged-send`
 * routes has an awaiting caller. The Agglayer (Slow) route enters via
 * `initiateB2AggBridge` (lib/agglayer/b2agg/index.ts), which returns the txId
 * immediately and never awaits the row — it carries a self-contained pre-built
 * B2AGG `requestBytes` and needs nothing read back off it. Failing an Agglayer row
 * whose note IS on chain is actively harmful: `BridgeClaimSection` gates the deposit
 * tracker and the whole Connect-wallet / Claim-Asset block on
 * `status !== Failed`, so a Failed row removes the only in-wallet path to claim the
 * bridged funds on L1, and the Epoch-only "Reclaim funds" fallback does not apply.
 * So an Agglayer row takes the generic “mark Completed, sync will reconcile” path
 * instead, exactly like a plain send.
 *
 * A `bridged-send` with no recorded `provider` (no such row is written by this
 * codebase — `IBridgedSendExtraInputs.provider` is required) is treated as NOT
 * result-awaiting, matching `isRequeueableTransaction`'s handling of the same field.
 */
const RESULT_AWAITING_BRIDGE_PROVIDER: IBridgeProvider = 'epoch';

const isResultAwaitingRow = (tx: Pick<ITransaction, 'type' | 'extraInputs'>): boolean => {
  if (tx.type === 'earn-deposit') return true;
  if (tx.type === 'bridged-send') return bridgeProviderOf(tx) === RESULT_AWAITING_BRIDGE_PROVIDER;
  return false;
};

/**
 * Activity label for a guardian row whose submit LANDED on chain but whose local
 * reconcile failed. There is no `TransactionResult` here, so the label is derived
 * from the type alone and must match what the happy-path completion handler would
 * have written: `completeConsumeTransaction` → "Claimed",
 * `completeBridgedSendTransaction` → "Bridged to EVM", everything else → "Sent".
 */
const applyLandedDisplayMessage = (type: ITransactionType): string => {
  if (type === 'consume') return 'Claimed';
  if (type === 'bridged-send') return 'Bridged to EVM';
  return 'Sent';
};

// Cooldown (seconds) applied to a tx requeued after a transient guardian
// pending-delta 409. A persistently-conflicting tx is always the OLDEST Queued
// row by initiatedAt, so without a backoff it is re-picked every cycle — burning
// the ~60s inline retry budget and starving another account's freshly-queued tx
// until it ages out at MAX_QUEUED_AGE. Setting `nextEligibleAt = now + this` makes
// the loop skip it for at least one cycle so other accounts drain first. Kept
// comfortably above the processing loop's ~5s poll interval so the skip is not a
// race; MAX_QUEUED_AGE stays the terminal cap.
const PENDING_CONFLICT_REQUEUE_COOLDOWN_SEC = 15;

// Cooldown (seconds) applied to a tx requeued after a transient remote-prover
// outage (#419). A delegated prove step that fails at the 'proving' stage is
// PRE-submit — nothing reached the chain — so instead of terminal-failing the
// user's transfer we return it to the queue and retry, letting it complete once
// the prover recovers. Kept a bit longer than the pending-conflict cooldown to
// avoid hammering a downed prover; MAX_QUEUED_AGE stays the terminal cap.
const PROVER_OUTAGE_REQUEUE_COOLDOWN_SEC = 30;

// Fallback cooldown (seconds) for a tx requeued after a guardian 429 (#617),
// used only when the guardian didn't send a `retry_after_secs`. The guardian
// declares rate-limit rejections retryable, so terminal-failing a value-moving
// transfer on one loses the user's transaction to a transient limit. Prefer the
// server's own figure via `guardianRetryAfterSec`; MAX_QUEUED_AGE stays the
// terminal cap.
const RATE_LIMIT_REQUEUE_COOLDOWN_SEC = 30;
// The guardian's `retry_after_secs` is advisory and must be CLAMPED before it
// becomes `nextEligibleAt`, in both directions:
//   - Too small (0, or anything under the ~5s SW / 10s UI poll cadence) and the
//     requeued row — still the oldest by initiatedAt, which requeueing does not
//     refresh — is re-picked every single cycle, re-running syncState under the
//     global WASM lock and re-hitting the guardian that just said back off, while
//     head-of-line blocking every other account's tx. That is exactly the
//     starvation PENDING_CONFLICT_REQUEUE_COOLDOWN_SEC exists to prevent.
//   - Too large and the row never becomes eligible before MAX_QUEUED_AGE (30
//     min from initiatedAt) reaps it, so the user waits out the whole cap for
//     zero retries and gets a generic "expired" message.
// Cooldown (seconds) applied to a tx deferred because the wallet LOCKED mid-sign
// (issue #313). The deferral has to return the row to `Queued`: `generateTransaction`
// advances it to `GeneratingTransaction` BEFORE any signing, and
// `getTransactionsInProgress()` selects exactly that status, so a row left there
// head-of-line blocks `generateTransactionsLoop` for EVERY account until
// `cancelStuckTransactions` reaps it at MAX_WAIT_BEFORE_CANCEL (30 min desktop /
// 2 min mobile) — the terminal note-claim failure the #313 guard exists to prevent.
// The cooldown keeps a still-locked wallet from re-attempting (and re-syncing)
// every ~5s poll, and is short enough that the first post-unlock cycle picks the
// tx up; MAX_QUEUED_AGE stays the terminal cap.
const LOCKED_REQUEUE_COOLDOWN_SEC = 15;

const MIN_RATE_LIMIT_REQUEUE_COOLDOWN_SEC = PENDING_CONFLICT_REQUEUE_COOLDOWN_SEC;
const MAX_RATE_LIMIT_REQUEUE_COOLDOWN_SEC = 300;

/**
 * Build the row-bound per-step stage stamp handed to a write pipeline (PR #524):
 * `stage => setTransactionStage(txId, stage)`, made UNFAILABLE.
 *
 * A stage stamp is telemetry for the generating-transaction screen's per-step
 * durations — never transaction state — so it must not be able to fail a
 * funds-moving write. Two of the four pipelines that receive one AWAIT it mid-write
 * (`MidenClientInterface.sendTransaction`'s `await onStage?.(…)` on the flag-OFF
 * send, and `runGuardianPipeline`'s `await setStage(…)` on the flag-OFF guardian
 * leaf), so a Dexie hiccup inside `setTransactionStage` would propagate straight out
 * of the write. The other two are already safe by construction — flag-ON both
 * pipelines post the stamp across the offscreen bus and the SW-side
 * `handleOffscreenStageEvent` swallows a throwing callback — which is exactly why
 * the guard belongs HERE, at the single place the callback is produced, rather than
 * at each consumer: every path then inherits it once, and the invariant no longer
 * depends on which realm the leaf happened to run in.
 */
const stageStampFor =
  (txId: string): ((stage: ITransactionStage, opts?: { readonly reliable?: boolean }) => Promise<void>) =>
  async (stage, opts) => {
    try {
      // 'submitting' is stamped immediately before the submit call, so it is the
      // exact crossing the double-send guard needs — and it has to be recorded
      // even for an unreliable stamp, and even once the row is terminal. A
      // concurrent cancel makes the row terminal without stopping the pipeline,
      // and `setTransactionStage` drops writes on terminal rows, so the stage
      // would stay frozen where the cancel caught it and Retry would read a
      // landed send as never-broadcast. `markMayHaveSubmitted` is guard-free for
      // that reason. Unlike `stage`, a dropped stamp here can only under-report,
      // which the coarser `isSubmitOutcomeUnknown` reading still catches.
      if (stage === 'submitting') await markMayHaveSubmitted(txId);
      // An UNRELIABLE stamp (replayed from the offscreen realm — see StageCallback in
      // back/miden-client-proxy.ts) records the boundary for the progress screen but
      // must not author `stage`: the requeue gates below read that field to conclude a
      // failed guardian tx never reached the chain, and a dropped or reordered
      // cross-realm stamp would make that conclusion wrong.
      await setTransactionStage(txId, stage, { timingOnly: opts?.reliable === false });
    } catch (err) {
      console.warn(`Stage stamp '${stage}' for transaction ${txId} failed; ignoring`, err);
    }
  };

/**
 * Return a value-moving tx to the Queued state for a later generateTransactionsLoop
 * cycle instead of terminal-failing it, backing it off with `nextEligibleAt` so it
 * doesn't starve other accounts' queued txs. Shared by the guardian pending-delta
 * 409 requeue and the remote-prover-outage requeue (#419). Clearing
 * `processingStartedAt` avoids cancelStuckTransactions reaping it as stalled;
 * cancelStaleQueuedTransactions (MAX_QUEUED_AGE) remains the terminal cap.
 */
async function requeueTransactionForRetry(
  txId: string,
  txType: ITransactionType,
  stage: ITransactionStage,
  cooldownSec: number
): Promise<void> {
  // An earn-deposit's requestBytes freeze an ABSOLUTE reclaim height at build
  // time (syncHeight + recallBlocks); reusing them across a long requeue loop
  // would strand the collateral at the Epoch allocator. Drop the cached request
  // so the next cycle rebuilds the P2IDE note against a fresh sync height. Safe:
  // nothing reached the chain on a pre-submit requeue.
  //
  // A guardian recallable `send` freezes the same absolute height, and freezes
  // its asset too — built at first attempt, so a wrong callback flag there fails
  // the kernel's remove-asset assertion on every cycle for as long as the bytes
  // survive. Same rule, same pre-submit safety argument. `swap` is requeueable
  // too and must NOT be cleared: the PSWAP flow requires byte-identical reuse.
  //
  // The pre-submit argument holds for the attempt running RIGHT NOW (all callers
  // requeue from proposal creation or proving), but not necessarily for the row:
  // a user Retry of a send that died post-submit keeps its bytes and stamps
  // `mayHaveSubmitted`, and the fresh attempt can then hit a 409 here. Clearing
  // on the strength of this attempt's stage would rebuild the note id that is
  // the only thing stopping the chain from accepting a second payment, so the
  // sticky flag vetoes the clear.
  //
  // Folded into the status write rather than a second `modify`: as two writes, a
  // service-worker death between them left the row Queued with its stale bytes
  // intact — the exact state this clear exists to prevent, and self-perpetuating
  // once the row is picked up again. `updateTransactionStatus` Object.assigns
  // `otherValues`, so the undefined lands in the same transaction as the status.
  const row = await Repo.transactions.where({ id: txId }).first();
  const clearRequestBytes = (txType === 'earn-deposit' || txType === 'send') && row?.mayHaveSubmitted !== true;
  await updateTransactionStatus(txId, ITransactionStatus.Queued, {
    processingStartedAt: undefined,
    stage,
    // Reset the per-stage timing stamps: the row re-enters at `stage`, and the
    // stamps are first-entry-wins, so a stale original would make that step span
    // the whole cooldown plus every failed attempt in the generating-transaction
    // step timings.
    stageTimestamps: undefined,
    nextEligibleAt: Math.floor(Date.now() / 1000) + cooldownSec,
    ...(clearRequestBytes ? { requestBytes: undefined } : {})
  });
}

/**
 * Run the structural side effects a structural Guardian op needs after its
 * submit landed on chain but the LOCAL apply failed (`ApplyTransactionAfterSubmitFailed`).
 * Without this the generic apply-failure handler would mark the tx Completed and
 * skip reconciliation, stranding the account.
 *
 * replace-hot-key → swap the vault hot pointer (idempotent).
 * switch-guardian → rebuild a service to drive `finalizeGuardianSwitch` (which
 *   re-syncs the post-switch account state itself) + persist the per-account
 *   endpoint. Both completion handlers tolerate a missing TransactionResult.
 */
async function reconcileStructuralApplyFailure(
  tx: ITransaction,
  guardianProvider: GuardianAccountProvider
): Promise<void> {
  if (tx.type === 'replace-hot-key') {
    await completeReplaceHotKeyTransaction(tx as ReplaceHotKeyTransaction, undefined, guardianProvider);
    return;
  }
  const service = await getOrCreateMultisigService(tx.accountId, guardianProvider);
  await completeSwitchGuardianTransaction(tx as SwitchGuardianTransaction, undefined, service, guardianProvider);
}

/**
 * #260 follow-up #3a — node-verified requeue for a deadline-killed CONSUME write.
 *
 * A wedge-killed offscreen write surfaces as a retryable `OperationAbortedError`
 * (issue #260). Today a killed consume falls through to `cancelTransaction` →
 * Failed even when the consume actually LANDED on chain before the offscreen realm
 * was torn down. That Failed-but-landed consume is SAFE from double-spend (a
 * re-consume collides on the note nullifier), but the status is misleading: the
 * note WAS claimed. A consume's input `noteId` is known BEFORE execute (it is on
 * the tx row) and the note's on-chain consumed-state is authoritative, so before
 * failing a killed consume we ask the node whether the note landed as consumed and
 * mark it Completed if so.
 *
 * Returns `true` when the caller must NOT fail the row — either because this
 * marked it Completed, or because the node reports the consume already in flight
 * (`'processing'`), which the stuck reaper resolves on a later cycle. Returns
 * `false` to fall through to the existing `cancelTransaction` → Failed.
 *
 * FUNDS-SAFETY — a false 'Received' is impossible. 'landed' requires a node-positive
 * consumed state, and this path completes ONLY on `'landed-local'`: a note consumed
 * by THIS client's own tracked tx, provably my consume. `'landed-external'`
 * (`ConsumedExternal`) is consumed by *someone* but NOT provably me — a reclaimable
 * P2IDE the sender may have reclaimed lands in that state — so it is NOT treated as
 * landed here and falls through to Failed. The residual is a SAFE false-Failed: a
 * landed-but-untracked consume shows Failed while a re-consume harmlessly collides
 * on the note nullifier and the next sync reconciles the row — never a false
 * 'Received' telling the user they got funds a third party actually took. A missing
 * note, `'invalid'`, `'not-landed'`, or a query error (`'unknown'`) likewise return
 * `false` → the unchanged funds-safe Failed path.
 *
 * `'processing'` is the one verdict that is neither: the note is spent by a
 * transaction of OURS that was submitted and applied locally, so failing the row
 * would report a claim that reached the node as Failed (and count it toward the
 * per-note auto-consume backoff), while completing it would call a not-yet-committed
 * block 'Received'. It therefore returns `true` WITHOUT writing a terminal status —
 * the row stays in progress and `verifyStuckTransactionsFromNode` resolves it once
 * the note settles into a consumed state or reverts to `Committed`. SCOPE is CONSUME only: send / swap
 * / execute / bridged-send / earn-deposit have no node-checkable post-kill identity
 * (their tx-id/output-note are lost with the killed result) — a separate deferred
 * follow-up (#3b) handles them, and this helper leaves that send-style path untouched.
 */
async function tryCompleteKilledConsume(transaction: Transaction, error: unknown): Promise<boolean> {
  // A lock-recovery eviction (issue #775) is the same shape as an offscreen
  // deadline kill: the consume was killed from outside with its outcome
  // unknown, so it gets the same node adjudication instead of a blind Failed.
  if (!isOperationAbortedError(error) && !isWasmClientPoisonedError(error)) return false;
  if (transaction.type !== 'consume') return false;
  const consumeTx = transaction as ConsumeTransaction;
  if (!consumeTx.noteId) return false;

  // sync: true — this resolves ONE killed tx and wants the freshest possible note
  // state before deciding (the background reaper rides AutoSync and passes false).
  const verdict = await verifyConsumeLanded(consumeTx, true);
  // In flight: submitted and applied locally, block not committed yet. Neither
  // terminal state is honest, so leave the row for the reaper (see above).
  if (verdict === 'processing') return true;
  // Complete ONLY on 'landed-local' (provably this client's own consume). See the
  // FUNDS-SAFETY note above: 'landed-external'/'invalid'/'not-landed'/'unknown' →
  // funds-safe Failed, never a false 'Received'.
  if (verdict !== 'landed-local') return false;

  // The node confirms the note is consumed on chain by this client's own tx — the
  // consume DID land. Mirror completeConsumeTransaction's label: a self-reclaim
  // (note sender === my account) shows 'Reclaimed', a claim of someone else's note
  // shows 'Received'. NO requeue.
  const reclaimed = compareAccountIds(consumeTx.accountId, consumeTx.secondaryAccountId ?? '');
  await updateTransactionStatus(transaction.id, ITransactionStatus.Completed, {
    displayMessage: reclaimed ? 'Reclaimed' : 'Received',
    completedAt: Math.floor(Date.now() / 1000) // seconds
  });
  return true;
}

/**
 * Throws when `openEarnPosition` has already abandoned this earn deposit, so the
 * collateral note must NOT be submitted. Called by BOTH leaves — the Guardian one
 * and the non-Guardian one — each inside its own error handling, which is why it
 * is a helper rather than a single check at the top of `generateTransaction`.
 *
 * `openEarnPosition` gives up on a deposit whose queued row didn't complete within
 * `waitForTransactionCompletion`'s 5 minutes (or whose Epoch intent was aborted)
 * and records that by patching `extraInputs.epochStatus = 'failed'` (earn.ts). That
 * patch does NOT touch `status` — unlike the bridged-send abandonment path
 * (`markBridgedSendFailed`, which writes `Failed` and so removes the row from the
 * Queued scan) — leaving the row Queued and well inside MAX_QUEUED_AGE, so the FIFO
 * loop still picks it up once the queue drains. Submitting it then mints a P2IDE
 * collateral note to the Epoch allocator with no live intent behind it: the funds
 * are stranded until the note's reclaim height (MIDEN_MIN_RECLAIM_BLOCKS +
 * MIDEN_RECLAIM_BUFFER_BLOCKS) and the activity row falsely reads "Deposited to
 * lending".
 *
 * The row is re-read rather than trusted from memory: the in-memory copy was loaded
 * when the loop picked the row, which can be minutes earlier — exactly the window in
 * which the caller gives up.
 *
 * The throw is terminal (→ cancelTransaction → Failed), and a Failed earn-deposit is
 * never auto-requeued: it is excluded from REQUEUEABLE_TYPES precisely so it cannot
 * be replayed into a duplicate note.
 */
const assertEarnDepositIntentLive = async (transaction: ITransaction): Promise<void> => {
  const freshRow = await Repo.transactions.where({ id: transaction.id }).first();
  const row: ITransaction = freshRow ?? transaction;
  if (row.extraInputs?.epochStatus === 'failed') {
    throw new Error(
      'Earn deposit was already abandoned by the caller (epochStatus=failed) — refusing to submit an orphan collateral note.'
    );
  }
};

export const generateTransaction = async (
  transaction: Transaction,
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  _useWorker: boolean = true,
  guardianProvider: GuardianAccountProvider
) => {
  // Sync state first to ensure we have latest account state
  // Separate lock acquisition to avoid holding lock during network call
  // If sync fails (e.g. network down), the error propagates to generateTransactionsLoop's
  // catch block which cancels the transaction — this is intentional fail-fast behavior,
  // since the transaction can't be submitted without network anyway
  await setTransactionStage(transaction.id, 'syncing');
  await withWasmClientLock(async () => midenClientProxy.syncState());

  // Mark transaction as in progress
  await updateTransactionStatus(transaction.id, ITransactionStatus.GeneratingTransaction, {
    processingStartedAt: Math.floor(Date.now() / 1000), // seconds
    stage: 'sending'
  });

  // Route Guardian accounts through Guardian service
  if (await isGuardianAccount(transaction.accountId, guardianProvider)) {
    try {
      // Serialize guardian transactions per account: the guardian co-signs one
      // delta per account at a time, and concurrent same-account txs make its
      // expected commitment diverge from on-chain, stalling canonicalization
      // for minutes (see guardian/serialize.ts and OpenZeppelin/guardian#303).
      // Canonicalize the lock key: the same guardian account can arrive as a bare
      // bech32 address (dApp) or the composite publicKey (in-wallet); both must take
      // the SAME per-account chain, else concurrent deltas stall canonicalization.
      await withGuardianAccountLock(canonicalWalletAccountId(transaction.accountId), () =>
        generateGuardianTransaction(transaction, signCallback, guardianProvider)
      );
    } catch (error) {
      // The wallet locked (vault === null) somewhere in the guardian flow: DEFER,
      // don't cancel. Re-throw so generateTransactionsLoop's locked-requeue path
      // leaves the tx Queued for retry after unlock instead of marking it Failed
      // and losing the note-claim (issue #313).
      if (isLockedError(error)) {
        throw error;
      }
      // Submit-succeeded-but-local-apply-failed on a structural op (replace-hot-key
      // / switch-guardian) is special: the change IS on chain, but the failure
      // happened before generateGuardianTransaction's completion handler ran, so
      // the vault hot pointer / guardian re-registration are un-reconciled. Cancelling
      // would strand the account (signing with a rotated-out key, or talking to the
      // old guardian). Run the same finalization the happy path would; only cancel if
      // that reconcile itself fails.
      if (
        isApplyAfterSubmitError(error) &&
        (transaction.type === 'replace-hot-key' || transaction.type === 'switch-guardian')
      ) {
        try {
          await reconcileStructuralApplyFailure(transaction, guardianProvider);
          return;
        } catch (reconcileError) {
          console.error('Structural-op apply-failure reconcile failed; cancelling', reconcileError);
        }
      }
      // Value-moving guardian op (consume/send/swap/execute) whose submit landed on
      // chain but whose LOCAL apply failed. The tx IS live — cancelling would leave
      // it terminally Failed while the note is spent on chain (conservation loss),
      // and verifyStuckTransactionsFromNode only scans in-progress rows so it can't
      // recover a Failed one. Mirror generateTransactionsLoop's generic
      // ApplyTransactionAfterSubmitFailed handler: mark Completed so the next sync
      // reconciles the note state via ConsumedExternal. (Structural ops are handled
      // above and never reach here on success.)
      //
      // The result-awaiting exception among value-moving guardian ops
      // (earn-deposit and EPOCH bridged-send): their callers read `resultBytes` /
      // `outputNoteIds` back off the finished row, and a post-submit failure — a
      // local apply throw OR a canonicalization race — leaves no TransactionResult
      // to repopulate them from. Marking the row Completed (as the branches below do
      // for send/consume/swap/execute/agglayer bridged-send) would hang the awaiting
      // Epoch flow forever; see the `isResultAwaitingRow` doc comment for the full
      // mechanism. Fail the row instead so the caller resolves via its error branch.
      // Mirrors generateTransactionsLoop's non-guardian guard; neither row can be
      // blindly re-queued into a duplicate collateral note (both are excluded from
      // `REQUEUEABLE_TYPES` — earn-deposit outright, bridged-send for the Epoch
      // provider, which is the only provider that takes this collateral-note path).
      // (earn-deposit IS a member of REQUEUEABLE_ON_PENDING_CONFLICT, but that set
      // only requeues still-Queued rows on a transient pre-submit 409; a Failed row
      // is terminal.)
      if (
        isResultAwaitingRow(transaction) &&
        (isApplyAfterSubmitError(error) || isGuardianCanonicalizationError(error))
      ) {
        console.warn(
          `[Guardian] ${transaction.type} submitted but post-submit reconcile failed — marking Failed so the awaiting caller stops waiting:`,
          error
        );
        await cancelTransactionAfterPipelineStopped(transaction, error);
        return;
      }
      // `bridged-send` is in this list too, and by the ordering above it can only
      // be an Agglayer (Slow) row here — an Epoch one returned from the
      // result-awaiting branch. Its B2AGG note is on chain, so it must be marked
      // Completed like any other landed value-moving op; leaving it to fall through
      // to `cancelTransaction` would hide the L1 claim UI on funds that already left
      // the account (see the `isResultAwaitingRow` doc comment).
      if (
        isApplyAfterSubmitError(error) &&
        (transaction.type === 'consume' ||
          transaction.type === 'send' ||
          transaction.type === 'swap' ||
          transaction.type === 'execute' ||
          transaction.type === 'bridged-send')
      ) {
        console.warn(
          '[Guardian] submit landed but local apply failed — marking Completed; sync will reconcile:',
          error
        );
        try {
          await updateTransactionStatus(transaction.id, ITransactionStatus.Completed, {
            displayMessage: applyLandedDisplayMessage(transaction.type),
            completedAt: Math.floor(Date.now() / 1000) // seconds
          });
        } catch (markErr) {
          // updateTransactionStatus throws if the tx is already finalized — fine.
          console.warn('[Guardian] could not re-mark Completed (likely already finalized):', markErr);
        }
        return;
      }
      // Guardian canonicalization is eventually-consistent: the SDK can throw
      // "Refusing to overwrite local state: incoming nonce N is not greater
      // than local nonce M" when the guardian's view lags the local client.
      // The on-chain tx is fine — only the local sync refused. Mark Completed
      // so the user sees the success state; the next sync tick will reconcile.
      if (isGuardianCanonicalizationError(error)) {
        console.warn('[Guardian] canonicalization race during tx generation — marking Completed:', error);
        try {
          await updateTransactionStatus(transaction.id, ITransactionStatus.Completed, {
            displayMessage: applyLandedDisplayMessage(transaction.type),
            completedAt: Math.floor(Date.now() / 1000) // seconds
          });
        } catch (markErr) {
          // updateTransactionStatus throws if the tx is already finalized — fine.
          console.warn('[Guardian] could not re-mark Completed (likely already finalized):', markErr);
        }
        return;
      }
      // An offscreen wedge-kill (deadline / `closeDocument`) surfaces as a
      // retryable OperationAbortedError (issue #260). It is NOT special-cased here:
      // it falls through to `cancelTransaction` → Failed, exactly like the proven
      // non-guardian loop (an abort there also falls through to cancel → Failed at
      // `generateTransactionsLoop`) and exactly like the guardian flag-OFF path.
      //
      // We do NOT auto-requeue it. A guardian send/swap/execute has no input-note
      // nullifier: each retry builds a FRESH proposal (new random output-note serial)
      // gated only by the account nonce, so a kill that fired AFTER the offscreen
      // submit landed on chain, then a requeue, would let the retry build and co-sign
      // a SECOND valid send — the recipient receives a second note and the account is
      // debited twice, with no nullifier to reject it (the offscreen path also cannot
      // distinguish a pre-submit from a post-submit abort, so any requeue is
      // unconditional). Only `consume` re-consumes the same note (nullifier collision
      // rejects the retry), but for consistency it too Fails here, matching
      // non-guardian consume. A safe "verify submit landed on chain via node, then
      // requeue only if provably not-landed" recovery is a prerequisite for the
      // flag-flip slice (guardian AND non-guardian alike) — not this PR.
      //
      // Flag-OFF is byte-unchanged: OperationAbortedError only arises from the
      // offscreen dispatch (`dispatchGuardianPipeline`), reached only when
      // `shouldRouteGuardianLeafOffscreen` is true (MIDEN_USE_OFFSCREEN_CLIENT on).
      // The inline flag-OFF leaf (`runGuardianPipeline`) never throws it, so the
      // (former) abort branch was unreachable with the flag off — its removal
      // cannot change flag-OFF behavior.
      //
      // A transient guardian 409 (a prior delta still canonicalizing) that
      // outlasted withGuardianConflictRetry's budget is NOT a terminal failure
      // for a VALUE-MOVING op: the single-delta lock clears on its own, and its
      // proposal creator is side-effect-free/idempotent, so returning the tx to
      // the queue for the next generateTransactionsLoop cycle is safe. We reset
      // the status to Queued AND clear processingStartedAt — a bare return would
      // leave it GeneratingTransaction, which cancelStuckTransactions would then
      // reap as stalled; cancelStaleQueuedTransactions (MAX_QUEUED_AGE) remains
      // the terminal cap. We also stamp `nextEligibleAt` so the loop backs this
      // tx off for a cycle rather than re-picking it as the oldest row every
      // time — otherwise it would starve another account's queued tx.
      //
      // Structural ops are gated OUT (see REQUEUEABLE_ON_PENDING_CONFLICT): a
      // replace-hot-key 409 escapes createReplaceHotKeyProposal AFTER the hardware
      // hot key was minted, so requeueing would re-mint and orphan a key every
      // cycle; switch-guardian / update-procedure-threshold re-runs can register a
      // duplicate delta. They fall through to cancelTransaction — the user retries.
      if (isGuardianPendingConflict(error) && REQUEUEABLE_ON_PENDING_CONFLICT.has(transaction.type)) {
        console.warn('[Guardian] proposal still conflicting after retry budget — requeueing for a later cycle');
        await requeueTransactionForRetry(
          transaction.id,
          transaction.type,
          'creating-proposal',
          PENDING_CONFLICT_REQUEUE_COOLDOWN_SEC
        );
        return;
      }
      // A DELEGATED prove step that failed at the 'proving' stage is a PRE-submit
      // failure (submit is stamped 'submitting' and runs only AFTER prove), so
      // nothing reached the chain — requeue for a later cycle instead of killing
      // the user's transfer on a transient remote-prover outage (#419). It retries
      // (with backoff) and completes once the prover recovers. Re-read the row: the
      // in-memory `transaction` still carries the stage it was picked at, not the
      // 'proving' stage set mid-run. Structural ops are gated out via
      // REQUEUEABLE_ON_PENDING_CONFLICT (a requeue would re-mint a hot key / register
      // a duplicate delta); MAX_QUEUED_AGE remains the terminal cap. The prover
      // connectivity banner explains the wait and auto-clears on the next success.
      //
      // A lock-recovery eviction is excluded (issue #775). The stage gate's
      // safety argument is that 'proving' precedes submit, which holds for an
      // error that STOPPED the pipeline — but an eviction only rejects the
      // caller: the abandoned pipeline runs on, and can still stamp 'submitting'
      // and submit. A delegated prove is deliberately not watchdog-paused, so it
      // sits squarely inside the window an eviction lands in, and requeueing
      // there would broadcast the transfer a second time. Falls through to the
      // funds-safe terminal path instead.
      const currentRow = await Repo.transactions.where({ id: transaction.id }).first();
      if (
        transaction.delegateTransaction === true &&
        currentRow?.stage === 'proving' &&
        !isWasmClientPoisonedError(error) &&
        REQUEUEABLE_ON_PENDING_CONFLICT.has(transaction.type)
      ) {
        console.warn('[Guardian] remote prove failed pre-submit — requeueing for a later cycle', error);
        markConnectivityIssue('prover');
        await requeueTransactionForRetry(
          transaction.id,
          transaction.type,
          'creating-proposal',
          PROVER_OUTAGE_REQUEUE_COOLDOWN_SEC
        );
        return;
      }
      // A guardian 429 is the server explicitly telling us to come back later —
      // it sets `meta.retryable` and usually `retry_after_secs` (#617). Failing a
      // value-moving tx on one loses the user's transfer to a transient limit, so
      // requeue it like the 409 and prover-outage cases above.
      //
      // The STAGE GATE is the safety property, not a nicety: 'creating-proposal'
      // and 'signing-proposal' are both PRE-submit, so nothing reached the chain
      // and a retry cannot double-spend. A 429 at or after 'sending' must NOT
      // requeue. We gate on the RE-READ row because the in-memory `transaction`
      // still carries the stage it was picked at, not the stage the failure
      // actually happened in. Structural ops stay excluded via
      // REQUEUEABLE_ON_PENDING_CONFLICT (a requeue would re-mint a hot key).
      //
      // Candidate cleanup differs per arm, and neither is a guarantee:
      // 'creating-proposal' fails before any candidate exists; 'signing-proposal'
      // fails after the inner catch has ATTEMPTED service.abandonCandidate —
      // best-effort, since that abandon can itself throw (logged, swallowed), and
      // even a successful abandon only records an intent (202) with the account
      // staying locked until the guardian worker confirms. A leftover candidate
      // surfaces as a 409 on the next cycle, which the pending-conflict requeue
      // above already handles.
      if (
        isGuardianRateLimited(error) &&
        REQUEUEABLE_ON_PENDING_CONFLICT.has(transaction.type) &&
        (currentRow?.stage === 'creating-proposal' || currentRow?.stage === 'signing-proposal')
      ) {
        const cooldown = Math.min(
          Math.max(
            guardianRetryAfterSec(error) ?? RATE_LIMIT_REQUEUE_COOLDOWN_SEC,
            MIN_RATE_LIMIT_REQUEUE_COOLDOWN_SEC
          ),
          MAX_RATE_LIMIT_REQUEUE_COOLDOWN_SEC
        );
        console.warn(`[Guardian] rate limited (429) pre-submit — requeueing in ${cooldown}s`, error);
        await requeueTransactionForRetry(transaction.id, transaction.type, 'creating-proposal', cooldown);
        return;
      }
      // #260 follow-up #3a: a deadline-killed CONSUME (OperationAbortedError) may
      // have LANDED on chain before the offscreen realm was torn down. Its noteId
      // is known pre-execute, so verify against the node: only 'landed-local'
      // (provably this client's own consume) → Completed (the note WAS claimed)
      // instead of a misleading Failed; 'processing' (submitted + applied locally,
      // awaiting commit) leaves the row in progress for the stuck reaper;
      // 'landed-external' (not provably mine) / 'invalid' / 'not-landed' /
      // 'unknown' fall through to the funds-safe cancelTransaction below. CONSUME
      // only — send/swap/execute have no post-kill node identity (deferred #3b).
      if (await tryCompleteKilledConsume(transaction, error)) return;
      await cancelTransactionAfterPipelineStopped(transaction, error);
    }
    return;
  }

  // MidenClient handles the full pipeline (execute → prove → submit → apply).
  //
  // EVERY non-guardian value-moving write routes through `midenClientProxy` so it
  // can run WHOLE-OP inside the offscreen realm when MIDEN_USE_OFFSCREEN_CLIENT is on
  // (issue #260) — a wedge anywhere in its execute→prove→submit→apply then becomes
  // killable. `consume` (slice 5a), `send`/`swap`/`execute` (slice 5b), and now
  // `bridged-send`/`earn-deposit` (slice 7b) all share this. Each proxy method's
  // flag-OFF path is BYTE-IDENTICAL to the inline switch it replaced (same
  // `withWasmClientLock`, same `getMidenClient(buildSignCallbackOptions(signCallback))`,
  // same underlying `sendTransaction`/`newTransaction`), so production is unchanged.
  // The proxy owns its own per-flag locking, so these are NOT wrapped in a caller
  // lock here (flag-on must not hold the SW WASM lock across the whole offscreen op —
  // that would stall SW sync and block the reverse-IPC sign handler).
  //
  // `bridged-send`/`earn-deposit` only wrap the SAME leaf writes (send-style for the
  // Epoch bridge + earn collateral, `newTransaction` for a pre-built Agglayer
  // request) with extra pre/post orchestration; the pre-build (guardian
  // requestBytes freeze) and the completion handlers are untouched — only the LEAF
  // write moves offscreen. Funds-safety mirrors the moved send/execute exactly: a
  // wedge-kill → OperationAbortedError → the generateTransactionsLoop catch →
  // cancelTransaction → Failed with NO auto-requeue (earn-deposit is excluded from
  // REQUEUEABLE_TYPES; bridged-send is user-retry-only, like send/execute — never
  // auto-requeued — so a killed-then-retried send-style write can't silently
  // double-spend), and a round-tripped `ApplyTransactionAfterSubmitFailed` reaches
  // that same classifier (→ earn-deposit Failed so its awaiting caller stops;
  // bridged-send Completed, sync reconciles).
  let result: TransactionResult;
  switch (transaction.type) {
    case 'consume':
      result = await midenClientProxy.consumeNoteId(transaction as ConsumeTransaction, signCallback);
      break;
    case 'send':
      // The staged send stamps `executing`/`proving`/`submitting` as it runs so the
      // generating-transaction screen can time the proof + submit steps (#524).
      // Those stamps are keyed by the ROW id, which the offscreen write DTO
      // deliberately doesn't carry — so the proxy carries them on the OP id instead:
      // flag-OFF it hands this callback straight to the inline `sendTransaction`,
      // flag-ON it registers it op-scoped and replays the offscreen realm's
      // `OFFSCREEN_STAGE_EVENT`s through it. Both states therefore stamp, which
      // matters because the SW build (`vite.background.config.ts`) is the ONE build
      // that defaults the flag ON — a stage callback that rode the inline leaf only
      // would silently lose the timings on Chrome, the primary platform.
      result = await midenClientProxy.sendTransaction(
        transaction as SendTransaction,
        signCallback,
        stageStampFor(transaction.id)
      );
      break;
    case 'swap':
      result = await midenClientProxy.swapTransaction(transaction as SwapTransaction, signCallback);
      break;
    case 'bridged-send':
    case 'earn-deposit':
      // Agglayer bridged-send carries a pre-built B2AGG request; Epoch bridged-send
      // + earn-deposit now ALSO carry pre-built request bytes — the P2IDE collateral
      // note with the mandate-binding attachment (smallocator PR #38), built at
      // initiate time by `buildEpochCollateralRequestBytes`. Route the leaf through
      // the proxy so it runs offscreen flag-on, inline flag-off. The bare
      // `sendTransaction` fallback only remains for legacy rows queued before the
      // binding migration.
      //
      // The abandoned-intent guard the Guardian leaf has must apply here too: this
      // shared block had none, so a non-Guardian account still minted the orphan
      // collateral note. `bridged-send` needs no equivalent — its abandonment path
      // writes `status = Failed`, which takes the row out of the Queued scan.
      if (transaction.type === 'earn-deposit') {
        await assertEarnDepositIntentLive(transaction);
      }
      if (transaction.requestBytes) {
        result = await midenClientProxy.newTransaction(
          transaction.accountId,
          transaction.requestBytes,
          transaction.delegateTransaction,
          signCallback
        );
      } else {
        result = await midenClientProxy.sendTransaction(transaction as SendTransaction, signCallback);
      }
      break;
    case 'execute':
    default:
      result = await midenClientProxy.newTransaction(
        transaction.accountId,
        transaction.requestBytes!,
        transaction.delegateTransaction,
        signCallback
      );
      break;
  }

  switch (transaction.type) {
    case 'send':
      await completeSendTransaction(transaction as SendTransaction, result);
      break;
    case 'consume':
      await completeConsumeTransaction(transaction.id, result);
      break;
    case 'swap':
      await completeSwapTransaction(transaction as SwapTransaction, result);
      break;
    case 'bridged-send':
      await completeBridgedSendTransaction(transaction as BridgedSendTransaction, result);
      break;
    case 'earn-deposit':
      await completeEarnDepositTransaction(transaction as EarnDepositTransaction, result);
      break;
    case 'execute':
    default:
      await completeCustomTransaction(transaction, result);
      break;
  }
};

/**
 * Build a transient cold-bound MultisigService for `accountId`. Cold signing
 * goes through the SDK keystore (not the SE/StrongBox-wrapped hot key) — used
 * for structural ops that must be cold-signed.
 */
const buildColdServiceForAccount = async (
  accountId: string,
  guardianProvider: GuardianAccountProvider
): Promise<MultisigService> => {
  const walletAccount = (await guardianProvider.getAccounts()).find(a => a.publicKey === accountId);
  if (!walletAccount) {
    throw new Error(`Guardian account ${accountId} not found in provider`);
  }
  const sdkAccount = await withWasmClientLock(async () => midenClientProxy.getAccount(accountId));
  if (!sdkAccount) {
    throw new Error(`Guardian account ${accountId} not found in local client`);
  }
  return MultisigService.buildColdMultisigService(sdkAccount, walletAccount, guardianProvider.signWord);
};

/**
 * Build (and persist for retry) the serialized P2IDE send-request bytes for a
 * Guardian recallable send. `createP2idProposal` can only mint a plain P2ID, so
 * any note that needs a reclaim height — a user "recall by" send, or an Epoch
 * bridge/allocator collateral note the solver validates on-chain — is built here
 * as a P2IDE send request and driven through `createCustomProposal` instead.
 *
 * The P2IDE note's serial number is random, so the request must be built ONCE and
 * the SAME bytes reused for both `createCustomProposal` and
 * `signAndCreateTransactionRequest` — persisted on the row so a retry after a
 * restart reuses them, which is also what makes a duplicate submit rejectable
 * (the reused serial pins the note id). A retry only rebuilds them when the row
 * proves nothing was broadcast; see `PRE_SUBMIT_STAGES`. `recallBlocks` is a RELATIVE
 * blocks-until-recall offset, converted to an absolute reclaim height here
 * (`syncHeight + recallBlocks`) — the guardian-path counterpart of the
 * relative→absolute conversion in `MidenClientInterface.sendTransaction`.
 */
const ensureGuardianRecallableSendRequestBytes = async (
  transaction: ITransaction,
  recipientId: string,
  faucetId: string,
  amount: bigint,
  noteType: NoteType,
  recallBlocks: number,
  opts: { freshSync?: boolean } = {}
): Promise<Uint8Array> => {
  if (transaction.requestBytes) return transaction.requestBytes;
  const requestBytes = await withWasmClientLock(async () => {
    // `freshSync` (Epoch bridge + earn collateral): the solver's allocator
    // validates the note's REMAINING reclaim window against its own (later) chain
    // head, so the absolute reclaim height must be measured against a CURRENT head
    // — a stale cached height on a cold-started wallet could understate it below the
    // allocator's minimum and get the note rejected. A network sync can fail, and
    // that must NOT fail an otherwise-submittable request, so fall back to the
    // last-synced height (the recall buffer absorbs mild lag). A plain recallable
    // user send has no such validator, so it reads the cached height directly.
    //
    // Routed through `midenClientProxy` (issue #260, slice 7a) so flag-ON the height
    // is read from the OFFSCREEN client that owns the canonical sync state; flag-OFF
    // is byte-identical to the inline `getMidenClient().client.sync().blockNum()` /
    // `.getSyncHeight()` this used to run (the proxy reads run under this caller lock).
    let syncHeight: number;
    if (opts.freshSync) {
      try {
        syncHeight = await midenClientProxy.getSyncHeight({ fresh: true });
      } catch (syncError) {
        console.warn('[Guardian] fresh sync before P2IDE note build failed; using last-synced height', syncError);
        syncHeight = await midenClientProxy.getSyncHeight();
      }
    } else {
      syncHeight = await midenClientProxy.getSyncHeight();
    }
    // The sender's local account supplies the outgoing asset's vault key
    // (callback flag included) — see `buildSendTransactionRequest`.
    //
    // Read through `midenClientProxy`, like the sync height above, rather than a
    // transient `WasmWebClient.createClient(...)`. That transient client existed
    // to reach `newSendTransactionRequest`, a raw-client method; now that the
    // request is built from statically-imported SDK types the only thing left
    // needing a client is this account read, and the proxy does it better on both
    // counts. Correctness: flag-ON it reads from the OFFSCREEN client that owns
    // the canonical sync state and that will EXECUTE this request, so the vault
    // key is derived from the same account snapshot the kernel will check it
    // against — a separate client could disagree. Cost: no worker spawn and no
    // second multi-MB wasm instance inside the app-wide lock, which now matters
    // per requeue cycle rather than once, since a requeued `send` drops its
    // cached bytes and rebuilds. The proxy read is unlocked by design and this
    // caller already holds `withWasmClientLock`, as its W2 contract requires.
    //
    // Passed as canonical hex: `walletAccountIdToSdk` strips the composite
    // `<address>_<suffix>` form, and the SDK's `resolveAccountRef` takes `0x…`
    // directly, so neither id shape can be rejected here.
    const account = await midenClientProxy.getAccount(walletAccountIdToSdk(transaction.accountId).toString());
    return buildSendTransactionRequest(
      account ?? undefined,
      walletAccountIdToSdk(transaction.accountId),
      // The recipient is parsed as permissively as the non-guardian path rather
      // than bech32-only: an id the SDK's own `resolveAccountRef` accepts must
      // not be rejected just because the account holds a guardian.
      accountRefToSdk(recipientId),
      faucetId,
      amount,
      noteType,
      syncHeight + recallBlocks
    ).serialize();
  });
  transaction.requestBytes = requestBytes;
  await Repo.transactions.where({ id: transaction.id }).modify(t => {
    t.requestBytes = requestBytes;
  });
  return requestBytes;
};

/**
 * The guardian write LEAF PIPELINE — `executeRequest → prove → submit → apply`
 * for an already-signed, guardian-co-signed `TransactionRequest` (issue #260,
 * slice 6a).
 *
 * This is the VERBATIM extraction of the former inline block (the
 * `withWasmClientLock(...)` at the guardian submit site): same wrapped keystore
 * options, same prover selection (non-delegated `newLocalProver` / mobile
 * `newCallbackProver`; delegated remote `prove({})` with local fallback), same
 * `executing`/`proving`/`submitting` stage progression. It runs entirely SW-side
 * and is byte-identical to the old inline path — the flag-OFF branch of the
 * per-type route calls exactly this.
 *
 * When the offscreen client is enabled, the routable guardian types (value-moving
 * in slice 6a; structural — switch-guardian / replace-hot-key /
 * update-procedure-threshold — in slice 6b; bridged-send / earn-deposit in slice 7c)
 * run the SAME leaf offscreen via
 * `dispatchGuardianPipeline` instead; everything BEFORE this (proposal creation,
 * guardian HTTP co-sign, cold co-sign, mid-flight `persistNewHotKey`,
 * `signAndCreateTransactionRequest`) and AFTER it (abandonCandidate on failure,
 * waitForTransactionCommit, completion handlers) stays SW-side, unchanged.
 *
 * Returns the pipeline's `TransactionResult` (was: the executed-transaction
 * handle; the caller now re-derives the tx id from
 * `result.executedTransaction().id()`), so its shape matches what
 * `dispatchGuardianPipeline` re-hydrates from the offscreen round-trip.
 */
const runGuardianPipeline = async (
  accountId: string,
  tr: TransactionRequest,
  delegateTransaction: boolean | undefined,
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  setStage: (stage: ITransactionStage) => Promise<void>
): Promise<TransactionResult> => {
  const options: MidenClientCreateOptions = {
    signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
      const keyString = Buffer.from(publicKey).toString('hex');
      const signingInputsString = Buffer.from(signingInputs).toString('hex');
      return await signCallback(keyString, signingInputsString);
    }
  };

  // MidenClient handles the full pipeline (execute → prove → submit → apply).
  return withWasmClientLock(async hold => {
    const midenClient = await getMidenClient(options);
    await setStage('executing');
    const executedTx = await midenClient.client.transactions.executeRequest(accountId, tr);
    await setStage('proving');
    let provenTx;
    if (!delegateTransaction) {
      // Local (non-delegated) proving. The guardian pipeline drives the raw
      // client directly, whose default local prover is the single-threaded
      // WASM one — which on iOS WKWebView runs on the main thread and freezes
      // the UI for the whole multi-second prove. Route to the native Rust
      // prover on mobile (off the main thread via @miden/native-prover),
      // exactly like `proveWithFallback`'s localProverFactory and the
      // delegated fallback below; WASM local prover elsewhere.
      const localProver = isMobile()
        ? TransactionProver.newCallbackProver(buildNativeProverCallback())
        : TransactionProver.newLocalProver();
      // Local proving is deliberately unbounded — pause the lock watchdog for
      // its duration, exactly like proveWithFallback's local attempts (#775).
      provenTx = await withWasmLockWatchdogPaused(() => executedTx.prove({ prover: localProver }), hold);
    } else {
      // Delegated (remote) proving. The client's default prover is the remote
      // gRPC prover on every platform, and its ~10s deadline is too tight for a
      // heavyweight guardian multisig proof when the machine is under load — a
      // single "Deadline expired" used to kill the whole co-signed transaction
      // (surfacing as the guardian 409 canonicalize-conflict retry loop and a
      // claim timeout), because the guardian pipeline drives the raw client
      // directly and had none of the local fallback the non-guardian path gets
      // for free from `proveWithFallback`. Give it that resilience: on remote
      // failure, re-prove the SAME executed tx locally. Re-proving is safe
      // because `proveTransaction` borrows the executed result (only the prover
      // is consumed, and each attempt passes a fresh one). The local prover
      // mirrors `proveWithFallback`: the native Rust prover on mobile (WASM
      // proving isn't viable in iOS WKWebView), the WASM local prover elsewhere.
      try {
        provenTx = await executedTx.prove({});
      } catch (proveError) {
        console.warn('Delegated guardian prove failed; retrying with local prover', proveError);
        const fallbackProver = isMobile()
          ? TransactionProver.newCallbackProver(buildNativeProverCallback())
          : TransactionProver.newLocalProver();
        provenTx = await withWasmLockWatchdogPaused(() => executedTx.prove({ prover: fallbackProver }), hold);
      }
    }
    await setStage('submitting');
    const submittedTx = await provenTx.submit();
    await submittedTx.apply();
    return executedTx.result;
  });
};

// Route a value-moving guardian leaf offscreen only when the offscreen client is
// enabled AND the offscreen document API is present (mobile hardcodes the flag
// off — no chrome.offscreen). Read per-call (not a module const) so the route is
// deterministically togglable in tests; the heavy offscreen machinery it reaches
// lives in miden-client-proxy — already imported for syncState/getAccount — so
// there is no dead-code-elimination benefit to a module const here.
const shouldRouteGuardianLeafOffscreen = (type: ITransactionType): boolean =>
  process.env.MIDEN_USE_OFFSCREEN_CLIENT === 'true' &&
  isOffscreenAvailable() &&
  OFFSCREEN_ROUTABLE_GUARDIAN_TYPES.has(type);

/**
 * Generate a transaction for a Guardian account using the MultisigService.
 * Routes the transaction through MultisigService proposal methods.
 */
const generateGuardianTransaction = async (
  transaction: ITransaction,
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  guardianProvider: GuardianAccountProvider
): Promise<void> => {
  // Gate ordinary guardian-signed ops while the stored endpoint is untrustworthy.
  // 'switch-guardian' is exempt: it's the deliberate, user-initiated provider
  // change (GuardianSettings) and must stay available as a manual recovery path.
  // The primary recovery mechanisms — resolveGuardianDrift's auto-resolution and
  // applyUserGuardianEndpoint's verified-URL apply — reconcile the vault directly
  // and never route through this function, so exempting switch-guardian here only
  // affects the deliberate Settings-driven switch flow, not account recovery.
  if (transaction.type !== 'switch-guardian') {
    const walletAccount = (await guardianProvider.getAccounts()).find(a =>
      sameWalletAccountId(a.publicKey, transaction.accountId)
    );
    if (walletAccount) {
      assertGuardianInSync(walletAccount);
    }
  }

  // Set the stage eagerly — `getOrCreateMultisigService` and the subsequent
  // `createXxxProposal` call can both hit the guardian over the network,
  // so surfacing "Creating proposal" immediately is more honest than
  // leaving the label stuck on "Sending transaction".
  await setTransactionStage(transaction.id, 'creating-proposal');
  let proposalResult: Proposal;
  // The service that creates the proposal AND issues the final
  // signAndCreateTransactionRequest. Hot-bound for routine ops; cold-bound for
  // structural ops (replace-hot-key / update-procedure-threshold). The
  // hot-bound path is the only one cached by guardian-manager; cold services
  // here are transient.
  //
  // `withGuardianConflictRetry` waits out a transient 409 ConflictPendingDelta
  // (a prior delta still canonicalizing) instead of failing the tx. It wraps
  // only side-effect-free proposal creation — NOT replace-hot-key, whose
  // createReplaceHotKeyProposal mints a fresh hardware hot key, so retrying it
  // would orphan SE/StrongBox keys.
  let service: MultisigService;

  switch (transaction.type) {
    case 'send': {
      const sendTx = transaction as SendTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      const recallBlocks = sendTx.extraInputs?.recallBlocks;
      if (recallBlocks) {
        // TEMP WORKAROUND (OpenZeppelin/guardian#366): the multisig client's
        // P2ID send proposal has no reclaim support, so the expiration the
        // user picked used to be silently dropped on Guardian accounts —
        // every guardian send went out as a plain P2ID, never recallable.
        // Route recallable sends through a custom proposal built from a P2IDE
        // send request instead; once createP2idProposal grows
        // reclaimHeight/timelockHeight options, replace this branch with the
        // typed API. `recallBlocks` is a
        // RELATIVE blocks-until-recall offset; this is the guardian-path
        // counterpart of the relative→absolute conversion in
        // `MidenClientInterface.sendTransaction`.
        //
        const requestBytes = await ensureGuardianRecallableSendRequestBytes(
          transaction,
          sendTx.secondaryAccountId,
          sendTx.faucetId,
          BigInt(sendTx.amount),
          // Via `isPrivateNoteType` like every other send-path coercion, so
          // this path and the non-guardian one can't disagree about the same
          // row. Note the direction change: the former `=== Public ? Public :
          // Private` mapped an unrecognized value to Private (safe but silent)
          // and a MISSING one to Private too, where this resolves missing to
          // Public like the SDK. That is only sound because a missing noteType
          // can no longer reach here — the dApp send boundary rejects it with
          // InvalidParams before the user is prompted, and the wallet's own
          // send screens always set it.
          isPrivateNoteType(sendTx.noteType) ? NoteType.Private : NoteType.Public,
          recallBlocks
        );
        proposalResult = await withGuardianConflictRetry(() =>
          service.createCustomProposal(requestBytes, 'recallable_send')
        );
      } else {
        // Same coercion as the recallable branch above. This used to be
        // hardcoded Private, which broke a Public guardian send two ways at
        // once: the note went out private although the review screen (and a
        // dApp's preview) said Public, and because the ROW still said 'public',
        // `completeSendTransaction` skipped the private-note relay — so the
        // recipient was never handed the note file and could not see or consume
        // it, on a plain P2ID with no reclaim window for the sender either.
        proposalResult = await withGuardianConflictRetry(() =>
          service.createSendProposal(
            sendTx.secondaryAccountId,
            sendTx.faucetId,
            BigInt(sendTx.amount),
            isPrivateNoteType(sendTx.noteType) ? NoteType.Private : NoteType.Public
          )
        );
      }
      break;
    }
    case 'consume': {
      const consumeTx = transaction as ConsumeTransaction;
      // Always hot-bound, including background/auto-consume. Auto-consume used
      // to be routed through the COLD key because the iOS SE hot key carried
      // `.userPresence` — hot-signing a silent background claim would have
      // popped Face ID on every attempt. That flag is gone (hot signing is
      // silent everywhere now), so the cold detour buys nothing and the cached
      // hot service is strictly cheaper than building a transient cold one.
      const consumeNoteIds = consumeTx.noteIds?.length > 0 ? consumeTx.noteIds : [consumeTx.noteId];
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() => service.createConsumeNotesProposal(consumeNoteIds));
      break;
    }
    case 'switch-guardian': {
      const sgTx = transaction as SwitchGuardianTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      const { proposal } = await withGuardianConflictRetry(() =>
        service.createSwitchGuardianProposal(sgTx.extraInputs.newGuardianEndpoint)
      );
      proposalResult = proposal;
      break;
    }
    case 'replace-hot-key': {
      const walletAccount = (await guardianProvider.getAccounts()).find(a => a.publicKey === transaction.accountId);
      if (!walletAccount) {
        throw new Error(`Guardian account ${transaction.accountId} not found in provider`);
      }
      const sdkAccount = await withWasmClientLock(async () => midenClientProxy.getAccount(transaction.accountId));
      if (!sdkAccount) {
        throw new Error(`Guardian account ${transaction.accountId} not found in local client`);
      }
      service = await MultisigService.buildColdMultisigService(sdkAccount, walletAccount, guardianProvider.signWord);
      // NOT retry-wrapped — createReplaceHotKeyProposal mints a hot key.
      const { proposal, newHot } = await service.createReplaceHotKeyProposal(sdkAccount);
      if (!guardianProvider.persistNewHotKey) {
        throw new Error('persistNewHotKey not implemented in this provider');
      }
      // Persist the new hot ciphertext BEFORE submitting. Old hot stays valid
      // until the on-chain rotation lands so this is idempotent. If the app
      // dies between submit and complete, the new ciphertext is on disk and
      // complete reconciles against the on-chain state.
      // KNOWN LEAK: if this rotation terminally fails (submit error → tx
      // cancelled, never reconciled) and the user re-initiates, a fresh hardware
      // key is minted while this one's SE/Keystore entry + ciphertext blob are
      // left orphaned (inert). A blind delete-on-failure here is unsafe — the
      // persist-before-submit design relies on this blob surviving for the
      // reconcile path — so reaping orphaned pending keys belongs in a dedicated
      // cleanup, not this hot path.
      await guardianProvider.persistNewHotKey(newHot.publicKeyHex, newHot.ciphertext);
      // Stash the new pubkey on the in-memory transaction AND in dexie so
      // complete (which may run after a process restart) can find it.
      const rTx = transaction as ReplaceHotKeyTransaction;
      rTx.extraInputs = { ...(rTx.extraInputs ?? {}), newHotPublicKey: newHot.publicKeyHex };
      await Repo.transactions.where({ id: transaction.id }).modify(t => {
        t.extraInputs = rTx.extraInputs;
      });
      proposalResult = proposal;
      break;
    }
    case 'bridged-send': {
      const bridgeTx = transaction as BridgedSendTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      // Discriminate on the provider, NOT on `requestBytes` presence: the Epoch
      // branch persists the P2IDE bytes it builds, so a retry would otherwise be
      // mistaken for the Agglayer (pre-built request) path.
      if (bridgeTx.extraInputs?.provider === 'epoch') {
        // The solver's allocator requires a recallable, PUBLIC P2IDE collateral
        // note — it reads the note on-chain (a private note is "not found on-chain"),
        // validates its recall window (a plain P2ID has none and is rejected,
        // "P2IDE reclaim window too small"), AND requires the mandate-binding
        // attachment (smallocator PR #38 — "Miden note is not bound to the intent
        // mandate"). Rows queued by `createBridgeP2IDENote` carry the pre-built
        // request (own output note with the attachment) in `requestBytes`, which
        // `ensureGuardianRecallableSendRequestBytes` returns verbatim; its build
        // path below is only a fallback for legacy attachment-less rows.
        const recallBlocks = bridgeTx.extraInputs?.recallBlocks;
        if (!recallBlocks) {
          throw new Error(
            'Epoch bridged-send is missing recallBlocks; cannot build the recallable P2IDE collateral note the allocator requires.'
          );
        }
        const requestBytes = await ensureGuardianRecallableSendRequestBytes(
          transaction,
          bridgeTx.secondaryAccountId!,
          bridgeTx.faucetId,
          BigInt(bridgeTx.amount),
          NoteType.Public,
          recallBlocks,
          // Allocator-validated collateral: measure the reclaim height against a
          // fresh chain head (same rule as earn-deposit below).
          { freshSync: true }
        );
        proposalResult = await withGuardianConflictRetry(() =>
          service.createCustomProposal(requestBytes, 'bridged_send')
        );
      } else {
        // Agglayer: preview the pre-built request into a custom multisig proposal.
        proposalResult = await service.createCustomProposal(bridgeTx.requestBytes!);
      }
      break;
    }
    case 'earn-deposit': {
      // Guardian earn deposit: the Epoch mandate requires a P2IDE collateral note
      // with a reclaim height, which the multisig client's P2ID proposal cannot
      // express — so route it through a custom proposal built from a P2IDE send
      // request, exactly like the recallable `send` case (see OpenZeppelin/
      // guardian#366). `recallBlocks` (set on the row from the Epoch SDK's mint
      // callback — allocator minimum + SDK drift buffer) is a RELATIVE
      // blocks-until-reclaim offset; the note's absolute reclaim height is
      // `head + recallBlocks` at build time. The Epoch allocator validates the
      // REMAINING reclaim window against its own (later) chain head — not an exact
      // height — so the extra guardian propose/sign/submit delay is absorbed by
      // the ~1000-block buffer the SDK bakes into `recallBlocks`.
      const earnTx = transaction as EarnDepositTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      const recallBlocks = earnTx.extraInputs?.recallBlocks;
      if (!recallBlocks || !earnTx.secondaryAccountId) {
        throw new Error(
          'Earn deposit is missing recallBlocks/allocator — the collateral must be a recallable P2IDE note.'
        );
      }
      // If openEarnPosition already abandoned this deposit, bail out rather than
      // submit a collateral note the allocator has no live intent for. A guardian
      // requeue can keep this row live long past the caller's wait (up to
      // MAX_QUEUED_AGE). See assertEarnDepositIntentLive; the throw is terminal
      // (→ cancelTransaction below) and a Failed row is never re-picked.
      await assertEarnDepositIntentLive(earnTx);
      // Rows queued by `createEarnP2IDENote` carry the pre-built P2IDE collateral
      // request (own output note with the mandate-binding attachment, smallocator
      // PR #38) in `requestBytes`, which the shared guardian helper returns
      // verbatim; its build path is only a fallback for legacy attachment-less
      // rows (`freshSync`: measure the reclaim height against a current head).
      // Earn collateral is always PUBLIC — the allocator discovers + consumes it
      // on-chain (createEarnP2IDENote hardcodes it), regardless of the row's noteType.
      const requestBytes = await ensureGuardianRecallableSendRequestBytes(
        transaction,
        earnTx.secondaryAccountId!,
        earnTx.faucetId,
        BigInt(earnTx.amount),
        NoteType.Public,
        recallBlocks,
        { freshSync: true }
      );
      proposalResult = await withGuardianConflictRetry(() =>
        service.createCustomProposal(requestBytes, 'earn_deposit')
      );
      break;
    }
    case 'swap': {
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      const swapTx = transaction as SwapTransaction;
      // PSWAP notes carry a randomly-generated serial number, so the request
      // must be built ONCE and the exact same bytes reused for BOTH
      // `createCustomProposal` and `signAndCreateTransactionRequest` below (the
      // latter rebuilds the final tx from these bytes + the proposal's advice
      // map, and throws if they're missing). Persist them so a retry after a
      // process restart reuses the same request instead of registering a
      // second, divergent proposal.
      if (!transaction.requestBytes) {
        const requestBytes = await withWasmClientLock(async () => {
          // The offered asset has to carry the vault key of the slot it is
          // actually held in — the callback flag is part of that key, and the
          // PSWAP builder always produces the Disabled variant. Read the vault
          // through the proxy, like every other path that does this, so under the
          // offscreen client the key comes from the realm that will EXECUTE the
          // request. The proxy read is unlocked by design and this scope already
          // holds the client lock, which is what that contract requires.
          const creatorAccount = await midenClientProxy.getAccount(accountIdStringToSdk(swapTx.accountId).toString());
          const client = await WasmWebClient.createClient(getEffectiveRpcUrl());
          try {
            const tr = await client.newPswapCreateTransactionRequest(
              accountIdStringToSdk(swapTx.accountId),
              accountIdStringToSdk(swapTx.faucetId),
              swapTx.amount,
              accountIdStringToSdk(swapTx.extraInputs.requestedFaucetId),
              swapTx.extraInputs.requestedAmount,
              NoteType.Public,
              NoteType.Public
            );
            // Built once and rewritten once, in the same scope: each builder call
            // draws a fresh serial number, which IS the order id. See
            // `buildPswapCreateRequest`.
            return buildPswapCreateRequest(
              creatorAccount ?? undefined,
              tr,
              swapTx.faucetId,
              BigInt(swapTx.amount)
            ).serialize();
          } finally {
            client.terminate();
          }
        });
        transaction.requestBytes = requestBytes;
        await Repo.transactions.where({ id: transaction.id }).modify(t => {
          t.requestBytes = requestBytes;
        });
      }
      proposalResult = await withGuardianConflictRetry(() =>
        service.createCustomProposal(transaction.requestBytes!, 'swap')
      );
      break;
    }
    case 'update-procedure-threshold': {
      // Cold-routed structural change (same class as switch-guardian /
      // replace-hot-key): cold + guardian satisfies it on-chain.
      const uptTx = transaction as UpdateProcedureThresholdTransaction;
      service = await buildColdServiceForAccount(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() =>
        service.createUpdateProcedureThresholdProposal(uptTx.extraInputs.procedure, uptTx.extraInputs.threshold)
      );
      break;
    }
    case 'execute':
    default: {
      // For custom transactions, build a custom proposal from the serialized
      // request bytes. Hot-routed (threshold-1). A custom proposal that embeds a
      // structural op (e.g. update_guardian / add_signer) cannot bypass the
      // hardening: the on-chain `procedureThresholds` map enforces per-procedure
      // thresholds (update_guardian = 2 → needs cold + guardian) during proof
      // verification regardless of which key signed the proposal here.
      const requestBytes = transaction.requestBytes;
      if (!requestBytes) {
        throw new Error('Request Bytes not available for custom transaction');
      }
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() => service.createCustomProposal(requestBytes));
      break;
    }
  }

  // Sign and execute the proposal
  await setTransactionStage(transaction.id, 'signing-proposal');

  // switch_guardian is on-chain threshold-2 (set at create time via
  // procedureThresholds). Hot's signAndCreateTransactionRequest below
  // contributes one sig; we add the cold sig here. Sigs accumulate on the
  // Guardian server keyed by proposal id so order doesn't matter, and the
  // transient cold service is dropped at scope exit.
  if (transaction.type === 'switch-guardian') {
    const walletAccount = (await guardianProvider.getAccounts()).find(a => a.publicKey === transaction.accountId);
    if (!walletAccount) {
      throw new Error(`Guardian account ${transaction.accountId} not found in provider`);
    }
    const sdkAccount = await withWasmClientLock(async () => midenClientProxy.getAccount(transaction.accountId));
    if (!sdkAccount) {
      throw new Error(`Guardian account ${transaction.accountId} not found in local client`);
    }
    const coldService = await MultisigService.buildColdMultisigService(
      sdkAccount,
      walletAccount,
      guardianProvider.signWord
    );
    // Wait out a transient 409 ConflictPendingDelta on the cold co-sign too —
    // otherwise a prior delta mid-canonicalization fails the whole switch even
    // though the hot proposal already landed.
    await withGuardianConflictRetry(() => coldService.signProposal(proposalResult.id));
  }

  let result: TransactionResult;
  try {
    const tr = await service.signAndCreateTransactionRequest(proposalResult.id, transaction.requestBytes);

    await setTransactionStage(transaction.id, 'sending');
    if (shouldRouteGuardianLeafOffscreen(transaction.type)) {
      // Offscreen leaf (issue #260, slice 6a). The fully-signed, guardian-co-
      // signed request crosses as bytes: its extended advice map — where the hot
      // / cold / guardian co-signatures live — is preserved by
      // `TransactionRequest.serialize()` (Rust `Serializable for TransactionRequest`
      // writes `advice_map.write_into(target)`; §4.0), so the offscreen realm
      // executes the identical request. execute→prove→submit→apply runs whole-op
      // in the offscreen doc as ONE killable op; the executeRequest keystore sign
      // reaches the SW-resident vault via the EXISTING OFFSCREEN_SIGN_REQUEST
      // reverse channel (no new IPC). On a deadline/close kill the offscreen op
      // rejects with a retryable OperationAbortedError and the SW catch below
      // still runs `abandonCandidate`, byte-identical to the inline path.
      //
      // The per-step stage stamps (PR #524) cross too: the offscreen leaf stamps the
      // SAME three boundaries `runGuardianPipeline` does (executing / proving /
      // submitting) and posts each as an OFFSCREEN_STAGE_EVENT, which the proxy
      // replays through this callback. Guardian is the wallet's DEFAULT account type
      // and the SW build defaults the flag ON, so a flag-ON-only gap here would blank
      // the step durations on the primary send flow of the primary platform.
      //
      // The submit crossing rides that same channel — 'submitting' arrives like
      // any other stage and `stageStampFor` records it — but a replayed stamp is
      // not a substitute for pinning the guard here, because the failure this
      // guards against is precisely the one that eats the replay: a realm killed
      // between `submit()` and the event reaching the SW leaves the row looking
      // never-broadcast. So pin it before dispatch and accept the
      // over-approximation, which errs the safe way (a needless rebuild rather
      // than a second payment).
      //
      // Only where there ARE bytes to pin, which is what makes the
      // over-approximation affordable. The flag is sticky and vetoes the cached-
      // request clear in `requeueTransactionForRetry`, so stamping a row that
      // caches nothing would assert a crossing on a row with neither bytes nor a
      // captured id — the exact shape `requeueFailedTransaction` refuses — and
      // brick every non-recallable guardian send on its FIRST failure, the
      // vault-slot rejection included. A guardian send with no recall window
      // takes `createSendProposal` and caches nothing, so it is left alone.
      if (transaction.requestBytes !== undefined) {
        await markMayHaveSubmitted(transaction.id);
      }
      result = await dispatchGuardianPipeline(
        transaction.accountId,
        tr.serialize(),
        transaction.delegateTransaction,
        signCallback,
        stageStampFor(transaction.id)
      );
    } else {
      result = await runGuardianPipeline(
        transaction.accountId,
        tr,
        transaction.delegateTransaction,
        signCallback,
        stageStampFor(transaction.id)
      );
    }
  } catch (error) {
    console.error('Error during Guardian transaction submission or execution', { error });
    try {
      await service.abandonCandidate(proposalResult.nonce);
    } catch (abandonError) {
      // Cleanup must never mask the transaction failure. The abandonment call
      // is idempotent, so a later recovery path can safely retry it.
      console.error('Failed to request Guardian candidate abandonment', {
        nonce: proposalResult.nonce,
        error: abandonError
      });
    }
    throw error;
  }

  // The tx id, re-derived from the (possibly offscreen-round-tripped) result
  // rather than a separate handle: the offscreen pipeline returns only the
  // serialized TransactionResult, and `executedTransaction()` survives that
  // round-trip (slice 5b). Byte-identical to the former
  // `submittedTransaction.id.toHex()`.
  const id = result.executedTransaction().id().toHex();

  // For switch-guardian, the new guardian must be seeded with the POST-switch
  // account state. submit() returns after submission, not after inclusion, so
  // without this wait finalizeGuardianSwitch would serialize the pre-switch
  // account and register that stale state with the new guardian.
  // For replace-hot-key, we wait so the WalletAccount.hotPublicKey swap in
  // complete only happens once the on-chain rotation is final — otherwise a
  // resync could race with stale on-chain state and pick the wrong canonical
  // hot pubkey.
  // For update-procedure-threshold, we wait so the post-completion guardian
  // re-registration serializes the COMMITTED post-threshold state — otherwise it
  // could push a pre-threshold blob and leave the guardian diverged again.
  if (
    transaction.type === 'switch-guardian' ||
    transaction.type === 'replace-hot-key' ||
    transaction.type === 'update-procedure-threshold'
  ) {
    await setTransactionStage(transaction.id, 'confirming');
    // Route the commit-wait through the proxy so it polls the SAME client that
    // applied the tx: the offscreen realm flag-on (which ran the whole leaf), the
    // SW client flag-off. A raw `getMidenClient().waitForTransactionCommit(id)` here
    // would, flag-on, poll the dormant/unsynced SW client, time out at ~60s, fall
    // through the guardian catch to cancelTransaction → Failed, and SKIP the
    // structural completion below (e.g. leaving replace-hot-key's chain rotation done
    // but the local hot-key pointer stale). Flag-off, the proxy runs the exact same
    // `withWasmClientLock(getMidenClient().waitForTransactionCommit)` block as before.
    await midenClientProxy.waitForTransactionCommit(id);
  }

  // Sync the cached hot service so the next consumer sees post-tx state.
  //
  // Skipped for the structural ops (replace-hot-key / update-procedure-threshold
  // / switch-guardian): each runs on a transient/cold service and invalidates
  // the cached hot service in its completion handler (clearGuardianServiceFor),
  // so there's nothing useful to sync here. For switch-guardian specifically a
  // sync here would also be MIS-ORDERED: completeSwitchGuardianTransaction must
  // run finalizeGuardianSwitch (register on the new guardian) "before anything
  // else touches the local cache or storage", and this runs before the
  // completion switch below.
  //
  // Post-completion bookkeeping only: the transaction is already marked Completed
  // and the on-chain submit succeeded, so a sync failure here must NOT propagate
  // (it would flip a genuinely-successful transaction to Failed). The next sync
  // tick reconciles.
  if (
    transaction.type !== 'replace-hot-key' &&
    transaction.type !== 'update-procedure-threshold' &&
    transaction.type !== 'switch-guardian'
  ) {
    try {
      await setTransactionStage(transaction.id, 'guardian-syncing');
      await service.sync();
      await setTransactionStage(transaction.id, 'guardian-synced');
    } catch (error) {
      console.warn('[Guardian] post-completion sync failed; will reconcile on next tick', error);
    }
  }

  switch (transaction.type) {
    case 'send':
      await completeSendTransaction(transaction as SendTransaction, result);
      break;
    case 'consume':
      await completeConsumeTransaction(transaction.id, result);
      break;
    case 'switch-guardian':
      await completeSwitchGuardianTransaction(
        transaction as SwitchGuardianTransaction,
        result,
        service,
        guardianProvider
      );
      break;
    case 'replace-hot-key':
      await completeReplaceHotKeyTransaction(transaction as ReplaceHotKeyTransaction, result, guardianProvider);
      break;
    case 'update-procedure-threshold':
      await completeUpdateProcedureThresholdTransaction(
        transaction as UpdateProcedureThresholdTransaction,
        result,
        service
      );
      break;
    case 'swap':
      await completeSwapTransaction(transaction as SwapTransaction, result);
      break;
    case 'bridged-send':
      await completeBridgedSendTransaction(transaction as BridgedSendTransaction, result);
      break;
    case 'earn-deposit':
      // Same completion as the non-Guardian path: extract the committed P2IDE
      // collateral note id and mark the row Deposited. `createEarnP2IDENote` reads
      // `outputNoteIds[0]` off this row to hand the note back to the Epoch SDK, so
      // routing this to the generic custom-tx completion would strand the deposit.
      await completeEarnDepositTransaction(transaction as EarnDepositTransaction, result);
      break;
    case 'execute':
    default:
      await completeCustomTransaction(transaction, result);
      break;
  }

  await setTransactionStage(transaction.id, 'complete');
};

export const generateTransactionsLoop = async (
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  useWorker: boolean = true,
  guardianProvider: GuardianAccountProvider
): Promise<boolean | void> => {
  await cancelStuckTransactions();
  await cancelStaleQueuedTransactions();

  // Import any notes needed for queued transactions
  await importAllNotes();

  // Wait for other in progress transactions
  const inProgressTransactions = await getTransactionsInProgress();
  if (inProgressTransactions.length > 0) {
    return;
  }

  // Find transactions waiting to process
  const queuedTransactions = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.Queued).toArray();
  queuedTransactions.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  if (queuedTransactions.length === 0) {
    return;
  }

  // Process the oldest ELIGIBLE transaction. A tx requeued after a transient
  // guardian pending-delta 409 carries a `nextEligibleAt` cooldown; skip it while
  // that is in the future so it doesn't monopolize the loop as the oldest row and
  // starve another account's queued tx. A tx with no `nextEligibleAt` is always
  // eligible (backward compatible). If every queued tx is still cooling down there
  // is nothing to do this cycle; MAX_QUEUED_AGE remains the terminal cap.
  const now = Math.floor(Date.now() / 1000);
  const nextTransaction = queuedTransactions.find(tx => tx.nextEligibleAt === undefined || tx.nextEligibleAt <= now);
  if (!nextTransaction) return;

  // Call safely to cancel transaction and unlock records if something goes wrong
  try {
    await generateTransaction(nextTransaction, signCallback, useWorker, guardianProvider);
    return true;
  } catch (e) {
    logger.warning('Failed to generate transaction', e);
    // A stable code string, when the SDK attaches one (web-sdk sets `code`; the
    // offscreen bus re-attaches a forwarded code as `errorCode`). web-sdk 0.16
    // maps only a couple of account-tracking variants, so most failures arrive
    // code-less and are classified by text instead — see `isApplyAfterSubmitError`.
    const errorCode = extractSdkErrorCode(e);

    // If the failure was caused by the wallet being locked mid-sign,
    // leave the tx Queued rather than marking it Failed — the next
    // auto-consume cycle (after the wallet unlocks) will retry it.
    // This prevents the note-loss scenario the 1000-op stress run
    // surfaced: lock during executeTransaction → tx cancelled → next
    // cycle starts fresh but some races can leave the note stuck.
    // Two locked signals. (1) The SDK-captured sign-callback auth error on the
    // SW-inline (FLAG-OFF) client — `readLastAuthReason()` returns `undefined`
    // under flag-on, where the SW client never signed for the offscreen op (issue
    // #260 flip-prep #2). (2) An explicit `reason:'locked'` error tag — thrown by
    // the guardian provider when the vault is null (guardian path), OR re-tagged
    // onto a flag-on offscreen write whose reverse-IPC sign reported 'locked'
    // (`dispatchOffscreenWrite`). Either one defers the tx for retry after unlock
    // rather than marking it Failed.
    const authReason = await readLastAuthReason();
    if (authReason === 'locked' || isLockedError(e)) {
      logger.warning('Wallet locked during tx generation; requeueing tx for retry after unlock');
      // Genuinely RE-QUEUE it. `generateTransaction` already advanced the row to
      // `GeneratingTransaction` (before any signing), and that status is exactly
      // what `getTransactionsInProgress()` selects — so a bare `return` would pin
      // the FIFO for every account until the stuck reaper Failed this row half an
      // hour later. Nothing reached the chain: the failure is a locked vault at
      // sign time, which is strictly pre-submit, so requeueing cannot double-spend.
      // Wrapped: `updateTransactionStatus` throws on an already-terminal row (a
      // concurrent cancel), and that throw must not escape the loop's catch.
      try {
        await requeueTransactionForRetry(
          nextTransaction.id,
          nextTransaction.type,
          'syncing',
          LOCKED_REQUEUE_COOLDOWN_SEC
        );
      } catch (requeueError) {
        logger.warning('Failed to requeue locked transaction', requeueError);
      }
      return false;
    }

    // Submit succeeded but apply failed: the tx IS live on chain. Mark
    // as Completed (not Failed) so the activity tab shows the right
    // outcome; the next sync will reconcile note states via
    // ConsumedExternal. Retrying would hit the node's nullifier check
    // and produce a misleading "already consumed" error.
    if (isApplyAfterSubmitError(e)) {
      const tx = await Repo.transactions.where({ id: nextTransaction.id }).first();

      // Result-awaiting rows (earn-deposit, EPOCH bridged-send) must NOT be marked
      // Completed here: their callers read `resultBytes`/`outputNoteIds` back off
      // the completed row and this generic post-submit path has no
      // `TransactionResult` to repopulate them from (the apply threw before we could
      // capture it). See the `isResultAwaitingRow` doc comment. Fail the row instead
      // so the caller resolves via the error branch and gives up cleanly; the
      // on-chain P2IDE collateral note reclaims itself at its recall height, and
      // neither is blindly re-queued into a duplicate collateral note. An AGGLAYER
      // `bridged-send` is deliberately NOT in this branch — nothing awaits it, its
      // note is on chain, and failing it would hide the L1 claim UI.
      if (tx && isResultAwaitingRow(tx)) {
        logger.warning(
          `${tx.type} submitted but local apply failed; marking Failed so the awaiting caller stops waiting`
        );
        if (tx.status !== ITransactionStatus.Failed) await cancelTransactionAfterPipelineStopped(tx, e);
        return false;
      }

      logger.warning('Transaction submitted but local apply failed; marking Completed, sync will reconcile');
      if (tx && tx.status !== ITransactionStatus.Completed) {
        // Guardian ops never reach here — they're routed through the guardian branch
        // of `generateTransaction`, whose own catch handles apply-after-submit-failed
        // for value-moving ops (send/consume/swap/execute) by marking Completed, and
        // for replace-hot-key/switch-guardian via `reconcileStructuralApplyFailure`.
        // (update-procedure-threshold is currently handled by neither and still falls
        // through to cancel there — a separate, pre-existing gap.) This generic path
        // covers non-guardian send/consume, whose note states the next sync reconciles
        // via ConsumedExternal.
        //
        // A PRIVATE send reaching here has strictly worse consequences than "the next
        // sync reconciles it", and they are invisible from the row alone. The apply
        // threw, so `completeSendTransaction` never ran — and that is the only code
        // that hands a private note to the transport. The transaction is on chain and
        // its note was never relayed to anyone, which no amount of syncing repairs:
        // sync reconciles what the CHAIN knows, and the chain holds a commitment, not
        // the note body the recipient needs. Marking this Completed with a bare
        // "Completed" is therefore the same silent loss this field exists to expose.
        //
        // There is nothing to retry from here — the apply threw before a
        // `TransactionResult` could be captured, so the note bytes are gone with the
        // call frame — which is exactly why it has to be surfaced rather than
        // absorbed.
        // `isPrivateNoteType`, not a bare compare against the string enum: a row can
        // hold the SDK's NUMERIC note type, which a string compare reads as public —
        // and that would report this exact loss as a clean "Completed". Unreadable
        // values resolve toward private, since over-reporting a delivery problem
        // costs a stale warning while under-reporting costs the funds.
        let isPrivateSend = tx.type === 'send';
        if (isPrivateSend) {
          try {
            isPrivateSend = isPrivateNoteType(tx.noteType);
          } catch {
            isPrivateSend = true;
          }
        }
        await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
          displayMessage: isPrivateSend ? 'Completed — the private note could not be delivered' : 'Completed',
          ...(isPrivateSend ? { noteDelivery: 'undelivered' as const } : {}),
          completedAt: Math.floor(Date.now() / 1000)
        });
      }
      return false;
    }

    // Diagnostic only. If the input note was already consumed on chain, the
    // pre-flight nullifier check transitioned it to ConsumedExternal; the tx is
    // then marked Failed below (it never reached chain) while the note stays
    // reconciled, so subsequent cycles won't retry it. This branch logs that
    // case when the SDK labels it — web-sdk 0.16 does not emit an
    // `InputNoteAlreadyConsumedOnChain` code, so it is currently only reachable
    // from a code explicitly attached by a caller or a future SDK. It changes no
    // behaviour either way; the funds-critical classification is
    // `isApplyAfterSubmitError` above.
    if (errorCode === 'InputNoteAlreadyConsumedOnChain') {
      logger.warning('Input note already consumed on chain; tx unnecessary');
    }

    // #260 follow-up #3a: node-verify a deadline-killed CONSUME (mirrors the
    // guardian catch in generateTransaction). An OperationAbortedError on a
    // consume whose note the node reports as consumed BY THIS CLIENT'S OWN tx
    // ('landed-local') → mark Completed (the note WAS claimed), no requeue;
    // 'processing' → leave the row in progress for the stuck reaper; otherwise
    // (incl. 'landed-external' — consumed but not provably mine) fall through to
    // the funds-safe Failed path below. Send/swap/execute are untouched
    // (deferred #3b).
    if (await tryCompleteKilledConsume(nextTransaction, e)) return false;

    // Cancel the transaction if it hasn't already been cancelled
    const tx = await Repo.transactions.where({ id: nextTransaction.id }).first();
    if (tx && tx.status !== ITransactionStatus.Failed) await cancelTransactionAfterPipelineStopped(tx, e);
    return false;
  }
};

export const safeGenerateTransactionsLoop = async (
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  useWorker: boolean = true,
  guardianProvider: GuardianAccountProvider
) => {
  return navigator.locks
    .request(`generate-transactions-loop`, { ifAvailable: true }, async lock => {
      if (!lock) return;

      const result = await generateTransactionsLoop(signCallback, useWorker, guardianProvider);
      if (result === false) {
        return false;
      }

      // Either a transaction was processed successfully (true)
      // or there was nothing to do / another transaction is in progress (undefined).
      return true;
    })
    .catch(e => {
      logger.error('Error in safe generate transactions loop', e);
      return false;
    });
};

/**
 * Start background transaction processing for dApp transactions.
 * This runs the transaction loop without any UI, using the backend's signTransaction directly.
 * Polls every 5 seconds until all queued transactions are processed.
 */
export const startBackgroundTransactionProcessing = (
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  useWorker: boolean = false,
  guardianProvider: GuardianAccountProvider
) => {
  // Process transactions in a loop until none are left
  const processLoop = async () => {
    let hasMore = true;
    let attempts = 0;
    // Cap the number of loop passes, not wall-clock time. Each pass now runs one
    // full generate cycle whose guardian ops can spend up to the conflict-retry
    // budget (~60s) before returning, so 60 passes is NOT "5 minutes" — it's a
    // pass ceiling that, together with the 5s inter-pass wait, just bounds how
    // long this background driver keeps polling. Terminal per-tx caps live
    // elsewhere: MAX_QUEUED_AGE (queued) and MAX_WAIT_BEFORE_CANCEL (in-flight).
    const maxAttempts = 60;

    while (hasMore && attempts < maxAttempts) {
      attempts++;
      await safeGenerateTransactionsLoop(signCallback, useWorker, guardianProvider);

      // Check if there are more transactions to process
      const remaining = await getAllUncompletedTransactions();
      hasMore = remaining.length > 0;

      if (hasMore) {
        // Wait before next attempt
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  };

  // Run in background (don't await)
  processLoop().catch(e => {
    console.error('[BackgroundTxProcessor] Error:', e);
  });
};
