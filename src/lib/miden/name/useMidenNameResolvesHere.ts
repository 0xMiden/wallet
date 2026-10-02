/**
 * The "resolves to this account" check of an owned Miden Name.
 */

import { useEffect, useState } from 'react';

import { compareAccountIds } from 'lib/miden/activity/utils';

import { isMidenNameSupported } from './config';
import { MidenNameAbortedError } from './errors';
import { fetchDomainRecordAccount } from './resolver';

/**
 * True when the registry record of the label points to the account.
 *
 * The check runs only when the network has a Miden Name deployment. While the
 * registry has no record for the label, the result is false. Each new account
 * or label cancels the previous check.
 */
export function useMidenNameResolvesHere(accountId: string | undefined, label: string | undefined): boolean {
  const [resolves, setResolves] = useState(false);

  useEffect(() => {
    setResolves(false);
    if (!accountId || label === undefined || !isMidenNameSupported()) return undefined;

    let cancelled = false;
    fetchDomainRecordAccount(label)
      .then(record => {
        if (!cancelled) setResolves(record !== null && compareAccountIds(record, accountId));
      })
      .catch(error => {
        if (!cancelled && !(error instanceof MidenNameAbortedError)) {
          console.warn('[miden-name] Record read failed:', error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, label]);

  return resolves;
}
