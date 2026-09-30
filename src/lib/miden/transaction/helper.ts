import { TransactionResult } from '@miden-sdk/miden-sdk/lazy';
import { liveQuery } from 'dexie';

import * as Repo from 'lib/miden/repo';
import { u8ToB64 } from 'lib/shared/helpers';
import { classifyError } from 'lib/telemetry/classify';
import { reportOperation } from 'lib/telemetry/report-operation';
import { elapsedMsSince, operationOfType, stepOfStage } from 'lib/telemetry/transaction-operation';

import { type SignCallbackReason } from './sign-callback';
import { splitExecutedOutputNotes } from '../activity/fee-notes';
import { compareAccountIds } from '../activity/utils';
import {
  INoteDeliveryState,
  ITransaction,
  ITransactionStage,
  ITransactionStatus,
  TransactionOutput
} from '../db/types';
import { isPrivateNoteType } from '../helpers';
import { errorMessageParts, type LandedTransaction } from '../sdk/sdk-error-code';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';

// Re-export the sign-callback classification from its leaf home (issue #260,
// slice 5). It moved to `./sign-callback` to break a `helper ↔ proxy` import
// cycle (the offscreen write proxy needs the classifier). Re-exporting keeps
// every existing caller — `import { buildSignCallbackError, ... } from './helper'`
// / `./index` — unchanged.
export { buildSignCallbackError, buildSdkSignCallback, type SignCallbackError } from './sign-callback';
// `SignCallbackReason` is imported locally and re-exported from that binding.
export type { SignCallbackReason };

/**
 * Detect the Guardian canonicalization refusal, which the pinned multisig client
 * (0.17.0) throws from `syncState` when the guardian's view of an account has the
 * local nonce with another commitment, or does not match the chain (a guardian
 * behind local is kept quietly):
 *
 *   "Refusing to overwrite local state: incoming nonce N equals local nonce N
 *    but commitments differ for account X"
 *   "Refusing to overwrite local state: incoming commitment does not match
 *    on-chain commitment for account X"
 *
 * An answer about the guardian's view, never a landed write: a post-submit failure
 * arrives as the apply-after-submit error (#1233). See `sdk/sdk-error-code.ts`.
 */
export { isGuardianCanonicalizationError } from '../sdk/sdk-error-code';

/**
 * Detect a co-signature that no longer authorizes the transaction being executed:
 *
 * The verbatim text, from all 67 guardian failures in a 300-send devnet run:
 *
 *   "Offscreen call 'guardianPipeline' failed: failed to execute transaction:
 *    transaction execution failed: transaction is unauthorized with summary
 *    TransactionSummary { ... }"
 *
 * The guardian co-signs a `TransactionSummary` bound to the account state and
 * block commitment it saw when it signed. If the executing client recomputes
 * that summary against anything else, the account's auth procedure rejects the
 * signature. It is not a rejection of the transfer — the transfer is untouched,
 * and a fresh proposal is authorized again.
 *
 * The mechanism behind every observed instance is the chain moving between the
 * signature and the `executeRequest`, and its odds scale with the guardian
 * round-trip: measured over a 300-send devnet run at ~4.5% with a sub-second
 * proposal→execute window, rising to ~35% past 1.7s under sustained load.
 *
 * That mechanism is closable, and closing it is in review as #786: the execute is
 * pinned to the proposal's own `ChainAnchor`, so a client whose sync height has
 * advanced still reproduces the summary. Once it lands, a match here stops
 * meaning "a block landed mid-flow" and starts meaning some other divergence
 * between the two computations of the summary — a proposal carrying no anchor
 * included. Widen the wording here, not the predicate, when that happens.
 *
 * BOTH halves are required, and the execution half is the load-bearing one: it
 * is what lets callers conclude the transaction never reached the chain, since
 * this text can only come from the execute step, which precedes prove and
 * submit in both the inline (`runGuardianPipeline`) and offscreen
 * (`guardianPipeline`) leaves. Matching "unauthorized" alone would also catch a
 * post-submit rejection carrying the same word, and requeueing one of those
 * could double-send a transfer that had already landed.
 *
 * The execution marker is deliberately the narrow `transaction execution
 * failed` and not the broader "failed to execute …": the native prover reports
 * `failed to execute transaction kernel program`, which would pair with the
 * word "unauthorized" on a text coincidence and pin the failure to no step at
 * all.
 *
 * The `cause` chain is searched, like `isApplyAfterSubmitError` in the same
 * catch chain — the offscreen bus rewraps errors and callers may attach a
 * cause, so the reason does not reliably land on `.message`, and reading only
 * that fails closed (silently switching this arm back off) rather than
 * announcing itself. But both halves must come from the SAME error in that
 * chain, which is why this tests each link instead of the flattened string: on
 * the flattened form a post-submit rejection supplying "unauthorized" and any
 * unrelated inner error supplying the execution marker would assemble a match
 * for a transfer that may already be on chain, out of two errors that never
 * described one failure.
 */
export function isGuardianUnauthorizedExecutionError(error: unknown): boolean {
  // A lock-recovery eviction is never a guardian auth rejection, but its `cause`
  // carries the raw realm error VERBATIM — and this classifier walks the cause
  // chain, so an eviction that interrupted a pipeline which had already produced
  // this text would match on the wrapper (issue #775). That breaks the arm's
  // whole safety argument: it holds because the execute step STOPPED the
  // pipeline before prove and submit, whereas an eviction only rejects the
  // caller — the abandoned pipeline runs on and can still submit, so requeueing
  // would broadcast the transfer a second time. Checked first, mirroring
  // `isApplyAfterSubmitError` and `isLockedError`.
  if (isWasmClientPoisonedError(error)) return false;
  return errorMessageParts(error).some(
    part => /transaction is unauthorized/i.test(part) && /transaction execution failed/i.test(part)
  );
}

/**
 * True when `err` signals the wallet is LOCKED (its vault reference is
 * null / unavailable) rather than a genuine transaction failure. The
 * transaction loop uses this to DEFER a tx (leave it Queued) so the next
 * auto-consume cycle retries it after unlock, instead of marking it Failed.
 *
 * Two signals, mirroring `buildSignCallbackError`'s locked classification:
 *   - a `reason: 'locked'` tag, attached to the write's own rejection by
 *     `withWasmClientLock` (from the record its sign trampoline keyed by the
 *     hold) or by `dispatchOffscreenWrite` (from its op-keyed record), through
 *     `tagLockedSignReason`; the vault-backed guardian provider's null-vault
 *     guard throws it directly, or
 *   - an explicit "locked" / "not initialized" message, which is all the SDK
 *     forwards from a sign callback's throw.
 *
 * Deliberately NARROWER than `buildSignCallbackError`: it does NOT treat a
 * bare `Cannot read properties of null` TypeError as locked. That regex is
 * safe inside the sign-callback wrapper (only reached on an actual sign
 * attempt), but here it runs over EVERY `generateTransaction` failure, and
 * classifying arbitrary null-derefs as "locked" would requeue genuinely
 * broken transactions forever. The guardian provider throws an explicit
 * locked message, so this precise match is sufficient.
 */
export function isLockedError(err: unknown): boolean {
  // A lock-recovery eviction is never a locked vault, whatever its text says
  // (issue #775). "Locked" means DEFER: leave the row Queued for the next cycle.
  // That is safe only because a locked vault is strictly pre-submit — and an
  // eviction is the one failure where that does not hold, since the abandoned
  // pipeline runs on and can still submit. Belt-and-braces with the closed-set
  // message in `WasmClientPoisonedError`: this is the classifier whose false
  // positive turns into a second payment, so it checks the TYPE too.
  if (isWasmClientPoisonedError(err)) return false;
  if (err && typeof err === 'object' && (err as { reason?: unknown }).reason === 'locked') {
    return true;
  }
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /wallet is locked|vault is (?:null|locked|unavailable)|not initialized/i.test(msg);
}

/**
 * Update the status of the transaction
 * @param id The id of the transaction to update
 * @throws if the transaction has been cancelled
 */
export const updateTransactionStatus = async <K extends keyof ITransaction>(
  id: string,
  status: ITransactionStatus,
  otherValues: Pick<ITransaction, K>
) => {
  const tx = await Repo.transactions.where({ id }).first();
  if (!tx) throw new Error('No transaction found to update');
  if (tx.status === ITransactionStatus.Failed || tx.status === ITransactionStatus.Completed) {
    throw new Error('Transaction already in a finalized state');
  }

  // Re-checked at WRITE time as well as above, because the two are separate
  // transactions and the terminal writer is no longer always inside the loop
  // lock: the requeue wake's ceiling can fail a stale row from outside it. Lose
  // that race and this call writes a live status straight over the Failed —
  // without clearing `error`, `displayIcon` or `completedAt`, which nothing on
  // the success path clears either. The row then completes wearing a FAILED
  // icon and an expiry message, on a send that actually went through.
  let finalized = false;
  await Repo.transactions.where({ id: id }).modify(t => {
    if (t.status === ITransactionStatus.Failed || t.status === ITransactionStatus.Completed) {
      finalized = true;
      return false;
    }
    // Snapshot the stamps accumulated DURING the run, before the assign below
    // can overwrite them with a stale forwarded copy (see the Completed branch).
    const runStageTimestamps = t.stageTimestamps;
    Object.assign(t, otherValues);
    t.status = status;
    // Stamp the terminal stage on success. `setTransactionStage` refuses writes
    // once a row is terminal, so the trailing setTransactionStage(id,'complete')
    // in generateTransaction is a silent no-op and a SUCCESSFUL row keeps
    // whatever stage it happened to be in — a completed replace-hot-key freezes
    // at 'confirming', a completed guardian consume at 'guardian-synced'. That
    // read as "still in flight" and cost several investigations (#618).
    //
    // Unconditional, and AFTER the Object.assign so it wins: completeCustomTransaction
    // forwards `interpretTransactionResult(...)`, i.e. the whole pick-time row, so any
    // presence check on `otherValues.stage` misfires there and writes the stale
    // pick-time stage straight back. No Completed caller passes `stage` deliberately —
    // the only deliberate stage payload is requeueTransactionForRetry, which writes Queued.
    //
    // Failed rows keep their stage: there it records WHERE the failure happened
    // and is diagnostically load-bearing (GeneratingTransaction reads it to pin
    // the failed step).
    if (status === ITransactionStatus.Completed) {
      t.stage = 'complete';
      // Restore the run's stamps, for the same reason the stage write above is
      // unconditional: completeCustomTransaction forwards
      // `interpretTransactionResult(...)`, i.e. the whole row as picked at loop
      // time — which predates every stamp `setTransactionStage` wrote during the
      // run, so the assign above would hand back an empty set and every step
      // would render without a duration (#524). No Completed caller supplies
      // stamps deliberately; the only deliberate payload is
      // requeueTransactionForRetry, and that writes Queued, not Completed.
      if (runStageTimestamps) t.stageTimestamps = runStageTimestamps;
      // The same write also closes the LAST processing step: its span runs to the
      // synthetic `complete` boundary, since no following stage exists to end it.
      if (!t.stageTimestamps) t.stageTimestamps = {};
      if (t.stageTimestamps.complete === undefined) t.stageTimestamps.complete = Date.now();
    }
    return undefined;
  });
  if (finalized) throw new Error('Transaction already in a finalized state');

  // Both terminal outcomes, from the one place a row can reach either through
  // this function.
  //
  // The success side is the denominator: a failure count alone says nothing,
  // since ten failed sends is a crisis or a rounding error depending on how many
  // succeeded.
  //
  // The failure side does NOT double-count what `cancelTransaction` already
  // reports, and the reason is worth stating because it is not obvious. That
  // function writes its `Failed` with a raw `.modify` rather than calling this
  // one, so the two sets of failures are disjoint: everything the pipeline fails
  // deliberately goes through there, and the handful that bypass it — a private
  // send with no note to deliver, a guardian rotation that could not be applied
  // — arrive here and would otherwise be the only failures that reported
  // nothing at all.
  //
  // Two more writers exist and both report for themselves, because both are
  // *transitions between* terminal states and this function's guard refuses
  // those outright: `completeVerifiedLandedTransaction` promotes Failed →
  // Completed on node evidence, and `markBridgedSendFailed` demotes Completed →
  // Failed when the allocator rejects an intent whose note already committed.
  // Adding a writer that skips this function is therefore also adding a report;
  // `rg 'status = ITransactionStatus\.(Completed|Failed)'` is the list to check
  // against, and every hit on it should be one of these five.
  if (status === ITransactionStatus.Completed || status === ITransactionStatus.Failed) {
    reportOperation({
      operation: operationOfType(tx.type),
      result: status === ITransactionStatus.Completed ? 'completed' : 'errored',
      // How long the user waited from pressing the button to the money having
      // moved, which is the number worth watching for regressions.
      durationMs: elapsedMsSince(tx.initiatedAt),
      // The stage of a failure written this way is whatever the row was in when
      // it happened, which is exactly the diagnostic the failure carries. A
      // success has none: `stage` was just stamped `complete` above, which is
      // not somewhere anything went wrong.
      ...(status === ITransactionStatus.Failed
        ? { errorKind: classifyError(failureTextOf(otherValues)), step: stepOfStage(tx.stage) }
        : {})
    });
  }
};

/**
 * The failure text a caller passed alongside a `Failed` status, if any.
 *
 * These writes carry their reason in `otherValues` rather than as a thrown
 * error, so this is the only thing available to classify. Read through a narrow
 * structural check rather than a cast, and handed to `classifyError`, which
 * returns a closed union — the text is inspected here and goes no further.
 */
function failureTextOf(otherValues: object): string | undefined {
  const values = otherValues as { rawError?: unknown; error?: unknown };
  if (typeof values.rawError === 'string') return values.rawError;
  if (typeof values.error === 'string') return values.error;
  return undefined;
}

/**
 * Informational stage write. Called at phase boundaries inside
 * `generateTransaction` / `completeSendTransaction` so the progress modal
 * can show "Syncing" / "Sending" / "Confirming" / "Delivering" instead of
 * a single opaque "Generating transaction". Does not gate on status —
 * late writes after a terminal status are no-ops via the `.modify` callback.
 *
 * That terminal guard is load-bearing, NOT a formality: a Failed row's stage
 * records WHERE it failed and `GeneratingTransaction` reads it to pin the failed
 * step, so a late write would erase the failure location. Completed rows are
 * stamped `'complete'` by `updateTransactionStatus` itself (#618), which is why
 * this function stays the pre-terminal writer.
 */
export const setTransactionStage = async (
  id: string,
  stage: ITransactionStage,
  opts?: { readonly timingOnly?: boolean }
) => {
  await Repo.transactions.where({ id }).modify(tx => {
    // `false` on the declining path, not a fall-through: Dexie only skips its
    // put on that exact value and treats `undefined` as "modified", so a
    // terminal row would be re-put unchanged and fire a `liveQuery` event for
    // it. This writer runs at every stage boundary and `useTransactionRow`
    // observes the table, so that is the noisiest place to get it wrong.
    if (tx.status === ITransactionStatus.Completed || tx.status === ITransactionStatus.Failed) return false;
    // `tx.stage` is CONTROL state, `tx.stageTimestamps` is TELEMETRY, and the two
    // are written together only when the writer is reliable and in-order.
    //
    // The rate-limit, remote-prover-outage and guardian-unreachable gates in
    // `transaction/index.ts` read `tx.stage` to decide a failed guardian tx is
    // PRE-submit and may therefore be auto-requeued: "submit is stamped
    // 'submitting' and runs only AFTER prove, so nothing reached the chain". That
    // inference is only sound if every writer of `stage` is ordered with respect
    // to the work it describes. (The 409 pending-conflict arm reads only the
    // error and the transaction type.)
    //
    // The unauthorized-at-execution gate deliberately does NOT read `stage`: on the
    // shipping path its leaf runs offscreen, so by the rule below the row still
    // reads 'sending' when execution failed, and a stage-gated arm would never have
    // fired in production. It proves pre-submit from the error text instead. Do not
    // "harmonize" it onto `stage`.
    //
    // A stamp replayed from the OFFSCREEN realm is not: it crosses `chrome.runtime`
    // fire-and-forget, with no delivery or ordering guarantee against the op's own
    // reply. A dropped or late `submitting` would leave the row reading `proving`
    // after submit had actually run, and the requeue gate would re-submit a
    // transaction that may already be on chain. So cross-realm stamps record the
    // boundary for the progress screen and leave `stage` alone — the service
    // worker's own in-order writes remain its only author.
    if (!opts?.timingOnly) tx.stage = stage;
    // Record the first time this stage was entered so the UI can compute
    // per-step durations from persisted stamps (see ITransaction.stageTimestamps).
    // First-entry-wins WITHIN AN ATTEMPT: a requeue clears the whole map (both
    // the automatic arms and a user Retry do), so the next attempt re-stamps
    // from scratch rather than inheriting this one's boundaries.
    if (!tx.stageTimestamps) tx.stageTimestamps = {};
    if (tx.stageTimestamps[stage] === undefined) tx.stageTimestamps[stage] = Date.now();
    return undefined;
  });
};

const UNDELIVERED_SEPARATOR = ' - ';

/**
 * The label of a landed row whose private notes could not be delivered: `base` plus the wording.
 * Omit `notes` for a send, whose single note is "the private note"; pass the count where a row
 * can carry several. {@link recordNoteDelivery} takes the wording off again once they arrive.
 */
export const undeliveredDisplayMessage = (base: string, notes?: number): string => {
  const phrase = notes === undefined ? 'the private note' : notes === 1 ? 'a private note' : `${notes} private notes`;
  return `${base}${UNDELIVERED_SEPARATOR}${phrase} could not be delivered`;
};

/**
 * The private notes a row owes the relay, which its single `noteDelivery` covers. A send's one output
 * note is its private note; a custom row records them apart from its public notes in `relayNoteIds`.
 */
export const relayNoteIdsOf = (row: Pick<ITransaction, 'relayNoteIds' | 'outputNoteIds'>): string[] =>
  row.relayNoteIds ?? row.outputNoteIds ?? [];

/**
 * The account a row's private notes were relayed to. A send's recipient is its `secondaryAccountId`; a custom
 * row records it apart with its `relayNoteIds`, because reading its result as a consume puts the input note's
 * sender there instead. So a custom row whose dApp named no recipient has none, never that sender.
 */
export const relayRecipientOf = (
  row: Pick<ITransaction, 'relayNoteIds' | 'relayRecipientId' | 'secondaryAccountId'>
): string | undefined => (row.relayNoteIds ? row.relayRecipientId : row.secondaryAccountId);

/** `label`'s base when {@link undeliveredDisplayMessage} built it, else `label` unchanged. */
const withoutUndeliveredWording = (label: string): string => {
  const at = label.lastIndexOf(UNDELIVERED_SEPARATOR);
  if (at < 0) return label;
  const base = label.slice(0, at);
  const count = Number(label.slice(at + UNDELIVERED_SEPARATOR.length).split(' ', 1)[0]);
  // Rebuilding and comparing makes this the exact inverse, so no near miss loses its text.
  return [undefined, 1, count].some(notes => undeliveredDisplayMessage(base, notes) === label) ? base : label;
};

/**
 * Record the delivery state of this row's private output note, plus the evidence
 * needed to reason about it after the fact.
 *
 * The point is ordering. The SDK's retry outbox is written from inside the Rust
 * relay and only after it resolves the transport API, so any failure upstream of
 * that write leaves nothing queued anywhere — and the wallet, having written
 * nothing of its own until the terminal status, could not tell an interrupted
 * relay from a delivered one. Stamping `'pending'` with the landed transaction id
 * and note id BEFORE the attempt is what makes those two distinguishable.
 *
 * Deliberately NOT guarded on terminal status, unlike {@link setTransactionStage}.
 * That guard is right for a stage, which is display state describing the attempt
 * currently running; it is wrong here, because this is EVIDENCE about what the
 * pipeline did, and the case that most needs recording is exactly the one the
 * guard would drop. Nothing aborts a running pipeline when its row is failed from
 * outside — the Cancel button and the stuck-row reaper both mark the row and walk
 * away, so the relay still runs. Under the guard that relay's outcome went
 * unrecorded, leaving a Failed row with no delivery evidence and no landed-tx id:
 * the worst of both, since a later retry then cannot tell the send already
 * happened. `status` is the thing that must not move here, and this never touches
 * it.
 */
export const recordNoteDelivery = async (
  id: string,
  noteDelivery: INoteDeliveryState,
  evidence?: { transactionId?: string; outputNoteIds?: string[] }
) => {
  await Repo.transactions.where({ id }).modify(tx => {
    tx.noteDelivery = noteDelivery;
    if (evidence?.transactionId) tx.transactionId = evidence.transactionId;
    if (evidence?.outputNoteIds?.length) tx.outputNoteIds = evidence.outputNoteIds;
    // History renders the label, not `noteDelivery`, so a delivered note retires its warning there too, but only
    // on a row owing at most one private note: the row's single state cannot speak for several.
    const delivered = noteDelivery === 'relayed' || noteDelivery === 'confirmed';
    if (delivered && relayNoteIdsOf(tx).length <= 1 && tx.displayMessage) {
      tx.displayMessage = withoutUndeliveredWording(tx.displayMessage);
    }
  });
};

/**
 * Activity label for a row, Guardian or not, whose submit LANDED on chain but whose
 * local reconcile failed. There is no `TransactionResult` here, so the label is the one
 * the type's normal completion writes, derived from the row alone:
 * `completeConsumeTransaction` writes "Reclaimed" when the note's sender (the row's
 * `secondaryAccountId`) is the account itself and "Received" otherwise, as the
 * kill-verified consume derives it; `completeSwapTransaction` writes "Swapped",
 * `completeBridgedSendTransaction` "Bridged to EVM" and `completeSendTransaction` "Sent".
 * `completeCustomTransaction` reads its label off the result, so a landed execute takes
 * the one it writes when the result shows no single direction, "Executed".
 */
export const applyLandedDisplayMessage = (
  tx: Pick<ITransaction, 'type' | 'accountId' | 'secondaryAccountId'>
): string => {
  switch (tx.type) {
    case 'consume':
      return compareAccountIds(tx.accountId, tx.secondaryAccountId ?? '') ? 'Reclaimed' : 'Received';
    case 'swap':
      return 'Swapped';
    case 'bridged-send':
      return 'Bridged to EVM';
    case 'execute':
      return 'Executed';
    default:
      return 'Sent';
  }
};

/**
 * What a landed reconcile knows about a write whose submit resolved and whose local apply failed
 * (#1233): no `TransactionResult`, only the facts the apply-after-submit error carried.
 */
export type LandedWithoutResult = LandedTransaction;

/** The landed id as row fields, so the receipt names the transaction; empty when there is none. */
export const landedTransactionIdFields = (landed: LandedWithoutResult | undefined): { transactionId?: string } =>
  landed?.transactionId === undefined ? {} : { transactionId: landed.transactionId };

/**
 * The Completed fields for a value-moving row whose submit landed and whose local reconcile did not,
 * on either catch or on Retry's landed reconcile (#1233). A PRIVATE send's note reaches its
 * recipient only through `completeSendTransaction`'s relay, which never ran and which no sync
 * repairs, so the row says the note was not delivered. `isPrivateNoteType` and not a string
 * compare, since a row can hold the SDK's numeric note type; an unreadable one counts as private,
 * because under-reporting costs the funds while over-reporting costs a stale warning.
 *
 * An execute's private notes are relayed only by `completeCustomTransaction`, so the same holds for
 * the `privateOutputNotes` its failure counted. Without a count (a refusal, Retry, an unreadable
 * transaction) the recipient its request named says notes were owed, and an 'undelivered' the row
 * already recorded is kept under a label that says so.
 */
export const landedValueRowFields = (
  tx: Pick<ITransaction, 'type' | 'noteType' | 'accountId' | 'secondaryAccountId' | 'noteDelivery'>,
  privateOutputNotes?: number
): { displayMessage: string; noteDelivery?: 'undelivered' } => {
  const displayMessage = applyLandedDisplayMessage(tx);
  if (tx.type === 'execute') {
    const owed =
      tx.noteDelivery === 'undelivered' ||
      (privateOutputNotes === undefined ? Boolean(tx.secondaryAccountId) : privateOutputNotes > 0);
    const notes = privateOutputNotes !== undefined && privateOutputNotes > 0 ? privateOutputNotes : undefined;
    return owed
      ? { displayMessage: undeliveredDisplayMessage(displayMessage, notes), noteDelivery: 'undelivered' }
      : { displayMessage };
  }
  let privateSend = tx.type === 'send';
  if (privateSend) {
    try {
      privateSend = isPrivateNoteType(tx.noteType);
    } catch {
      privateSend = true;
    }
  }
  return privateSend
    ? { displayMessage: undeliveredDisplayMessage(displayMessage), noteDelivery: 'undelivered' }
    : { displayMessage };
};

/**
 * Reconcile a Failed row that the node says actually LANDED.
 *
 * Separate from {@link updateTransactionStatus} because that function's terminal
 * guard makes this impossible through it: `requeueFailedTransaction` only ever
 * runs on a Failed row, so its "provably on chain — complete it instead of
 * resubmitting" branch threw `Transaction already in a finalized state` every
 * single time, and the UI surfaced that string as the retry error. The row then
 * stayed Failed for a send that had succeeded, with no way to reconcile it.
 *
 * The guard itself is right and stays: it stops a LATE error downgrading a
 * finalized row. Promoting Failed → Completed on node evidence is the opposite
 * operation — deliberate, evidence-backed, and the only thing standing between
 * an ambiguous post-submit abort and a second payment — so it gets its own
 * narrow door rather than a hole in that one. Refuses to touch an
 * already-Completed row, which needs no reconciling.
 *
 * `otherValues` may be a function of the row as the write finds it, for fields that
 * depend on state another writer can record while the caller awaits the node.
 */
export const completeVerifiedLandedTransaction = async (
  id: string,
  otherValues: Partial<ITransaction> | ((fresh: ITransaction) => Partial<ITransaction>) = {}
): Promise<void> => {
  let reconciled: ITransaction | undefined;
  await Repo.transactions.where({ id }).modify(tx => {
    if (tx.status !== ITransactionStatus.Failed) return;
    applyVerifiedLanding(tx, typeof otherValues === 'function' ? otherValues(tx) : otherValues);
    reconciled = tx;
  });

  if (reconciled !== undefined) {
    reportVerifiedLanding(reconciled);
  }
};

/**
 * The write `completeVerifiedLandedTransaction` applies to a Failed row inside
 * its `.modify`, pulled out so a caller that must promote a row INSIDE an
 * existing `.modify` of its own can do so without a second write after it -
 * `updateBridgeClaimStatus` (#1250), whose bridge evidence and the status it
 * proves must land in the same Dexie write, never a write recording the
 * evidence followed by a second one settling the row.
 */
export const applyVerifiedLanding = (tx: ITransaction, otherValues: Partial<ITransaction> = {}): void => {
  Object.assign(tx, otherValues);
  tx.status = ITransactionStatus.Completed;
  tx.stage = 'complete';
  // The failure is no longer the row's story; leaving it behind renders a
  // completed transaction with an error on it.
  tx.error = undefined;
  tx.rawError = undefined;
};

/**
 * Report the reconciliation `applyVerifiedLanding` just wrote onto `tx`.
 *
 * The row already reported `errored` when it was failed, and that report was
 * true at the time - the wallet genuinely could not tell whether the money had
 * moved. Reporting the success as well leaves both, which is the honest
 * record: one operation that failed and was later reconciled from node
 * evidence. Suppressing the failure is not an option, since it was reported
 * from a realm that may no longer exist, and suppressing this one would leave
 * the ambiguous post-submit abort - the case this reconciliation exists for -
 * permanently counted as a failure and never as a success.
 *
 * Deliberately without a duration. A landed row can be reported through here
 * arbitrarily long after `initiatedAt` - `completeVerifiedLandedTransaction`
 * when the user taps Retry, and `updateBridgeClaimStatus` when a bridge claim
 * or fill write reconciles a row days later (#1250) - so that interval means
 * "how long until somebody came back", and putting it in the field a reader
 * uses to watch for latency regressions would let a handful of them own the
 * tail of every send's distribution. There is no honest interval to report
 * here, so none is.
 */
export const reportVerifiedLanding = (tx: ITransaction): void => {
  reportOperation({ operation: operationOfType(tx.type), result: 'completed' });
};

/**
 * Record that this row's pipeline reached the point where a broadcast can no
 * longer be ruled out — the sticky half of the double-send guard that
 * `requeueFailedTransaction` reads before dropping a send's cached request.
 *
 * Unlike `setTransactionStage` this deliberately does NOT skip terminal rows,
 * and that exemption is the entire reason it exists. Nothing aborts a running
 * pipeline when its row is failed out from under it — the Cancel button and the
 * stuck-row reaper (`cancelStuckTransactions`) both go through
 * `cancelWhilePipelineMayStillRun`, which writes `Failed` and no stage — so the
 * pipeline runs on and submits. (Not `cancelStaleQueuedTransactions`, which
 * takes rows that were never picked up, so there is no pipeline to outlive.) The
 * `setStage('submitting')` that would have recorded the crossing is exactly what
 * the terminal guard suppresses, leaving the row frozen at whichever pre-submit
 * stage it happened to hold when the cancel landed. Retry then reads that stage
 * as proof nothing was broadcast, rebuilds the request, and mints a SECOND
 * payment for a transfer already on chain. Writing the flag through a guard-free
 * modify is what makes the record outlive that race.
 */
export const markMayHaveSubmitted = async (id: string) => {
  await Repo.transactions.where({ id }).modify(tx => {
    tx.mayHaveSubmitted = true;
  });
};

/**
 * Record that this row was failed from outside its own pipeline while that
 * pipeline was still running, so the retry guard treats a submit as possible
 * until the pipeline resolves. See `ITransaction.cancelledInFlightAt` for why
 * this is separate from — and expires unlike — `mayHaveSubmitted`.
 *
 * Guard-free as to the TERMINAL state, for the same reason as
 * `markMayHaveSubmitted`: the cancel it accompanies is what makes the row
 * terminal, so it cannot wait for that.
 *
 * It does test the in-flight condition, and does so in here rather than at the
 * call site, because the two have to be one write. The caller decides from a row
 * it read earlier; if the pipeline's own catch lands in between, that catch
 * resolves the marker and THEN this writes a fresh one — onto a row whose
 * pipeline is now provably dead, with the only thing that would have cleared it
 * already run. The row is then refused for the marker's full lifetime for no
 * reason. Re-reading the status inside the `modify` closes that window: Dexie
 * runs it against the committed row.
 */
export const markCancelledInFlight = async (id: string) => {
  const at = Math.floor(Date.now() / 1000);
  await Repo.transactions.where({ id }).modify(tx => {
    // `false`, not a bare return — Dexie reads `undefined` as "modified" and
    // re-puts the unchanged clone, a write and a `liveQuery` event for nothing.
    if (tx.status !== ITransactionStatus.GeneratingTransaction) return false;
    tx.cancelledInFlightAt = at;
    return undefined;
  });
};

/**
 * Resolve the above: the pipeline has stopped, so a submit is no longer merely
 * possible. Called from the pipeline's own catch, and what lets a genuine execute
 * or prove failure rebuild its request rather than replaying a bad one.
 *
 * On the guardian paths a submit that HAD happened is recorded on
 * `mayHaveSubmitted` by the leaf before it submitted, so the guard holds on that
 * instead and clearing this loses nothing. A plain send stamps nothing, so
 * clearing genuinely returns it to "no evidence either way" — correct for the
 * failures that reach here (the pipeline stopped, and the aborted-op case is
 * routed to the flag instead), but not a claim that a crossing was recorded
 * elsewhere. See `cancelTransactionAfterPipelineStopped`.
 */
export const clearCancelledInFlight = async (id: string) => {
  await Repo.transactions.where({ id }).modify(tx => {
    tx.cancelledInFlightAt = undefined;
  });
};

// Timeout for waiting on consume transactions (5 minutes)
const WAIT_FOR_CONSUME_TX_TIMEOUT = 5 * 60_000;

export const waitForConsumeTx = async (id: string, signal?: AbortSignal): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    let subscription: { unsubscribe: () => void } | null = null;

    const timeoutId = setTimeout(() => {
      subscription?.unsubscribe();
      reject(new Error('Transaction timed out. Please try again.'));
    }, WAIT_FOR_CONSUME_TX_TIMEOUT);

    const cleanup = () => {
      clearTimeout(timeoutId);
      subscription?.unsubscribe();
    };

    subscription = liveQuery(() => Repo.transactions.where({ id }).first()).subscribe(tx => {
      if (!tx) {
        cleanup();
        reject(new Error('Transaction not found'));
        return;
      }

      if (tx.status === ITransactionStatus.Completed) {
        cleanup();
        resolve(tx.transactionId!);
      } else if (tx.status === ITransactionStatus.Failed) {
        cleanup();
        reject(new Error('Consume transaction failed'));
      }
    });

    signal?.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
};

const WAIT_FOR_TX_TIMEOUT = 5 * 60_000; // 5 minutes

export const waitForTransactionCompletion = async (transactionId: string) => {
  return new Promise<TransactionOutput>(resolve => {
    let subscription: { unsubscribe: () => void } | null = null;

    const timeoutId = setTimeout(() => {
      subscription?.unsubscribe();
      resolve({ errorMessage: 'Transaction timed out' });
    }, WAIT_FOR_TX_TIMEOUT);

    const cleanup = () => {
      clearTimeout(timeoutId);
      subscription?.unsubscribe();
    };

    subscription = liveQuery(() => Repo.transactions.where({ id: transactionId }).first()).subscribe({
      next: tx => {
        if (!tx) {
          // Transaction not found - resolve with error
          cleanup();
          resolve({ errorMessage: 'Transaction not found' });
          return;
        }

        if (tx.status === ITransactionStatus.Completed) {
          cleanup();
          // Never let a throw escape this observer. `cleanup()` has already cleared
          // the timeout, and dexie runs `next` inside its own promise chain — so an
          // exception here settles the wait promise as neither success NOR timeout
          // and the awaiting caller (the Epoch bridge/earn note builders) hangs
          // forever while the activity row reads Completed. The known trigger is a
          // row marked Completed by a post-submit failure path with no
          // `resultBytes`; `isResultAwaitingRow` in `transaction/index.ts` now
          // Fails those rows instead, and this is the backstop for any other route
          // to a result-less Completed row.
          try {
            if (!tx.resultBytes) {
              // A landed write (#1233) reaches here with its id recorded: the network accepted it and
              // only the local apply failed. It stays an error, since no output exists to return, but
              // says so, or a dApp reading "not sent" asks the user to sign and pay again.
              resolve({
                errorMessage: tx.transactionId
                  ? `Transaction ${tx.transactionId} was accepted by the network, but its result is not available`
                  : 'Transaction completed without a transaction result'
              });
              return;
            }
            const txResult = TransactionResult.deserialize(tx.resultBytes);
            // The kernel's fee note is an output note too, and this array is the wallet's
            // PUBLIC dApp API (`window.miden.waitForTransaction`). Handing it out unsplit
            // invited the very bug this module's siblings were hardened against: a site
            // doing `outputNotes[0]` -- the obvious "the note my transaction created" --
            // would get the fee note whenever the kernel ordered it first, and every site
            // reading `.length` counted one note too many. Silent at fee 0, since the
            // kernel skips the fee branch entirely.
            const { userNotes } = splitExecutedOutputNotes(txResult.executedTransaction());
            const res = {
              txHash: tx.transactionId!,
              outputNotes: userNotes
                .map(no => no.intoFull())
                .filter(no => !!no)
                .map(fullNote => u8ToB64(fullNote.serialize()))
            };
            resolve(res);
          } catch (err) {
            resolve({ errorMessage: err instanceof Error ? err.message : String(err) });
          }
        } else if (tx.status === ITransactionStatus.Failed) {
          cleanup();
          resolve({ errorMessage: tx.error || 'Transaction failed' });
        }
      },
      error: err => {
        cleanup();
        resolve({ errorMessage: err?.message || 'Subscription error' });
      }
    });
  });
};
