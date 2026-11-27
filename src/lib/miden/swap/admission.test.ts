import { ITransactionStatus, SendTransaction } from 'lib/miden/db/types';
import { transactions } from 'lib/miden/repo';
import { queueOutgoingTransaction, spendsOf } from 'lib/miden/spending-limits/queue';
import { NoteTypeEnum } from 'lib/miden/types';

import { assertSwapQueueAvailable } from './admission';

jest.mock('lib/i18n/core', () => ({ getMessage: (key: string) => key }));
jest.mock('lib/miden/sdk/helpers', () => ({
  sameWalletAccountId: (a: string, b: string) => a === b,
  canonicalWalletAccountId: (a: string) => a
}));
jest.mock('lib/miden-chain/native-asset', () => ({ cacheScope: () => 'testnet|rpc' }));
const row = (id: string) => {
  const tx = new SendTransaction('account', 10n, 'recipient', 'pay', NoteTypeEnum.Public);
  tx.id = id;
  return tx;
};
const queue = (id: string) => {
  const tx = row(id);
  return queueOutgoingTransaction(tx, spendsOf(tx), undefined, undefined, () =>
    assertSwapQueueAvailable('account', 'testnet|rpc')
  );
};
it.each([ITransactionStatus.Queued, ITransactionStatus.GeneratingTransaction, ITransactionStatus.Unconfirmed])(
  'refuses an unresolved outgoing spend with status %s',
  async status => {
    await transactions.add({ ...row('existing'), status });
    await expect(queue('swap')).rejects.toThrow('swapPendingSpend');
    await expect(transactions.get('swap')).resolves.toBeUndefined();
  }
);
it('admits only one concurrent swap against the same vault', async () => {
  const results = await Promise.allSettled([queue('a'), queue('b')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await transactions.count()).toBe(1);
});
it('does not reserve funds for a completed outgoing transaction', async () => {
  await transactions.add({ ...row('existing'), status: ITransactionStatus.Completed });
  await expect(queue('swap')).resolves.toBeUndefined();
});
it('rejects a changed endpoint before inserting', async () => {
  await expect(assertSwapQueueAvailable('account', 'other')).rejects.toThrow('swapBalanceUnavailable');
});

it('does not assume a pending claim leaves the fee balance available', async () => {
  await transactions.add({ ...row('claim'), type: 'consume' });
  await expect(queue('swap')).rejects.toThrow('swapPendingSpend');
});

it('stops after the first matching pending row inside the rw transaction and supports stripped mocks', async () => {
  await transactions.clear();
  await transactions.bulkAdd(
    Array.from({ length: 20 }, (_, i) => ({ ...row(`q-${i}`), status: ITransactionStatus.Queued }))
  );

  const filterSpy = jest.spyOn(transactions, 'filter');
  const whereSpy = jest.spyOn(transactions, 'where');
  let continueCalls = 0;
  const origOpenCursor = transactions.core.openCursor.bind(transactions.core);
  transactions.core.openCursor = req =>
    origOpenCursor(req).then(cursor => {
      if (cursor) {
        const origContinue = cursor.continue.bind(cursor);
        cursor.continue = (...args) => {
          continueCalls += 1;
          return origContinue(...args);
        };
      }
      return cursor;
    });
  try {
    await expect(queue('swap')).rejects.toThrow('swapPendingSpend');
    expect(filterSpy).not.toHaveBeenCalled();
    expect(whereSpy).not.toHaveBeenCalled();
    expect(continueCalls).toBe(0);
  } finally {
    transactions.core.openCursor = origOpenCursor;
    filterSpy.mockRestore();
    whereSpy.mockRestore();
  }

  const origSchema = Object.getOwnPropertyDescriptor(transactions, 'schema');
  const origFilter = Object.getOwnPropertyDescriptor(transactions, 'filter');
  const strippedWhereSpy = jest.spyOn(transactions, 'where').mockImplementation((() => {
    throw new Error('must not call where on stripped mock');
  }) as never);
  Object.defineProperty(transactions, 'schema', { value: undefined, configurable: true });
  Object.defineProperty(transactions, 'filter', { value: undefined, configurable: true });
  try {
    await expect(assertSwapQueueAvailable('account', 'testnet|rpc')).rejects.toThrow('swapPendingSpend');
  } finally {
    if (origSchema) Object.defineProperty(transactions, 'schema', origSchema);
    else delete (transactions as unknown as Record<string, unknown>).schema;
    if (origFilter) Object.defineProperty(transactions, 'filter', origFilter);
    else delete (transactions as unknown as Record<string, unknown>).filter;
    strippedWhereSpy.mockRestore();
    await transactions.clear();
  }
});
