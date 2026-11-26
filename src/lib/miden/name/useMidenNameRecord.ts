/**
 * Live registry-record state of one Miden Name, read from the chain.
 *
 * The registry's `domain_to_account` record is what makes `alice.miden` usable
 * in a send. The wallet's own rows only say what IT did; a record published
 * from another device, or one that is not there yet, is visible only on chain.
 * The registry writes the record when it mints the name, so this hook reads
 * the record by RPC (no cache), again on every change of `refreshKey`, and
 * every `MIDEN_NAME_RECORD_POLL_MS` while the page is on screen.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { compareAccountIds } from 'lib/miden/activity/utils';
import {
  getEffectiveNetworkName,
  getEffectiveRpcUrl,
  subscribeEffectiveEndpoints
} from 'lib/miden-chain/effective-endpoints';

import { isMidenNameSupported } from './config';
import { isMidenNameAbortedError } from './errors';
import { fetchDomainRecordAccount } from './resolver';

export type MidenNameRecordState =
  /** The read did not finish yet, or failed. */
  | 'checking'
  /** The registry record points to this account. */
  | 'here'
  /** The registry record points to an other account. */
  | 'elsewhere'
  /** The registry has no record for the label. */
  | 'none';

export const MIDEN_NAME_RECORD_POLL_MS = 15_000;

const getRegistryScope = () => JSON.stringify([getEffectiveNetworkName(), getEffectiveRpcUrl()]);

interface RecordSnapshot {
  accountId: string | undefined;
  label: string | undefined;
  refreshKey: string;
  scope: string;
  supported: boolean;
  state: MidenNameRecordState;
}

function defaultRecordState(
  accountId: string | undefined,
  label: string | undefined,
  supported: boolean
): MidenNameRecordState {
  if (!accountId || label === undefined) return 'checking';
  return supported ? 'checking' : 'none';
}

function sameQuery(
  snapshot: RecordSnapshot,
  accountId: string | undefined,
  label: string | undefined,
  refreshKey: string,
  scope: string,
  supported: boolean
): boolean {
  return (
    snapshot.accountId === accountId &&
    snapshot.label === label &&
    snapshot.refreshKey === refreshKey &&
    snapshot.scope === scope &&
    snapshot.supported === supported
  );
}

/**
 * The record state of `label` for `accountId`. Returns `'checking'` until the
 * first read finished, and `'none'` on a network with no deployment.
 */
export function useMidenNameRecord(
  accountId: string | undefined,
  label: string | undefined,
  refreshKey: string = ''
): MidenNameRecordState {
  const active = usePageActive();
  const scope = useSyncExternalStore(subscribeEffectiveEndpoints, getRegistryScope, getRegistryScope);
  const supported = useSyncExternalStore(subscribeEffectiveEndpoints, isMidenNameSupported, isMidenNameSupported);
  const fallbackState = defaultRecordState(accountId, label, supported);
  const [snapshot, setSnapshot] = useState<RecordSnapshot>(() => ({
    accountId,
    label,
    refreshKey,
    scope,
    supported,
    state: fallbackState
  }));

  useEffect(() => {
    setSnapshot(prev =>
      sameQuery(prev, accountId, label, refreshKey, scope, supported)
        ? prev
        : { accountId, label, refreshKey, scope, supported, state: fallbackState }
    );

    if (!accountId || label === undefined || !supported || !active) {
      return undefined;
    }

    let cancelled = false;
    let inFlight = false;
    let requestSeq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      if (cancelled) return;
      timer = setTimeout(read, MIDEN_NAME_RECORD_POLL_MS);
    };

    const read = () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const seq = ++requestSeq;
      fetchDomainRecordAccount(label)
        .then(record => {
          if (cancelled || seq !== requestSeq) return;
          const nextState: MidenNameRecordState =
            record === null ? 'none' : compareAccountIds(record, accountId) ? 'here' : 'elsewhere';
          setSnapshot({ accountId, label, refreshKey, scope, supported, state: nextState });
        })
        .catch(error => {
          if (cancelled || seq !== requestSeq || isMidenNameAbortedError(error)) return;
          console.warn('[miden-name] Record read failed:', error);
          setSnapshot({ accountId, label, refreshKey, scope, supported, state: 'checking' });
        })
        .finally(() => {
          inFlight = false;
          scheduleNext();
        });
    };

    read();
    return () => {
      cancelled = true;
      requestSeq += 1;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [accountId, label, refreshKey, scope, supported, active, fallbackState]);

  return sameQuery(snapshot, accountId, label, refreshKey, scope, supported) ? snapshot.state : fallbackState;
}
