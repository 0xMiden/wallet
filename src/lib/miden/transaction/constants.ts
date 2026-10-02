import { isGuardianUnreachableError } from 'lib/miden/guardian/direct-switch';
import { isGuardianRequestTimeout } from 'lib/miden/guardian/serialize';

import { isOperationAbortedError } from '../back/offscreen-codec';
import {
  IBridgedSendExtraInputs,
  ITransaction,
  ITransactionStage,
  ITransactionStatus,
  STRUCTURAL_GUARDIAN_TYPES
} from '../db/types';
import { causeChain, isKilledPipeline } from '../sdk/sdk-error-code';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';

/**
 * User-facing error messages persisted on `ITransaction.error` (surfaced in
 * the history row / details view). Keep every failure-reason string here so
 * the copy stays in one place.
 */
// Shown ONLY for a stage-'proving' delegated failure, which is provably
// pre-submit (submit runs after the 'submitting' stage), so the "no funds moved"
// guarantee is real.
export const REMOTE_PROVER_FAILED_ERROR =
  'The proving service was temporarily unavailable, so the transaction could not be completed. No funds moved — please try again in a moment.';

// Shown for a delegated timeout under the broad non-Guardian 'sending' stage,
// which runs execute→prove→submit as one call — so a timeout there CANNOT be
// pinned to pre-submit. Deliberately does NOT claim funds are safe (#419 review).
export const REMOTE_PROVER_TIMEOUT_ERROR =
  'The proving service timed out. The transaction may not have completed — check your balance before trying again.';

export const LOCAL_PROVER_FAILED_ERROR = 'Local proving failed — please try again.';

export const PROVER_PROCEDURE_MISMATCH_ERROR =
  'Proving failed because the prover does not recognize part of this transaction — the app and its prover are out of sync. Update to the latest version; retrying this version will not help.';

export const USER_CANCELLED_TRANSACTION_REASON = 'Transaction was cancelled by user';

/**
 * The request reached the kernel without the fee conversion info `fee::pay_fee`
 * needs, so the fee could not be charged at all.
 *
 * NOT a balance problem, and the distinction matters: this says nothing about
 * what the account holds, so telling the user to "receive some MIDEN" sends them
 * to top up an account that is very likely already funded, and topping it up
 * changes nothing. A genuine shortfall arrives as a vault assertion and gets
 * `TRANSACTION_VAULT_SHORTFALL_ERROR` instead.
 *
 * What it actually means is that whoever BUILT the request did not commit
 * conversion info into its auth args. On a multisig account the client cannot
 * inject that -- the auth-arg slot belongs to the multisig -- so the request has
 * to carry it, and a request built elsewhere may not.
 *
 * The flows that produce request bytes before any proposal is created -- Epoch
 * bridged-send and earn-deposit (`buildEpochCollateralRequestBytes`), AggLayer
 * bridged-send (`initiateB2AggBridge`) and the swap's PSWAP note
 * (`buildPswapCreateRequest`) -- declare a fee conversion SALT at BUILD time, each
 * taking it as a `feeSalt` argument. miden-client derives the native 1/1 conversion
 * info from the execution reference header and commits it into the auth arg itself.
 *
 * It has to be the build, not the finished request: the SDK exposes only a getter
 * for the auth arg on `TransactionRequest`, deliberately, because miden-client keeps
 * it mutually exclusive with the fee conversion salt and enforces that on the builder.
 * A finished request also cannot be rebuilt into one -- its readers cover neither
 * input notes nor the script, and `serialize()` is not canonical, so a rebuild could
 * neither carry everything forward nor prove that it did.
 *
 * A dApp `execute` is the one flow whose bytes the wallet does not build, so it
 * commits nothing and cannot pay a fee on a fee-charging chain.
 *
 * So this message means no conversion info reached the kernel. That happens when the
 * request declared no salt, or when the account's auth component is one miden-client
 * cannot classify and so declines to commit for -- a guarded multisig deployed before
 * guardian 0.17.0-rc.3 is exactly that case. Not an exhaustive
 * list, and the module is the place to read for the current one.
 *
 * What they share is that a retry can plausibly help, so the copy does NOT forbid
 * one -- an earlier version did, from when no retry could have.
 */
export const TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR =
  'This transaction could not be set up to pay the network fee, so nothing was submitted. Your balance is not ' +
  'the problem — try again, and report this if it keeps happening.';

export const TRANSACTION_STUCK_ERROR = 'Transaction took too long to process and was cancelled';

export const TRANSACTION_EXPIRED_ERROR = 'Transaction expired after being queued too long';

export const TRANSACTION_INTERRUPTED_ERROR = 'Transaction was interrupted';

// The cold-start sweep reason (failInterruptedTransactions). Special-cased in
// cancelTransaction so a tx interrupted while its stage was 'proving' is NOT
// relabelled as a prover failure ("please try again") — which would invite the
// retry the cold-start sweep deliberately avoids (submit() may already be on chain).
export const TRANSACTION_INTERRUPTED_ON_STARTUP = 'Transaction was interrupted when the browser closed';

export const INVALID_NOTE_ERROR = 'Note is invalid';

// Thrown before anything is minted: only the bytes built at initiate carry the mandate binding, and a note built
// without it is one the allocator refuses to bind.
export const EARN_DEPOSIT_MISSING_REQUEST_ERROR =
  'Earn deposit has no collateral request with its mandate binding, so it was not sent.';

export const TRANSACTION_FORCE_CANCELLED_ERROR = 'Transaction force-cancelled for debugging';

/**
 * Final reasons the wallet itself passes to `cancelTransaction` as copy, stored as the row's error with no
 * `rawError`, whatever the row's stage: the wallet has proved the row can never land, so the reason is shown
 * as a completed failure. A Queued row that expired before it ever started, and a note that can never be
 * consumed, both qualify unconditionally. User cancel does not: it goes through
 * `cancelWhilePipelineMayStillRun`, which stops no pipeline, so it is final only while the row's write stamp
 * (`processingStartedAt`) is unset. A reader that keeps that field must gate this one member on it rather than
 * treat membership here as sufficient by itself (see `describeRotationFailure`).
 */
export const WALLET_FAILURE_REASONS: ReadonlySet<string> = new Set([
  USER_CANCELLED_TRANSACTION_REASON,
  TRANSACTION_EXPIRED_ERROR,
  INVALID_NOTE_ERROR
]);

export const isWalletFailureReason = (text: string): boolean => WALLET_FAILURE_REASONS.has(text);

/**
 * Reasons a writer sets on a row without proving the pipeline stopped before its submit, stored as the row's
 * error with no `rawError`, same as {@link WALLET_FAILURE_REASONS}, but the row's outcome is unknown rather
 * than failed, so a reader shows it as not confirmed instead of as a completed failure: the stuck reaper (the
 * pipeline it cancels keeps running), the cold-start sweep (its own docs say the row may already be on chain),
 * `verifyStuckTransactions`' not-landed arm (it fails a consume still in progress without stopping it), and the
 * debug force-cancel (same shape as the reaper).
 */
export const UNCONFIRMED_FAILURE_REASONS: ReadonlySet<string> = new Set([
  TRANSACTION_STUCK_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  TRANSACTION_INTERRUPTED_ERROR,
  TRANSACTION_FORCE_CANCELLED_ERROR
]);

export const isUnconfirmedFailureReason = (text: string): boolean => UNCONFIRMED_FAILURE_REASONS.has(text);

/**
 * True for a Failed row whose outcome cannot be told apart from "may still land" - the one
 * predicate both readers of a failed row share (the rotation gate's `describeRotationFailure`
 * and Activity History), so a row never reads confirmed-failed in one and not-confirmed in the
 * other (#1250). True when `mayHaveSubmitted` is set, the row's `error` is the engine-recovered
 * copy, its reason (`rawError ?? error`) is a member of {@link UNCONFIRMED_FAILURE_REASONS}, or
 * the reason is a user cancel that reached the write stamp (`processingStartedAt` set) - see
 * {@link WALLET_FAILURE_REASONS} for why an unstamped cancel is final rather than unconfirmed.
 * False whenever {@link isVaultShortfallRow} holds, even with `mayHaveSubmitted` set: a
 * rotation moves no asset, so a fee shortfall is a definite failure, not an unknown outcome.
 * False whenever {@link isBridgeRouteFailedRow} holds too: a bridged-send its own route
 * evidence (the allocator or the fill poll) reports failed is settled by that, not unknown.
 * And whenever {@link isNodeDiscardedRow} holds: a structural write the node discarded never lands.
 */
export function isUnconfirmedFailure(
  row: Pick<ITransaction, 'type' | 'status' | 'error' | 'rawError' | 'mayHaveSubmitted' | 'processingStartedAt'> &
    Partial<Pick<ITransaction, 'extraInputs'>>
): boolean {
  if (row.status !== ITransactionStatus.Failed) return false;
  // A vault shortfall is provable straight from the error, so it stays a definite failure.
  if (isVaultShortfallRow(row)) return false;
  // Same reasoning for a bridge its own route evidence proves the allocator or fill rejected.
  if (isBridgeRouteFailedRow(row)) return false;
  if (isNodeDiscardedRow(row)) return false;
  const reason = row.rawError ?? row.error;
  return (
    row.mayHaveSubmitted === true ||
    row.error === TRANSACTION_ENGINE_RECOVERED_ERROR ||
    (reason !== undefined && isUnconfirmedFailureReason(reason)) ||
    (row.processingStartedAt !== undefined && reason !== undefined && isUserCancelledTransaction(reason))
  );
}

/**
 * Refusal reason for a Retry the wallet cannot prove is safe. Surfaced verbatim
 * by the two retry footers (they render `error.message`).
 */
export const TRANSACTION_RETRY_UNSAFE_ERROR =
  'This transaction may already have been submitted, so it cannot be retried automatically. ' +
  'Check your activity once it syncs, and start a new one only if it never arrived.';

/**
 * A lock-recovery eviction (issue #775). Deliberately hedged: recovery ABANDONS
 * the operation rather than cancelling it, so the pipeline may still be running
 * and may still submit. Every stage-based message below would claim more than
 * that — a 'proving' eviction would otherwise render as "No funds moved", which
 * is a promise the wallet cannot keep here.
 */
export const TRANSACTION_ENGINE_RECOVERED_ERROR =
  'The wallet had to recover its transaction engine, so this transaction was left in an unknown state. ' +
  'Check your activity once it syncs before trying again.';

/**
 * True when a Failed row's `submit()` outcome cannot be ruled out from local
 * state — i.e. "did this already reach the node?" is unanswerable here.
 *
 * ONE durable, in-realm signal decides it: `processingStartedAt`, stamped
 * atomically with the Queued → GeneratingTransaction transition by the service
 * worker's / driver's own ordered write, and never replayed across the offscreen
 * bus. Its ABSENCE proves the row never left the queue, so nothing was executed,
 * let alone submitted. Its PRESENCE proves nothing either way — which is the
 * whole point: the answer is then UNKNOWN, and a caller that moves funds must
 * treat it as "may already have landed".
 *
 * This used to ENUMERATE the failure reasons written by the routes that kill a
 * row from OUTSIDE its own write pipeline (the stuck reaper, the cold-start
 * sweep, a force-cancel, a user Cancel, an offscreen deadline kill) and let every
 * other reason through as safe. That was fail-OPEN, because a write can also fail
 * from INSIDE its own pipeline AFTER `submit()` has landed, and such a failure
 * carries an arbitrary error string that matches no entry. Under
 * `MIDEN_USE_OFFSCREEN_CLIENT` (the service worker's default, i.e. shipped
 * Chrome) that is reachable three ways: the offscreen document going away right
 * after a multi-second prove rejects `chrome.runtime.sendMessage`, and both
 * `getWasmOrThrow()` and `TransactionResult.deserialize(...)` in
 * `dispatchOffscreenWrite` run only AFTER the offscreen write reported success.
 * Each left a landed send one tap away from a second submit.
 *
 * Deliberately NOT keyed on `tx.stage`: under `MIDEN_USE_OFFSCREEN_CLIENT` a
 * non-guardian write runs in the offscreen realm and its stage stamps come back
 * as TELEMETRY only, so a dropped stamp must never be able to widen this gate.
 */
export function isSubmitOutcomeUnknown(tx: { processingStartedAt?: number }): boolean {
  // Never left the queue → nothing was executed, let alone submitted.
  return tx.processingStartedAt !== undefined;
}

export const isUserCancelledTransaction = (error: unknown): boolean => error === USER_CANCELLED_TRANSACTION_REASON;

/**
 * Stages during which the (remote) prover can be the thing that failed:
 * Guardian txs stamp an explicit 'proving' stage; non-Guardian txs run the
 * whole execute→prove→submit SDK pipeline under the broad 'sending' stage,
 * so there a prover timeout surfaces with the stage still at 'sending'.
 */
const PROVING_STAGES: ITransactionStage[] = ['proving', 'sending'];

/** The raw `name: message` string persisted on `ITransaction.rawError`. */
export function formatRawTransactionError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Walk `cause`. Several wrappers in this pipeline say "see the cause chain" in
  // their own message -- `WasmClientPoisonedError` among them -- while every
  // consumer printed only the outermost frame, so the sentence pointed at
  // something nothing rendered. A WASM trap arrives as a bare `RuntimeError`
  // whose only identifying detail lives one or two links down; without this a
  // guardian send failure reads as "uncaught realm error" and names neither the
  // call that trapped nor the reason.
  const parts: string[] = [];
  for (const link of causeChain(error)) {
    if (parts.length >= 5) break;
    let isError = false;
    // Guarded like the walk: `name` and `message` can be accessors, and this runs on the failure path, where a throw
    // loses the failure being recorded.
    try {
      if (link instanceof Error) {
        isError = true;
        parts.push(`${link.name}: ${link.message}`);
      } else if (link !== undefined) {
        parts.push(String(link));
      }
    } catch {
      // An unreadable link costs its own text, not the links below it.
    }
    if (!isError) break;
  }
  return parts.join(' <- caused by ');
}

/**
 * A deterministic native-prover failure where the on-device prover is missing a
 * kernel procedure the transaction needs — a version/artifact mismatch between
 * the packaged prover and the transaction kernel, NOT a transient outage. The
 * native prover surfaces this as `… procedure with root digest 0x… could not be
 * found` (often prefixed `MidenNativeProver:`). Because retrying the same build
 * re-fails identically, this must not be relabelled as a "please try again"
 * prover timeout, which would both mislead the user and hide the mismatch (#487).
 */
export function isProverProcedureMismatch(error: unknown): boolean {
  const raw = formatRawTransactionError(error);
  return /procedure with root digest/i.test(raw) && /could not be found/i.test(raw);
}

/**
 * A lock-recovery eviction or an offscreen kill that provably landed BEFORE the row
 * built a write — `cancel.ts` derives that from the committed stage plus an unstamped
 * `processingStartedAt`, and refuses to record a may-have-submitted crossing for it.
 *
 * Kept distinct from the hedged copy above because "left in an unknown state, check your
 * activity" is false here and the falsehood costs the user something: the row it lands
 * on is one Retry can safely repeat, and the message talks them out of it. The extension
 * reaches this on a routine `deadline-no-kill` — a non-critical sync deadline that
 * deliberately kills nothing — so it is not a rare shape.
 */
export const TRANSACTION_ENGINE_RECOVERED_PRE_WRITE_ERROR =
  'The wallet had to recover its transaction engine before this transaction was prepared, so nothing was ' +
  'submitted. Please try again.';

/**
 * Map a raw thrown error (+ the stage the transaction failed in) to the
 * message persisted on `ITransaction.error`. Falls back to the raw
 * `name: message` string when no friendlier mapping applies.
 *
 * `abandonedPreWrite` is the caller's structural finding that an abandonment happened
 * before the row could have submitted; only `cancel.ts` can derive it, since it needs
 * the committed row rather than the stage alone.
 */
/**
 * The kernel's report that a request carried no fee conversion info.
 *
 * The numeric code is `error_code_from_msg("paying a non-zero fee requires
 * conversion info committed via the auth args")` from miden-standards -- it is a
 * stable hash of that message, so matching it is matching the message. Note what
 * the message says: "requires conversion info", not "insufficient balance". Only
 * reachable when the fee is NON-ZERO, which is why a zero-fee chain never sees it.
 */
export const ERR_FEE_CONVERSION_INFO_MISSING_CODE = '14712559985122731094';

export function isFeeConversionInfoMissingError(raw: string): boolean {
  return raw.includes(ERR_FEE_CONVERSION_INFO_MISSING_CODE);
}

/**
 * The remove-asset assertion below by its numeric code, which is all a failed local
 * execution reports (`assertion failed with error code: ...`): an unfunded account's
 * rotation failed in exactly that form and was never classified (#805).
 *
 * `ERR_VAULT_FUNGIBLE_ASSET_AMOUNT_LESS_THAN_AMOUNT_TO_WITHDRAW` in miden-protocol 0.16.1
 * (`asm/kernels/transaction-core/src/fungible_asset.masm`). Derived like the
 * conversion-info code above: the first 8 bytes, little-endian, of blake3 of the
 * message, so matching the code is matching the message.
 */
export const ERR_VAULT_FUNGIBLE_ASSET_AMOUNT_LESS_THAN_AMOUNT_TO_WITHDRAW_CODE = '644413868907058392';

/**
 * The kernel's generic remove-asset assertion, which says a vault held less of some
 * asset than the transaction tried to take out — but NOT which asset.
 *
 * Deliberately NOT treated as a fee failure. The fee is one producer, but
 * `resolveHeldFungibleAsset` (`sdk/helpers.ts`) documents two others and warns about
 * both: a faucet with no local vault slot (usually stale local state, not a real
 * shortfall) and a balance split across callback flags, where no single slot can fund
 * an amount the total covers. Attributing all three to the fee told a user holding
 * plenty of MIDEN to "Receive some MIDEN", and asserted the failure was deterministic
 * — which talked them out of the resync/retry that fixes the stale-state case.
 */
export function isVaultShortfallError(raw: string): boolean {
  return (
    /amount of the asset in the vault is less than the amount to remove/i.test(raw) ||
    raw.includes(ERR_VAULT_FUNGIBLE_ASSET_AMOUNT_LESS_THAN_AMOUNT_TO_WITHDRAW_CODE)
  );
}

/**
 * An asset the transaction tried to move was not available in full, without claiming
 * WHICH one. Names both candidates rather than guessing, and does not forbid a retry:
 * the local-vault-view case is one a fresher sync genuinely resolves.
 */
export const TRANSACTION_VAULT_SHORTFALL_ERROR =
  'The transaction could not be completed because an asset it moves was not available in full — either the ' +
  'amount sent, or the MIDEN for the network fee. Check your balances once the wallet has synced, then try again.';

/**
 * An everyday-key rotation that failed because the account could not pay its fee. A
 * rotation moves no asset, so on this row type the only withdrawal that can fall short
 * is the fee. A row a build without the code match failed keeps the raw kernel line as
 * `error` and has no `rawError`, hence the fallback read.
 */
export function isVaultShortfallRow(row: Pick<ITransaction, 'type' | 'status' | 'error' | 'rawError'>): boolean {
  if (row.type !== 'replace-hot-key' || row.status !== ITransactionStatus.Failed) return false;
  if (row.error === TRANSACTION_VAULT_SHORTFALL_ERROR) return true;
  const raw = row.rawError ?? row.error;
  return raw !== undefined && isVaultShortfallError(raw);
}

/**
 * True for a Failed `bridged-send` whose own route evidence proves the allocator rejected the
 * intent, or the fill itself failed - `extraInputs.epochStatus === 'failed'`. That is what
 * `markBridgedSendFailed` writes when the allocator rejects an intent whose note already
 * committed (funds reclaimable), and what the Epoch fill poll persists when the allocator
 * reports the fill failed (#1250).
 */
export function isBridgeRouteFailedRow(
  row: Pick<ITransaction, 'type' | 'status'> & Partial<Pick<ITransaction, 'extraInputs'>>
): boolean {
  if (row.type !== 'bridged-send' || row.status !== ITransactionStatus.Failed) return false;
  const extraInputs: Partial<IBridgedSendExtraInputs> | undefined = row.extraInputs;
  return extraInputs?.epochStatus === 'failed';
}

/**
 * True for a Failed structural Guardian row (`STRUCTURAL_GUARDIAN_TYPES`) the node discarded:
 * `extraInputs.nodeDiscarded`, which `cancelTransaction` writes in the write that fails the row when
 * the error is the node's discard (#1233). A set `mayHaveSubmitted` does not make such a row unknown:
 * the write did submit, but a discarded write never lands.
 */
export function isNodeDiscardedRow(
  row: Pick<ITransaction, 'type' | 'status'> & Partial<Pick<ITransaction, 'extraInputs'>>
): boolean {
  if (row.status !== ITransactionStatus.Failed || !STRUCTURAL_GUARDIAN_TYPES.includes(row.type)) return false;
  const extraInputs: { nodeDiscarded?: boolean } | undefined = row.extraInputs;
  return extraInputs?.nodeDiscarded === true;
}

/** A consume for an account whose everyday key is not active yet, other than the gate's own claim (#805). */
export const ROTATION_PENDING_CONSUME_ERROR =
  "This account's everyday key has to be activated before it can claim transfers. Open the wallet to finish " +
  'activating it.';

/** The gate's claim named a note the account no longer lists as consumable. */
export const ROTATION_FUNDING_NOTE_UNAVAILABLE_ERROR =
  'This transfer is no longer available to claim. It may have been claimed on another device.';

/**
 * The gate's claim named a note holding anything the wallet cannot prove is the native asset, or one
 * that is not a standard P2ID or P2IDE payment.
 */
export const ROTATION_FUNDING_NON_NATIVE_ERROR =
  'The wallet stopped this claim because it could not confirm that the transfer holds only MIDEN.';

/**
 * A consume the wallet refused before building anything. The message IS the row's text,
 * so it is matched by identity ahead of every reading of a raw cause: the row's message,
 * and the outage verdict that would have #779's arm retry it until it expired.
 */
export class RotationGateConsumeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RotationGateConsumeRefusal';
  }
}

// Hedged: the proposal stages call the node as well as the guardian.
export const GUARDIAN_UNREACHABLE_ERROR =
  'The guardian or the Miden network could not be reached, so this transaction was not sent. Your funds are safe; ' +
  'try again in a moment.';

/**
 * The guardian, or the node the proposal stages also call, gave no usable answer, and the failure is none of the
 * readings the classifier ranks above an outage. A guardian 5xx can carry a deterministic kernel failure (a prover
 * procedure mismatch, the missing fee conversion info, a vault shortfall) that fails the same way on every retry, so
 * the requeue arm and the classifier both ask this rather than the transport verdict alone. A killed pipeline anywhere
 * in the cause chain is never an outage; otherwise a Guardian request timeout anywhere in the chain always is, ahead of
 * the kernel-failure exclusions, because a cut-off request carries no answer and so no kernel failure.
 */
export function isGuardianOutage(error: unknown): boolean {
  if (error instanceof RotationGateConsumeRefusal) return false;
  // A killed pipeline stays a kill at any depth: a requeue would re-broadcast it and the copy would say it was not
  // sent (#1313).
  if (isKilledPipeline(error)) return false;
  // The fetch boundary's cut-off is the Guardian not answering wherever a caller wrapped it, which the message check
  // below cannot see.
  if (isGuardianRequestTimeout(error)) return true;
  if (!isGuardianUnreachableError(error) || isProverProcedureMismatch(error)) return false;
  const raw = formatRawTransactionError(error);
  return !isFeeConversionInfoMissingError(raw) && !isVaultShortfallError(raw);
}

function classifyTransactionError(
  error: unknown,
  raw: string,
  stage?: ITransactionStage,
  delegateTransaction?: boolean,
  abandonedPreWrite?: boolean
): string {
  // A lock-recovery eviction is checked FIRST because every mapping below reads
  // the stage, and the stage is exactly what an eviction makes unreliable: it
  // says where the pipeline was when its caller was rejected, not where the
  // still-running pipeline got to (issue #775).
  // BOTH kill shapes. An offscreen deadline kill arrives as `OperationAbortedError`
  // from the identical point and is equally still running, and `cancel.ts` stamps
  // `mayHaveSubmitted` for both — so leaving abort out put "No funds moved — please
  // try again" on the very row whose Retry then refuses with "may already have been
  // submitted". Two contradictory statements about the same money, from one error.
  if (isWasmClientPoisonedError(error) || isOperationAbortedError(error)) {
    return abandonedPreWrite === true
      ? TRANSACTION_ENGINE_RECOVERED_PRE_WRITE_ERROR
      : TRANSACTION_ENGINE_RECOVERED_ERROR;
  }
  if (error instanceof RotationGateConsumeRefusal) {
    return error.message;
  }
  // A deterministic native-prover procedure-set mismatch (version/artifact skew)
  // keeps its real cause instead of being flattened into a transient remote
  // timeout: the automatic remote→native fallback can turn a genuine mismatch
  // into a misleading "Remote prover failed — please try again", hiding it and
  // inviting a retry that only re-fails on the same build (#487).
  if (isProverProcedureMismatch(error)) {
    return PROVER_PROCEDURE_MISMATCH_ERROR;
  }
  // A failure at the prove step: Guardian txs stamp an explicit 'proving'
  // stage; non-Guardian txs surface a prover timeout under the broad 'sending'
  // stage. Attribute it to the prover that actually ran — remote when the tx
  // delegated proving, local/native (on-device) otherwise. The old copy always
  // blamed the "remote prover", which became wrong once local proving shipped:
  // a failed on-device prove was misreported as a remote timeout.
  // Guardian txs stamp an explicit 'proving' stage BEFORE submit, so a failure
  // there is provably pre-submit — safe to reassure "no funds moved".
  if (stage === 'proving') {
    return delegateTransaction ? REMOTE_PROVER_FAILED_ERROR : LOCAL_PROVER_FAILED_ERROR;
  }
  // Non-Guardian txs surface a prover timeout under the broad 'sending' stage,
  // which spans execute→prove→submit — so we can't guarantee pre-submit. Use the
  // hedged timeout copy for the remote case rather than a false safety claim.
  if (stage != null && PROVING_STAGES.includes(stage) && /timeout/i.test(raw)) {
    return delegateTransaction ? REMOTE_PROVER_TIMEOUT_ERROR : LOCAL_PROVER_FAILED_ERROR;
  }
  // Deterministic: the request itself is missing the conversion-info commitment,
  // so the same bytes will fail identically no matter how the balance moves.
  // Naming it stops the UI offering a Retry that cannot succeed — and stops it
  // blaming a balance that is not involved.
  if (isFeeConversionInfoMissingError(raw)) {
    return TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR;
  }
  // Checked AFTER the conversion-info code, since that one is the more specific
  // reading of an assertion this one deliberately declines to attribute.
  if (isVaultShortfallError(raw)) {
    return TRANSACTION_VAULT_SHORTFALL_ERROR;
  }
  // Proposal creation and co-signing are pre-submit, so nothing moved. A requeueable transfer never gets here (the
  // pipeline requeues it, #779); this names the failure for the operations that still end on it.
  if ((stage === 'creating-proposal' || stage === 'signing-proposal') && isGuardianOutage(error)) {
    return GUARDIAN_UNREACHABLE_ERROR;
  }
  return raw;
}

export function resolveTransactionErrorMessage(
  error: unknown,
  stage?: ITransactionStage,
  delegateTransaction?: boolean,
  abandonedPreWrite?: boolean
): string {
  const raw = formatRawTransactionError(error);
  const message = classifyTransactionError(error, raw, stage, delegateTransaction, abandonedPreWrite);
  // Keep the raw failure reachable in logs whenever a mapping replaces it. The
  // friendly copy is deliberately non-technical, so a mapped error otherwise
  // erases the only detail that identifies it -- which procedure root a prover
  // could not resolve, which limb overflowed, which stage the kernel aborted in.
  // The stored row and the UI still show `message`; this costs one log line and
  // is the difference between a diagnosable failure and a shrug.
  if (message !== raw) {
    console.warn('[transaction] error classified, raw cause:', raw);
  }
  return message;
}
