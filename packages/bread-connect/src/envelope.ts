import { fromBase64Url, toBase64Url } from './base64url.js';
import { ID_BYTES, KEY_BYTES, MAX_CALLBACK_LENGTH, MAX_MESSAGE_LENGTH, NONCE_BYTES, TAG_BYTES } from './constants.js';

export const ERROR_CODES = [
  'NOT_GRANTED',
  'NOT_FOUND',
  'INVALID_PARAMS',
  'NETWORK_NOT_GRANTED',
  'LOGIN_KEY_UNAVAILABLE',
  'UNSUPPORTED_METHOD',
  'INVALID_REQUEST',
  'DUPLICATE_REQUEST',
  'REQUEST_EXPIRED',
  'SESSION_NOT_FOUND',
  'UNSUPPORTED_VERSION',
  'TRANSACTION_FAILED',
  'TRANSACTION_TIMEOUT',
  'INTERNAL_ERROR'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The codes Bread sends unsealed: those for a message it holds no keys for. */
export const UNSEALED_ERROR_CODES: readonly ErrorCode[] = [
  'SESSION_NOT_FOUND',
  'UNSUPPORTED_VERSION',
  'INVALID_REQUEST'
];

export interface ProtocolError {
  code: ErrorCode;
  message: string;
}

/** A Miden dApp request or response: a JSON object with a string `type`. */
export interface DAppMessage {
  type: string;
  [field: string]: unknown;
}

export interface ConnectEnvelope {
  type: 'connect';
  id: string;
  callback: string;
  appPublicKey: string;
  request: DAppMessage;
}

export interface ConnectedEnvelope {
  type: 'connected';
  id: string;
  session: string;
  walletPublicKey: string;
  nonce: string;
  sealed: string;
}

export interface RequestEnvelope {
  type: 'request';
  id: string;
  session: string;
  callback: string;
  nonce: string;
  sealed: string;
}

export interface ResponseEnvelope {
  type: 'response';
  id: string;
  session: string;
  nonce: string;
  sealed: string;
}

export interface ErrorEnvelope {
  type: 'error';
  id?: string;
  error: ProtocolError;
}

export type Envelope = ConnectEnvelope | ConnectedEnvelope | RequestEnvelope | ResponseEnvelope | ErrorEnvelope;

/**
 * What a link under a base says. `unsupported-version` and `invalid` carry the callback and request id when the
 * message names valid ones, so the receiver can answer there.
 */
export type ReadLink =
  | { kind: 'envelope'; envelope: Envelope }
  | { kind: 'unsupported-version' | 'invalid'; callback?: string; id?: string };

const HOST_LABEL = /^[a-z0-9-]+$/;
const NUMERIC_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;
const PATH = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*$/;

/**
 * The origin of a callback that follows the protocol's rules, else null: a canonical https link on a named host,
 * with a path and no port, credentials, query or fragment. The grammar alone decides, as in the Swift and Kotlin
 * clients, because URL parsers disagree on hosts such as a malformed xn-- label.
 */
export function callbackOrigin(callback: string): string | null {
  if (callback.length > MAX_CALLBACK_LENGTH || !callback.startsWith('https://')) return null;
  const rest = callback.slice('https://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const host = rest.slice(0, slash);
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(label => HOST_LABEL.test(label))) return null;
  if (NUMERIC_LABEL.test(labels[labels.length - 1] ?? '') || host.endsWith('.localhost')) return null;
  const path = rest.slice(slash);
  if (!PATH.test(path)) return null;
  for (const segment of path.split('/')) {
    const dots = segment.toLowerCase().replace(/%2e/g, '.');
    if (dots === '.' || dots === '..') return null;
  }
  return `https://${host}`;
}

export function isErrorCode(code: unknown): code is ErrorCode {
  return ERROR_CODES.some(known => known === code);
}

export function writeLink(base: string, envelope: Envelope): string {
  return `${base}#v=1&m=${toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)))}`;
}

/** Null when the link is not `base` followed by a fragment, so it is not a message for this receiver. */
export function readLink(link: string, base: string): ReadLink | null {
  if (!link.startsWith(`${base}#`)) return null;
  const fields = new Map<string, string>();
  for (const part of link.slice(base.length + 1).split('&')) {
    const at = part.indexOf('=');
    const name = at < 0 ? part : part.slice(0, at);
    if (at < 0 || fields.has(name)) return { kind: 'invalid' };
    fields.set(name, part.slice(at + 1));
  }
  const version = fields.get('v');
  const message = fields.get('m');
  if (version === undefined || message === undefined || message.length > MAX_MESSAGE_LENGTH) return { kind: 'invalid' };
  const json = decodeJson(message);
  if (version !== '1') return { kind: 'unsupported-version', ...replyAddress(json) };
  const envelope = parseEnvelope(json);
  return envelope ? { kind: 'envelope', envelope } : { kind: 'invalid', ...replyAddress(json) };
}

export function parseEnvelope(value: unknown): Envelope | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'connect': {
      const { id, callback, appPublicKey, request } = value;
      if (!isId(id) || !isCallback(callback) || !isBytes(appPublicKey, KEY_BYTES)) return null;
      if (!isRecord(request) || request.type !== 'PERMISSION_REQUEST') return null;
      return { type: 'connect', id, callback, appPublicKey, request: { ...request, type: request.type } };
    }
    case 'connected': {
      const { id, session, walletPublicKey, nonce, sealed } = value;
      if (!isId(id) || !isId(session) || !isBytes(walletPublicKey, KEY_BYTES) || !isNonce(nonce) || !isSealed(sealed)) {
        return null;
      }
      return { type: 'connected', id, session, walletPublicKey, nonce, sealed };
    }
    case 'request': {
      const { id, session, callback, nonce, sealed } = value;
      if (!isId(id) || !isId(session) || !isCallback(callback) || !isNonce(nonce) || !isSealed(sealed)) return null;
      return { type: 'request', id, session, callback, nonce, sealed };
    }
    case 'response': {
      const { id, session, nonce, sealed } = value;
      if (!isId(id) || !isId(session) || !isNonce(nonce) || !isSealed(sealed)) return null;
      return { type: 'response', id, session, nonce, sealed };
    }
    case 'error': {
      const { id, error } = value;
      if ((id !== undefined && !isId(id)) || !isProtocolError(error) || !UNSEALED_ERROR_CODES.includes(error.code)) {
        return null;
      }
      return id === undefined ? { type: 'error', error } : { type: 'error', id, error };
    }
    default:
      return null;
  }
}

export function isProtocolError(value: unknown): value is ProtocolError {
  return isRecord(value) && isErrorCode(value.code) && typeof value.message === 'string';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeJson(message: string): unknown {
  const bytes = fromBase64Url(message);
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function replyAddress(json: unknown): { callback?: string; id?: string } {
  if (!isRecord(json)) return {};
  return {
    ...(isCallback(json.callback) ? { callback: json.callback } : {}),
    ...(isId(json.id) ? { id: json.id } : {})
  };
}

function isBytes(value: unknown, length: number): value is string {
  return typeof value === 'string' && fromBase64Url(value)?.length === length;
}

function isId(value: unknown): value is string {
  return isBytes(value, ID_BYTES);
}

function isNonce(value: unknown): value is string {
  return isBytes(value, NONCE_BYTES);
}

function isSealed(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const bytes = fromBase64Url(value);
  return bytes !== null && bytes.length >= TAG_BYTES;
}

function isCallback(value: unknown): value is string {
  return typeof value === 'string' && callbackOrigin(value) !== null;
}
