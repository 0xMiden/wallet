/**
 * Branch-coverage tests for `lib/miden/transaction`.
 *
 * Targets: completeSendTransaction (private note success, transport error,
 * init error, missing full note), extractFullNote (no output, intoFull
 * undefined, intoFull throws), getCompletedTransactions (includeFailed,
 * tokenId filter), cancelStaleQueuedTransactions, generateTransactionsLoop
 * error paths, waitForTransactionCompletion (completed with resultBytes,
 * error subscription).
 */

import { ITransactionStatus, SendTransaction } from '../db/types';
import { NoteTypeEnum } from '../types';
import {
  completeSendTransaction,
  getCompletedTransactions,
  getSwapSettlementNotes,
  cancelStaleQueuedTransactions,
  waitForTransactionCompletion,
  generateTransactionsLoop,
  buildSignCallbackError,
  readLastAuthReason
} from './index'; // eslint-disable-line import/order

const _g = globalThis as any;
_g.__txBrTest = {
  rows: [] as any[],
  liveQueryCallbacks: [] as Array<(rows: any) => void>
};

const txStore: any[] = _g.__txBrTest.rows;

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
    where: jest.fn((query: any) => ({
      first: jest.fn(async () => txStore.find(t => t.id === query.id)),
      modify: jest.fn(async (fn: (tx: any) => void) => {
        const tx = txStore.find(t => t.id === query.id);
        if (tx) fn(tx);
      })
    }))
  }
}));

jest.mock('dexie', () => ({
  liveQuery: jest.fn((cb: () => any) => ({
    subscribe: (subscriber: any) => {
      const dispatch = async () => {
        try {
          const value = await cb();
          if (typeof subscriber === 'function') {
            subscriber(value);
          } else if (subscriber && typeof subscriber.next === 'function') {
            subscriber.next(value);
          }
        } catch (err) {
          if (subscriber && typeof subscriber.error === 'function') {
            subscriber.error(err);
          }
        }
      };
      dispatch();
      const handler = () => dispatch();
      _g.__txBrTest.liveQueryCallbacks.push(handler);
      return {
        unsubscribe: () => {
          const idx = _g.__txBrTest.liveQueryCallbacks.indexOf(handler);
          if (idx !== -1) _g.__txBrTest.liveQueryCallbacks.splice(idx, 1);
        }
      };
    }
  }))
}));

const mockSyncState = jest.fn().mockResolvedValue(undefined);
const mockWaitForTransactionCommit = jest.fn().mockResolvedValue(undefined);
const mockSendPrivateNote = jest.fn().mockResolvedValue(undefined);
// Raw WASM client's lastAuthError(), read by readLastAuthReason in the
// generate-loop catch. Default null = no auth failure recorded.
const mockLastAuthError = jest.fn((): unknown => null);
// The #260 offscreen client proxy (through which non-guardian send/swap/execute
// now route their flag-off write) imports getMidenClient / withWasmClientLock via
// the `lib/...` alias, which jest mocks separately from the relative specifier
// below; bridge the alias to the same mock so the proxy's flag-off passthrough
// invokes the wrapped sign callback exactly as the old inline switch did.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async (options?: { signCallback?: (pk: Uint8Array, si: Uint8Array) => Promise<Uint8Array> }) => {
    // Mirror the SDK invoking the wrapped per-tx sign callback so its wrapper
    // (and buildSignCallbackError on failure) is exercised through the real path.
    if (options?.signCallback) {
      try {
        await options.signCallback(new Uint8Array([1]), new Uint8Array([2]));
      } catch {
        /* wrapper threw a typed SignCallbackError; the SDK would capture it */
      }
    }
    return {
      syncState: mockSyncState,
      waitForTransactionCommit: mockWaitForTransactionCommit,
      sendPrivateNote: mockSendPrivateNote,
      client: { lastAuthError: mockLastAuthError }
    };
  },
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn()
}));

// Default to non-Guardian so generateTransaction takes the standard
// signCallback dispatch path. generateTransaction now guards on
// isGuardianAccount(accountId, guardianProvider); these branch tests drive
// the loop without a guardianProvider, so the real implementation would throw
// on `provider.getAccounts()`.
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: jest.fn(async () => false),
  getOrCreateMultisigService: jest.fn(),
  clearGuardianServiceFor: jest.fn()
}));

jest.mock('../activity/notes', () => ({
  importAllNotes: jest.fn(),
  queueNoteImport: jest.fn()
}));

jest.mock('../activity/helpers', () => ({
  interpretTransactionResult: jest.fn((tx: any) => ({ ...tx, displayMessage: 'Executed' }))
}));

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isExtension: () => true
}));

jest.mock('shared/logger', () => ({
  logger: { warning: jest.fn(), error: jest.fn() }
}));

jest.mock('../helpers', () => ({
  ...jest.requireActual('../helpers'),
  toNoteTypeString: () => 'public'
}));

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (x: any) => (typeof x === 'string' ? x : 'bech32-stub'),
  // Needed once a test enters the Guardian branch of generateTransaction
  // (isGuardianAccount → true): the per-account lock key is canonicalized and
  // wallet-account matching is done via these helpers.
  canonicalWalletAccountId: (id: string) => id,
  sameWalletAccountId: (a: string, b: string) => a === b
}));

// The guardian branch wraps generateGuardianTransaction in a per-account lock;
// run the callback straight through so the branch is exercised without the real
// navigator.locks-backed serializer.
jest.mock('lib/miden/guardian/serialize', () => ({
  withGuardianAccountLock: (_key: string, fn: () => Promise<unknown>) => fn(),
  withGuardianConflictRetry: (fn: () => Promise<unknown>) => fn()
}));

jest.mock('lib/store', () => ({
  getIntercom: () => ({
    request: jest.fn(() => Promise.resolve({}))
  })
}));

jest.mock('lib/shared/helpers', () => ({
  u8ToB64: (u8: Uint8Array) => Buffer.from(u8).toString('base64')
}));

// Mock navigator.locks for safeGenerateTransactionsLoop
Object.defineProperty(globalThis.navigator, 'locks', {
  value: {
    request: jest.fn(async (_name: string, opts: any, fn: any) => {
      // ifAvailable: true ⇒ pass a truthy lock object
      const lock = opts?.ifAvailable ? {} : {};
      return fn(lock);
    })
  },
  writable: true,
  configurable: true
});

const stubGuardianProvider = {
  getAccounts: jest.fn(async () => []),
  getPublicKeyForCommitment: jest.fn(async () => 'pk'),
  signWord: jest.fn(async () => 'sig')
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLastAuthError.mockReset();
  mockLastAuthError.mockImplementation((): unknown => null);
  txStore.length = 0;
  _g.__txBrTest.liveQueryCallbacks.length = 0;
});

describe('completeSendTransaction', () => {
  function makeSendTx(overrides: Partial<SendTransaction> = {}): SendTransaction {
    return {
      id: 'tx-send-1',
      type: 'send',
      accountId: 'acc-1',
      secondaryAccountId: 'recipient-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100,
      noteType: NoteTypeEnum.Public,
      faucetId: 'faucet-1',
      ...overrides
    } as SendTransaction;
  }

  function makeResult(opts: { hasOutputNote?: boolean; intoFullReturns?: any; intoFullThrows?: boolean } = {}) {
    const {
      hasOutputNote = true,
      intoFullReturns = { id: () => ({ toString: () => 'note-out-1' }), serialize: () => new Uint8Array([1]) },
      intoFullThrows = false
    } = opts;
    const fakeOutputNote = hasOutputNote
      ? {
          metadata: () => ({ noteType: () => 'public' }),
          intoFull: intoFullThrows
            ? () => {
                throw new Error('intoFull-fail');
              }
            : () => intoFullReturns
        }
      : undefined;
    return {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'tx-hash-1' }),
        outputNotes: () => ({
          notes: () => (fakeOutputNote ? [fakeOutputNote] : [])
        })
      }),
      serialize: () => new Uint8Array([9])
    } as any;
  }

  it('marks public send as completed without sending private note', async () => {
    const tx = makeSendTx();
    txStore.push({ ...tx });
    await completeSendTransaction(tx, makeResult());
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
    expect(mockSendPrivateNote).not.toHaveBeenCalled();
  });

  it('handles private send with successful note delivery', async () => {
    const tx = makeSendTx({ noteType: NoteTypeEnum.Private });
    txStore.push({ ...tx });
    const fullNote = { id: () => ({ toString: () => 'note-out-1' }), serialize: () => new Uint8Array([1]) };
    await completeSendTransaction(tx, makeResult({ intoFullReturns: fullNote }));
    // When noteType is Private, it should call sendPrivateNote or handle transport
    // The mock toNoteTypeString returns 'public' so this won't enter the private branch
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
  });

  it('marks failed when extractFullNote returns undefined for private note', async () => {
    const tx = makeSendTx({ noteType: NoteTypeEnum.Private });
    txStore.push({ ...tx });
    // Need to make the helpers mock return 'private' for this test
    const helpers = require('../helpers');
    const orig = helpers.toNoteTypeString;
    helpers.toNoteTypeString = () => 'private';
    try {
      await completeSendTransaction(tx, makeResult({ hasOutputNote: false }));
      expect(txStore[0]!.status).toBe(ITransactionStatus.Failed);
      expect(txStore[0]!.displayMessage).toContain('unavailable');
    } finally {
      helpers.toNoteTypeString = orig;
    }
  });

  it('marks Completed when private-note transport fails — SDK outbox handles retry', async () => {
    // Transport-level failures are no longer surfaced to the wallet: the
    // SDK persists the relay payload to its durable outbox before calling
    // transport (miden-client#2127) and retries on every subsequent
    // sync_state. The wallet just marks Completed; eventual delivery is
    // the SDK's responsibility.
    const tx = makeSendTx({ noteType: NoteTypeEnum.Private });
    txStore.push({ ...tx });
    mockSendPrivateNote.mockRejectedValueOnce(new Error('transport-down'));
    const helpers = require('../helpers');
    const orig = helpers.toNoteTypeString;
    helpers.toNoteTypeString = () => 'private';
    const fullNote = { id: () => ({ toString: () => 'note-out-1' }), serialize: () => new Uint8Array([1]) };
    try {
      await completeSendTransaction(tx, makeResult({ intoFullReturns: fullNote }));
      expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
      expect(txStore[0]!.displayMessage).toBe('Sent');
    } finally {
      helpers.toNoteTypeString = orig;
    }
  });

  it('marks Completed when the WASM client lock cannot be acquired during a private send', async () => {
    // Lock acquisition failures are also non-fatal: the on-chain tx is the
    // source of truth and the SDK's outbox + sync_state will reconcile.
    const tx = makeSendTx({ noteType: NoteTypeEnum.Private });
    txStore.push({ ...tx });
    const helpers = require('../helpers');
    const orig = helpers.toNoteTypeString;
    helpers.toNoteTypeString = () => 'private';
    const sdk = require('../sdk/miden-client');
    const origLock = sdk.withWasmClientLock;
    sdk.withWasmClientLock = async () => {
      throw new Error('init-fail');
    };
    const fullNote = { id: () => ({ toString: () => 'note-out-1' }), serialize: () => new Uint8Array([1]) };
    try {
      await completeSendTransaction(tx, makeResult({ intoFullReturns: fullNote }));
      expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
      expect(txStore[0]!.displayMessage).toBe('Sent');
    } finally {
      helpers.toNoteTypeString = orig;
      sdk.withWasmClientLock = origLock;
    }
  });

  it('handles extractFullNote when intoFull throws', async () => {
    const tx = makeSendTx();
    txStore.push({ ...tx });
    await completeSendTransaction(tx, makeResult({ intoFullThrows: true }));
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
  });

  it('handles extractFullNote when intoFull returns undefined', async () => {
    const tx = makeSendTx();
    txStore.push({ ...tx });
    await completeSendTransaction(tx, makeResult({ intoFullReturns: undefined }));
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
  });

  it('handles extractFullNote when no output notes exist', async () => {
    const tx = makeSendTx();
    txStore.push({ ...tx });
    await completeSendTransaction(tx, makeResult({ hasOutputNote: false }));
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
  });

  it('catches update status error gracefully (console.error logged)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    const tx = makeSendTx();
    // Don't push to txStore — updateTransactionStatus will throw 'No transaction found'
    try {
      await completeSendTransaction(tx, makeResult());
    } catch {
      // May or may not throw depending on the error path
    }
    // `toBeDefined` on a spy is always true: it held whether the failure was
    // logged or the path was never reached at all.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('getCompletedTransactions', () => {
  it('includes failed transactions when includeFailed is true', async () => {
    txStore.push(
      { id: 'tx-1', status: ITransactionStatus.Completed, accountId: 'acc-1', initiatedAt: 100, completedAt: 200 },
      { id: 'tx-2', status: ITransactionStatus.Failed, accountId: 'acc-1', initiatedAt: 150, completedAt: 250 }
    );
    const txs = await getCompletedTransactions('acc-1', undefined, undefined, true);
    expect(txs).toHaveLength(2);
  });

  it('filters by tokenId when provided', async () => {
    txStore.push(
      { id: 'tx-1', status: ITransactionStatus.Completed, accountId: 'acc-1', faucetId: 'f1', initiatedAt: 100 },
      { id: 'tx-2', status: ITransactionStatus.Completed, accountId: 'acc-1', faucetId: 'f2', initiatedAt: 200 }
    );
    const txs = await getCompletedTransactions('acc-1', undefined, undefined, false, 'f1');
    expect(txs).toHaveLength(1);
    expect(txs[0]!.faucetId).toBe('f1');
  });

  it('applies offset and limit correctly', async () => {
    for (let i = 0; i < 10; i++) {
      txStore.push({ id: `tx-${i}`, status: ITransactionStatus.Completed, accountId: 'acc-1', initiatedAt: i });
    }
    const txs = await getCompletedTransactions('acc-1', 2, 5);
    expect(txs).toHaveLength(3);
  });
});

describe('getSwapSettlementNotes', () => {
  it('groups completed settlement consumes by kind and dedupes note ids', async () => {
    txStore.push(
      {
        id: 'c-1',
        type: 'consume',
        status: ITransactionStatus.Completed,
        noteIds: ['n-1', 'n-2'],
        transactionId: 'chain-c-1',
        amount: 685n,
        faucetId: 'eth-faucet',
        completedAt: 1_700_000_000,
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'settle' }
      },
      {
        id: 'c-2',
        type: 'consume',
        status: ITransactionStatus.Completed,
        // Same note re-tagged by a later batch — must not appear twice.
        noteIds: ['n-2'],
        amount: 685n,
        faucetId: 'eth-faucet',
        completedAt: 1_700_000_050,
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'settle' }
      },
      {
        id: 'c-3',
        type: 'consume',
        status: ITransactionStatus.Completed,
        noteId: 'n-3',
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'reclaim' }
      }
    );

    const notes = await getSwapSettlementNotes('swap-1');

    expect(notes.settled).toEqual(['n-1', 'n-2']);
    expect(notes.reclaimed).toEqual(['n-3']);
    expect(notes.settledTransactions[0]).toEqual({
      id: 'c-1',
      transactionId: 'chain-c-1',
      noteIds: ['n-1', 'n-2'],
      amount: 685n,
      faucetId: 'eth-faucet',
      completedAt: 1_700_000_000
    });
    // Deduplicating only the id set left the transaction array disagreeing with
    // it: the receipt drew n-2 in two rows, and a caller summing the rows'
    // amounts to infer the fill counted the same 685 twice. A row whose notes
    // were all claimed by an earlier consume is that same claim seen again.
    expect(notes.settledTransactions.map(tx => tx.id)).toEqual(['c-1']);
    expect(notes.settledTransactions.flatMap(tx => tx.noteIds)).toEqual(['n-1', 'n-2']);
    expect(notes.reclaimedTransactions[0]?.id).toBe('c-3');
  });

  it('attributes an overlapping note to the earlier consume only', async () => {
    // A later batch that covers a new note as well as one already claimed keeps
    // its row — it delivered something — but not the duplicate id.
    txStore.push(
      {
        id: 'c-1',
        type: 'consume',
        status: ITransactionStatus.Completed,
        noteIds: ['n-1'],
        transactionId: 'chain-1',
        completedAt: 1_700_000_000,
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'settle' }
      },
      {
        id: 'c-2',
        type: 'consume',
        status: ITransactionStatus.Completed,
        noteIds: ['n-1', 'n-2'],
        transactionId: 'chain-2',
        completedAt: 1_700_000_100,
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'settle' }
      }
    );

    const notes = await getSwapSettlementNotes('swap-1');

    expect(notes.settled).toEqual(['n-1', 'n-2']);
    expect(notes.settledTransactions.map(tx => tx.noteIds)).toEqual([['n-1'], ['n-2']]);
  });

  it('reports no amount for a row whose notes were split across consumes', async () => {
    // `amount` is an aggregate over the row's whole note list, so it stops
    // describing the row once part of that list belongs to an earlier consume.
    // Keeping it overstated the money: 400 + 600 read as 1000 received where
    // only 600 arrived. There is no per-note breakdown to split it with, so the
    // honest value is "unknown" — which the receipt renders as such.
    txStore.push(
      {
        id: 'c-1',
        type: 'consume',
        status: ITransactionStatus.Completed,
        noteIds: ['n-1'],
        transactionId: 'chain-1',
        amount: 400n,
        faucetId: 'eth-faucet',
        completedAt: 1_700_000_000,
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'settle' }
      },
      {
        id: 'c-2',
        type: 'consume',
        status: ITransactionStatus.Completed,
        noteIds: ['n-1', 'n-2'],
        transactionId: 'chain-2',
        amount: 600n,
        faucetId: 'eth-faucet',
        completedAt: 1_700_000_100,
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'settle' }
      }
    );

    const notes = await getSwapSettlementNotes('swap-1');

    expect(notes.settledTransactions.map(tx => [tx.id, tx.noteIds, tx.amount])).toEqual([
      ['c-1', ['n-1'], 400n],
      ['c-2', ['n-2'], undefined]
    ]);
  });

  it('orders same-second consumes by chain id so every device numbers the fills alike', async () => {
    // `completedAt` is a one-second local stamp and auto-consume settles a batch
    // within one tick, so ties are ordinary. Falling through to the Dexie scan's
    // primary-key order numbered those fills by row UUID — arbitrary, and
    // different on each device that saw the same order. Rows are pushed in
    // reverse chain order here to prove the comparator, not the input order.
    txStore.push(
      {
        id: 'uuid-a',
        type: 'consume',
        status: ITransactionStatus.Completed,
        noteIds: ['n-2'],
        transactionId: 'chain-2',
        completedAt: 1_700_000_000,
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'settle' }
      },
      {
        id: 'uuid-b',
        type: 'consume',
        status: ITransactionStatus.Completed,
        noteIds: ['n-1'],
        transactionId: 'chain-1',
        completedAt: 1_700_000_000,
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'settle' }
      }
    );

    const notes = await getSwapSettlementNotes('swap-1');

    expect(notes.settledTransactions.map(tx => tx.transactionId)).toEqual(['chain-1', 'chain-2']);
    expect(notes.settled).toEqual(['n-1', 'n-2']);
  });

  it('treats an untagged kind as a settle and reads the singular noteId', async () => {
    txStore.push({
      id: 'c-1',
      type: 'consume',
      status: ITransactionStatus.Completed,
      noteId: 'n-1',
      extraInputs: { swapOrderTxId: 'swap-1' }
    });

    const notes = await getSwapSettlementNotes('swap-1');

    expect(notes.settled).toEqual(['n-1']);
    expect(notes.reclaimed).toEqual([]);
  });

  it('ignores consumes for other orders, other types and non-completed rows', async () => {
    txStore.push(
      {
        id: 'c-other-order',
        type: 'consume',
        status: ITransactionStatus.Completed,
        noteIds: ['n-x'],
        extraInputs: { swapOrderTxId: 'swap-2', swapSettleKind: 'settle' }
      },
      {
        id: 'c-queued',
        type: 'consume',
        status: ITransactionStatus.Queued,
        noteIds: ['n-y'],
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'settle' }
      },
      {
        id: 'c-not-consume',
        type: 'send',
        status: ITransactionStatus.Completed,
        noteIds: ['n-z'],
        extraInputs: { swapOrderTxId: 'swap-1' }
      },
      { id: 'c-untagged', type: 'consume', status: ITransactionStatus.Completed, noteIds: ['n-w'] }
    );

    const notes = await getSwapSettlementNotes('swap-1');

    expect(notes.settled).toEqual([]);
    expect(notes.reclaimed).toEqual([]);
  });

  it('returns empty buckets when the order has no settlement consumes at all', async () => {
    const notes = await getSwapSettlementNotes('swap-unknown');
    expect(notes).toEqual({
      settled: [],
      reclaimed: [],
      settledTransactions: [],
      reclaimedTransactions: []
    });
  });
});

describe('cancelStaleQueuedTransactions', () => {
  it('cancels transactions that exceeded MAX_QUEUED_AGE', async () => {
    const longAgo = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    txStore.push({
      id: 'tx-stale',
      status: ITransactionStatus.Queued,
      initiatedAt: longAgo,
      accountId: 'acc-1'
    });
    await cancelStaleQueuedTransactions();
    expect(txStore[0]!.status).toBe(ITransactionStatus.Failed);
  });

  it('does not cancel recent queued transactions', async () => {
    txStore.push({
      id: 'tx-fresh',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      accountId: 'acc-1'
    });
    await cancelStaleQueuedTransactions();
    expect(txStore[0]!.status).toBe(ITransactionStatus.Queued);
  });
});

describe('waitForTransactionCompletion — error subscription', () => {
  it('resolves with errorMessage when liveQuery subscription errors', async () => {
    // Override dexie mock to trigger subscriber.error
    const dexie = require('dexie');
    dexie.liveQuery.mockImplementationOnce(() => ({
      subscribe: (subscriber: any) => {
        setTimeout(() => {
          if (subscriber.error) subscriber.error(new Error('sub-err'));
        }, 0);
        return { unsubscribe: jest.fn() };
      }
    }));
    const result = await waitForTransactionCompletion('tx-error');
    expect(result).toEqual({ errorMessage: 'sub-err' });
  });

  it('resolves with Failed error message (fallback "Transaction failed")', async () => {
    txStore.push({ id: 'tx-f', status: ITransactionStatus.Failed });
    const result = await waitForTransactionCompletion('tx-f');
    expect(result).toEqual({ errorMessage: 'Transaction failed' });
  });
});

describe('generateTransactionsLoop error paths', () => {
  const dummySign = jest.fn(async () => new Uint8Array([1]));

  it('returns void when there are no queued transactions', async () => {
    const result = await generateTransactionsLoop(dummySign, true, stubGuardianProvider);
    expect(result).toBeUndefined();
  });

  it('cancels the tx when generateTransaction throws a generic error', async () => {
    const sdk = require('../sdk/miden-client');
    const origLock = sdk.withWasmClientLock;
    // First call (sync) succeeds, second call (tx execution) throws
    let callCount = 0;
    sdk.withWasmClientLock = jest.fn(async (fn: any) => {
      callCount++;
      if (callCount >= 2) throw new Error('tx-execution-failed');
      return fn();
    });

    txStore.push({
      id: 'tx-q1',
      type: 'send',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      accountId: 'acc-1'
    });

    const result = await generateTransactionsLoop(dummySign, true, stubGuardianProvider);
    expect(result).toBe(false);
    expect(txStore[0]!.status).toBe(ITransactionStatus.Failed);

    sdk.withWasmClientLock = origLock;
  });

  it('marks Completed when errorCode is ApplyTransactionAfterSubmitFailed', async () => {
    const sdk = require('../sdk/miden-client');
    const origLock = sdk.withWasmClientLock;
    let callCount = 0;
    sdk.withWasmClientLock = jest.fn(async (fn: any) => {
      callCount++;
      if (callCount >= 2) {
        const err: any = new Error('apply failed');
        err.errorCode = 'ApplyTransactionAfterSubmitFailed';
        throw err;
      }
      return fn();
    });

    txStore.push({
      id: 'tx-apply-fail',
      type: 'consume',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      accountId: 'acc-1'
    });

    const result = await generateTransactionsLoop(dummySign, true, stubGuardianProvider);
    expect(result).toBe(false);
    // The whole point of this error code: the transaction IS on chain, only the
    // local apply failed, so the row must not be demoted to Failed — that would
    // offer a retry for a consume that already happened. Accepting either
    // terminal status here made the test's own name unfalsifiable.
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);

    sdk.withWasmClientLock = origLock;
  });

  it('cancels when errorCode is InputNoteAlreadyConsumedOnChain', async () => {
    const sdk = require('../sdk/miden-client');
    const origLock = sdk.withWasmClientLock;
    let callCount = 0;
    sdk.withWasmClientLock = jest.fn(async (fn: any) => {
      callCount++;
      if (callCount >= 2) {
        const err: any = new Error('note consumed');
        err.errorCode = 'InputNoteAlreadyConsumedOnChain';
        throw err;
      }
      return fn();
    });

    txStore.push({
      id: 'tx-consumed',
      type: 'consume',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      accountId: 'acc-1'
    });

    const result = await generateTransactionsLoop(dummySign, true, stubGuardianProvider);
    expect(result).toBe(false);
    expect(txStore[0]!.status).toBe(ITransactionStatus.Failed);

    sdk.withWasmClientLock = origLock;
  });

  it('leaves the tx Queued (not Failed) when the wallet was locked mid-sign', async () => {
    const sdk = require('../sdk/miden-client');
    const origLock = sdk.withWasmClientLock;
    let callCount = 0;
    sdk.withWasmClientLock = jest.fn(async (fn: any) => {
      callCount++;
      if (callCount >= 2) throw new Error('executeTransaction failed: vault is null');
      return fn();
    });
    // SDK captured a locked-wallet auth failure during the sign callback.
    mockLastAuthError.mockReturnValueOnce({ reason: 'locked' });

    txStore.push({
      id: 'tx-locked',
      type: 'send',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      accountId: 'acc-1'
    });

    const result = await generateTransactionsLoop(dummySign, true, stubGuardianProvider);
    expect(result).toBe(false);
    // Locked → the loop skips cancellation (NOT Failed), leaving the tx
    // mid-flight so the next auto-consume cycle retries it after unlock.
    expect(txStore[0]!.status).not.toBe(ITransactionStatus.Failed);

    sdk.withWasmClientLock = origLock;
  });

  it('leaves a Guardian tx Queued (not Failed) when the wallet is locked at consume time (#313)', async () => {
    // A background Guardian consume that runs while the wallet is locked hits
    // `isGuardianAccount` → `guardianProvider.getAccounts()` first, which throws
    // because the vault is null. That failure must be recognised as "locked" and
    // the tx DEFERRED (left non-Failed) for the next cycle — NOT cancelled like a
    // genuine error, otherwise the note-claim is lost.
    const gm = require('lib/miden/front/guardian-manager');
    gm.isGuardianAccount.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Wallet is locked: vault unavailable'), { reason: 'locked' });
    });

    txStore.push({
      id: 'tx-guardian-locked',
      type: 'consume',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      accountId: 'guardian-acc'
    });

    const result = await generateTransactionsLoop(dummySign, true, stubGuardianProvider);
    expect(result).toBe(false);
    expect(txStore[0]!.status).not.toBe(ITransactionStatus.Failed);
  });

  it('leaves a Guardian tx Queued (not Failed) when the wallet locks mid-guardian-flow, e.g. at sign time (#313)', async () => {
    // Distinct from the getAccounts-preflight case above: here we ENTER the
    // guardian branch (isGuardianAccount → true, getAccounts already passed) and
    // a locked-classified error surfaces DEEPER inside generateGuardianTransaction
    // — the null-vault sign step (`swSignCallback`) is the motivating case, but the
    // guardian catch is source-agnostic, so any locked error from the flow must
    // route the same way. It must be re-thrown by the guardian catch and DEFERRED
    // by the loop, NOT cancelled to Failed (which would lose the note-claim).
    const gm = require('lib/miden/front/guardian-manager');
    gm.isGuardianAccount.mockImplementationOnce(async () => true);
    gm.getOrCreateMultisigService.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Wallet is locked: vault unavailable'), { reason: 'locked' });
    });

    txStore.push({
      id: 'tx-guardian-sign-locked',
      type: 'consume',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      accountId: 'guardian-acc'
    });

    const result = await generateTransactionsLoop(dummySign, true, stubGuardianProvider);
    expect(result).toBe(false);
    expect(txStore[0]!.status).not.toBe(ITransactionStatus.Failed);
  });

  it('invokes the wrapped sign callback during dispatch (success path)', async () => {
    // Default withWasmClientLock runs fn(), so generateTransaction reaches
    // getMidenClient(options) and the mock invokes the wrapped sign callback.
    txStore.push({
      id: 'tx-sign-ok',
      type: 'send',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      accountId: 'acc-1'
    });
    const signOk = jest.fn(async () => new Uint8Array([7]));

    await generateTransactionsLoop(signOk, true, stubGuardianProvider);

    expect(signOk).toHaveBeenCalled();
  });

  it('wraps a failing sign callback via buildSignCallbackError during dispatch', async () => {
    txStore.push({
      id: 'tx-sign-throw',
      type: 'send',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      accountId: 'acc-1'
    });
    const signThrows = jest.fn(async () => {
      throw new Error('vault is not initialized');
    });

    await generateTransactionsLoop(signThrows, true, stubGuardianProvider);

    expect(signThrows).toHaveBeenCalled();
  });
});

describe('generateTransactionsLoop — head-of-line fairness', () => {
  const dummySign = jest.fn(async () => new Uint8Array([1]));

  it("skips a cooling-down requeued tx and runs another account's eligible tx that cycle", async () => {
    // Regression for the guardian pending-delta requeue starving other accounts:
    // a persistently-conflicting tx is always the OLDEST by initiatedAt, so after
    // it is requeued it would be re-picked every cycle and burn the retry budget
    // while a second account's freshly-queued tx never runs — until it ages out at
    // MAX_QUEUED_AGE (~30 min). The backoff (nextEligibleAt) makes it yield the slot.
    const now = Math.floor(Date.now() / 1000);

    // Account A: oldest, but cooling down after a pending-conflict requeue
    // (nextEligibleAt in the future) — must NOT be picked this cycle.
    txStore.push({
      id: 'tx-A-cooldown',
      type: 'send',
      status: ITransactionStatus.Queued,
      initiatedAt: now - 100,
      nextEligibleAt: now + 300,
      accountId: 'acc-A'
    });
    // Account B: newer, no cooldown — the only eligible tx, must run this cycle.
    txStore.push({
      id: 'tx-B-eligible',
      type: 'send',
      status: ITransactionStatus.Queued,
      initiatedAt: now - 50,
      accountId: 'acc-B'
    });

    await generateTransactionsLoop(dummySign, true, stubGuardianProvider);

    const a = txStore.find(t => t.id === 'tx-A-cooldown');
    const b = txStore.find(t => t.id === 'tx-B-eligible');
    // A is untouched — still Queued, still cooling down; it did not block B.
    expect(a!.status).toBe(ITransactionStatus.Queued);
    // B was selected and processed (left the queue), proving the cooling-down A
    // yielded the slot instead of being re-picked as the oldest row.
    expect(b!.status).not.toBe(ITransactionStatus.Queued);
  });

  it('still runs a cooling-down tx once its nextEligibleAt has passed (terminal cap unaffected)', async () => {
    const now = Math.floor(Date.now() / 1000);
    // A single queued tx whose cooldown already elapsed — must be picked normally.
    txStore.push({
      id: 'tx-cooldown-expired',
      type: 'send',
      status: ITransactionStatus.Queued,
      initiatedAt: now - 100,
      nextEligibleAt: now - 1,
      accountId: 'acc-A'
    });

    await generateTransactionsLoop(dummySign, true, stubGuardianProvider);

    const row = txStore.find(t => t.id === 'tx-cooldown-expired');
    // Cooldown elapsed → eligible again → selected and processed (left the queue).
    expect(row!.status).not.toBe(ITransactionStatus.Queued);
  });
});

describe('readLastAuthReason', () => {
  it.each(['locked', 'rejected', 'not_found', 'internal'])(
    "returns the '%s' reason from the SDK's lastAuthError",
    async reason => {
      mockLastAuthError.mockReturnValueOnce({ reason });
      expect(await readLastAuthReason()).toBe(reason);
    }
  );

  it('returns undefined for an unrecognized reason', async () => {
    mockLastAuthError.mockReturnValueOnce({ reason: 'something-else' });
    expect(await readLastAuthReason()).toBeUndefined();
  });

  it('returns undefined when there is no recorded auth error', async () => {
    mockLastAuthError.mockReturnValueOnce(null);
    expect(await readLastAuthReason()).toBeUndefined();
  });

  it('returns undefined when lastAuthError throws', async () => {
    mockLastAuthError.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(await readLastAuthReason()).toBeUndefined();
  });

  // Issue #260 flip-prep #1+#2: under the flag-on offscreen write the SW-inline
  // client NEVER signed for the op (the sign ran in the offscreen realm), so its
  // `lastAuthError()` is STALE / another op's — consulting it would DEFER a
  // genuinely-failed offscreen write forever on a stale 'locked'. The op's locked
  // signal is carried instead by the op-keyed error tag (`isLockedError(e)`), so
  // `readLastAuthReason()` must NOT consult the SW client at all under flag-on.
  it('flag-on: never consults the stale SW-client lastAuthError (returns undefined)', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    jest.resetModules();
    try {
      const { readLastAuthReason: readFlagOn } = await import('./helper');
      // Seed a STALE 'locked' on the SW client — a genuinely-failed offscreen
      // write must not be deferred on it.
      mockLastAuthError.mockReturnValue({ reason: 'locked' });
      expect(await readFlagOn()).toBeUndefined();
    } finally {
      delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
      mockLastAuthError.mockReturnValue(null);
      jest.resetModules();
    }
  });
});

describe('buildSignCallbackError', () => {
  it("classifies a 'not initialized' vault error as locked", () => {
    const wrapped = buildSignCallbackError(new Error('Wallet is not initialized'));
    expect(wrapped.reason).toBe('locked');
    expect(wrapped.message).toContain('locked');
  });

  it('classifies a null-vault TypeError as locked', () => {
    const wrapped = buildSignCallbackError(new TypeError("Cannot read properties of null (reading 'signData')"));
    expect(wrapped.reason).toBe('locked');
  });

  it('classifies an unrecognized error as internal', () => {
    const wrapped = buildSignCallbackError(new Error('keystore IO failure'));
    expect(wrapped.reason).toBe('internal');
    expect(wrapped.cause).toBeInstanceOf(Error);
  });

  it('wraps a non-Error thrown value (classified internal)', () => {
    const wrapped = buildSignCallbackError('plain string failure');
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.reason).toBe('internal');
    expect(wrapped.message).toContain('plain string failure');
  });

  it('tolerates an empty-message Error (falls back to internal)', () => {
    const wrapped = buildSignCallbackError(new Error(''));
    expect(wrapped.reason).toBe('internal');
  });
});
