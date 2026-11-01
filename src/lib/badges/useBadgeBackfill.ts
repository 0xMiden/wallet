import { useEffect } from 'react';

import { ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front/client';
import { fetchFromStorage } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';
import {
  getActiveOverride,
  getEffectiveNetworkName,
  hasCustomEndpointOverride
} from 'lib/miden-chain/effective-endpoints';
import { onStorageCleared } from 'lib/storage-cleared';

import { backfillWalletBadges } from './backfill';
import { evidenceTypes } from './evidence';
import { mergeBadgeAwards } from './progress';
import { BADGE_STORAGE_KEY, readEarnedBadges } from './types';

export function useBadgeBackfill(networkId: string): void {
  const { accounts } = useMidenContext();
  const accountKey = accounts
    .map(account => account.publicKey)
    .sort()
    .join('\n');
  useEffect(() => {
    let active = true;
    const stopReset = onStorageCleared(() => {
      active = false;
    });
    backfillWalletBadges({
      readAwards: async () => readEarnedBadges(await fetchFromStorage(BADGE_STORAGE_KEY)),
      // Recovered rows store their network in recovery and have no badgeNetwork index entry.
      readTransactions: wanted =>
        Repo.transactions
          .where('type')
          .anyOf(evidenceTypes(wanted))
          .filter(row => row.status === ITransactionStatus.Completed)
          .toArray(),
      accounts: accountKey ? accountKey.split('\n') : [],
      isCurrent: () =>
        active && getEffectiveNetworkName() === 'mainnet' && !hasCustomEndpointOverride(getActiveOverride()),
      mergeAwards: mergeBadgeAwards
    }).catch(error => console.warn('[badges] history backfill failed', error));
    return () => {
      active = false;
      stopReset();
    };
  }, [accountKey, networkId]);
}
