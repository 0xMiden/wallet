import { readReownNativeFailure, type ReownNativeFailure } from 'lib/walletconnect/native-request-failure';

export {
  REOWN_NATIVE_ORIGINS,
  REOWN_WALLET_RESPONSE_CODES,
  REOWN_REQUEST_AGES,
  REOWN_PUBLICATIONS,
  REOWN_BACKGROUND_ANSWERS,
  type ReownNativeOrigin,
  type ReownWalletResponseCode,
  type ReownRequestAge,
  type ReownPublication,
  type ReownBackgroundAnswer,
  type ReownNativeFailure
} from 'lib/walletconnect/native-request-failure';

/** The routes an inbound bridge's row names as its `provider`. */
export const BRIDGE_RECEIVE_ROUTES = ['epoch', 'agglayer', 'usdcx'] as const;

/** Each step at which a writer fails an inbound bridge's row: the deposit screen's, the Epoch store's, the reconciler's. */
export const BRIDGE_RECEIVE_STEPS = [
  'provider_unavailable',
  'precheck_route',
  'precheck_balance',
  'precheck_session_chain',
  'precheck_allowance',
  'precheck_domain',
  'precheck_quote',
  'wallet_approve',
  'approve_receipt',
  'wallet_deposit',
  'deposit_receipt',
  'epoch_solve',
  'epoch_execute',
  'reconciler_receipt',
  'submission_interrupted',
  'epoch_intent_failed',
  'usdcx_mismatch_domain',
  'usdcx_mismatch_token',
  'usdcx_mismatch_recipient',
  'usdcx_mismatch_amount',
  'delivery_timed_out'
] as const;

export type BridgeReceiveFailureStep = (typeof BRIDGE_RECEIVE_STEPS)[number];

/** What failed an inbound bridge's row, as its writer knows it. Only the row's crash report reads it; it is never stored. */
export interface BridgeReceiveFailureSource {
  step: BridgeReceiveFailureStep;
  /** The error the step failed with, read for its library identity alone; a failure the wallet raised has none. */
  cause?: unknown;
}

/** What a failed inbound bridge's crash report adds: the row's route and what its writer said failed it. */
export interface BridgeReceiveFailure extends Partial<BridgeReceiveFailureSource> {
  route?: string;
}

// A registered symbol rather than a module-local set: every copy of this module in a realm reads the same mark, and a
// failure's write and its report run in one realm.
const WALLET_RAISED = Symbol.for('miden.bridge-receive.wallet-raised');
const ORIGINAL_REJECTIONS = new WeakMap<object, object>();

/** Marks an error raised in the wallet's own words, never an answer's: the report reads only the answer it wraps. */
export function walletRaised<E extends Error>(error: E, originalRejection?: object): E {
  Object.defineProperty(error, WALLET_RAISED, { value: true });
  // A display-only wrapper must leave its original rejection's bounded traversal unchanged.
  if (originalRejection !== undefined)
    ORIGINAL_REJECTIONS.set(error, ORIGINAL_REJECTIONS.get(originalRejection) ?? originalRejection);
  return error;
}

/** The library errors the report can name; `http_` is followed by the HTTP status. */
export const BRIDGE_RECEIVE_LIBRARY_ERRORS = [
  'user_rejected',
  'session_deleted',
  'no_session',
  'request_expired',
  'insufficient_funds',
  'reverted',
  'timeout',
  'http_',
  'invalid_permissions',
  'unknown_rpc_error'
] as const;

type LibraryError = (typeof BRIDGE_RECEIVE_LIBRARY_ERRORS)[number];

interface Link {
  name?: string;
  code?: unknown;
  status?: unknown;
  text: string;
}

const MAX_LINKS = 8;
const MAX_VISITS = MAX_LINKS * 2;
const TEXT_LIMIT = 16_384;

const REVERTED_ERRORS = new Set<unknown>([
  'ExecutionRevertedError',
  'ContractFunctionRevertedError',
  'EvmTransactionRevertedError'
]);
const TIMEOUT_ERRORS = new Set<unknown>(['TimeoutError', 'WaitForTransactionReceiptTimeoutError', 'RpcTimeoutError']);

// A wallet's own answer is read loosely, since every wallet words it its own way; a library's only as it writes it.
const USER_REJECTED =
  /\buser (?:rejected|denied|declined|cancell?ed)\b|\b(?:rejected|denied|declined|cancell?ed) by (?:the )?user\b/i;
const INSUFFICIENT_FUNDS =
  /insufficient funds|exceeds transaction sender account balance|exceeds the balance of the account/i;
const TIMED_OUT =
  /The request took too long to respond\.|Timed out while waiting for transaction with hash|^RPC "[^"\n]{0,200}" timed out after \d{1,9}ms|Transaction simulation failed after \d{1,9}ms/m;

// viem 2.55.4's classes and wording, the native Reown plugins' rejections, the wallet's RPC timeout and the Epoch SDK's
// simulation timeout. A user rejection comes first: viem wraps one that carries no code, as the native plugins send it,
// in an unknown RPC error.
const LIBRARY_ERROR_RULES: ReadonlyArray<readonly [LibraryError, (link: Link) => boolean]> = [
  [
    'user_rejected',
    link => link.code === 4001 || link.name === 'UserRejectedRequestError' || USER_REJECTED.test(link.text)
  ],
  ['session_deleted', link => link.text.includes('WalletConnect session was deleted')],
  ['no_session', link => link.text.includes('No WalletConnect session is connected')],
  ['request_expired', link => /\bRequest expired\b/.test(link.text)],
  ['insufficient_funds', link => link.name === 'InsufficientFundsError' || INSUFFICIENT_FUNDS.test(link.text)],
  ['reverted', link => REVERTED_ERRORS.has(link.name) || /\breverted\b/i.test(link.text)],
  ['timeout', link => TIMEOUT_ERRORS.has(link.name) || TIMED_OUT.test(link.text)],
  ['http_', link => link.name === 'HttpRequestError' || /^HTTP request failed\.$/m.test(link.text)],
  ['invalid_permissions', link => /^Invalid permissions for call\.$/m.test(link.text)],
  ['unknown_rpc_error', link => link.name === 'UnknownRpcError' || link.text.includes('An unknown RPC error occurred.')]
];

function readLink(source: object): Link {
  const field = (key: string): unknown => Reflect.get(source, key);
  const name = field('name');
  return {
    name: typeof name === 'string' ? name : undefined,
    code: field('code'),
    status: field('status'),
    text: ['message', 'shortMessage', 'details']
      .map(field)
      .filter((value): value is string => typeof value === 'string')
      .join('\n')
      .slice(0, TEXT_LIMIT)
  };
}

// The cause chain, objects included: an EIP-1193 rejection's code sits on the provider's plain error object. A link the
// wallet raised is no answer, so only what it wraps is read. A separate visit cap bounds fresh-object causes.
function linksOf(error: unknown): Link[] {
  const chain: Link[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (chain.length < MAX_LINKS && seen.size < MAX_VISITS) {
    if (typeof current === 'object' && current !== null) current = ORIGINAL_REJECTIONS.get(current) ?? current;
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current === 'string') {
      if (current !== '') chain.push({ text: current.slice(0, TEXT_LIMIT) });
      break;
    }
    if (typeof current !== 'object' || current === null) break;
    try {
      if (Reflect.get(current, WALLET_RAISED) !== true) chain.push(readLink(current));
      current = Reflect.get(current, 'cause');
    } catch {
      // A throwing accessor ends the chain, not the report.
      break;
    }
  }
  return chain;
}

function httpStatus(link: Link): string {
  const status = typeof link.status === 'number' ? link.status : Number(/^Status: (\d{1,3})$/m.exec(link.text)?.[1]);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'other';
}

/** The library error a failure names, matched against fixed wording and error classes; its text is never returned. */
export function bridgeReceiveLibraryError(error: unknown): string {
  const chain = linksOf(error);
  if (chain.length === 0) return 'none';
  for (const [identity, matches] of LIBRARY_ERROR_RULES) {
    const link = chain.find(matches);
    if (link !== undefined) return identity === 'http_' ? `http_${httpStatus(link)}` : identity;
  }
  return 'other';
}

/** The nearest boundary-marked native snapshot, independently of wallet-authored display text. */
export function bridgeReceiveNativeFailure(cause: unknown): ReownNativeFailure | undefined {
  const seen = new Set<object>();
  let current = cause;
  while (typeof current === 'object' && current !== null && seen.size < MAX_LINKS && !seen.has(current)) {
    seen.add(current);
    const snapshot = readReownNativeFailure(current);
    if (snapshot !== undefined) return snapshot;
    try {
      current = Reflect.get(current, 'cause');
    } catch {
      break;
    }
  }
  return undefined;
}

const listed = (value: unknown, allowed: readonly string[]): string =>
  allowed.find(entry => entry === value) ?? 'other';

/** `via <route>; failed at <step>; evm error <error>`, each from its closed list; the error from the cause alone. */
export function bridgeReceiveIdentity(failure: BridgeReceiveFailure): string {
  const route = listed(failure.route, BRIDGE_RECEIVE_ROUTES);
  const step = listed(failure.step, BRIDGE_RECEIVE_STEPS);
  // Never the row's stored text: for a failure the wallet raised, that is the App's own words, not an answer.
  const error = bridgeReceiveLibraryError(failure.cause);
  // Labels of words outside BIP-39: the crash reporter drops a report holding four wordlist words in a row (redact.ts),
  // and `route other; step other` is four.
  return `via ${route}; failed at ${step}; evm error ${error}`;
}
