import Dexie from 'dexie';
import { IDBDatabase, IDBObjectStore } from 'fake-indexeddb';

import { ITransaction, ITransactionStatus } from './db/types';

describe('storage-loss regression', () => {
  let target: Dexie;
  let sequence = 0;

  beforeEach(async () => {
    jest.resetModules();
    const { createSchemaFor } = await import('./repo');
    target = createSchemaFor(`storage-loss-${Date.now()}-${sequence++}`);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    target.close();
    await Dexie.delete(target.name);
  });

  const row = (id: string): ITransaction => ({
    id,
    type: 'send',
    accountId: 'retained-account',
    status: ITransactionStatus.Queued,
    initiatedAt: 1,
    displayIcon: 'SEND'
  });

  it('blocks a later wallet mutation after an asynchronous quota request failure', async () => {
    await target.open();
    const transactions = target.table<ITransaction, string>('transactions');
    await transactions.add(row('retained'));

    const failure = new DOMException('Storage quota exceeded', 'QuotaExceededError');
    const originalAdd = IDBObjectStore.prototype.add;
    let failNextAdd = true;
    let requestErrorName: string | undefined;
    jest.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.transaction.db.name !== target.name || this.name !== 'transactions' || !failNextAdd) {
        return originalAdd.call(this, value, key);
      }
      failNextAdd = false;
      const rawStore: unknown = Reflect.get(this, '_rawObjectStore');
      if (rawStore === null || typeof rawStore !== 'object') throw new Error('Missing fake-indexeddb backing store');
      const originalStoreRecord: unknown = Reflect.get(rawStore, 'storeRecord');
      // add() binds the operation now; fake-indexeddb executes it later as a real request.
      Object.defineProperty(rawStore, 'storeRecord', {
        configurable: true,
        value: () => {
          throw failure;
        }
      });
      try {
        const request = originalAdd.call(this, value, key);
        request.addEventListener('error', () => {
          requestErrorName = request.error?.name;
        });
        return request;
      } finally {
        Object.defineProperty(rawStore, 'storeRecord', { configurable: true, value: originalStoreRecord });
      }
    });

    await expect(transactions.add(row('quota-failed'))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(requestErrorName).toBe('QuotaExceededError');

    const nextMutation = await transactions.add(row('must-not-land')).then(
      () => 'committed',
      () => 'blocked'
    );
    expect(nextMutation).toBe('blocked');
    await expect(transactions.get('must-not-land')).resolves.toBeUndefined();
    await expect(transactions.get('retained')).resolves.toEqual(row('retained'));
  });

  it('allows a healthy wallet mutation to commit', async () => {
    await target.open();
    const transactions = target.table<ITransaction, string>('transactions');

    await transactions.add(row('healthy'));

    await expect(transactions.get('healthy')).resolves.toEqual(row('healthy'));
  });

  it('allows a later wallet mutation after an ordinary transaction abort', async () => {
    await target.open();
    const transactions = target.table<ITransaction, string>('transactions');

    await expect(
      target.transaction('rw', transactions, async transaction => {
        await transactions.add(row('cancelled'));
        transaction.abort();
        throw new DOMException('User cancelled the transaction', 'AbortError');
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(transactions.get('cancelled')).resolves.toBeUndefined();

    await transactions.add(row('after-cancel'));

    await expect(transactions.get('after-cancel')).resolves.toEqual(row('after-cancel'));
  });

  it.each(['transactions', 'spendingLimits'])(
    'requests strict durability at the native IndexedDB boundary for %s writes',
    async tableName => {
      const originalTransaction = IDBDatabase.prototype.transaction;
      const writeOptions: unknown[] = [];
      // Dexie binds the backend transaction method while opening the database.
      jest.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        names,
        mode,
        options
      ) {
        if (this.name === target.name && mode === 'readwrite') writeOptions.push(options);
        return originalTransaction.call(this, names, mode, options);
      });
      await target.open();

      if (tableName === 'transactions') {
        await target.table<ITransaction, string>(tableName).add(row('strict'));
      } else {
        await target.table<{ accountId: string; revision: string }, string>(tableName).add({
          accountId: 'retained-account',
          revision: 'strict'
        });
      }

      expect(writeOptions.length).toBeGreaterThan(0);
      for (const options of writeOptions) expect(options).toEqual({ durability: 'strict' });
    }
  );
});
