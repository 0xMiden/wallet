/**
 * Dexie re-puts a deep clone of the row whenever a `.modify()` callback returns anything but
 * exactly `false`. A declining path that falls through therefore rewrites the row it meant to leave
 * alone — and for a Completed transaction that means rewriting the ~237 KB `resultBytes` this
 * module exists to reclaim, plus a `liveQuery` event for every observer of the table.
 *
 * Counted through the `updating` hook, which fires once per row dexie actually writes.
 */
import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { completeVerifiedLandedTransaction } from './helper';

const row = (over: Partial<ITransaction>): ITransaction =>
  ({
    id: 'tx-1',
    type: 'send',
    accountId: 'acc',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    completedAt: 1,
    resultBytes: new Uint8Array(1024),
    ...over
  }) as unknown as ITransaction;

describe('declining .modify() callbacks do not rewrite the row', () => {
  let written: string[];
  let unhook: (() => void) | undefined;

  beforeEach(async () => {
    await Repo.transactions.clear();
    written = [];
    const handler = (_mods: unknown, primKey: string) => {
      written.push(primKey);
    };
    Repo.transactions.hook('updating', handler);
    unhook = () => Repo.transactions.hook('updating').unsubscribe(handler);
  });

  afterEach(() => unhook?.());

  it('completeVerifiedLandedTransaction leaves an already-Completed row untouched', async () => {
    // The guard exists to refuse a Completed row. With a bare return dexie still re-puts it,
    // blob and all, and every liveQuery observer sees a change that did not happen.
    await Repo.transactions.put(row({ status: ITransactionStatus.Completed }));

    await completeVerifiedLandedTransaction('tx-1');

    expect(written).toEqual([]);
    expect((await Repo.transactions.get('tx-1'))?.resultBytes).toBeDefined();
  });

  it('still writes the row it is meant to reconcile', async () => {
    // The companion assertion: without it, `return false` on both arms would also pass.
    await Repo.transactions.put(row({ status: ITransactionStatus.Failed, error: 'boom' }));

    await completeVerifiedLandedTransaction('tx-1');

    expect(written).toEqual(['tx-1']);
    expect((await Repo.transactions.get('tx-1'))?.status).toBe(ITransactionStatus.Completed);
  });
});
