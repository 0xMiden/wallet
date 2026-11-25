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

import { useEffect, useState } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { compareAccountIds } from 'lib/miden/activity/utils';

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

interface RecordSnapshot {
  accountId: string | undefined;
  label: string | undefined;
  refreshKey: string;
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
  supported: boolean
): boolean {
  return (
    snapshot.accountId === accountId &&
    snapshot.label === label &&
    snapshot.refreshKey === refreshKey &&
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
  const supported = isMidenNameSupported();
  const fallbackState = defaultRecordState(accountId, label, supported);
  const [snapshot, setSnapshot] = useState<RecordSnapshot>(() => ({
    accountId,
    label,
    refreshKey,
    supported,
    state: fallbackState
  }));

  useEffect(() => {
    setSnapshot(prev =>
      sameQuery(prev, accountId, label, refreshKey, supported)
        ? prev
        : { accountId, label, refreshKey, supported, state: fallbackState }
    );

    if (!accountId || label === undefined || !supported || !active) {
      return undefined;
    }

    let cancelled = false;
    const read = () => {
      fetchDomainRecordAccount(label)
        .then(record => {
          if (cancelled) return;
          const nextState: MidenNameRecordState =
            record === null ? 'none' : compareAccountIds(record, accountId) ? 'here' : 'elsewhere';
          setSnapshot({ accountId, label, refreshKey, supported, state: nextState });
        })
        .catch(error => {
          if (cancelled || isMidenNameAbortedError(error)) return;
          console.warn('[miden-name] Record read failed:', error);
          setSnapshot({ accountId, label, refreshKey, supported, state: 'checking' });
        });
    };

    read();
    const timer = setInterval(read, MIDEN_NAME_RECORD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [accountId, label, refreshKey, supported, active, fallbackState]);

  return sameQuery(snapshot, accountId, label, refreshKey, supported) ? snapshot.state : fallbackState;
}
