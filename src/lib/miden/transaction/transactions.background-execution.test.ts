import { __resetBackgroundExecutionForTest } from 'lib/mobile/background-execution';

import { generateTransactionsLoop } from './index';
import { ITransactionStatus } from '../db/types';

type StoredRow = { id: string; status: ITransactionStatus; [field: string]: unknown };

const mockTxStore: StoredRow[] = [];
const mockBegin = jest.fn();
const mockEnd = jest.fn();
const mockAddListener = jest.fn();
const mockNewTransaction = jest.fn();

jest.mock('@capacitor/core', () => {
  const actual = jest.requireActual('@capacitor/core');
  return {
    ...actual,
    registerPlugin: (name: string, implementations?: unknown) =>
      name === 'BackgroundExecution'
        ? {
            begin: () => mockBegin(),
            end: (options: unknown) => mockEnd(options),
            addListener: (eventName: string, listener: () => void) => mockAddListener(eventName, listener)
          }
        : actual.registerPlugin(name, implementations)
  };
});

jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isIOS: () => true,
  isMobile: () => true,
  isExtension: () => false
}));

jest.mock('lib/miden/repo', () => ({
  transactions: {
    add: jest.fn(async (row: StoredRow) => {
      mockTxStore.push({ ...row });
    }),
    filter: jest.fn((matches: (row: StoredRow) => boolean) => ({
      toArray: jest.fn(async () => mockTxStore.filter(matches))
    })),
    where: jest.fn((query: { id: string }) => ({
      first: jest.fn(async () => mockTxStore.find(row => row.id === query.id)),
      modify: jest.fn(async (change: (row: StoredRow) => void) => {
        const row = mockTxStore.find(candidate => candidate.id === query.id);
        if (row) change(row);
      })
    }))
  }
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn(async () => ({
    syncState: jest.fn(async () => ({ blockNum: () => 42 })),
    newTransaction: mockNewTransaction
  })),
  withWasmClientLock: jest.fn((callback: () => unknown) => callback())
}));
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
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

jest.mock('../helpers', () => ({
  ...jest.requireActual('../helpers'),
  toNoteTypeString: jest.fn(() => 'public')
}));

jest.mock('../activity/helpers', () => ({
  interpretTransactionResult: jest.fn((row: StoredRow) => ({
    ...row,
    transactionId: 'mock-tx-hash',
    displayMessage: 'Executed',
    displayIcon: 'DEFAULT'
  }))
}));

jest.mock('../activity/notes', () => ({
  importAllNotes: jest.fn(),
  queueNoteImport: jest.fn()
}));

jest.mock('shared/logger', () => ({
  logger: { warning: jest.fn(), error: jest.fn() }
}));

const signCallback = jest.fn(async () => new Uint8Array());
const guardianProvider = {
  getAccounts: async () => [],
  getPublicKeyForCommitment: async () => '',
  signWord: async () => ''
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const queueRow = () =>
  mockTxStore.push({
    id: 'tx-1',
    type: 'execute',
    accountId: 'acc-1',
    status: ITransactionStatus.Queued,
    initiatedAt: Date.now(),
    displayIcon: 'DEFAULT',
    displayMessage: 'Executing',
    requestBytes: new Uint8Array([1])
  });

describe('background time around a transaction attempt', () => {
  let endsSeenInsideAttempt: number | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTxStore.length = 0;
    endsSeenInsideAttempt = undefined;
    __resetBackgroundExecutionForTest();
    mockBegin.mockResolvedValue({ granted: true, key: 'attempt-key' });
    mockEnd.mockResolvedValue(undefined);
    mockAddListener.mockResolvedValue({ remove: jest.fn() });
  });

  const attemptSucceeds = () =>
    mockNewTransaction.mockImplementation(async () => {
      endsSeenInsideAttempt = mockEnd.mock.calls.length;
      return {
        executedTransaction: () => ({
          id: () => ({ toHex: () => 'mock-tx-hash' }),
          outputNotes: () => ({ notes: () => [] }),
          inputNotes: () => ({ notes: () => [] })
        }),
        serialize: () => new Uint8Array([1, 2, 3])
      };
    });

  const attemptFails = () =>
    mockNewTransaction.mockImplementation(async () => {
      endsSeenInsideAttempt = mockEnd.mock.calls.length;
      throw new Error('execution failed');
    });

  it('holds the time across a successful attempt and ends it once', async () => {
    attemptSucceeds();
    queueRow();

    await expect(generateTransactionsLoop(signCallback, false, guardianProvider)).resolves.toBe(true);
    await flush();

    expect(mockTxStore[0]!.status).toBe(ITransactionStatus.Completed);
    expect(mockBegin).toHaveBeenCalledTimes(1);
    expect(endsSeenInsideAttempt).toBe(0);
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledWith({ key: 'attempt-key' });
  });

  it('still ends the time when the attempt fails', async () => {
    attemptFails();
    queueRow();
    let statusAtEnd: ITransactionStatus | undefined;
    mockEnd.mockImplementation(async () => {
      statusAtEnd = mockTxStore[0]!.status;
    });

    await expect(generateTransactionsLoop(signCallback, false, guardianProvider)).resolves.toBe(false);
    await flush();

    expect(mockTxStore[0]!.status).toBe(ITransactionStatus.Failed);
    // The failure's own writes are what iOS would otherwise suspend halfway through.
    expect(statusAtEnd).toBe(ITransactionStatus.Failed);
    expect(mockBegin).toHaveBeenCalledTimes(1);
    expect(endsSeenInsideAttempt).toBe(0);
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledWith({ key: 'attempt-key' });
  });

  it('does not touch the outcome of an attempt the bridge refused', async () => {
    mockBegin.mockRejectedValue(new Error('UNIMPLEMENTED'));
    attemptSucceeds();
    queueRow();

    await expect(generateTransactionsLoop(signCallback, false, guardianProvider)).resolves.toBe(true);
    await flush();

    expect(mockTxStore[0]!.status).toBe(ITransactionStatus.Completed);
    expect(mockEnd).not.toHaveBeenCalled();
  });
});
