import { ITransactionStage } from '../db/types';

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
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
 * Map a raw thrown error (+ the stage the transaction failed in) to the
 * message persisted on `ITransaction.error`. Falls back to the raw
 * `name: message` string when no friendlier mapping applies.
 */
export function resolveTransactionErrorMessage(
  error: unknown,
  stage?: ITransactionStage,
  delegateTransaction?: boolean
): string {
  const raw = formatRawTransactionError(error);
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
  return raw;
}
