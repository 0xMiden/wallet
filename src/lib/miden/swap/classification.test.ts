import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { localSwapOrders } from './classification';

// `settlement.test.ts` mocks `Repo.transactions.filter` to return a fixed array,
// so the predicate inside `localSwapOrders` never actually runs there. These
// apply it, which is the only way its clauses can be pinned.
jest.mock('lib/miden/repo', () => ({
  transactions: { filter: jest.fn(), where: jest.fn() }
}));

const ACCOUNT = 'account-1';

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'swap-1',
  type: 'swap',
  status: ITransactionStatus.Completed,
  accountId: ACCOUNT,
  initiatedAt: 10,
  completedAt: 100,
  extraInputs: { requestedFaucetId: 'requested', requestedAmount: 50n, orderId: 77n },
  ...overrides
});

/** Run the real predicate over `rows`, the way Dexie would. */
const withRows = (rows: unknown[]) => {
  (Repo.transactions.filter as jest.Mock).mockImplementation((predicate: (row: unknown) => boolean) => ({
    toArray: async () => rows.filter(predicate)
  }));
};

describe('localSwapOrders', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns this account’s completed swap orders', async () => {
    withRows([order()]);

    expect(await localSwapOrders(ACCOUNT)).toHaveLength(1);
  });

  it.each([
    ['another account', { accountId: 'someone-else' }],
    ['a row that is not complete', { status: ITransactionStatus.Failed }],
    ['a swap with no order id', { extraInputs: { requestedFaucetId: 'r', requestedAmount: 1n } }]
  ])('excludes %s', async (_label, overrides) => {
    withRows([order(overrides)]);

    expect(await localSwapOrders(ACCOUNT)).toEqual([]);
  });
});
