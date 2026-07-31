import { ITransactionStage } from '../db/types';

/**
 * User-facing error messages persisted on `ITransaction.error` (surfaced in
 * the history row / details view). Keep every failure-reason string here so
 * the copy stays in one place.
 */
export const REMOTE_PROVER_FAILED_ERROR =
  'Remote prover failed — this is most often caused by a timeout. Please try again.';

export const LOCAL_PROVER_FAILED_ERROR = 'Local proving failed — please try again.';

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
  // A failure at the prove step: Guardian txs stamp an explicit 'proving'
  // stage; non-Guardian txs surface a prover timeout under the broad 'sending'
  // stage. Attribute it to the prover that actually ran — remote when the tx
  // delegated proving, local/native (on-device) otherwise. The old copy always
  // blamed the "remote prover", which became wrong once local proving shipped:
  // a failed on-device prove was misreported as a remote timeout.
  const isProveFailure =
    stage === 'proving' || (stage != null && PROVING_STAGES.includes(stage) && /timeout/i.test(raw));
  if (isProveFailure) {
    return delegateTransaction ? REMOTE_PROVER_FAILED_ERROR : LOCAL_PROVER_FAILED_ERROR;
  }
  return raw;
}
