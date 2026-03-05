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
    get transactions() {
      return {
        filter: mockTransactionsFilter,
        where: mockTransactionsWhere,
        add: mockTransactionsAdd
      };
    }
  };
});

const mockSyncState = jest.fn().mockResolvedValue({ blockNum: () => 1 });
const mockGetMidenClient = jest.fn().mockResolvedValue({ syncState: mockSyncState });

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: (...args: any[]) => mockGetMidenClient(...args),
  withWasmClientLock: jest.fn((callback: () => any) => callback())
}));

jest.mock('./notes', () => ({
  importAllNotes: jest.fn(),
  queueNoteImport: jest.fn(),
  registerOutputNote: jest.fn()
}));

jest.mock('lib/miden-worker/consumeNoteId', () => ({
  consumeNoteId: jest.fn()
}));

jest.mock('lib/miden-worker/sendTransaction', () => ({
  sendTransaction: jest.fn()
}));

jest.mock('lib/miden-worker/submitTransaction', () => ({
  submitTransaction: jest.fn()
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

      expect(result[0].id).toBe('tx-2'); // Earlier initiatedAt first
      expect(result[1].id).toBe('tx-1');
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

      expect(result[0].id).toBe('tx-2');
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
      expect(result[0].id).toBe('tx-1');
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
    it('is 30 minutes in milliseconds', () => {
      expect(MAX_WAIT_BEFORE_CANCEL).toBe(30 * 60_000);
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
    it('creates consume transaction when none exists', async () => {
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([])
      });
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const note = {
        id: 'note-123',
        faucetId: 'faucet',
        amount: '100',
        senderAddress: 'sender',
        isBeingClaimed: false
      };

      const result = await initiateConsumeTransaction('account-1', note);

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });

    it('returns existing transaction id if consume for same note exists', async () => {
      const existingTx = {
        id: 'existing-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Queued,
        initiatedAt: 100
      };
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([existingTx])
      });

      const note = {
        id: 'note-123',
        faucetId: 'faucet',
        amount: '100',
        senderAddress: 'sender',
        isBeingClaimed: false
      };

      const result = await initiateConsumeTransaction('account-1', note);

      expect(result).toBe('existing-tx');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
    });
  });

  describe('initiateConsumeTransactionFromId', () => {
    it('creates consume transaction from note id', async () => {
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([])
      });
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransactionFromId('account-1', 'note-456');

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });
  });

  describe('cancelStuckTransactions', () => {
    it('cancels transactions that exceed MAX_WAIT_BEFORE_CANCEL', async () => {
      const stuckTx = {
        id: 'stuck-tx',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: 100,
        processingStartedAt: Date.now() - MAX_WAIT_BEFORE_CANCEL - 1000
      };
      const recentTx = {
        id: 'recent-tx',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: 200,
        processingStartedAt: Date.now()
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
      const staleTx = {
        id: 'stale-tx',
        status: ITransactionStatus.Queued,
        initiatedAt: Date.now() - MAX_QUEUED_AGE - 1000
      };
      const freshTx = {
        id: 'fresh-tx',
        status: ITransactionStatus.Queued,
        initiatedAt: Date.now()
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
        initiatedAt: Date.now()
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
      const modifyFn = mockModify.mock.calls[0][0];
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

      const modifyFn = mockModify.mock.calls[0][0];
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
      mockGetMidenClient.mockResolvedValue({
        syncState: mockSyncState,
        sendTransaction: jest.fn().mockImplementation(() => {
          callOrder.push('sendTransaction');
          return new Uint8Array();
        })
      });

      // Mock sendTransaction worker
      const { sendTransaction: mockSendTxWorker } = require('lib/miden-worker/sendTransaction');
      const mockResultBytes = new Uint8Array([1, 2, 3]);
      mockSendTxWorker.mockResolvedValue(mockResultBytes);

      // We need to mock TransactionResult.deserialize — this will throw since we can't
      // easily mock the SDK class. Instead, test a consume transaction that's simpler.
      // Let's just verify syncState is called and the order is correct by catching the error
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

      // Verify syncState was called BEFORE updateStatus
      expect(callOrder[0]).toBe('syncState');
      expect(callOrder[1]).toBe('updateStatus');
      expect(mockSyncState).toHaveBeenCalled();
    });
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
      queueNoteImport: jest.fn(),
      registerOutputNote: jest.fn()
    }));

    jest.doMock('lib/miden-worker/consumeNoteId', () => ({
      consumeNoteId: jest.fn()
    }));
    jest.doMock('lib/miden-worker/sendTransaction', () => ({
      sendTransaction: jest.fn()
    }));
    jest.doMock('lib/miden-worker/submitTransaction', () => ({
      submitTransaction: jest.fn()
    }));

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      Address: { fromBech32: jest.fn() },
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
