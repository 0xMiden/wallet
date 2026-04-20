import { ITransactionStatus, Transaction } from '../db/types';
import { NoteTypeEnum } from '../types';
// Import after mocks are set up
import {
  hasQueuedTransactions,
  getTransactionsInProgress,
  getAllUncompletedTransactions,
  getFailedTransactions,
  getCompletedTransactions,
  getTransactionById,
  cancelTransactionById,
  cancelTransaction,
  updateTransactionStatus,
  initiateSendTransaction,
  initiateConsumeTransaction,
  initiateConsumeTransactionFromId,
  cancelStuckTransactions,
  cancelStaleQueuedTransactions,
  generateTransaction,
  MAX_WAIT_BEFORE_CANCEL,
  MAX_QUEUED_AGE
} from './transactions';

// Mock functions defined inside factory to avoid hoisting issues with SWC
const mockTransactionsFilter = jest.fn();
const mockTransactionsWhere = jest.fn();
const mockTransactionsAdd = jest.fn();

jest.mock('lib/miden/repo', () => {
  // These will be assigned after module initialization
  return {
    get db() {
      return {
        // Run the body inline so the existing mockTransactionsWhere / mockTransactionsAdd
        // wiring the tests already set up still drives behavior. In prod, Dexie serializes
        // concurrent rw transactions at the DB level — this mock preserves the "body runs
        // with atomic check+add" contract without the real atomicity machinery.
        transaction: (_mode: string, _table: unknown, cb: () => Promise<unknown>) => cb()
      };
    },
    get transactions() {
      return {
        filter: mockTransactionsFilter,
        where: mockTransactionsWhere,
        add: mockTransactionsAdd
      };
    }
  };
});

const mockGetInputNote = jest.fn();
const mockSyncState = jest.fn().mockResolvedValue({ blockNum: () => 1 });
const mockGetMidenClient = jest.fn((): any => ({
  syncState: mockSyncState,
  getInputNote: mockGetInputNote
}));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  withWasmClientLock: jest.fn((fn: () => Promise<any>) => fn())
}));

jest.mock('./notes', () => ({
  importAllNotes: jest.fn(),
  queueNoteImport: jest.fn()
}));

describe('transactions utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('hasQueuedTransactions', () => {
    it('returns true when queued transactions exist', async () => {
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([{ id: 'tx-1', status: ITransactionStatus.Queued }])
      });

      const result = await hasQueuedTransactions();

      expect(result).toBe(true);
    });

    it('returns false when no queued transactions', async () => {
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([])
      });

      const result = await hasQueuedTransactions();

      expect(result).toBe(false);
    });
  });

  describe('getTransactionsInProgress', () => {
    it('returns transactions in GeneratingTransaction status sorted by initiatedAt', async () => {
      const tx1 = { id: 'tx-1', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 200 };
      const tx2 = { id: 'tx-2', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 100 };
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([tx1, tx2])
      });

      const result = await getTransactionsInProgress();

      expect(result[0]!.id).toBe('tx-2'); // Earlier initiatedAt first
      expect(result[1]!.id).toBe('tx-1');
    });
  });

  describe('getAllUncompletedTransactions', () => {
    it('returns queued and generating transactions', async () => {
      const txs = [
        { id: 'tx-1', status: ITransactionStatus.Queued, initiatedAt: 100 },
        { id: 'tx-2', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 200 }
      ];
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce(txs)
      });

      const result = await getAllUncompletedTransactions();

      expect(result).toHaveLength(2);
    });
  });

  describe('getFailedTransactions', () => {
    it('returns failed transactions sorted by initiatedAt', async () => {
      const tx1 = { id: 'tx-1', status: ITransactionStatus.Failed, initiatedAt: 200 };
      const tx2 = { id: 'tx-2', status: ITransactionStatus.Failed, initiatedAt: 100 };
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([tx1, tx2])
      });

      const result = await getFailedTransactions();

      expect(result[0]!.id).toBe('tx-2');
    });
  });

  describe('getCompletedTransactions', () => {
    it('returns completed transactions for account', async () => {
      const txs = [
        { id: 'tx-1', status: ITransactionStatus.Completed, accountId: 'acc-1', completedAt: 100 },
        { id: 'tx-2', status: ITransactionStatus.Completed, accountId: 'acc-2', completedAt: 200 }
      ];
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce(txs)
      });

      const result = await getCompletedTransactions('acc-1');

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('tx-1');
    });

    it('includes failed transactions when includeFailed is true', async () => {
      const completedTxs = [{ id: 'tx-1', status: ITransactionStatus.Completed, accountId: 'acc-1', completedAt: 100 }];
      const failedTxs = [{ id: 'tx-2', status: ITransactionStatus.Failed, accountId: 'acc-1', initiatedAt: 200 }];

      mockTransactionsFilter
        .mockReturnValueOnce({ toArray: jest.fn().mockResolvedValueOnce(completedTxs) })
        .mockReturnValueOnce({ toArray: jest.fn().mockResolvedValueOnce(failedTxs) });

      const result = await getCompletedTransactions('acc-1', undefined, undefined, true);

      expect(result).toHaveLength(2);
    });
  });

  describe('getTransactionById', () => {
    it('returns transaction when found', async () => {
      const tx = { id: 'tx-1', accountId: 'acc-1' };
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(tx)
      });

      const result = await getTransactionById('tx-1');

      expect(result).toEqual(tx);
    });

    it('throws when transaction not found', async () => {
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(undefined)
      });

      await expect(getTransactionById('nonexistent')).rejects.toThrow('Transaction not found');
    });
  });

  describe('cancelTransactionById', () => {
    it('cancels transaction when found', async () => {
      const tx = { id: 'tx-1' };
      const mockModify = jest.fn();
      mockTransactionsWhere
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(tx) })
        .mockReturnValueOnce({ modify: mockModify });

      await cancelTransactionById('tx-1', 'Test cancellation');

      expect(mockModify).toHaveBeenCalled();
    });

    it('does nothing when transaction not found', async () => {
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(undefined)
      });

      // Should not throw
      await expect(cancelTransactionById('nonexistent', 'Test cancellation')).resolves.toBeUndefined();
    });
  });

  describe('MAX_WAIT_BEFORE_CANCEL', () => {
    it('is 30 minutes in seconds', () => {
      expect(MAX_WAIT_BEFORE_CANCEL).toBe(30 * 60);
    });
  });

  describe('cancelTransaction', () => {
    it('marks transaction as failed with completedAt timestamp', async () => {
      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValueOnce({ modify: mockModify });

      const tx = { id: 'tx-1' } as Transaction;
      await cancelTransaction(tx, 'Test error');

      expect(mockTransactionsWhere).toHaveBeenCalledWith({ id: 'tx-1' });
      expect(mockModify).toHaveBeenCalled();
    });
  });

  describe('updateTransactionStatus', () => {
    it('updates transaction status and other values', async () => {
      const tx = { id: 'tx-1', status: ITransactionStatus.Queued };
      const mockModify = jest.fn();
      mockTransactionsWhere
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(tx) })
        .mockReturnValueOnce({ modify: mockModify });

      await updateTransactionStatus('tx-1', ITransactionStatus.GeneratingTransaction, {
        processingStartedAt: 12345
      });

      expect(mockModify).toHaveBeenCalled();
    });

    it('throws when transaction not found', async () => {
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(undefined)
      });

      await expect(updateTransactionStatus('nonexistent', ITransactionStatus.Completed, {})).rejects.toThrow(
        'No transaction found to update'
      );
    });

    it('throws when transaction already completed', async () => {
      const tx = { id: 'tx-1', status: ITransactionStatus.Completed };
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(tx)
      });

      await expect(updateTransactionStatus('tx-1', ITransactionStatus.Failed, {})).rejects.toThrow(
        'Transaction already in a finalized state'
      );
    });

    it('throws when transaction already failed', async () => {
      const tx = { id: 'tx-1', status: ITransactionStatus.Failed };
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(tx)
      });

      await expect(updateTransactionStatus('tx-1', ITransactionStatus.Completed, {})).rejects.toThrow(
        'Transaction already in a finalized state'
      );
    });
  });

  describe('initiateSendTransaction', () => {
    it('creates and adds a send transaction', async () => {
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateSendTransaction(
        'sender-account',
        'recipient-account',
        'faucet-id',
        NoteTypeEnum.Public,
        BigInt(1000),
        undefined,
        false
      );

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });
  });

  describe('initiateConsumeTransaction', () => {
    const note = {
      id: 'note-123',
      faucetId: 'faucet',
      amount: '100',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: NoteTypeEnum.Private
    };

    const mockDedupQuery = (rows: any[]) => {
      mockTransactionsWhere.mockReturnValueOnce({
        equals: jest.fn().mockReturnValueOnce({
          filter: jest.fn().mockReturnValueOnce({
            toArray: jest.fn().mockResolvedValueOnce(rows)
          })
        })
      });
    };

    it('creates consume transaction when none exists', async () => {
      mockDedupQuery([]);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });

    it('returns existing transaction id when a Queued consume exists for same note', async () => {
      const existingTx = {
        id: 'existing-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Queued,
        initiatedAt: 100
      };
      mockDedupQuery([existingTx]);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(result).toBe('existing-tx');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
    });

    it('returns existing transaction id when a Completed consume exists for same note', async () => {
      // This is the bug from issue #171: after a consume completes, getConsumableNotes()
      // can still return the note briefly. Without Completed dedup, auto-consume would
      // re-enqueue a fresh tx every SWR poll.
      const existingTx = {
        id: 'completed-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Completed,
        initiatedAt: 100,
        completedAt: 200
      };
      mockDedupQuery([existingTx]);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(result).toBe('completed-tx');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
    });

    it('creates a new transaction when only a Failed consume exists (retry allowed)', async () => {
      // Failed txs are excluded from the dedup filter, so the user can retry a consume
      // that previously failed. The Dexie query filter drops Failed rows, so we simulate
      // that here by returning [] from the filtered query.
      mockDedupQuery([]);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });

    it('does not dedup across different accounts', async () => {
      const otherAccountTx = {
        id: 'other-account-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-2',
        status: ITransactionStatus.Completed,
        initiatedAt: 100
      };
      mockDedupQuery([otherAccountTx]);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(result).not.toBe('other-account-tx');
      expect(mockTransactionsAdd).toHaveBeenCalled();
    });
  });

  describe('initiateConsumeTransactionFromId', () => {
    it('creates consume transaction from note id', async () => {
      mockGetInputNote.mockReturnValueOnce({
        metadata: () => ({ noteType: () => 'public' })
      });
      mockTransactionsWhere.mockReturnValueOnce({
        equals: jest.fn().mockReturnValueOnce({
          filter: jest.fn().mockReturnValueOnce({
            toArray: jest.fn().mockResolvedValueOnce([])
          })
        })
      });
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransactionFromId('account-1', 'note-456');

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });
  });

  describe('cancelStuckTransactions', () => {
    it('cancels transactions that exceed MAX_WAIT_BEFORE_CANCEL', async () => {
      const nowInSeconds = Math.floor(Date.now() / 1000);
      const stuckTx = {
        id: 'stuck-tx',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: 100,
        processingStartedAt: nowInSeconds - MAX_WAIT_BEFORE_CANCEL - 10 // 10 seconds past the limit
      };
      const recentTx = {
        id: 'recent-tx',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: 200,
        processingStartedAt: nowInSeconds
      };

      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([stuckTx, recentTx])
      });

      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValue({ modify: mockModify });

      await cancelStuckTransactions();

      // Should only cancel the stuck transaction
      expect(mockModify).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no transactions are stuck', async () => {
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([])
      });

      await cancelStuckTransactions();

      expect(mockTransactionsWhere).not.toHaveBeenCalled();
    });

    it('cancels transactions with undefined processingStartedAt', async () => {
      const crashedTx = {
        id: 'crashed-tx',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: 100,
        processingStartedAt: undefined
      };

      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([crashedTx])
      });

      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValue({ modify: mockModify });

      await cancelStuckTransactions();

      expect(mockModify).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancelStaleQueuedTransactions', () => {
    it('cancels queued transactions older than MAX_QUEUED_AGE', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const staleTx = {
        id: 'stale-tx',
        status: ITransactionStatus.Queued,
        initiatedAt: nowSec - MAX_QUEUED_AGE - 10
      };
      const freshTx = {
        id: 'fresh-tx',
        status: ITransactionStatus.Queued,
        initiatedAt: nowSec
      };

      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([staleTx, freshTx])
      });

      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValue({ modify: mockModify });

      await cancelStaleQueuedTransactions();

      // Should only cancel the stale transaction
      expect(mockModify).toHaveBeenCalledTimes(1);
    });

    it('does nothing when all queued transactions are recent', async () => {
      const freshTx = {
        id: 'fresh-tx',
        status: ITransactionStatus.Queued,
        initiatedAt: Math.floor(Date.now() / 1000)
      };

      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([freshTx])
      });

      await cancelStaleQueuedTransactions();

      expect(mockTransactionsWhere).not.toHaveBeenCalled();
    });
  });

  describe('cancelTransaction error serialization', () => {
    it('sets displayMessage, displayIcon, and serializes Error objects', async () => {
      const mockModify = jest.fn((fn: (tx: any) => void) => {
        const dbTx: any = {};
        fn(dbTx);
        return dbTx;
      });
      mockTransactionsWhere.mockReturnValueOnce({ modify: mockModify });

      const tx = { id: 'tx-1' } as Transaction;
      await cancelTransaction(tx, new Error('Network failure'));

      expect(mockModify).toHaveBeenCalled();
      const modifyFn = mockModify.mock.calls[0]![0];
      const dbTx: any = {};
      modifyFn(dbTx);

      expect(dbTx.status).toBe(ITransactionStatus.Failed);
      expect(dbTx.error).toBe('Error: Network failure');
      expect(dbTx.displayMessage).toBe('Failed');
      expect(dbTx.displayIcon).toBe('FAILED');
    });

    it('serializes plain string errors with String()', async () => {
      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValueOnce({ modify: mockModify });

      const tx = { id: 'tx-1' } as Transaction;
      await cancelTransaction(tx, 'simple error string');

      const modifyFn = mockModify.mock.calls[0]![0];
      const dbTx: any = {};
      modifyFn(dbTx);

      expect(dbTx.error).toBe('simple error string');
    });
  });

  describe('generateTransaction', () => {
    it('calls syncState before processing transaction', async () => {
      const callOrder: string[] = [];
      mockSyncState.mockImplementation(async () => {
        callOrder.push('syncState');
        return { blockNum: () => 1 };
      });

      // Mock updateTransactionStatus
      const tx = { id: 'tx-1', status: ITransactionStatus.Queued };
      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValue({
        first: jest.fn().mockResolvedValue(tx),
        modify: mockModify.mockImplementation(() => {
          callOrder.push('updateStatus');
        })
      });

      // Mock the WASM client for the actual transaction execution
      // sendTransaction now returns TransactionResult directly (no worker)
      mockGetMidenClient.mockResolvedValue({
        syncState: mockSyncState,
        sendTransaction: jest.fn().mockImplementation(() => {
          callOrder.push('sendTransaction');
          return {
            executedTransaction: () => ({
              id: () => ({ toHex: () => 'tx-hex' }),
              outputNotes: () => ({ notes: () => [] }),
              inputNotes: () => ({ notes: () => [] })
            }),
            serialize: () => new Uint8Array([7])
          };
        })
      });

      // Verify syncState is called and the order is correct by catching the error
      // after syncState + updateStatus
      const signCallback = jest.fn().mockResolvedValue(new Uint8Array());
      const transaction = {
        id: 'tx-1',
        type: 'send',
        accountId: 'acc-1',
        delegateTransaction: false
      } as any;

      try {
        await generateTransaction(transaction, signCallback);
      } catch {
        // Expected to fail on TransactionResult.deserialize — that's fine
      }

      // Verify syncState runs before the status flip to GeneratingTransaction.
      // An earlier `updateStatus` entry is the stage='syncing' marker — that's
      // an informational write; what matters is that syncState completes
      // before the final status flip (the last `updateStatus`).
      const syncIdx = callOrder.indexOf('syncState');
      const lastStatusIdx = callOrder.lastIndexOf('updateStatus');
      expect(syncIdx).toBeGreaterThanOrEqual(0);
      expect(syncIdx).toBeLessThan(lastStatusIdx);
      expect(mockSyncState).toHaveBeenCalled();
    });
  });
});

/**
 * Integration test: full network outage recovery flow.
 * Uses jest.isolateModules with a stateful in-memory DB to simulate:
 *   1. Network up → transaction succeeds
 *   2. Network down → syncState fails → transaction cancelled
 *   3. Network back up → new transaction succeeds
 */
describe('Transaction resilience: network outage recovery (isolated)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('recovers after network outage - full flow', async () => {
    // ---- In-memory DB ----
    const txStore: any[] = [];
    const repoMock = {
      transactions: {
        add: jest.fn(async (tx: any) => {
          txStore.push({ ...tx });
        }),
        filter: jest.fn((fn: (tx: any) => boolean) => ({
          toArray: jest.fn(async () => txStore.filter(fn))
        })),
        where: jest.fn((query: any) => ({
          first: jest.fn(async () => txStore.find(tx => tx.id === query.id)),
          modify: jest.fn(async (fn: (tx: any) => void) => {
            const tx = txStore.find(t => t.id === query.id);
            if (tx) fn(tx);
          })
        }))
      }
    };

    // ---- Network toggle ----
    let networkUp = true;
    const mockSyncState = jest.fn(async () => {
      if (!networkUp) throw new Error('Network unreachable');
      return { blockNum: () => 42 };
    });

    const mockNewTransaction = jest.fn(async () => ({
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'mock-tx-hash' }),
        outputNotes: () => ({ notes: () => [] }),
        inputNotes: () => ({ notes: () => [] })
      }),
      serialize: () => new Uint8Array([1, 2, 3])
    }));

    jest.doMock('lib/miden/repo', () => repoMock);

    jest.doMock('../sdk/miden-client', () => ({
      getMidenClient: jest.fn(async () => ({
        syncState: mockSyncState,
        newTransaction: mockNewTransaction
      })),
      withWasmClientLock: jest.fn((cb: () => any) => cb())
    }));

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      InputNoteState: {
        ConsumedAuthenticatedLocal: 0,
        ConsumedUnauthenticatedLocal: 1,
        ConsumedExternal: 2,
        Invalid: 3,
        Committed: 4,
        Expected: 5,
        Unverified: 6
      }
    }));

    jest.doMock('../helpers', () => ({
      toNoteTypeString: jest.fn(() => 'public')
    }));

    jest.doMock('./helpers', () => ({
      interpretTransactionResult: jest.fn((tx: any) => ({
        ...tx,
        transactionId: 'mock-tx-hash',
        displayMessage: 'Executed',
        displayIcon: 'DEFAULT'
      }))
    }));

    jest.doMock('./notes', () => ({
      importAllNotes: jest.fn(),
      queueNoteImport: jest.fn()
    }));

    jest.doMock('lib/platform', () => ({
      isMobile: jest.fn(() => false),
      isExtension: jest.fn(() => false)
    }));

    jest.doMock('shared/logger', () => ({
      logger: { warning: jest.fn(), error: jest.fn() }
    }));

    let ITransactionStatus: any;
    let generateTransactionsLoop: any;

    jest.isolateModules(() => {
      ({ ITransactionStatus } = require('../db/types'));
      ({ generateTransactionsLoop } = require('./transactions'));
    });

    const signCallback = jest.fn(async () => new Uint8Array());

    // ---- Phase 1: Network up, transaction succeeds ----
    networkUp = true;
    txStore.push({
      id: 'tx-1',
      type: 'execute',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: Date.now(),
      displayIcon: 'DEFAULT',
      displayMessage: 'Executing',
      requestBytes: new Uint8Array([1])
    });

    const result1 = await generateTransactionsLoop(signCallback);

    expect(result1).toBe(true);
    const tx1 = txStore.find((t: any) => t.id === 'tx-1');
    expect(tx1.status).toBe(ITransactionStatus.Completed);
    expect(tx1.transactionId).toBe('mock-tx-hash');
    expect(mockSyncState).toHaveBeenCalled();

    // ---- Phase 2: Network down, new transaction gets cancelled ----
    networkUp = false;
    mockSyncState.mockClear();

    txStore.push({
      id: 'tx-2',
      type: 'execute',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: Date.now(),
      displayIcon: 'DEFAULT',
      displayMessage: 'Executing',
      requestBytes: new Uint8Array([2])
    });

    const result2 = await generateTransactionsLoop(signCallback);

    // generateTransactionsLoop catches the error and cancels the tx
    expect(result2).toBe(false);
    const tx2 = txStore.find((t: any) => t.id === 'tx-2');
    expect(tx2.status).toBe(ITransactionStatus.Failed);
    expect(tx2.displayMessage).toBe('Failed');
    expect(tx2.displayIcon).toBe('FAILED');

    // ---- Phase 3: Network back up, new transaction succeeds ----
    networkUp = true;
    mockSyncState.mockClear();

    txStore.push({
      id: 'tx-3',
      type: 'execute',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: Date.now(),
      displayIcon: 'DEFAULT',
      displayMessage: 'Executing',
      requestBytes: new Uint8Array([3])
    });

    const result3 = await generateTransactionsLoop(signCallback);

    expect(result3).toBe(true);
    const tx3 = txStore.find((t: any) => t.id === 'tx-3');
    expect(tx3.status).toBe(ITransactionStatus.Completed);
    expect(tx3.transactionId).toBe('mock-tx-hash');
    expect(mockSyncState).toHaveBeenCalled();
  });
});

// Note: The completeCustomTransaction test below uses jest.isolateModules
// which conflicts with module-level mocks. It's kept as a separate isolated test.
describe('completeCustomTransaction (isolated)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('marks transaction completed even when output notes are non-private', async () => {
    const dbTx: any = { id: 'tx-1', status: 0 };
    const modify = jest.fn(async (fn: (tx: any) => void) => fn(dbTx));

    jest.doMock('lib/miden/repo', () => ({
      transactions: {
        where: jest.fn(() => ({
          first: jest.fn(async () => dbTx),
          modify
        }))
      }
    }));

    jest.doMock('../helpers', () => ({
      toNoteTypeString: jest.fn(() => 'public')
    }));

    jest.doMock('./helpers', () => ({
      interpretTransactionResult: jest.fn((tx: any) => ({ ...tx }))
    }));

    jest.doMock('./notes', () => ({
      importAllNotes: jest.fn(),
      queueNoteImport: jest.fn()
    }));

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      InputNoteState: {
        ConsumedAuthenticatedLocal: 'ConsumedAuthenticatedLocal',
        ConsumedUnauthenticatedLocal: 'ConsumedUnauthenticatedLocal',
        ConsumedExternal: 'ConsumedExternal',
        Invalid: 'Invalid',
        Committed: 'Committed',
        Expected: 'Expected',
        Unverified: 'Unverified'
      }
    }));

    jest.doMock('../sdk/miden-client', () => ({
      getMidenClient: jest.fn()
    }));

    jest.doMock('lib/platform', () => ({
      isMobile: jest.fn(() => false),
      isExtension: jest.fn(() => false)
    }));

    let ITransactionStatus: any;
    let completeCustomTransaction: any;

    jest.isolateModules(() => {
      ({ ITransactionStatus } = require('../db/types'));
      ({ completeCustomTransaction } = require('./transactions'));
    });

    const nonPrivateNote = {
      metadata: () => ({ noteType: () => ({}) })
    };

    const result: any = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [nonPrivateNote]
        })
      })
    };

    const tx: any = { id: 'tx-1' };

    await completeCustomTransaction(tx, result);

    expect(modify).toHaveBeenCalledTimes(1);
    expect(dbTx.status).toBe(ITransactionStatus.Completed);
    expect(dbTx.completedAt).toEqual(expect.any(Number));
  });
});
