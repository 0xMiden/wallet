import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { carriesIndefiniteSubmitOutcome, isApplyAfterSubmitError } from 'lib/miden/sdk/sdk-error-code';
import { SUBMIT_UNKNOWN_OUTCOME_STATUSES, submitGrpcFailure } from 'lib/telemetry/transaction-failure';
import type { SubmissionFeedbackBranch } from 'lib/telemetry/ui-producer-diagnostics';

import {
  hasUnresolvedAttempt,
  isAccountBlockedError,
  isOutcomeUnconfirmed,
  isUnconfirmedFailure,
  isUserCancelledTransaction,
  REMOTE_PROVER_FAILED_ERROR,
  TRANSACTION_ENGINE_RECOVERED_ERROR,
  TRANSACTION_INTERRUPTED_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  TRANSACTION_STUCK_ERROR
} from './constants';
import { keptCandidateHoldUntil, nowSeconds } from './verdict-rules';

export type SubmissionFeedbackKind = 'rejected' | 'interrupted' | 'unanswered';

export type SubmissionMessageKey =
  | 'submissionRejectedByNetwork'
  | 'submissionRejectedByGuardian'
  | 'submissionBlockedByIssuer'
  | 'submissionInterrupted'
  | 'submissionUnanswered';

export interface SubmissionFeedback {
  submissionFeedbackBranch?: SubmissionFeedbackBranch;
  kind: SubmissionFeedbackKind;
  messageKey: SubmissionMessageKey;
  /** A sentence the row already stored, shown in place of the category line. */
  rowCopy?: string;
  /** The stored client, RPC, or Guardian text, for the existing full-error disclosure. */
  details?: string;
}

type FeedbackRow = Pick<ITransaction, 'status' | 'stage' | 'error' | 'rawError'>;

const NETWORK_DROP =
  /failed to fetch|load failed|networkerror|network error|connection refused|connection reset|econnreset|err_internet_disconnected|\boffline\b/i;

const UNKNOWN_OUTCOME: ReadonlySet<string> = new Set(SUBMIT_UNKNOWN_OUTCOME_STATUSES);

// Telemetry's submit-request extraction and gRPC table, so the miden-client prefixes are listed once.
const grpcKind = (text: string): 'refused' | 'unknown' | 'pre-submit' | undefined => {
  const failure = submitGrpcFailure(text);
  if (failure === undefined) return undefined;
  if (failure.endpoint === 'get_transaction_encryption_key' && UNKNOWN_OUTCOME.has(failure.status)) return 'pre-submit';
  return UNKNOWN_OUTCOME.has(failure.status) ? 'unknown' : 'refused';
};

const guardianKind = (text: string): 'rejected' | 'unanswered' | undefined => {
  const status = /GUARDIAN HTTP error (\d{3})/.exec(text)?.[1];
  if (status === undefined) {
    return /Guardian request to \S+ timed out after \d+ ms/.test(text) ? 'unanswered' : undefined;
  }
  const code = Number(status);
  if (code === 408 || code === 409 || code >= 500) return 'unanswered';
  if (code >= 400) return 'rejected';
  return 'unanswered';
};

const isNoAnswer = (text: string): boolean =>
  text === TRANSACTION_STUCK_ERROR ||
  text === TRANSACTION_INTERRUPTED_ERROR ||
  text === TRANSACTION_INTERRUPTED_ON_STARTUP ||
  text === TRANSACTION_ENGINE_RECOVERED_ERROR ||
  carriesIndefiniteSubmitOutcome(text) ||
  /timed out|timeout|deadline exceeded/i.test(text);

const pack = (kind: SubmissionFeedbackKind, messageKey: SubmissionMessageKey, raw: string): SubmissionFeedback => ({
  kind,
  messageKey,
  ...(raw !== '' ? { details: raw } : {})
});

/**
 * Copy for a consume that already finished its submit attempt. An in-progress row stays on the
 * existing spinner: the wait is the request deadline the client, RPC, or Guardian already uses.
 * A completed row, including one whose local apply failed after the node accepted it, stays on
 * the success path. Checking this never submits, and it never starts a timer of its own.
 */
export function submissionFeedback(row: FeedbackRow | undefined): SubmissionFeedback | undefined {
  if (row === undefined) return undefined;
  if (row.status !== ITransactionStatus.Failed && row.status !== ITransactionStatus.Unconfirmed) return undefined;
  if (isUserCancelledTransaction(row.error) || isUserCancelledTransaction(row.rawError)) return undefined;
  if (isApplyAfterSubmitError(row.rawError ?? row.error)) return undefined;

  const raw = (row.rawError ?? row.error ?? '').trim();
  const display = (row.error ?? raw).trim();
  const prose = `${raw}\n${display}`;
  const classified = grpcKind(raw) ?? (raw === display ? undefined : grpcKind(display));
  const guardian = guardianKind(raw) ?? (raw === display ? undefined : guardianKind(display));

  // A proving failure keeps its existing sentence. At submit, that sentence would claim no funds
  // moved, which this screen cannot know.
  if (display === REMOTE_PROVER_FAILED_ERROR || raw === REMOTE_PROVER_FAILED_ERROR) {
    return row.stage === 'submitting'
      ? { ...pack('unanswered', 'submissionUnanswered', raw), submissionFeedbackBranch: 'prover_at_submit' }
      : undefined;
  }
  // Ahead of the generic refusal: the node's answer can carry this code, and the issuer's block is the cause.
  if (isAccountBlockedError(prose)) return pack('rejected', 'submissionBlockedByIssuer', raw);
  if (guardian === 'rejected') return pack('rejected', 'submissionRejectedByGuardian', raw);
  if (guardian === 'unanswered')
    return { ...pack('unanswered', 'submissionUnanswered', raw), submissionFeedbackBranch: 'guardian_unanswered' };
  if (classified === 'refused') return pack('rejected', 'submissionRejectedByNetwork', raw);
  if (classified === 'unknown')
    return { ...pack('unanswered', 'submissionUnanswered', raw), submissionFeedbackBranch: 'grpc_unknown' };
  if (classified === 'pre-submit') return undefined;

  const dropped = NETWORK_DROP.test(prose);
  const noAnswer = isNoAnswer(raw) || isNoAnswer(display);
  if (dropped && (row.stage === 'submitting' || /failed to submit /i.test(prose))) {
    return pack('interrupted', 'submissionInterrupted', raw);
  }
  if (noAnswer && (row.stage === 'submitting' || carriesIndefiniteSubmitOutcome(prose))) {
    return { ...pack('unanswered', 'submissionUnanswered', raw), submissionFeedbackBranch: 'no_answer' };
  }
  // An error no category recognizes gets no verdict: the row keeps its existing failed or not-confirmed copy.
  return undefined;
}

type FinishedRow = FeedbackRow & Parameters<typeof isOutcomeUnconfirmed>[0];

// The rotation gate reads these through `isUnconfirmedFailure` and offers no Retry on that reading, so Activity follows.
const readByRotationGate = (row: FinishedRow): boolean =>
  row.type === 'replace-hot-key' || row.rotationFunding === true;

/**
 * Whether a finished row reads Not confirmed, the one rule every surface shares (#2060). A stored timeout, drop or
 * missing answer does, including on a Failed row. A stored refusal does while an attempt is unresolved: a refusal past
 * the crossing cannot be told from a lost answer, which is why the leaf keeps its candidate, so only the reconciler can
 * rule the attempt dead. With nothing left to judge the refusal is the row's outcome, whatever the node said.
 */
export function readsAsNotConfirmed(row: FinishedRow): boolean {
  const feedback = submissionFeedback(row);
  if (feedback === undefined) return isOutcomeUnconfirmed(row);
  return (
    feedback.kind !== 'rejected' || hasUnresolvedAttempt(row) || (readByRotationGate(row) && isUnconfirmedFailure(row))
  );
}

/**
 * The stored outcome a surface may show (#2060). A refusal tells the user to try again, so it is withheld while the row
 * reads Not confirmed and while the Guardian holds the candidate that a retry would meet.
 */
export function shownSubmissionFeedback(
  row: FinishedRow,
  nowSec: number = nowSeconds()
): SubmissionFeedback | undefined {
  const feedback = submissionFeedback(row);
  if (feedback?.kind !== 'rejected') return feedback;
  return readsAsNotConfirmed(row) || keptCandidateHoldUntil(row, nowSec) !== undefined ? undefined : feedback;
}
