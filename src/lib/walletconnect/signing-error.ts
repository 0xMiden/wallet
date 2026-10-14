import { TFunction } from 'i18next';

import { NativeSessionChainNotApprovedError } from './native';

// A wrapped error keeps the original under `cause`; the depth bound stops a cyclic chain.
const MAX_CAUSE_DEPTH = 8;

function findChainNotApproved(err: unknown): NativeSessionChainNotApprovedError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (current instanceof NativeSessionChainNotApprovedError) return current;
    current = typeof current === 'object' ? Reflect.get(current, 'cause') : undefined;
  }
  return undefined;
}

/**
 * A native signing failure as the screen shows it: a chain that the connected session did not
 * approve, found anywhere in the cause chain, gets the localized reconnect message, and every other
 * failure keeps its own message (`fallback` lets a caller keep its own wording for it).
 */
export function nativeSigningErrorMessage(
  err: unknown,
  t: TFunction,
  fallback: (err: unknown) => string = e => (e instanceof Error ? e.message : String(e))
): string {
  const notApproved = findChainNotApproved(err);
  return notApproved ? t('evmChainNotApproved', { network: notApproved.networkName }) : fallback(err);
}
