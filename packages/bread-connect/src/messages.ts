import { BREAD_REQUEST_URL, KEY_BYTES, MAX_MESSAGE_LENGTH, NONCE_BYTES } from './constants.js';
import {
  additionalData,
  decodeBytes,
  deriveSessionKeys,
  encodeBytes,
  generateKeyPair,
  open,
  randomId,
  randomNonce,
  seal,
  SessionKeys
} from './crypto.js';
import {
  callbackOrigin,
  ConnectEnvelope,
  ConnectedEnvelope,
  DAppMessage,
  Envelope,
  isProtocolError,
  isRecord,
  ProtocolError,
  RequestEnvelope,
  ResponseEnvelope,
  writeLink
} from './envelope.js';

export class ProtocolMessageError extends Error {
  name = 'ProtocolMessageError';
}

/** What the app keeps while its connect request is out. */
export interface AppConnection {
  id: string;
  callback: string;
  appSecretKey: string;
  appPublicKey: string;
}

/** What the app keeps for a connected session. */
export interface AppSession {
  session: string;
  callback: string;
  appSecretKey: string;
  appPublicKey: string;
  walletPublicKey: string;
}

/** What Bread keeps for a session. */
export interface WalletSession {
  session: string;
  callback: string;
  origin: string;
  appPublicKey: string;
  walletSecretKey: string;
  walletPublicKey: string;
}

export type ConnectAnswer = { response: DAppMessage } | { error: ProtocolError };

export type TransactionOutcome = { output: unknown } | { error: ProtocolError };

export type RequestAnswer = { response: DAppMessage; transaction?: TransactionOutcome } | { error: ProtocolError };

export interface OpenedRequest {
  request: DAppMessage;
  sentAt: number;
}

/** Starts a connection: the link opens Bread with the permission request. */
export function startConnect(callback: string, request: DAppMessage): { link: string; connection: AppConnection } {
  if (callbackOrigin(callback) === null) throw new ProtocolMessageError('The callback does not follow the rules');
  if (request.type !== 'PERMISSION_REQUEST') throw new ProtocolMessageError('A connect carries a PERMISSION_REQUEST');
  const keys = generateKeyPair();
  const connection: AppConnection = {
    id: randomId(),
    callback,
    appSecretKey: encodeBytes(keys.secretKey),
    appPublicKey: encodeBytes(keys.publicKey)
  };
  const envelope: ConnectEnvelope = {
    type: 'connect',
    id: connection.id,
    callback,
    appPublicKey: connection.appPublicKey,
    request
  };
  return { link: checkedLink(BREAD_REQUEST_URL, envelope), connection };
}

/** Reads Bread's answer to the connection; throws when it was not sealed for this connection. */
export function finishConnect(
  envelope: ConnectedEnvelope,
  connection: AppConnection
): { session: AppSession; answer: ConnectAnswer } {
  if (envelope.id !== connection.id) throw new ProtocolMessageError('The answer is for another connection');
  const keys = appKeys(connection.appSecretKey, connection.appPublicKey, envelope.walletPublicKey);
  const payload = openPayload(keys.walletKey, envelope);
  const answer = connectAnswer(payload);
  if (!answer) throw new ProtocolMessageError('The connect answer is malformed');
  const session: AppSession = {
    session: envelope.session,
    callback: connection.callback,
    appSecretKey: connection.appSecretKey,
    appPublicKey: connection.appPublicKey,
    walletPublicKey: envelope.walletPublicKey
  };
  return { session, answer };
}

/** Seals a request for the session: the link opens Bread with it. */
export function sendRequest(
  session: AppSession,
  request: DAppMessage,
  sentAt = Date.now()
): { link: string; id: string } {
  const keys = appKeys(session.appSecretKey, session.appPublicKey, session.walletPublicKey);
  const id = randomId();
  const { nonce, sealed } = sealPayload(keys.appKey, 'request', session.session, id, { request, sentAt });
  const envelope: RequestEnvelope = {
    type: 'request',
    id,
    session: session.session,
    callback: session.callback,
    nonce,
    sealed
  };
  return { link: checkedLink(BREAD_REQUEST_URL, envelope), id };
}

/** Reads Bread's answer to a request of the session; throws when it was not sealed for it. */
export function readResponse(envelope: ResponseEnvelope, session: AppSession): RequestAnswer {
  if (envelope.session !== session.session) throw new ProtocolMessageError('The answer is for another session');
  const keys = appKeys(session.appSecretKey, session.appPublicKey, session.walletPublicKey);
  const answer = requestAnswer(openPayload(keys.walletKey, envelope));
  if (!answer) throw new ProtocolMessageError('The answer is malformed');
  return answer;
}

/**
 * Bread's answer to a connection, sealed under a new session's keys, so a refusal is as authentic as an approval.
 * The caller keeps the session only when it approved.
 */
export function answerConnect(
  envelope: ConnectEnvelope,
  answer: ConnectAnswer
): { link: string; session: WalletSession } {
  const origin = callbackOrigin(envelope.callback);
  if (origin === null) throw new ProtocolMessageError('The callback does not follow the rules');
  const appPublicKey = requireBytes(envelope.appPublicKey, KEY_BYTES);
  const walletKeys = generateKeyPair();
  const session: WalletSession = {
    session: randomId(),
    callback: envelope.callback,
    origin,
    appPublicKey: envelope.appPublicKey,
    walletSecretKey: encodeBytes(walletKeys.secretKey),
    walletPublicKey: encodeBytes(walletKeys.publicKey)
  };
  const keys = deriveSessionKeys(walletKeys.secretKey, appPublicKey, appPublicKey, walletKeys.publicKey);
  const { nonce, sealed } = sealPayload(keys.walletKey, 'connected', session.session, envelope.id, answer);
  const connected: ConnectedEnvelope = {
    type: 'connected',
    id: envelope.id,
    session: session.session,
    walletPublicKey: session.walletPublicKey,
    nonce,
    sealed
  };
  return { link: checkedLink(envelope.callback, connected), session };
}

/** Opens a request sealed for the session; throws when it was not. */
export function openRequest(envelope: RequestEnvelope, session: WalletSession): OpenedRequest {
  if (envelope.session !== session.session) throw new ProtocolMessageError('The request is for another session');
  const payload = openPayload(walletKeys(session).appKey, envelope);
  if (!isRecord(payload) || !isDAppMessage(payload.request) || !isTimestamp(payload.sentAt)) {
    throw new ProtocolMessageError('The request is malformed');
  }
  return { request: payload.request, sentAt: payload.sentAt };
}

/**
 * Bread's sealed answer to a request, addressed to the callback the session was made with. Throws when the link is
 * longer than the app reads.
 */
export function answerRequest(envelope: RequestEnvelope, session: WalletSession, answer: RequestAnswer): string {
  const { nonce, sealed } = sealPayload(
    walletKeys(session).walletKey,
    'response',
    session.session,
    envelope.id,
    answer
  );
  const response: ResponseEnvelope = { type: 'response', id: envelope.id, session: session.session, nonce, sealed };
  return checkedLink(session.callback, response);
}

/** An unsealed error, for a message Bread holds no keys for. */
export function errorLink(callback: string, error: ProtocolError, id?: string): string {
  return checkedLink(callback, id === undefined ? { type: 'error', error } : { type: 'error', id, error });
}

function appKeys(appSecretKey: string, appPublicKey: string, walletPublicKey: string): SessionKeys {
  const app = requireBytes(appPublicKey, KEY_BYTES);
  const wallet = requireBytes(walletPublicKey, KEY_BYTES);
  return deriveSessionKeys(requireBytes(appSecretKey, KEY_BYTES), wallet, app, wallet);
}

function walletKeys(session: WalletSession): SessionKeys {
  const app = requireBytes(session.appPublicKey, KEY_BYTES);
  const wallet = requireBytes(session.walletPublicKey, KEY_BYTES);
  return deriveSessionKeys(requireBytes(session.walletSecretKey, KEY_BYTES), app, app, wallet);
}

function sealPayload(
  key: Uint8Array,
  type: string,
  session: string,
  id: string,
  payload: unknown
): { nonce: string; sealed: string } {
  const nonce = randomNonce();
  const sealed = seal(key, nonce, additionalData(type, session, id), JSON.stringify(payload));
  return { nonce: encodeBytes(nonce), sealed: encodeBytes(sealed) };
}

function openPayload(
  key: Uint8Array,
  envelope: { type: string; session: string; id: string; nonce: string; sealed: string }
): unknown {
  const nonce = requireBytes(envelope.nonce, NONCE_BYTES);
  const sealed = requireBytes(envelope.sealed);
  const plaintext = open(key, nonce, additionalData(envelope.type, envelope.session, envelope.id), sealed);
  try {
    return JSON.parse(plaintext);
  } catch {
    throw new ProtocolMessageError('The sealed payload is not JSON');
  }
}

function connectAnswer(payload: unknown): ConnectAnswer | null {
  if (!isRecord(payload)) return null;
  if (isDAppMessage(payload.response) && payload.error === undefined) return { response: payload.response };
  if (isProtocolError(payload.error) && payload.response === undefined) return { error: payload.error };
  return null;
}

function requestAnswer(payload: unknown): RequestAnswer | null {
  if (!isRecord(payload)) return null;
  if (isProtocolError(payload.error) && payload.response === undefined && payload.transaction === undefined) {
    return { error: payload.error };
  }
  if (!isDAppMessage(payload.response) || payload.error !== undefined) return null;
  if (payload.transaction === undefined) return { response: payload.response };
  const transaction = transactionOutcome(payload.transaction);
  return transaction ? { response: payload.response, transaction } : null;
}

function transactionOutcome(value: unknown): TransactionOutcome | null {
  if (!isRecord(value)) return null;
  if (isProtocolError(value.error) && !('output' in value)) return { error: value.error };
  if ('output' in value && value.error === undefined) return { output: value.output };
  return null;
}

function isDAppMessage(value: unknown): value is DAppMessage {
  return isRecord(value) && typeof value.type === 'string';
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function requireBytes(text: string, length?: number): Uint8Array {
  const bytes = decodeBytes(text, length);
  if (!bytes) throw new ProtocolMessageError('A byte field is malformed');
  return bytes;
}

function checkedLink(base: string, envelope: Envelope): string {
  const link = writeLink(base, envelope);
  if (link.length - link.indexOf('&m=') - 3 > MAX_MESSAGE_LENGTH) {
    throw new ProtocolMessageError('The message is longer than its receiver reads');
  }
  return link;
}
