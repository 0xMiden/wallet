import { useEffect } from 'react';

import Dexie from 'dexie';

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
import { BADGE_STORAGE_KEY, readEarnedBadges, type BadgeId } from './types';

let completedScanSignature: string | undefined;

export function __resetBadgeBackfillScanForTests(): void {
  completedScanSignature = undefined;
}

async function readIndexedRows(wanted: readonly BadgeId[]) {
  const types = evidenceTypes(wanted);
  const indexes = [
    '[badgeNetwork+status+type+badgeEvidenceRevision]',
    '[recoveredBadgeNetwork+status+type+badgeEvidenceRevision]'
  ] as const;
  const queries = indexes.flatMap(index =>
    types.map(type => ({
      index,
      query: Repo.transactions
        .where(index)
        .between(
          ['mainnet', ITransactionStatus.Completed, type, Dexie.minKey],
          ['mainnet', ITransactionStatus.Completed, type, Dexie.maxKey]
        )
    }))
  );
  const signatureRows = await Promise.all(
    queries.map(async ({ query }) => {
      const [ids, keys] = await Promise.all([query.primaryKeys(), query.keys()]);
      return ids
        .map((id, index) => {
          const key = keys[index] as unknown as readonly unknown[];
          return [String(id), key[3]] as const;
        })
        .sort(([left], [right]) => left.localeCompare(right));
    })
  );
  return {
    signatureRows,
    async materialize() {
      const rows = await Promise.all(queries.map(({ query }) => query.toArray()));
      const byId = new Map<string, (typeof rows)[number][number]>();
      rows.forEach((batch, index) => {
        for (const row of batch) {
          const previous = byId.get(row.id);
          const fromOrdinaryIndex = queries[index]?.index === indexes[0];
          if (!previous || fromOrdinaryIndex) byId.set(row.id, row);
        }
      });
      return [...byId.values()];
    }
  };
}

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
      __resetBadgeBackfillScanForTests();
    });
    let signatureToCommit: string | undefined;
    const isCurrent = () =>
      active && getEffectiveNetworkName() === 'mainnet' && !hasCustomEndpointOverride(getActiveOverride());
    void backfillWalletBadges({
      readAwards: async () => readEarnedBadges(await fetchFromStorage(BADGE_STORAGE_KEY)),
      readTransactions: async wanted => {
        const indexed = await readIndexedRows(wanted);
        signatureToCommit = JSON.stringify({ accountKey, networkId, wanted, rows: indexed.signatureRows });
        if (signatureToCommit === completedScanSignature) return [];
        return indexed.materialize();
      },
      accounts: accountKey ? accountKey.split('\n') : [],
      isCurrent: () =>
        active && getEffectiveNetworkName() === 'mainnet' && !hasCustomEndpointOverride(getActiveOverride()),
      mergeAwards: mergeBadgeAwards
    })
      .then(() => {
        if (signatureToCommit !== undefined && isCurrent()) completedScanSignature = signatureToCommit;
      })
      .catch(error => console.warn('[badges] history backfill failed', error));
    return () => {
      active = false;
      stopReset();
    };
  }, [accountKey, networkId]);
}
