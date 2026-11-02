import { TFunction } from 'i18next';

import { NativeSessionChainNotApprovedError } from './native';

// A wrapped error keeps the original under `cause`; the depth bound stops a cyclic chain.
const MAX_CAUSE_DEPTH = 8;

// MetaMask Smart Transactions does not broadcast a signed transaction itself. It sends it to the MetaMask relay
// (transaction.api.cx.metamask.io or a tx-sentinel host). When the relay answers with an HTTP 5xx, MetaMask rejects
// the request with the relay status and body as JSON, for example
// `Fetch error:{"status":500,"error":"Internal Server Error","statusCode":500}`. The same transaction goes through
// when the user turns Smart Transactions off. Both fields must be present, so that an RPC failure of a read that this
// wallet makes (viem writes `Status: 500`) does not match.
const RELAY_STATUS = /"status"\s*:\s*5\d\d\b/;
const RELAY_STATUS_CODE = /"statusCode"\s*:\s*5\d\d\b/;

function messageOf(err: unknown): string | undefined {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err !== 'object' || err === null) return undefined;
  const message = Reflect.get(err, 'message');
  return typeof message === 'string' ? message : undefined;
}

function causes(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    chain.push(current);
    current = typeof current === 'object' ? Reflect.get(current, 'cause') : undefined;
  }
  return chain;
}

function findChainNotApproved(err: unknown): NativeSessionChainNotApprovedError | undefined {
  return causes(err).find(cause => cause instanceof NativeSessionChainNotApprovedError);
}

function isSmartTransactionsRelayFailure(err: unknown): boolean {
  return causes(err).some(cause => {
    const message = messageOf(cause);
    return message !== undefined && RELAY_STATUS.test(message) && RELAY_STATUS_CODE.test(message);
  });
}

export function nativeSigningErrorId(
  err: unknown
): 'evmChainNotApproved' | 'evmWalletSmartTransactionsFailed' | undefined {
  if (findChainNotApproved(err)) return 'evmChainNotApproved';
  if (isSmartTransactionsRelayFailure(err)) return 'evmWalletSmartTransactionsFailed';
  return undefined;
}

/**
 * A native signing failure as the screen shows it. A chain that the connected session did not approve, found
 * anywhere in the cause chain, gets the localized reconnect message. A failure of the MetaMask Smart Transactions
 * relay gets the localized message that tells the user to turn Smart Transactions off. Every other failure keeps
 * its own message (`fallback` lets a caller keep its own wording for it).
 */
export function nativeSigningErrorMessage(
  err: unknown,
  t: TFunction,
  fallback: (err: unknown) => string = e => (e instanceof Error ? e.message : String(e))
): string {
  const notApproved = findChainNotApproved(err);
  if (notApproved) return t('evmChainNotApproved', { network: notApproved.networkName });
  if (isSmartTransactionsRelayFailure(err)) return t('evmWalletSmartTransactionsFailed');
  return fallback(err);
}
