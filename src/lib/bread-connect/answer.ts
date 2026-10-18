import {
  answerConnect,
  answerRequest,
  BREAD_REQUEST_URL,
  callbackOrigin,
  type ConnectAnswer,
  type ConnectEnvelope,
  type DAppMessage,
  type ErrorCode,
  errorLink,
  openRequest,
  type OpenedRequest,
  type ProtocolError,
  ProtocolMessageError,
  readLink,
  REQUEST_MAX_AGE_MS,
  REQUEST_MAX_CLOCK_AHEAD_MS,
  type RequestAnswer,
  type RequestEnvelope,
  type TransactionOutcome,
  type WalletSession
} from '@miden-sdk/bread-connect';
import { MidenDAppErrorType, MidenDAppMessageType, type MidenDAppRequest } from 'lib/adapter/types';
import { DAppQueueDeadlineError, processDApp } from 'lib/miden/back/actions';
import { ITransactionStatus } from 'lib/miden/db/types';
import { getTransactionById } from 'lib/miden/transaction/get';

import { dropSession, findSession, hasAnswered, keepSession, recordAnswered } from './sessions';

export interface BreadConnectAnswer {
  /** The app's link that carries the answer. */
  link: string;
  /** The app's callback, whose host Bread names when no app takes the link. */
  callback: string;
  /** What Bread keeps for the answer, written before the app opens so it is there when the app first uses it. */
  keep?: () => Promise<void>;
  /** Removes what `keep` wrote, when no app takes the link. */
  drop?: () => Promise<void>;
  /** The user approved a transaction, so it was sent whether or not the app gets the answer. */
  sentTransaction?: boolean;
}

export interface AnswerOptions {
  now?: number;
  /** Called with the app's callback once the user approved a transaction and Bread waits for its outcome. */
  onTransactionSent?: (callback: string) => void;
}

const METHODS = new Set<string>([
  MidenDAppMessageType.SignRequest,
  MidenDAppMessageType.TransactionRequest,
  MidenDAppMessageType.SendTransactionRequest,
  MidenDAppMessageType.ConsumeRequest,
  MidenDAppMessageType.PrivateNotesRequest,
  MidenDAppMessageType.AssetsRequest,
  MidenDAppMessageType.ConsumableNotesRequest,
  MidenDAppMessageType.ImportPrivateNoteRequest,
  MidenDAppMessageType.GuardianInfoRequest
]);

const TRANSACTIONS = new Set<string>([
  MidenDAppMessageType.TransactionRequest,
  MidenDAppMessageType.SendTransactionRequest,
  MidenDAppMessageType.ConsumeRequest
]);

const DAPP_ERRORS = new Set<string>(Object.values(MidenDAppErrorType));

function problem(code: ErrorCode, message: string): ProtocolError {
  return { code, message };
}

const INTERNAL = problem('INTERNAL_ERROR', 'Bread could not complete the request');
const TOO_LONG = problem('INTERNAL_ERROR', "Bread's answer is longer than a link carries");
const OUTCOME_TOO_LONG = problem('TRANSACTION_TIMEOUT', "The transaction's outcome is longer than a link carries");
const OUTCOME_UNKNOWN = problem('TRANSACTION_TIMEOUT', "Bread could not learn the transaction's outcome");
const QUEUED_TOO_LONG = problem('REQUEST_EXPIRED', 'The request waited too long behind other requests in Bread');

function refusal(error: unknown): ProtocolError {
  const code = error instanceof Error ? error.message : '';
  return DAPP_ERRORS.has(code) ? problem(code as ErrorCode, code) : INTERNAL;
}

/** What Bread sends back for a request link, or null when it drops the link. */
export async function answerRequestLink(
  link: string,
  { now = Date.now(), onTransactionSent }: AnswerOptions = {}
): Promise<BreadConnectAnswer | null> {
  const read = readLink(link, BREAD_REQUEST_URL);
  if (!read) return null;
  if (read.kind !== 'envelope') {
    if (!read.callback) return null;
    const error =
      read.kind === 'unsupported-version'
        ? problem('UNSUPPORTED_VERSION', 'Bread speaks version 1 of the protocol')
        : problem('INVALID_REQUEST', 'Bread could not read the request');
    return { link: errorLink(read.callback, error, read.id), callback: read.callback };
  }
  const { envelope } = read;
  if (envelope.type === 'connect') return connect(envelope, now);
  if (envelope.type === 'request') return request(envelope, now, onTransactionSent);
  return null;
}

async function connect(envelope: ConnectEnvelope, now: number): Promise<BreadConnectAnswer | null> {
  const origin = callbackOrigin(envelope.callback);
  if (origin === null) return null;
  let answer: ConnectAnswer;
  try {
    const response = await processDApp(origin, envelope.request as unknown as MidenDAppRequest);
    answer = response ? { response: response as unknown as DAppMessage } : { error: INTERNAL };
  } catch (error) {
    answer = { error: refusal(error) };
  }
  const { link, session } = answerConnect(envelope, answer);
  return {
    link,
    callback: envelope.callback,
    ...('response' in answer
      ? { keep: () => keepSession(session, now), drop: () => dropSession(session.session, now) }
      : {})
  };
}

async function request(
  envelope: RequestEnvelope,
  now: number,
  onTransactionSent?: (callback: string) => void
): Promise<BreadConnectAnswer | null> {
  const session = await findSession(envelope.session, now);
  if (!session) {
    return {
      link: errorLink(envelope.callback, problem('SESSION_NOT_FOUND', 'Bread has no such session'), envelope.id),
      callback: envelope.callback
    };
  }
  let opened: OpenedRequest;
  try {
    opened = openRequest(envelope, session);
  } catch (error) {
    console.warn('[bread-connect] dropped a request whose seal does not open:', error);
    return null;
  }
  const reply = (answer: RequestAnswer): BreadConnectAnswer => ({
    link: fittingAnswer(envelope, session, answer),
    callback: session.callback
  });
  if (hasAnswered(session, envelope.id, now)) {
    return reply({ error: problem('DUPLICATE_REQUEST', 'Bread already answered this request') });
  }
  await recordAnswered(session.session, envelope.id, now);
  if (now - opened.sentAt > REQUEST_MAX_AGE_MS || opened.sentAt - now > REQUEST_MAX_CLOCK_AHEAD_MS) {
    return reply({ error: problem('REQUEST_EXPIRED', 'The request is too old, or from a clock far ahead') });
  }
  const { request } = opened;
  if (!METHODS.has(request.type)) {
    return reply({ error: problem('UNSUPPORTED_METHOD', `Bread does not answer ${request.type} here`) });
  }
  let response: DAppMessage;
  try {
    const startBy = opened.sentAt + REQUEST_MAX_AGE_MS;
    const answered = await processDApp(session.origin, request as unknown as MidenDAppRequest, undefined, startBy);
    if (!answered) return reply({ error: INTERNAL });
    response = answered as unknown as DAppMessage;
  } catch (error) {
    return reply({ error: error instanceof DAppQueueDeadlineError ? QUEUED_TOO_LONG : refusal(error) });
  }
  if (!TRANSACTIONS.has(request.type)) return reply({ response });
  const transactionId = response.transactionId;
  if (typeof transactionId !== 'string') return { ...reply({ response }), sentTransaction: true };
  onTransactionSent?.(session.callback);
  return { ...reply({ response, transaction: await outcome(session.origin, transactionId) }), sentTransaction: true };
}

/** The sealed answer, or, when the app could not read one that long, the shortest that keeps what it must know. */
function fittingAnswer(envelope: RequestEnvelope, session: WalletSession, answer: RequestAnswer): string {
  try {
    return answerRequest(envelope, session, answer);
  } catch (error) {
    if (!(error instanceof ProtocolMessageError)) throw error;
    const shorter: RequestAnswer =
      'response' in answer && answer.transaction
        ? { response: answer.response, transaction: { error: OUTCOME_TOO_LONG } }
        : { error: TOO_LONG };
    return answerRequest(envelope, session, shorter);
  }
}

async function outcome(origin: string, txId: string): Promise<TransactionOutcome> {
  try {
    const waited = await processDApp(origin, { type: MidenDAppMessageType.WaitForTransactionRequest, txId });
    const output = waited && 'transactionOutput' in waited ? waited.transactionOutput : undefined;
    if (!output) return { error: OUTCOME_UNKNOWN };
    if (!('errorMessage' in output)) return { output };
    const row = await getTransactionById(txId).catch(() => undefined);
    // Without its row Bread cannot tell whether the transaction landed, and a Completed row ends the wait in an
    // error when it landed without a result Bread can return: neither is a failure.
    const failed = row?.status === ITransactionStatus.Failed;
    return { error: problem(failed ? 'TRANSACTION_FAILED' : 'TRANSACTION_TIMEOUT', output.errorMessage) };
  } catch (error) {
    // The transaction was sent: a wait refused after it, such as for a permission removed meanwhile, is no failure.
    return { error: problem('TRANSACTION_TIMEOUT', refusal(error).message) };
  }
}
