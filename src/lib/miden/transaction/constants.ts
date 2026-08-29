import { isOperationAbortedError } from '../back/offscreen-codec';
import { ITransactionStage } from '../db/types';
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
 * to carry it, and a request built elsewhere (a dApp's, or one persisted before
 * the wallet handled fees) may not. See `ensureCustomProposalFeeAuth`. Retrying
 * the same row cannot fix it, so the copy does not invite one.
 */
export const TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR =
  'This transaction could not be set up to pay the network fee, so nothing was submitted. Your balance is not ' +
  'the problem — update the wallet if an update is available, and report this if it keeps happening.';

export const TRANSACTION_STUCK_ERROR = 'Transaction took too long to process and was cancelled';

export const TRANSACTION_EXPIRED_ERROR = 'Transaction expired after being queued too long';

export const TRANSACTION_INTERRUPTED_ERROR = 'Transaction was interrupted';

// The cold-start sweep reason (failInterruptedTransactions). Special-cased in
// cancelTransaction so a tx interrupted while its stage was 'proving' is NOT
// relabelled as a prover failure ("please try again") — which would invite the
// retry the cold-start sweep deliberately avoids (submit() may already be on chain).
export const TRANSACTION_INTERRUPTED_ON_STARTUP = 'Transaction was interrupted when the browser closed';

export const INVALID_NOTE_ERROR = 'Note is invalid';

export const TRANSACTION_FORCE_CANCELLED_ERROR = 'Transaction force-cancelled for debugging';

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
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current) && parts.length < 5) {
    seen.add(current);
    parts.push(`${current.name}: ${current.message}`);
    current = (current as { cause?: unknown }).cause;
  }
  if (current !== undefined && !(current instanceof Error) && parts.length < 5) {
    parts.push(String(current));
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
  return /amount of the asset in the vault is less than the amount to remove/i.test(raw);
}

/**
 * An asset the transaction tried to move was not available in full, without claiming
 * WHICH one. Names both candidates rather than guessing, and does not forbid a retry:
 * the local-vault-view case is one a fresher sync genuinely resolves.
 */
export const TRANSACTION_VAULT_SHORTFALL_ERROR =
  'The transaction could not be completed because an asset it moves was not available in full — either the ' +
  'amount sent, or the MIDEN for the network fee. Check your balances once the wallet has synced, then try again.';

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
