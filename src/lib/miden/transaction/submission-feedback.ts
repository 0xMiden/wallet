import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { carriesIndefiniteSubmitOutcome, isApplyAfterSubmitError } from 'lib/miden/sdk/sdk-error-code';

import {
  isUserCancelledTransaction,
  REMOTE_PROVER_FAILED_ERROR,
  TRANSACTION_ENGINE_RECOVERED_ERROR,
  TRANSACTION_INTERRUPTED_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  TRANSACTION_STUCK_ERROR
} from './constants';

export type SubmissionFeedbackKind = 'rejected' | 'interrupted' | 'unanswered';

export type SubmissionMessageKey =
  | 'submissionRejectedByNetwork'
  | 'submissionRejectedByGuardian'
  | 'submissionRejectedOnDevice'
  | 'submissionInterrupted'
  | 'submissionUnanswered';

export interface SubmissionFeedback {
  kind: SubmissionFeedbackKind;
  messageKey: SubmissionMessageKey;
  /** A sentence the row already stored, shown in place of the category line. */
  rowCopy?: string;
  /** The stored client, RPC, or Guardian text, for the existing full-error disclosure. */
  details?: string;
}

type FeedbackRow = Pick<ITransaction, 'status' | 'stage' | 'error' | 'rawError'>;

// miden-client 0.17.3 GrpcError Display prefixes for a submit call. The same list lives in
// transaction-failure.ts for crash reports; this copy only decides which sentence to show.
const GRPC_REFUSED = [
  'resource not found',
  'invalid request parameters',
  'permission denied',
  'resource already exists',
  "request was rate-limited or the node's resources are exhausted; retry after a delay",
  'precondition failed',
  'operation was attempted past the valid range',
  'the requested method is not implemented by this version of the Miden node',
  'request was rejected as unauthenticated; check your credentials and connection settings'
] as const;

const GRPC_UNKNOWN = [
  'Miden node is unavailable; check that the node is running and reachable',
  'Miden node returned an internal error; this is likely a node-side issue',
  'operation was cancelled',
  'operation was aborted',
  'unrecoverable data loss or corruption',
  'request to Miden node timed out; the node may be under heavy load',
  'unknown error: '
] as const;

const SUBMIT_REQUEST = /grpc request failed for (?:submit_proven_transaction|submit_proven_batch): /;
const NETWORK_DROP =
  /failed to fetch|load failed|networkerror|network error|connection refused|connection reset|econnreset|err_internet_disconnected|\boffline\b/i;
const TECHNICAL =
  /grpc request failed|failed to submit|GUARDIAN HTTP|Guardian request to |RPC error|transport error|TypeError:|Error:|submission of transaction/i;

const grpcKind = (text: string): 'refused' | 'unknown' | undefined => {
  const match = SUBMIT_REQUEST.exec(text);
  if (match === null) return undefined;
  const kind = text.slice(match.index + match[0].length);
  if (GRPC_REFUSED.some(prefix => kind.startsWith(prefix))) return 'refused';
  if (GRPC_UNKNOWN.some(prefix => kind.startsWith(prefix))) return 'unknown';
  return 'unknown';
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

const submitShaped = (text: string): boolean =>
  grpcKind(text) !== undefined ||
  guardianKind(text) !== undefined ||
  carriesIndefiniteSubmitOutcome(text) ||
  /failed to submit /i.test(text);

const pack = (
  kind: SubmissionFeedbackKind,
  messageKey: SubmissionMessageKey,
  raw: string,
  rowCopy?: string
): SubmissionFeedback => {
  const details = raw !== '' && raw !== rowCopy ? raw : undefined;
  return {
    kind,
    messageKey,
    ...(rowCopy !== undefined && rowCopy !== '' ? { rowCopy } : {}),
    ...(details !== undefined ? { details } : {})
  };
};

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
  const namedSubmit = submitShaped(raw) || submitShaped(display) || carriesIndefiniteSubmitOutcome(prose);

  // A proving failure keeps its existing sentence. At submit, that sentence would claim no funds
  // moved, which this screen cannot know.
  if (display === REMOTE_PROVER_FAILED_ERROR || raw === REMOTE_PROVER_FAILED_ERROR) {
    return row.stage === 'submitting' ? pack('unanswered', 'submissionUnanswered', raw) : undefined;
  }
  if (guardian === 'rejected') return pack('rejected', 'submissionRejectedByGuardian', raw);
  if (guardian === 'unanswered') return pack('unanswered', 'submissionUnanswered', raw);
  if (classified === 'refused') return pack('rejected', 'submissionRejectedByNetwork', raw);
  if (classified === 'unknown') return pack('unanswered', 'submissionUnanswered', raw);

  const dropped = NETWORK_DROP.test(prose);
  const noAnswer = isNoAnswer(raw) || isNoAnswer(display);
  const atSubmit = row.stage === 'submitting' || namedSubmit;
  if (dropped && (row.stage === 'submitting' || /failed to submit /i.test(prose))) {
    return pack('interrupted', 'submissionInterrupted', raw);
  }
  if (noAnswer && (row.stage === 'submitting' || carriesIndefiniteSubmitOutcome(prose))) {
    return pack('unanswered', 'submissionUnanswered', raw);
  }
  // A client sentence stored on a Failed submit. A technical "Error: 503" and an Unconfirmed row
  // keep the existing not-confirmed hint. The submit stamp alone does not hide this sentence.
  if (atSubmit && row.status === ITransactionStatus.Failed && display !== '' && !TECHNICAL.test(display)) {
    return pack('rejected', 'submissionRejectedOnDevice', raw, display);
  }
  return undefined;
}
