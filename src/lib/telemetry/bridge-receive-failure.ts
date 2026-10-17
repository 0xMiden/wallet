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
  /** The error the step failed with, read for its library identity alone. */
  cause?: unknown;
}

/** What a failed inbound bridge's crash report adds: the row's route and what its writer said failed it. */
export interface BridgeReceiveFailure extends Partial<BridgeReceiveFailureSource> {
  route?: string;
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

// The cause chain, objects included: an EIP-1193 rejection's code sits on the provider's plain error object.
function linksOf(error: unknown): Link[] {
  const chain: Link[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (chain.length < MAX_LINKS && !seen.has(current)) {
    seen.add(current);
    if (typeof current === 'string') {
      if (current !== '') chain.push({ text: current.slice(0, TEXT_LIMIT) });
      break;
    }
    if (typeof current !== 'object' || current === null) break;
    try {
      chain.push(readLink(current));
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

const listed = (value: unknown, allowed: readonly string[]): string =>
  allowed.find(entry => entry === value) ?? 'other';

/** `via <route>; failed at <step>; evm error <error>`, each from its closed list; the cause, else the stored text. */
export function bridgeReceiveIdentity(failure: BridgeReceiveFailure, storedError: unknown): string {
  const route = listed(failure.route, BRIDGE_RECEIVE_ROUTES);
  const step = listed(failure.step, BRIDGE_RECEIVE_STEPS);
  const error = bridgeReceiveLibraryError(failure.cause ?? storedError);
  // Labels of words outside BIP-39: the crash reporter drops a report holding four wordlist words in a row (redact.ts),
  // and `route other; step other` is four.
  return `via ${route}; failed at ${step}; evm error ${error}`;
}
