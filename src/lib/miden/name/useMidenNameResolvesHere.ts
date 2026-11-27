/**
 * The "resolves to this account" check of an owned Miden Name.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { compareAccountIds } from 'lib/miden/activity/utils';
import {
  getEffectiveNetworkName,
  getEffectiveRpcUrl,
  subscribeEffectiveEndpoints
} from 'lib/miden-chain/effective-endpoints';

import { isMidenNameSupported } from './config';
import { MidenNameAbortedError } from './errors';
import { fetchDomainRecordAccount } from './resolver';

const getRegistryScope = () => JSON.stringify([getEffectiveNetworkName(), getEffectiveRpcUrl()]);

interface ResolvesSnapshot {
  accountId: string | undefined;
  label: string | undefined;
  scope: string;
  supported: boolean;
  resolves: boolean;
}

function sameQuery(
  snapshot: ResolvesSnapshot,
  accountId: string | undefined,
  label: string | undefined,
  scope: string,
  supported: boolean
): boolean {
  return (
    snapshot.accountId === accountId &&
    snapshot.label === label &&
    snapshot.scope === scope &&
    snapshot.supported === supported
  );
}

/**
 * True when the registry record of the label points to the account.
 *
 * The check runs only when the network has a Miden Name deployment. While the
 * registry has no record for the label, the result is false. Each new account
 * or label cancels the previous check.
 */
export function useMidenNameResolvesHere(accountId: string | undefined, label: string | undefined): boolean {
  const scope = useSyncExternalStore(subscribeEffectiveEndpoints, getRegistryScope, getRegistryScope);
  const supported = useSyncExternalStore(subscribeEffectiveEndpoints, isMidenNameSupported, isMidenNameSupported);
  const [snapshot, setSnapshot] = useState<ResolvesSnapshot>(() => ({
    accountId,
    label,
    scope,
    supported,
    resolves: false
  }));

  useEffect(() => {
    setSnapshot(prev =>
      sameQuery(prev, accountId, label, scope, supported)
        ? prev
        : { accountId, label, scope, supported, resolves: false }
    );
    if (!accountId || label === undefined || !supported) return undefined;

    let cancelled = false;
    fetchDomainRecordAccount(label)
      .then(record => {
        if (!cancelled) {
          setSnapshot({
            accountId,
            label,
            scope,
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
  }, [accountId, label, scope, supported]);

  return sameQuery(snapshot, accountId, label, scope, supported) ? snapshot.resolves : false;
}
