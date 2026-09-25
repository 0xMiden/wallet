/**
 * Live registry-record state of one Miden Name, read from the chain.
 *
 * The registry's `domain_to_account` record is what makes `alice.miden` usable
 * in a send. The wallet's own rows only say what IT did; a record published
 * from another device, or one that is not there yet, is visible only on chain.
 * So this hook reads the record by RPC (no cache), again on every change of
 * `refreshKey` (the caller passes the phases of its publish rows), and every
 * `MIDEN_NAME_RECORD_POLL_MS` while the page is on screen.
 */

import { useEffect, useState } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { compareAccountIds } from 'lib/miden/activity/utils';

import { isMidenNameSupported } from './config';
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

/**
 * The record state of `label` for `accountId`. Returns `'checking'` until the
 * first read finished, and `'none'` on a network with no deployment.
 */
export function useMidenNameRecord(
  accountId: string | undefined,
  label: string | undefined,
  refreshKey: string = ''
): MidenNameRecordState {
  const [state, setState] = useState<MidenNameRecordState>('checking');
  const active = usePageActive();

  useEffect(() => {
    if (!accountId || label === undefined) {
      setState('checking');
      return undefined;
    }
    if (!isMidenNameSupported()) {
      setState('none');
      return undefined;
    }

    let cancelled = false;
    const read = () => {
      fetchDomainRecordAccount(label)
        .then(record => {
          if (cancelled) return;
          if (record === null) {
            setState('none');
            return;
          }
          setState(compareAccountIds(record, accountId) ? 'here' : 'elsewhere');
        })
        .catch(error => {
          if (!cancelled) console.warn('[miden-name] Record read failed:', error);
        });
    };

    read();
    const timer = active ? setInterval(read, MIDEN_NAME_RECORD_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [accountId, label, refreshKey, active]);

  return state;
}
