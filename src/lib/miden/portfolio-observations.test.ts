import { IDBCursor, IDBIndex } from 'fake-indexeddb';

import {
  prunePortfolioObservations,
  readPortfolioObservations,
  recordPortfolioObservation,
  type PortfolioObservation
} from './portfolio-observations';
import { db, exportDb, Table } from './repo';

const scope = { accountId: 'account-a', network: 'testnet', rpcUrl: 'https://node-a' };
const bucketMs = 15 * 60_000;
const yearMs = 365 * 24 * 60 * 60_000;
const now = 1_800_000_000_000;
const observation = (capturedAt: number, changes: Partial<PortfolioObservation> = {}): PortfolioObservation => ({
  ...scope,
  currency: 'USD',
  bucket: Math.floor(capturedAt / bucketMs) * bucketMs,
  capturedAt,
  value: '12.50',
  coverage: 'complete',
  coverageKey: 'priced:a',
  ...changes
});

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(now);
  await db.table(Table.PortfolioObservations).clear();
});
afterEach(() => jest.restoreAllMocks());

it('serializes concurrent upserts within a bucket and preserves the exact next bucket boundary', async () => {
  const base = Math.floor(now / bucketMs) * bucketMs - bucketMs;
  await Promise.all([
    recordPortfolioObservation(observation(base + 1)),
    recordPortfolioObservation(observation(base + 2, { value: '13.75' })),
    recordPortfolioObservation(observation(base + bucketMs, { value: '14.00' }))
  ]);
  const rows = await readPortfolioObservations(scope, base);
  expect(rows).toHaveLength(2);
  expect(rows.map(row => row.bucket)).toEqual([base, base + bucketMs]);
  expect(rows[0]).toMatchObject({ value: '13.75', capturedAt: base + 2 });
});

it('separates account, network and RPC history, and does not export observations', async () => {
  await Promise.all([
    recordPortfolioObservation(observation(now)),
    recordPortfolioObservation(observation(now, { accountId: 'account-b', coverage: 'partial' })),
    recordPortfolioObservation(observation(now, { network: 'devnet' })),
    recordPortfolioObservation(observation(now, { rpcUrl: 'https://node-b' }))
  ]);
  expect(await readPortfolioObservations(scope, 0)).toEqual([observation(now)]);
  expect(JSON.parse(await exportDb())).toEqual({ [Table.Transactions]: expect.any(Array) });
  await prunePortfolioObservations(['account-b']);
  expect(await readPortfolioObservations(scope, 0)).toEqual([]);
  expect(await readPortfolioObservations({ ...scope, accountId: 'account-b' }, 0)).toHaveLength(1);
});

it('reads a valid capture at the exact year cutoff even when its bucket begins earlier', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(now + 1_234);
  const cutoff = now + 1_234 - yearMs;
  await recordPortfolioObservation(observation(cutoff));
  expect(await readPortfolioObservations(scope, cutoff)).toEqual([observation(cutoff)]);
});

it('prunes aged rows even for retained accounts when the ready account list changes', async () => {
  await db.table(Table.PortfolioObservations).bulkPut([observation(now - yearMs - bucketMs), observation(now)]);
  await prunePortfolioObservations([scope.accountId]);
  expect(await readPortfolioObservations(scope, 0)).toEqual([observation(now)]);
  expect(await db.table(Table.PortfolioObservations).count()).toBe(1);
});

it('avoids advancing a cursor by the full retention cap when only a few scoped rows exist', async () => {
  await db
    .table(Table.PortfolioObservations)
    .bulkPut([
      observation(now - 2 * bucketMs),
      observation(now - bucketMs),
      observation(now - bucketMs, { accountId: 'account-b' })
    ]);
  const advance = jest.spyOn(IDBCursor.prototype, 'advance');
  const count = jest.spyOn(IDBIndex.prototype, 'count');
  const keys = jest.spyOn(IDBIndex.prototype, 'getAllKeys');
  await recordPortfolioObservation(observation(now));
  expect(advance).not.toHaveBeenCalled();
  expect(count).not.toHaveBeenCalled();
  expect(keys).toHaveBeenCalled();
  expect((await readPortfolioObservations(scope, 0)).map(row => row.bucket)).toEqual([
    now - 2 * bucketMs,
    now - bucketMs,
    now
  ]);
  expect(await readPortfolioObservations({ ...scope, accountId: 'account-b' }, 0)).toHaveLength(1);
});

it('deletes already-stored rows older than a year but retains the exact cutoff', async () => {
  await db
    .table(Table.PortfolioObservations)
    .bulkPut([observation(now - yearMs - bucketMs), observation(now - yearMs)]);
  await recordPortfolioObservation(observation(now));
  expect((await readPortfolioObservations(scope, 0)).map(row => row.bucket)).toEqual([now - yearMs, now]);
});

// CI-only high-cardinality fake-indexeddb fixture; local guarded runs select the other named cases.
it('retains at most 35,040 points even when all 35,041 are within the one-year window', async () => {
  const start = performance.now();
  await db
    .table(Table.PortfolioObservations)
    .bulkPut(Array.from({ length: 35_040 }, (_, index) => observation(now - (35_040 - index) * bucketMs)));
  const seededAt = performance.now();
  process.stdout.write(`[portfolio-observations] seed=${Math.round(seededAt - start)}ms\n`);
  await recordPortfolioObservation(observation(now));
  const prunedAt = performance.now();
  process.stdout.write(`[portfolio-observations] prune=${Math.round(prunedAt - seededAt)}ms\n`);
  const rows = await readPortfolioObservations(scope, 0);
  expect(rows).toHaveLength(35_040);
  expect(rows[0]?.bucket).toBe(now - 35_039 * bucketMs);
  expect(rows.at(-1)?.bucket).toBe(now);
  process.stdout.write(`[portfolio-observations] read=${Math.round(performance.now() - prunedAt)}ms\n`);
}, 120_000);
