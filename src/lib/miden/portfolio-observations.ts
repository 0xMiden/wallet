import Dexie from 'dexie';

import type { AccountScope } from 'lib/miden-chain/account-scope';

import { db, Table } from './repo';

export interface PortfolioObservation extends AccountScope {
  currency: 'USD';
  bucket: number;
  capturedAt: number;
  value: string;
  coverage: 'complete' | 'partial';
  coverageKey: string;
}

const BUCKET_MS = 15 * 60_000;
const YEAR_MS = 365 * 24 * 60 * 60_000;
const MAX_POINTS = 35_040;
const observations = db.table<PortfolioObservation, [string, string, string, string, number]>(
  Table.PortfolioObservations
);
const scopeKey = (scope: AccountScope): [string, string, string, 'USD'] => [
  scope.accountId,
  scope.network,
  scope.rpcUrl,
  'USD'
];

export async function recordPortfolioObservation(observation: PortfolioObservation): Promise<void> {
  if (
    !Number.isFinite(observation.capturedAt) ||
    observation.capturedAt > Date.now() ||
    observation.capturedAt < Date.now() - YEAR_MS ||
    observation.bucket !== Math.floor(observation.capturedAt / BUCKET_MS) * BUCKET_MS ||
    !Number.isFinite(Number(observation.value)) ||
    Number(observation.value) < 0
  )
    return;
  await db.transaction('rw', observations, async () => {
    const key: [string, string, string, 'USD', number] = [...scopeKey(observation), observation.bucket];
    const previous = await observations.get(key);
    if (!previous || observation.capturedAt >= previous.capturedAt) await observations.put(observation);
    const scope = scopeKey(observation);
    await observations
      .where('[accountId+network+rpcUrl+currency+capturedAt]')
      .between([...scope, 0], [...scope, Date.now() - YEAR_MS], true, false)
      .delete();
    if (!previous) {
      const excess = await observations
        .where('[accountId+network+rpcUrl+currency+capturedAt]')
        .between([...scope, 0], [...scope, Dexie.maxKey])
        .reverse()
        .offset(MAX_POINTS)
        .primaryKeys();
      if (excess.length) await observations.bulkDelete(excess);
    }
  });
}

export async function readPortfolioObservations(
  scope: AccountScope,
  from: number
): Promise<readonly PortfolioObservation[]> {
  const cutoff = Math.max(from, Date.now() - YEAR_MS);
  const rows = await observations
    .where('[accountId+network+rpcUrl+currency+bucket]')
    .between([...scopeKey(scope), Math.floor(cutoff / BUCKET_MS) * BUCKET_MS], [...scopeKey(scope), Dexie.maxKey])
    .toArray();
  return rows.filter(row => row.capturedAt >= cutoff);
}

export async function prunePortfolioObservations(retainedAccountIds: readonly string[]): Promise<void> {
  const retained = new Set(retainedAccountIds);
  await db.transaction('rw', observations, async () => {
    const cutoff = Date.now() - YEAR_MS;
    const removed = await observations
      .filter(row => !retained.has(row.accountId) || row.capturedAt < cutoff)
      .primaryKeys();
    if (removed.length) await observations.bulkDelete(removed);
  });
}
