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

/** Whether the balance check refused the deposit for its amount or could not read the balance at all. */
export const BRIDGE_BALANCE_CHECKS = ['too_low', 'read_failed'] as const;
export type BridgeBalanceCheck = (typeof BRIDGE_BALANCE_CHECKS)[number];

/** How the reconciler knew no flow still owned an interrupted row: the origin-wide lock, or this realm's own count. */
export const BRIDGE_ORPHAN_CHECKS = ['origin_lock', 'realm_idle'] as const;
export type BridgeOrphanCheck = (typeof BRIDGE_ORPHAN_CHECKS)[number];

/** The USDCx route a row recorded; `unrecorded` when it holds none the wallet defines. */
export const BRIDGE_SOURCE_ROUTES = ['xreserve', 'cctp_executor', 'unrecorded'] as const;
export type BridgeSourceRoute = (typeof BRIDGE_SOURCE_ROUTES)[number];

/** The wallet request implementation selected for an inbound bridge approval or deposit. */
export const BRIDGE_RECEIVE_REQUEST_CLIENTS = ['native_reown', 'wagmi'] as const;
export type BridgeReceiveRequestClient = (typeof BRIDGE_RECEIVE_REQUEST_CLIENTS)[number];

/** What failed an inbound bridge's row, as its writer knows it. Only the row's crash report reads it; it is never stored. */
export interface BridgeReceiveFailureSource {
  step: BridgeReceiveFailureStep;
  /** The error the step failed with, read for its library identity alone; a failure the wallet raised has none. */
  cause?: unknown;
  balanceCheck?: BridgeBalanceCheck;
  orphanCheck?: BridgeOrphanCheck;
  sourceRoute?: BridgeSourceRoute;
  requestClient?: BridgeReceiveRequestClient;
}

/** What a failed inbound bridge's crash report adds: the row's route and what its writer said failed it. */
export interface BridgeReceiveFailure extends Partial<BridgeReceiveFailureSource> {
  route?: string;
}

// A registered symbol rather than a module-local set: every copy of this module in a realm reads the same mark, and a
// failure's write and its report run in one realm.
const WALLET_RAISED = Symbol.for('miden.bridge-receive.wallet-raised');

/** Marks an error raised in the wallet's own words, never an answer's: the report reads only the answer it wraps. */
export function walletRaised<E extends Error>(error: E): E {
  Object.defineProperty(error, WALLET_RAISED, { value: true });
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
  'receipt_timeout',
  'timeout',
  'chain_mismatch',
  'chain_unconfigured',
  'provider_unauthorized',
  'method_unsupported',
  'provider_disconnected',
  'chain_disconnected',
  'chain_switch_failed',
  'request_invalid',
  'rpc_internal',
  'rpc_unavailable',
  'transaction_rejected',
  'rpc_limited',
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
const TEXT_LIMIT = 16_384;

const REVERTED_ERRORS = new Set<unknown>([
  'ExecutionRevertedError',
  'ContractFunctionRevertedError',
  'EvmTransactionRevertedError'
]);
const TIMEOUT_ERRORS = new Set<unknown>(['TimeoutError', 'WaitForTransactionReceiptTimeoutError', 'RpcTimeoutError']);

// viem 2.55.4's chain, provider and RPC classes, each by its exact name or the EIP-1193 or JSON-RPC code it carries.
const PROVIDER_ERROR_RULES: ReadonlyArray<readonly [LibraryError, ReadonlyArray<string>, ReadonlyArray<number>]> = [
  ['chain_mismatch', ['ChainMismatchError'], []],
  ['chain_unconfigured', ['ChainNotFoundError', 'ClientChainNotConfiguredError', 'InvalidChainIdError'], []],
  ['provider_unauthorized', ['UnauthorizedProviderError'], [4100]],
  [
    'method_unsupported',
    ['UnsupportedProviderMethodError', 'MethodNotFoundRpcError', 'MethodNotSupportedRpcError'],
    [4200, -32601, -32004]
  ],
  ['provider_disconnected', ['ProviderDisconnectedError'], [4900]],
  ['chain_disconnected', ['ChainDisconnectedError'], [4901]],
  ['chain_switch_failed', ['SwitchChainError'], [4902]],
  // Not -32000: nodes answer every server fault with it, so only viem's class names invalid input.
  [
    'request_invalid',
    ['ParseRpcError', 'InvalidRequestRpcError', 'InvalidParamsRpcError', 'InvalidInputRpcError'],
    [-32700, -32600, -32602]
  ],
  ['rpc_internal', ['InternalRpcError'], [-32603]],
  ['rpc_unavailable', ['ResourceNotFoundRpcError', 'ResourceUnavailableRpcError'], [-32001, -32002]],
  ['transaction_rejected', ['TransactionRejectedRpcError'], [-32003]],
  ['rpc_limited', ['LimitExceededRpcError'], [-32005]]
];

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
  ['receipt_timeout', link => link.name === 'WaitForTransactionReceiptTimeoutError'],
  ['timeout', link => TIMEOUT_ERRORS.has(link.name) || TIMED_OUT.test(link.text)],
  ...PROVIDER_ERROR_RULES.map(
    ([identity, names, codes]) =>
      [
        identity,
        (link: Link) =>
          (link.name !== undefined && names.includes(link.name)) ||
          (typeof link.code === 'number' && codes.includes(link.code))
      ] as const
  ),
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
// wallet raised is no answer, so only what it wraps is read.
function linksOf(error: unknown): Link[] {
  const chain: Link[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (seen.size < MAX_LINKS && !seen.has(current)) {
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

/** Why a native session precheck refused the bridge network. Closed; never a chain id, topic, or message. */
export const NATIVE_SESSION_PRECHECK_FAILURES = ['state_unread', 'session_missing', 'chain_unapproved'] as const;

/**
 * What the add-and-switch attempt did before that refusal. Closed. `not_attempted` is no request,
 * `unsupported` is a network that could not be proposed, `rejected` is a refused request whose session state was read
 * again, `rejected_unread` is a refused request whose session state could not be read again, `unconfirmed` is requests
 * that returned while the session still had not approved the network, and `unconfirmed_unread` is those requests when
 * the session state could not be read.
 */
export const NATIVE_SESSION_PRECHECK_RECOVERIES = [
  'not_attempted',
  'unsupported',
  'rejected',
  'rejected_unread',
  'unconfirmed',
  'unconfirmed_unread'
] as const;

export type NativeSessionPrecheckFailure = (typeof NATIVE_SESSION_PRECHECK_FAILURES)[number];
export type NativeSessionPrecheckRecovery = (typeof NATIVE_SESSION_PRECHECK_RECOVERIES)[number];

export interface NativeSessionPrecheck {
  failure: NativeSessionPrecheckFailure;
  recovery: NativeSessionPrecheckRecovery;
}

// Keyed by identity, so the refusal's own fields stay the message the user sees and no caller can forge the mark.
const SESSION_PRECHECKS = new WeakMap<object, NativeSessionPrecheck>();

function readOwn(source: object, key: string): unknown {
  try {
    return Reflect.get(source, key);
  } catch {
    return undefined;
  }
}

function validateNativeSessionPrecheck(value: unknown): NativeSessionPrecheck | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const failure = NATIVE_SESSION_PRECHECK_FAILURES.find(entry => entry === readOwn(value, 'failure'));
    const recovery = NATIVE_SESSION_PRECHECK_RECOVERIES.find(entry => entry === readOwn(value, 'recovery'));
    if (failure === undefined || recovery === undefined) return undefined;
    return { failure, recovery };
  } catch {
    return undefined;
  }
}

/** Records the closed precheck fact on `error`. A second mark, or a fact outside the lists, is ignored. */
export function markNativeSessionPrecheck(error: object, fact: NativeSessionPrecheck): boolean {
  try {
    if (SESSION_PRECHECKS.has(error)) return false;
    const validated = validateNativeSessionPrecheck(fact);
    if (validated === undefined) return false;
    SESSION_PRECHECKS.set(error, Object.freeze(validated));
    return true;
  } catch {
    return false;
  }
}

/** The nearest closed precheck fact on `cause`, or none. Own properties and free text are not a fact. */
export function readNativeSessionPrecheck(cause: unknown): NativeSessionPrecheck | undefined {
  const seen = new Set<object>();
  let current = cause;
  // A thrown function is a markable object. `typeof` reports it as `function`, not `object`.
  while (
    current !== null &&
    (typeof current === 'object' || typeof current === 'function') &&
    seen.size < MAX_LINKS &&
    !seen.has(current)
  ) {
    seen.add(current);
    const fact = SESSION_PRECHECKS.get(current);
    if (fact !== undefined) return fact;
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
  const precheck = readNativeSessionPrecheck(failure.cause);
  const requestClient =
    failure.requestClient === undefined || (step !== 'wallet_approve' && step !== 'wallet_deposit')
      ? ''
      : ` wallet request client ${listed(failure.requestClient, BRIDGE_RECEIVE_REQUEST_CLIENTS)};`;
  // `recovery` would drop the report: it is mnemonic context, and this sentence already holds wordlist words such as
  // `session`. The attempt's value is the recovery outcome. Labels stay outside a four-word run (redact.ts).
  const attempt =
    precheck === undefined
      ? ''
      : ` precheck ${listed(precheck.failure, NATIVE_SESSION_PRECHECK_FAILURES)}; attempt ${listed(
          precheck.recovery,
          NATIVE_SESSION_PRECHECK_RECOVERIES
        )};`;
  return `via ${route}; failed at ${step};${attempt}${requestClient} evm error ${error}`;
}
