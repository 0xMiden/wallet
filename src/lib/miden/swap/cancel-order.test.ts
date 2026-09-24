import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { cancelSwapOrder } from './cancel-order';

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn()
  }
}));

const NOW = 1_700_000_000;

type Row = Partial<ITransaction> & Record<string, unknown>;

/** The row the lookup returns, and the row the modify callback is handed. */
let storedRow: Row | undefined;
const modify = jest.fn();

const swapRow = (overrides: Row = {}): Row => ({
  id: 'tx-1',
  type: 'swap',
  status: ITransactionStatus.Completed,
  extraInputs: { orderId: 42n, requestedFaucetId: 'req', requestedAmount: 1000n, expiresAt: NOW + 120 },
  ...overrides
});

beforeEach(() => {
  jest.clearAllMocks();
  storedRow = swapRow();
  // One `where({ id })` chain serving both the read and the write, as Dexie does.
  jest.mocked(Repo.transactions.where).mockReturnValue({
    first: async () => storedRow,
    modify: (recipe: (row: Row) => unknown) => {
      modify(recipe);
      return Promise.resolve(storedRow === undefined ? 0 : 1);
    }
  } as unknown as ReturnType<typeof Repo.transactions.where>);
});

/** Runs whatever recipe the last `modify` was given against a row. */
const applyModify = (row: Row): unknown => {
  const recipe = modify.mock.calls.at(-1)?.[0] as (r: Row) => unknown;
  return recipe(row);
};

describe('cancelSwapOrder', () => {
  it('brings a live order’s expiry forward to now, which is all a reclaim needs', async () => {
    // There is no protocol cancel to call: the expiry is the wallet's own
    // bookkeeping, and moving it is what makes the next settlement tick reclaim
    // the tip through the path every order already takes when it times out.
    await cancelSwapOrder('tx-1', NOW);

    const row = swapRow();
    expect(applyModify(row)).toBeUndefined();
    expect(row.extraInputs).toEqual({
      orderId: 42n,
      requestedFaucetId: 'req',
      requestedAmount: 1000n,
      expiresAt: NOW
    });
  });

  it('gives an order that never carried an expiry the one that ends its wait', async () => {
    // Nothing deems such a row expired, so without this write it waits forever.
    storedRow = swapRow({ extraInputs: { orderId: 42n } });
    await cancelSwapOrder('tx-1', NOW);

    const row = swapRow({ extraInputs: { orderId: 42n } });
    applyModify(row);
    expect(row.extraInputs).toEqual({ orderId: 42n, expiresAt: NOW });
  });

  it('leaves an order whose expiry has already lapsed exactly as it found it', async () => {
    // A tick has already stamped `expiryTriggeredAt` and queued the consume;
    // rewriting the expiry there changes nothing on chain.
    await cancelSwapOrder('tx-1', NOW);

    const row = swapRow({ extraInputs: { orderId: 42n, expiresAt: NOW - 5, expiryTriggeredAt: NOW - 5 } });
    // `false` so Dexie skips the put rather than re-writing the unchanged clone.
    expect(applyModify(row)).toBe(false);
    expect(row.extraInputs).toEqual({ orderId: 42n, expiresAt: NOW - 5, expiryTriggeredAt: NOW - 5 });
  });

  it('refuses a row that is not a swap', async () => {
    storedRow = swapRow({ type: 'send' });
    await expect(cancelSwapOrder('tx-1', NOW)).rejects.toThrow('is not a swap');
    expect(modify).not.toHaveBeenCalled();
  });

  it('refuses a row restored from a backup, which settlement never looks at', async () => {
    // `localSwapOrders` excludes imported rows outright, so no tick would ever
    // act on the stamp - the write would be a button that could not work.
    storedRow = swapRow({ restoredFromBackup: true });
    await expect(cancelSwapOrder('tx-1', NOW)).rejects.toThrow('restored from a backup');
    expect(modify).not.toHaveBeenCalled();
  });

  it('refuses a swap whose place-order transaction has not completed', async () => {
    storedRow = swapRow({ status: ITransactionStatus.Queued, extraInputs: { requestedFaucetId: 'req' } });
    await expect(cancelSwapOrder('tx-1', NOW)).rejects.toThrow('no open order');
    expect(modify).not.toHaveBeenCalled();
  });

  it('refuses an order the user asked to settle by hand', async () => {
    // `reconcileSwapOrderNotes` skips it before it reads the expiry at all.
    storedRow = swapRow({ extraInputs: { orderId: 42n, autoConsume: false, expiresAt: NOW + 120 } });
    await expect(cancelSwapOrder('tx-1', NOW)).rejects.toThrow('settles manually');
    expect(modify).not.toHaveBeenCalled();
  });

  it('refuses a transaction that is not there', async () => {
    storedRow = undefined;
    await expect(cancelSwapOrder('tx-1', NOW)).rejects.toThrow('is not a swap');
    expect(modify).not.toHaveBeenCalled();
  });
});
