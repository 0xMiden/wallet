import { ITransactionStage } from '../db/types';

/**
 * User-facing error messages persisted on `ITransaction.error` (surfaced in
 * the history row / details view). Keep every failure-reason string here so
 * the copy stays in one place.
 */
export const REMOTE_PROVER_FAILED_ERROR =
  'Remote prover failed — this is most often caused by a timeout. Please try again.';

export const USER_CANCELLED_TRANSACTION_REASON = 'Transaction was cancelled by user';

export const TRANSACTION_STUCK_ERROR = 'Transaction took too long to process and was cancelled';

export const TRANSACTION_EXPIRED_ERROR = 'Transaction expired after being queued too long';

export const TRANSACTION_INTERRUPTED_ERROR = 'Transaction was interrupted';

export const INVALID_NOTE_ERROR = 'Note is invalid';

export const TRANSACTION_FORCE_CANCELLED_ERROR = 'Transaction force-cancelled for debugging';

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
export function resolveTransactionErrorMessage(error: unknown, stage?: ITransactionStage): string {
  const raw = formatRawTransactionError(error);
  if (stage === 'proving') return REMOTE_PROVER_FAILED_ERROR;
  if (stage && PROVING_STAGES.includes(stage) && /timeout/i.test(raw)) return REMOTE_PROVER_FAILED_ERROR;
  return raw;
}
