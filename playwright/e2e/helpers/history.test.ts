/**
 * @jest-environment node
 */
import 'fake-indexeddb/auto';

import { describeTransactionRow, readTransactionRowsInPage, TxStatus } from './history';

it('names the Unconfirmed status instead of printing its number', () => {
  expect(TxStatus.Unconfirmed).toBe(4);
  expect(describeTransactionRow({ id: 'r1', status: 4 })).toContain(' Unconfirmed ');
});

describe('readTransactionRowsInPage', () => {
  // Not TridentMain: jest.setup.js reopens that one at the wallet's real schema after every test.
  const query = { dbName: 'HistoryProjectionTest', storeName: 'transactions' };

  const seed = async (rows: Array<Record<string, unknown>>): Promise<void> => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(query.dbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(query.storeName, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(query.storeName, 'readwrite');
      for (const row of rows) tx.objectStore(query.storeName).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  afterEach(
    () =>
      new Promise<void>(resolve => {
        const request = indexedDB.deleteDatabase(query.dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      })
  );

  it('carries extraInputs JSON-safe: bigints as decimal strings and bytes as base64, at any depth', async () => {
    await seed([
      {
        id: 'b1',
        type: 'bridged-send',
        status: 2,
        feeAmount: 133n,
        extraInputs: {
          provider: 'usdcx',
          destinationNetwork: 5042002,
          usdcxBurn: { noteId: '0xab', destinationBalanceBefore: { balance: '0', blockNumber: '66531904' } },
          nested: [1n, new Uint8Array([1, 2, 255]), null, undefined],
          absent: undefined
        }
      }
    ]);

    const [row] = (await readTransactionRowsInPage(query)) ?? [];

    expect(row?.feeAmount).toBe('133');
    expect(row?.extraInputs).toEqual({
      provider: 'usdcx',
      destinationNetwork: 5042002,
      usdcxBurn: { noteId: '0xab', destinationBalanceBefore: { balance: '0', blockNumber: '66531904' } },
      nested: ['1', 'AQL/', null, null]
    });
  });

  it('carries stageTimestamps, submitEvidence and resultReleasedAt', async () => {
    await seed([
      {
        id: 'b1',
        type: 'bridged-send',
        stageTimestamps: { syncing: 1791663048764, 'creating-proposal': 1791663049003, broken: 'x' },
        submitEvidence: [
          { attemptId: 'a1', capturedAt: 1791663051, outputNoteIds: ['0x96', '0x4b'], verdict: undefined }
        ],
        resultReleasedAt: 1791663653
      }
    ]);

    const [row] = (await readTransactionRowsInPage(query)) ?? [];

    expect(row?.stageTimestamps).toEqual({ syncing: 1791663048764, 'creating-proposal': 1791663049003 });
    expect(row?.submitEvidence).toEqual([{ attemptId: 'a1', capturedAt: 1791663051, outputNoteIds: ['0x96', '0x4b'] }]);
    expect(row?.resultReleasedAt).toBe(1791663653);
  });

  it('leaves the byte fields out unless asked, and reads one type when asked', async () => {
    await seed([
      {
        id: 'b1',
        type: 'bridged-send',
        outputNoteIds: ['0x96'],
        requestBytes: new Uint8Array([7, 8]),
        resultBytes: new Uint8Array([0, 1, 2])
      },
      { id: 'c1', type: 'consume' }
    ]);

    const plain = (await readTransactionRowsInPage(query)) ?? [];
    const withBytes = (await readTransactionRowsInPage({ ...query, type: 'bridged-send', withBytes: true })) ?? [];

    expect(plain.map(row => [row.id, row.requestBytes, row.resultBytes, row.outputNoteIds])).toEqual([
      ['b1', undefined, undefined, undefined],
      ['c1', undefined, undefined, undefined]
    ]);
    expect(withBytes.map(row => [row.id, row.requestBytes, row.resultBytes, row.outputNoteIds])).toEqual([
      ['b1', [7, 8], 'AAEC', ['0x96']]
    ]);
  });

  it('encodes a result larger than one call can spread', async () => {
    const resultBytes = new Uint8Array(600_000).map((_, index) => index % 251);
    await seed([{ id: 'b1', type: 'bridged-send', resultBytes }]);

    const [row] = (await readTransactionRowsInPage({ ...query, withBytes: true })) ?? [];

    expect(Buffer.from(row?.resultBytes ?? '', 'base64').equals(Buffer.from(resultBytes))).toBe(true);
  });

  it('is null, not empty, when the database has no transactions store', async () => {
    await expect(readTransactionRowsInPage({ dbName: query.dbName, storeName: 'missing' })).resolves.toBeNull();
  });
});
