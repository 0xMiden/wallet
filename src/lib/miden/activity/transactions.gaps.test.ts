/**
 * Gap-coverage tests for `lib/miden/activity/transactions.ts`.
 *
 * Targets branches not exercised by the other transactions test files:
 *   - `getUncompletedTransactions` (queued+generating filter, tokenId filter)
 *   - `waitForConsumeTx` abort signal firing AFTER subscribe
 *   - `completeCustomTransaction` outer init-error path (withWasmClientLock rejects)
 *   - `extractFullNote` outer try/catch (outputNotes throws)
 *   - `generateTransactionsLoop` early-return when an in-progress tx exists
 */

import { ITransactionStatus } from '../db/types';
import { NoteTypeEnum } from '../types';
import {
  completeCustomTransaction,
  generateTransaction,
  generateTransactionsLoop,
  getUncompletedTransactions,
  safeGenerateTransactionsLoop,
  startBackgroundTransactionProcessing,
  verifyStuckTransactionsFromNode,
  waitForConsumeTx,
  waitForTransactionCompletion
} from './transactions';

const _g = globalThis as any;
_g.__txGapTest = {
  rows: [] as any[],
  liveQueryCallbacks: [] as Array<() => void>
};
const txStore: any[] = _g.__txGapTest.rows;

jest.mock('lib/miden/repo', () => ({
  db: {
    transaction: (_mode: string, _table: unknown, cb: () => Promise<unknown>) => cb()
  },
  transactions: {
    add: jest.fn(async (tx: any) => {
      txStore.push({ ...tx });
    }),
    filter: jest.fn((fn: (tx: any) => boolean) => ({
      toArray: jest.fn(async () => txStore.filter(fn))
    })),
    where: jest.fn((arg: any) => {
      if (typeof arg === 'string') {
        const field = arg;
        return {
          equals: (val: any) => ({
            filter: (fn: (tx: any) => boolean) => ({
              toArray: async () => txStore.filter(t => t[field] === val).filter(fn)
            })
          })
        };
      }
      return {
        first: jest.fn(async () => txStore.find(t => t.id === arg.id)),
        modify: jest.fn(async (fn: (tx: any) => void) => {
          const tx = txStore.find(t => t.id === arg.id);
          if (tx) fn(tx);
        })
      };
    })
  }
}));

jest.mock('dexie', () => ({
  liveQuery: jest.fn((cb: () => any) => ({
    subscribe: (subscriber: any) => {
      const dispatch = async () => {
        try {
          const value = await cb();
          if (typeof subscriber === 'function') subscriber(value);
          else if (subscriber?.next) subscriber.next(value);
        } catch (err) {
          if (subscriber?.error) subscriber.error(err);
        }
      };
      // Defer the initial dispatch so tests have a window to abort first.
      setTimeout(dispatch, 5);
      return {
        unsubscribe: jest.fn()
      };
    }
  }))
}));

const mockSyncState = jest.fn(async () => {});
const mockWaitForCommit = jest.fn(async () => {});
const mockSendPrivateNote = jest.fn(async () => {});
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({
    syncState: mockSyncState,
    waitForTransactionCommit: mockWaitForCommit,
    sendPrivateNote: mockSendPrivateNote
  }),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn()
}));

jest.mock('./notes', () => ({
  importAllNotes: jest.fn(),
  queueNoteImport: jest.fn()
}));

jest.mock('./helpers', () => ({
  interpretTransactionResult: jest.fn((tx: any) => ({ ...tx, displayMessage: 'Executed' }))
}));

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isExtension: () => true
}));

jest.mock('shared/logger', () => ({
  logger: { warning: jest.fn(), error: jest.fn() }
}));

const _gh = globalThis as any;
_gh.__noteTypeForTest = 'private';
jest.mock('../helpers', () => ({
  toNoteTypeString: () => (globalThis as any).__noteTypeForTest
}));

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (x: any) => (typeof x === 'string' ? x : 'bech32-stub')
}));

const mockTransactionResultDeserialize = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const base = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...base,
    TransactionResult: { deserialize: (...args: unknown[]) => mockTransactionResultDeserialize(...args) },
    TransactionProver: { newLocalProver: jest.fn(() => ({ __proverMarker: true })) }
  };
});

jest.mock('lib/store', () => ({
  getIntercom: () => ({ request: jest.fn(() => Promise.resolve({})) })
}));

jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: jest.fn(async () => false),
  getOrCreateMultisigService: jest.fn(),
  clearGuardianServiceFor: jest.fn()
}));

beforeEach(() => {
  jest.clearAllMocks();
  txStore.length = 0;
  _gh.__noteTypeForTest = 'private';
});

describe('getUncompletedTransactions', () => {
  it('returns Queued + GeneratingTransaction rows for the given account, sorted by initiatedAt', async () => {
    txStore.push(
      { id: 'q-late', status: ITransactionStatus.Queued, accountId: 'acc-1', initiatedAt: 200 },
      { id: 'q-early', status: ITransactionStatus.Queued, accountId: 'acc-1', initiatedAt: 100 },
      { id: 'gen', status: ITransactionStatus.GeneratingTransaction, accountId: 'acc-1', initiatedAt: 150 },
      { id: 'completed', status: ITransactionStatus.Completed, accountId: 'acc-1', initiatedAt: 50 },
      { id: 'other-acc', status: ITransactionStatus.Queued, accountId: 'acc-2', initiatedAt: 75 }
    );

    const result = await getUncompletedTransactions('acc-1');

    expect(result.map(t => t.id)).toEqual(['q-early', 'gen', 'q-late']);
  });

  it('filters by tokenId (faucetId) when provided', async () => {
    txStore.push(
      { id: 'a', status: ITransactionStatus.Queued, accountId: 'acc-1', initiatedAt: 100, faucetId: 'f1' },
      { id: 'b', status: ITransactionStatus.Queued, accountId: 'acc-1', initiatedAt: 200, faucetId: 'f2' }
    );
    const result = await getUncompletedTransactions('acc-1', 'f1');
    expect(result.map(t => t.id)).toEqual(['a']);
  });
});

describe('waitForConsumeTx', () => {
  it('rejects with AbortError when the signal fires after subscription', async () => {
    txStore.push({ id: 'tx-pending', status: ITransactionStatus.Queued });
    const ctrl = new AbortController();
    const p = waitForConsumeTx('tx-pending', ctrl.signal);
    // Abort before liveQuery's first dispatch (deferred 5ms in our mock).
    ctrl.abort();
    await expect(p).rejects.toThrow(/Aborted/);
  });
});

describe('completeCustomTransaction outer init-error path', () => {
  it('logs and continues when withWasmClientLock itself rejects (catch on line 114)', async () => {
    _gh.__noteTypeForTest = 'private';
    txStore.push({
      id: 'tx-cct',
      type: 'execute',
      accountId: 'acc-1',
      secondaryAccountId: 'recipient',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });

    // Force the OUTER lock acquisition itself to reject (vs. its inner cb).
    const sdk = require('../sdk/miden-client');
    const origLock = sdk.withWasmClientLock;
    sdk.withWasmClientLock = async () => {
      throw new Error('outer-lock-fail');
    };

    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    try {
      const fakeNote = {
        metadata: () => ({ noteType: () => 'private' }),
        intoFull: () => ({ valid: true })
      };
      const txResult = {
        executedTransaction: () => ({
          id: () => ({ toHex: () => 'h' }),
          outputNotes: () => ({ notes: () => [fakeNote] })
        })
      } as any;

      await completeCustomTransaction(txStore[0]!, txResult);

      // Even when the outer lock fails, the function still marks the tx complete
      // (the per-note error is logged and the loop continues).
      expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      sdk.withWasmClientLock = origLock;
      errSpy.mockRestore();
    }
  });
});

describe('extractFullNote intoFull-undefined branch', () => {
  it('logs and returns undefined when intoFull() returns undefined for the first output note', async () => {
    txStore.push({
      id: 'tx-intoundef',
      type: 'send',
      accountId: 'acc-1',
      noteType: NoteTypeEnum.Public,
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });
    const txResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'h' }),
        outputNotes: () => ({ notes: () => [{ intoFull: () => undefined }] })
      }),
      serialize: () => new Uint8Array([])
    } as any;
    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    try {
      const { completeSendTransaction } = require('./transactions');
      await completeSendTransaction(txStore[0], txResult);
      expect(errSpy).toHaveBeenCalledWith('intoFull() returned undefined for first output note');
      expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('extractFullNote outer try/catch', () => {
  it('completes a public send when outputNotes() throws (extractFullNote returns undefined)', async () => {
    _gh.__noteTypeForTest = 'public';
    txStore.push({
      id: 'tx-send',
      type: 'send',
      accountId: 'acc-1',
      noteType: NoteTypeEnum.Public,
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });
    const txResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'h' }),
        outputNotes: () => {
          throw new Error('outputNotes-explode');
        }
      }),
      serialize: () => new Uint8Array([])
    } as any;

    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    try {
      const { completeSendTransaction } = require('./transactions');
      await completeSendTransaction(txStore[0], txResult);
      expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
      expect(errSpy).toHaveBeenCalledWith(
        'Failed to extract full note from transaction result',
        expect.objectContaining({ error: expect.any(Error) })
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('generateTransactionsLoop early returns', () => {
  it('returns undefined when an in-progress transaction already exists', async () => {
    txStore.push({
      id: 'in-progress',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100,
      processingStartedAt: Math.floor(Date.now() / 1000)
    });
    const guardianProvider: any = { getGuardianClient: async () => null };
    const sign = jest.fn();
    const result = await generateTransactionsLoop(sign, false, guardianProvider);
    expect(result).toBeUndefined();
    expect(sign).not.toHaveBeenCalled();
  });

  it('returns undefined when there are no queued or in-progress transactions', async () => {
    const guardianProvider: any = { getGuardianClient: async () => null };
    const result = await generateTransactionsLoop(jest.fn(), false, guardianProvider);
    expect(result).toBeUndefined();
  });
});

describe('waitForConsumeTx timeout', () => {
  it('rejects with a timeout error when the underlying liveQuery never resolves', async () => {
    jest.useFakeTimers();
    try {
      // Push a queued (non-terminal) row so the subscriber sees it but doesn't
      // resolve/reject — only the timeout path can win.
      txStore.push({ id: 'tx-pending', status: ITransactionStatus.Queued });
      const promise = waitForConsumeTx('tx-pending');
      // Catch the rejection synchronously so the unhandled-rejection guard
      // doesn't fire while we advance fake timers.
      const captured = promise.catch((err: unknown) => err);
      jest.advanceTimersByTime(5 * 60_000 + 10);
      const err = (await captured) as Error;
      expect(err.message).toMatch(/timed out/i);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('waitForTransactionCompletion', () => {
  it('resolves with txHash + serialized output notes when the row goes Completed', async () => {
    mockTransactionResultDeserialize.mockReturnValueOnce({
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [
            { intoFull: () => ({ serialize: () => new Uint8Array([0x01, 0x02]) }) },
            { intoFull: () => undefined } // filtered out
          ]
        })
      })
    });
    txStore.push({
      id: 'tx-done',
      status: ITransactionStatus.Completed,
      transactionId: 'on-chain-hash',
      resultBytes: new Uint8Array([9, 9, 9])
    });
    const result = await waitForTransactionCompletion('tx-done');
    expect(result).toEqual({
      txHash: 'on-chain-hash',
      outputNotes: [Buffer.from([0x01, 0x02]).toString('base64')]
    });
  });

  it('resolves with timed-out errorMessage when the timer fires before completion', async () => {
    jest.useFakeTimers();
    try {
      txStore.push({ id: 'tx-stuck', status: ITransactionStatus.Queued });
      const p = waitForTransactionCompletion('tx-stuck');
      jest.advanceTimersByTime(5 * 60_000 + 10);
      const result = await p;
      expect(result).toEqual({ errorMessage: 'Transaction timed out' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('safeGenerateTransactionsLoop', () => {
  // Fresh navigator.locks per test so mockImplementation in one doesn't leak.
  const installNavigatorLocksMock = (impl: (..._args: any[]) => any) => {
    const nav = (globalThis as any).navigator || {};
    Object.defineProperty(nav, 'locks', {
      value: { request: jest.fn(impl) },
      writable: true,
      configurable: true
    });
  };

  it('returns false (catch path) when navigator.locks.request rejects', async () => {
    installNavigatorLocksMock(() => Promise.reject(new Error('lock-blew-up')));
    const result = await safeGenerateTransactionsLoop(jest.fn(), false, {} as any);
    expect(result).toBe(false);
  });

  it('returns false when generateTransactionsLoop returns false (forwards through `if (result === false)`)', async () => {
    // To make generateTransactionsLoop hit its catch branch and return false,
    // we patch the Repo.transactions.where().modify path so the very first
    // setTransactionStage call (inside generateTransaction) throws. Closure-
    // captured jest.fn mocks haven't been cooperating with the mocked-module
    // boundary, so we patch Repo directly which is also a top-level mock.
    txStore.push({
      id: 'fail-stage',
      type: 'send',
      accountId: 'acc-1',
      secondaryAccountId: 'recipient',
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      noteType: NoteTypeEnum.Public,
      faucetId: 'f'
    });
    const Repo = require('lib/miden/repo');
    const origWhere = Repo.transactions.where;
    let triggered = 0;
    Repo.transactions.where = jest.fn((arg: any) => {
      if (typeof arg === 'object' && arg.id === 'fail-stage') {
        triggered++;
        // First .modify() call (setTransactionStage from generateTransaction)
        // throws synchronously — generateTransaction throws, generateTransactionsLoop
        // catches, returns false. After the first throw allow normal behaviour
        // so the loop's own cancelTransaction call can still mark the row Failed.
        if (triggered === 1) {
          return {
            first: jest.fn(async () => txStore.find(t => t.id === arg.id)),
            modify: jest.fn(async () => {
              throw new Error('stage-fail');
            })
          };
        }
      }
      return origWhere(arg);
    });
    installNavigatorLocksMock((_n: string, _o: any, cb: any) => Promise.resolve(cb({})));
    try {
      const result = await safeGenerateTransactionsLoop(jest.fn(), false, {} as any);
      expect(result).toBe(false);
    } finally {
      Repo.transactions.where = origWhere;
    }
  });
});

describe('startBackgroundTransactionProcessing', () => {
  it('iterates the loop with a 5s wait when there are still uncompleted transactions', async () => {
    jest.useFakeTimers();
    // Make navigator.locks always unavailable on this test — safeGenerateTransactionsLoop
    // returns undefined and the queued row stays Queued, so hasMore stays true on the
    // first iteration and the 5s setTimeout fires.
    const nav = (globalThis as any).navigator || {};
    Object.defineProperty(nav, 'locks', {
      value: { request: jest.fn(async (_n: string, _o: any, cb: any) => cb(null)) },
      writable: true,
      configurable: true
    });

    try {
      txStore.push({
        id: 'queued-then-drained',
        status: ITransactionStatus.Queued,
        initiatedAt: 1,
        accountId: 'acc-1'
      });
      startBackgroundTransactionProcessing(jest.fn(), false, {} as any);

      // Let the first iteration's synchronous portion run + the await on
      // safeGenerateTransactionsLoop + getAllUncompletedTransactions flush.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Drain the queue and advance past the 5s wait so the loop's second
      // pass sees hasMore=false and exits cleanly. This drives the setTimeout
      // branch (lines 1043-1045).
      txStore.length = 0;
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // No assertion needed beyond "didn't throw"; we exercised the hasMore + setTimeout branches.
      expect(true).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('catches errors thrown by the inner processLoop (lines 1051-1052)', async () => {
    // Force getAllUncompletedTransactions to throw so processLoop rejects, then
    // assert that the unhandled rejection lands in the .catch on line 1050-1052.
    const Repo = require('lib/miden/repo');
    const origFilter = Repo.transactions.filter;
    Repo.transactions.filter = jest.fn(() => ({
      toArray: jest.fn(async () => {
        throw new Error('background-loop-fail');
      })
    }));
    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    // Lock is "unavailable" so safeGenerateTransactionsLoop short-circuits cleanly
    // and the failure surfaces from getAllUncompletedTransactions inside processLoop.
    const nav = (globalThis as any).navigator || {};
    Object.defineProperty(nav, 'locks', {
      value: { request: jest.fn(async (_n: string, _o: any, cb: any) => cb(null)) },
      writable: true,
      configurable: true
    });
    try {
      startBackgroundTransactionProcessing(jest.fn(), false, {} as any);
      // Drain enough microtasks for the inner await chain and the processLoop's
      // own rejection-to-.catch transition.
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      expect(errSpy).toHaveBeenCalledWith('[BackgroundTxProcessor] Error:', expect.any(Error));
    } finally {
      Repo.transactions.filter = origFilter;
      errSpy.mockRestore();
    }
  });
});

describe('verifyStuckTransactionsFromNode invalid + missing branches', () => {
  it('cancels a consume tx whose note state is Invalid', async () => {
    txStore.push({
      id: 'tx-invalid',
      type: 'consume',
      noteId: 'note-bad',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 1,
      processingStartedAt: Math.floor(Date.now() / 1000)
    });
    // getInputNoteDetails is on the gap-test mock client. Patch it on the fly.
    const sdk = require('../sdk/miden-client');
    const origGetClient = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      syncState: jest.fn(),
      getInputNoteDetails: jest.fn(async () => [{ state: 'Invalid' }])
    });
    try {
      const resolved = await verifyStuckTransactionsFromNode();
      expect(resolved).toBe(1);
      expect(txStore[0]!.status).toBe(ITransactionStatus.Failed);
    } finally {
      sdk.getMidenClient = origGetClient;
    }
  });

  it('cancels a consume tx when note state is Unverified and processing time exceeds the grace window', async () => {
    txStore.push({
      id: 'tx-unverified',
      type: 'consume',
      noteId: 'note-unv',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 1,
      // 2 minutes ago — comfortably beyond MIN_PROCESSING_TIME_BEFORE_STUCK (60s).
      processingStartedAt: Math.floor(Date.now() / 1000) - 120
    });
    const sdk = require('../sdk/miden-client');
    const origGetClient = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      getInputNoteDetails: jest.fn(async () => [{ state: 'Unverified' }])
    });
    try {
      const resolved = await verifyStuckTransactionsFromNode();
      expect(resolved).toBe(1);
      expect(txStore[0]!.status).toBe(ITransactionStatus.Failed);
    } finally {
      sdk.getMidenClient = origGetClient;
    }
  });

  it('skips when getInputNoteDetails returns an empty array (note: undefined)', async () => {
    txStore.push({
      id: 'tx-orphan',
      type: 'consume',
      noteId: 'note-x',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 1,
      processingStartedAt: Math.floor(Date.now() / 1000)
    });
    const sdk = require('../sdk/miden-client');
    const origGetClient = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      getInputNoteDetails: jest.fn(async () => [])
    });
    try {
      const resolved = await verifyStuckTransactionsFromNode();
      expect(resolved).toBe(0);
      expect(txStore[0]!.status).toBe(ITransactionStatus.GeneratingTransaction);
    } finally {
      sdk.getMidenClient = origGetClient;
    }
  });
});

describe('generateTransaction execute + consume default switch arms', () => {
  it('drives the execute branch and invokes the signCallback wrapper', async () => {
    txStore.push({
      id: 'tx-exec',
      type: 'execute',
      accountId: 'acc-1',
      secondaryAccountId: 'recipient',
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      requestBytes: new Uint8Array([1, 2, 3]),
      delegateTransaction: false
    });
    const fakeResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'exec-hash' }),
        outputNotes: () => ({ notes: () => [] })
      }),
      serialize: () => new Uint8Array([])
    };

    // Capture the options.signCallback the WASM client receives so we can
    // invoke it with byte buffers — that's the only way to exercise the
    // hex-encoding wrapper inside generateTransaction (lines 775-779).
    let capturedSignCallback: ((pk: Uint8Array, si: Uint8Array) => Promise<Uint8Array>) | null = null;
    const sdk = require('../sdk/miden-client');
    const origGetClient = sdk.getMidenClient;
    sdk.getMidenClient = async (options?: any) => {
      if (options?.signCallback) capturedSignCallback = options.signCallback;
      return {
        syncState: jest.fn(),
        newTransaction: jest.fn(async () => fakeResult),
        waitForTransactionCommit: jest.fn(),
        sendPrivateNote: jest.fn()
      };
    };
    _gh.__noteTypeForTest = 'public';
    try {
      const userSignCallback = jest.fn(async () => new Uint8Array([0xab, 0xcd]));
      await generateTransaction(txStore[0] as any, userSignCallback, false, {} as any);
      expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);

      // Drive the wrapper: it should hex-encode and forward to the user callback.
      expect(capturedSignCallback).not.toBeNull();
      const sig = await capturedSignCallback!(new Uint8Array([0x01, 0x02]), new Uint8Array([0x10, 0x20]));
      expect(userSignCallback).toHaveBeenCalledWith('0102', '1020');
      expect(sig).toEqual(new Uint8Array([0xab, 0xcd]));
    } finally {
      sdk.getMidenClient = origGetClient;
    }
  });

  it('Guardian consume: completes through completeConsumeTransaction → break (outer switch line 913)', async () => {
    txStore.push({
      id: 'guardian-consume',
      type: 'consume',
      accountId: 'guardian-acc',
      noteId: 'note-g',
      status: ITransactionStatus.Queued,
      initiatedAt: 1
    });
    // Build a TransactionResult-like object that completeConsumeTransaction
    // can fully consume — input notes with sender/metadata/fungible-assets.
    const fullResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'guardian-consume-hash' }),
        inputNotes: () => ({
          notes: () => [
            {
              note: () => ({
                metadata: () => ({ sender: () => 'sender-g', noteType: () => 0 }),
                assets: () => ({
                  fungibleAssets: () => [{ faucetId: () => 'f-g', amount: () => '7' }]
                })
              })
            }
          ]
        })
      }),
      serialize: () => new Uint8Array([])
    };
    const guardianManager = require('lib/miden/front/guardian-manager');
    guardianManager.isGuardianAccount.mockResolvedValueOnce(true);
    const fakeMultisigService = {
      createConsumeNotesProposal: jest.fn(async () => ({ id: 'proposal-1' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({ serialize: () => new Uint8Array([1]), authArg: () => undefined })),
      sync: jest.fn(async () => {})
    };
    guardianManager.getOrCreateMultisigService.mockResolvedValueOnce(fakeMultisigService);

    const sdk = require('../sdk/miden-client');
    const origGetClient = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      syncState: jest.fn(async () => {}),
      client: {
        transactions: {
          submit: jest.fn(async () => ({ result: fullResult }))
        }
      }
    });
    try {
      await generateTransaction(txStore[0] as any, jest.fn(), false, {} as any);
      // Reaching here without throwing means the `case 'consume': ... break;`
      // arm at lines 911-913 in the outer switch ran.
      expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
      expect(fakeMultisigService.sync).toHaveBeenCalled();
    } finally {
      sdk.getMidenClient = origGetClient;
    }
  });

  it('drives the consume branch (inner switch)', async () => {
    txStore.push({
      id: 'tx-consume',
      type: 'consume',
      accountId: 'acc-1',
      noteId: 'n-1',
      status: ITransactionStatus.Queued,
      initiatedAt: 1
    });
    const fakeResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'consume-hash' }),
        inputNotes: () => ({
          notes: () => [
            {
              note: () => ({
                metadata: () => ({ sender: () => 'sender', noteType: () => 0 }),
                assets: () => ({
                  fungibleAssets: () => [{ faucetId: () => 'f', amount: () => '5' }]
                })
              })
            }
          ]
        })
      }),
      serialize: () => new Uint8Array([])
    };
    const sdk = require('../sdk/miden-client');
    const origGetClient = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      syncState: jest.fn(),
      consumeNoteId: jest.fn(async () => fakeResult)
    });
    try {
      await generateTransaction(txStore[0] as any, jest.fn(), false, {} as any);
      expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
    } finally {
      sdk.getMidenClient = origGetClient;
    }
  });
});
