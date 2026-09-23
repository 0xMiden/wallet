/**
 * The "resolves to this account" check of an owned Miden Name.
 */

import { useEffect, useState } from 'react';

import { isMidenNameResolveEnabled } from 'lib/feature-flags';

import { reverseResolveMidenName } from './resolver';

/**
 * True when the registry reverse record of the account is the label.
 *
 * The check runs only when name resolution is enabled. In v1 the registry has no
 * records, so the result is always false. Each new account or label cancels the
 * previous check.
 */
export function useMidenNameResolvesHere(accountId: string | undefined, label: string | undefined): boolean {
  const [resolves, setResolves] = useState(false);

  useEffect(() => {
    setResolves(false);
    if (!accountId || label === undefined || !isMidenNameResolveEnabled()) return undefined;

    const controller = new AbortController();
    reverseResolveMidenName(accountId, { signal: controller.signal })
      .then(found => {
        if (!controller.signal.aborted) setResolves(found === label);
      })
      .catch(error => {
        if (!controller.signal.aborted) console.warn('[miden-name] Reverse resolve failed:', error);
      });
    return () => controller.abort();
  }, [accountId, label]);

  return resolves;
}
