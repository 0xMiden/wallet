/**
 * The "resolves to this account" check of an owned Miden Name.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { compareAccountIds } from 'lib/miden/activity/utils';
import { subscribeEffectiveEndpoints } from 'lib/miden-chain/effective-endpoints';

import { isMidenNameSupported } from './config';
import { MidenNameAbortedError } from './errors';
import { fetchDomainRecordAccount } from './resolver';

interface ResolvesSnapshot {
  accountId: string | undefined;
  label: string | undefined;
  supported: boolean;
  resolves: boolean;
}

function sameQuery(
  snapshot: ResolvesSnapshot,
  accountId: string | undefined,
  label: string | undefined,
  supported: boolean
): boolean {
  return snapshot.accountId === accountId && snapshot.label === label && snapshot.supported === supported;
}

/**
 * True when the registry record of the label points to the account.
 *
 * The check runs only when the network has a Miden Name deployment. While the
 * registry has no record for the label, the result is false. Each new account
 * or label cancels the previous check.
 */
export function useMidenNameResolvesHere(accountId: string | undefined, label: string | undefined): boolean {
  const supported = useSyncExternalStore(subscribeEffectiveEndpoints, isMidenNameSupported, isMidenNameSupported);
  const [snapshot, setSnapshot] = useState<ResolvesSnapshot>(() => ({
    accountId,
    label,
    supported,
    resolves: false
  }));

  useEffect(() => {
    setSnapshot(prev =>
      sameQuery(prev, accountId, label, supported) ? prev : { accountId, label, supported, resolves: false }
    );
    if (!accountId || label === undefined || !supported) return undefined;

    let cancelled = false;
    fetchDomainRecordAccount(label)
      .then(record => {
        if (!cancelled) {
          setSnapshot({
            accountId,
            label,
            supported,
            resolves: record !== null && compareAccountIds(record, accountId)
          });
        }
      })
      .catch(error => {
        if (!cancelled && !(error instanceof MidenNameAbortedError)) {
          console.warn('[miden-name] Record read failed:', error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, label, supported]);

  return sameQuery(snapshot, accountId, label, supported) ? snapshot.resolves : false;
}
