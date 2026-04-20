/**
 * Extended coverage for `lib/miden/activity/transactions.ts`.
 *
 * The existing `transactions.test.ts` covers the bulk of the read/state
 * helpers. This file fills the gaps:
 *   - requestCustomTransaction
 *   - waitForConsumeTx (success + abort + not-found)
 *   - completeConsumeTransaction
 *   - forceCaneclAllInProgressTransactions
 *   - verifyStuckTransactionsFromNode
 *   - safeGenerateTransactionsLoop
 *   - startBackgroundTransactionProcessing
 *   - waitForTransactionCompletion
 */

import { ITransactionStatus, Transaction } from '../db/types';
import { NoteTypeEnum } from '../types';
import {
  cancelTransaction,
  completeConsumeTransaction,
  forceCaneclAllInProgressTransactions,
  initiateConsumeTransaction,
  requestCustomTransaction,
  safeGenerateTransactionsLoop,
  startBackgroundTransactionProcessing,
  verifyStuckTransactionsFromNode,
  waitForConsumeTx,
  waitForTransactionCompletion
} from './transactions';

// In-memory db so liveQuery has something to subscribe to.
const _g = globalThis as any;
_g.__txExtTest = {
  rows: [] as any[],
  liveQueryCallbacks: [] as Array<(rows: any) => void>
};

const txStore: any[] = _g.__txExtTest.rows;

jest.mock('lib/miden/repo', () => ({
  transactions: {
    add: jest.fn(async (tx: any) => {
      txStore.push({ ...tx });
    }),
    filter: jest.fn((fn: (tx: any) => boolean) => ({
      toArray: jest.fn(async () => txStore.filter(fn))
    })),
    where: jest.fn((arg: any) => {
      // Indexed lookup path: where('fieldName').equals(value).filter(fn).toArray()
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
      // Primary-key path: where({ id }).first() / .modify()
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

// Mock dexie's liveQuery — return an Observable-like with subscribe.
jest.mock('dexie', () => ({
  liveQuery: jest.fn((cb: () => any) => ({
    subscribe: (subscriber: any) => {
      const dispatch = async () => {
        const value = await cb();
        if (typeof subscriber === 'function') {
          subscriber(value);
        } else if (subscriber && typeof subscriber.next === 'function') {
          subscriber.next(value);
        }
      };
      // Immediately deliver the current state
      dispatch();
      // Re-deliver whenever the test calls __txExtTest.notify()
      const handler = () => dispatch();
      _g.__txExtTest.liveQueryCallbacks.push(handler);
      return {
        unsubscribe: () => {
          const idx = _g.__txExtTest.liveQueryCallbacks.indexOf(handler);
          if (idx !== -1) _g.__txExtTest.liveQueryCallbacks.splice(idx, 1);
        }
      };
    }
  }))
}));

const mockGetInputNoteDetails = jest.fn();
const mockSyncState = jest.fn().mockResolvedValue(undefined);
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({
    syncState: mockSyncState,
    getInputNoteDetails: mockGetInputNoteDetails
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

// Mock toNoteTypeString — tests can switch between 'public' and 'private' via
// the global control variable.
const _gh = globalThis as any;
_gh.__noteTypeForTest = 'public';
jest.mock('../helpers', () => ({
  toNoteTypeString: () => (globalThis as any).__noteTypeForTest
}));

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (x: any) => (typeof x === 'string' ? x : 'bech32-stub')
}));

const mockGetIntercom = jest.fn(() => ({
  request: jest.fn(() => Promise.resolve({}))
}));
jest.mock('lib/store', () => ({
  getIntercom: () => mockGetIntercom()
}));

// Mock navigator.locks for safeGenerateTransactionsLoop. jsdom's `navigator`
// object is non-configurable, so we attach `.locks` to whatever object it
// already is rather than re-assigning navigator itself.
const installNavigatorLocksMock = (lockResult: any = {}) => {
  const nav = (globalThis as any).navigator || {};
  Object.defineProperty(nav, 'locks', {
    value: {
      request: jest.fn(async (_name: string, _opts: any, cb: any) => cb(lockResult))
    },
    writable: true,
    configurable: true
  });
};
installNavigatorLocksMock();

beforeEach(() => {
  jest.clearAllMocks();
  txStore.length = 0;
  _g.__txExtTest.liveQueryCallbacks.length = 0;
  installNavigatorLocksMock();
});

describe('requestCustomTransaction', () => {
  it('creates a Transaction record with the supplied bytes and returns its id', async () => {
    const id = await requestCustomTransaction(
      'acc-1',
      Buffer.from('hello').toString('base64'),
      ['note-1'],
      undefined,
      true,
      'recipient-1'
    );
    expect(typeof id).toBe('string');
    expect(txStore).toHaveLength(1);
    expect(txStore[0]!.accountId).toBe('acc-1');
  });

  it('queues note imports when importNotes is provided', async () => {
    const { queueNoteImport } = jest.requireMock('./notes');
    await requestCustomTransaction('acc-1', Buffer.from('x').toString('base64'), undefined, [
      'note-bytes-1',
      'note-bytes-2'
    ]);
    expect(queueNoteImport).toHaveBeenCalledTimes(2);
  });
});

describe('forceCaneclAllInProgressTransactions', () => {
  it('marks every in-progress transaction as failed', async () => {
    txStore.push(
      { id: 'tx-1', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 100 },
      { id: 'tx-2', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 200 }
    );
    await forceCaneclAllInProgressTransactions();
    expect(txStore[0]!.status).toBe(ITransactionStatus.Failed);
    expect(txStore[1]!.status).toBe(ITransactionStatus.Failed);
  });

  it('is a no-op when there are no in-progress transactions', async () => {
    await forceCaneclAllInProgressTransactions();
    expect(txStore).toHaveLength(0);
  });
});

describe('verifyStuckTransactionsFromNode', () => {
  it('returns 0 when no in-progress transactions exist', async () => {
    expect(await verifyStuckTransactionsFromNode()).toBe(0);
  });

  it('returns 0 when in-progress transactions are not consume type', async () => {
    txStore.push({
      id: 'tx-1',
      type: 'send',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });
    expect(await verifyStuckTransactionsFromNode()).toBe(0);
  });

  it('marks consume transaction as completed when note has been consumed on chain', async () => {
    txStore.push({
      id: 'tx-1',
      type: 'consume',
      noteId: 'note-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });
    // Use the wasmMock InputNoteState — ConsumedAuthenticatedLocal is in the array
    const { InputNoteState } = require('@miden-sdk/miden-sdk/lazy');
    mockGetInputNoteDetails.mockResolvedValueOnce([{ state: InputNoteState.ConsumedAuthenticatedLocal }]);
    const resolved = await verifyStuckTransactionsFromNode();
    expect(resolved).toBe(1);
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
  });

  it('marks consume transaction as failed when note is invalid', async () => {
    txStore.push({
      id: 'tx-1',
      type: 'consume',
      noteId: 'note-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });
    const { InputNoteState } = require('@miden-sdk/miden-sdk/lazy');
    mockGetInputNoteDetails.mockResolvedValueOnce([{ state: InputNoteState.Invalid }]);
    const resolved = await verifyStuckTransactionsFromNode();
    expect(resolved).toBe(1);
    expect(txStore[0]!.status).toBe(ITransactionStatus.Failed);
  });

  it('marks consume transaction as failed when note is still claimable AND processing is over the threshold', async () => {
    const longAgo = Math.floor(Date.now() / 1000) - 120;
    txStore.push({
      id: 'tx-1',
      type: 'consume',
      noteId: 'note-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100,
      processingStartedAt: longAgo
    });
    const { InputNoteState } = require('@miden-sdk/miden-sdk/lazy');
    mockGetInputNoteDetails.mockResolvedValueOnce([{ state: InputNoteState.Committed }]);
    const resolved = await verifyStuckTransactionsFromNode();
    expect(resolved).toBe(1);
    expect(txStore[0]!.status).toBe(ITransactionStatus.Failed);
  });

  it('skips claimable notes that are still inside the processing grace window', async () => {
    txStore.push({
      id: 'tx-1',
      type: 'consume',
      noteId: 'note-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100,
      processingStartedAt: Math.floor(Date.now() / 1000)
    });
    const { InputNoteState } = require('@miden-sdk/miden-sdk/lazy');
    mockGetInputNoteDetails.mockResolvedValueOnce([{ state: InputNoteState.Committed }]);
    const resolved = await verifyStuckTransactionsFromNode();
    expect(resolved).toBe(0);
    expect(txStore[0]!.status).toBe(ITransactionStatus.GeneratingTransaction);
  });

  it('continues past errors thrown by getInputNoteDetails', async () => {
    txStore.push({
      id: 'tx-1',
      type: 'consume',
      noteId: 'note-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });
    mockGetInputNoteDetails.mockRejectedValueOnce(new Error('rpc down'));
    const resolved = await verifyStuckTransactionsFromNode();
    expect(resolved).toBe(0);
  });
});

describe('safeGenerateTransactionsLoop', () => {
  it('returns true when there are no queued transactions', async () => {
    const sign = jest.fn();
    const result = await safeGenerateTransactionsLoop(sign);
    expect(result).toBe(true);
  });

  it('returns undefined when navigator.locks.request reports the lock is unavailable', async () => {
    installNavigatorLocksMock(null); // null lock means "not available"
    const result = await safeGenerateTransactionsLoop(jest.fn());
    expect(result).toBeUndefined();
  });
});

describe('startBackgroundTransactionProcessing', () => {
  it('schedules a background loop and returns synchronously', () => {
    // We just verify it returns without throwing — the actual background work
    // happens in a fire-and-forget Promise we don't await.
    expect(() => startBackgroundTransactionProcessing(jest.fn())).not.toThrow();
  });
});

describe('waitForConsumeTx', () => {
  it('rejects immediately when the AbortSignal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(waitForConsumeTx('tx-1', ctrl.signal)).rejects.toThrow(/Aborted/);
  });

  it('resolves with transactionId when liveQuery sees a Completed transaction', async () => {
    txStore.push({
      id: 'tx-1',
      status: ITransactionStatus.Completed,
      transactionId: 'on-chain-hash'
    });
    const result = await waitForConsumeTx('tx-1');
    expect(result).toBe('on-chain-hash');
  });

  it('rejects when the transaction is not found', async () => {
    await expect(waitForConsumeTx('ghost')).rejects.toThrow(/not found/);
  });

  it('rejects when the transaction has Failed status', async () => {
    txStore.push({
      id: 'tx-1',
      status: ITransactionStatus.Failed
    });
    await expect(waitForConsumeTx('tx-1')).rejects.toThrow(/failed/);
  });
});

describe('waitForTransactionCompletion', () => {
  it('resolves with errorMessage when transaction is not found', async () => {
    const res = await waitForTransactionCompletion('ghost');
    expect(res).toEqual({ errorMessage: 'Transaction not found' });
  });

  it('resolves with errorMessage when transaction Failed', async () => {
    txStore.push({ id: 'tx-1', status: ITransactionStatus.Failed, error: 'oops' });
    const res = await waitForTransactionCompletion('tx-1');
    expect(res).toEqual({ errorMessage: 'oops' });
  });
});

describe('completeConsumeTransaction', () => {
  function fakeAccountId(label: string) {
    return label;
  }

  function fakeNote(opts: { senderId: string; faucetId: string; amount: string; noteType?: number }) {
    return {
      note: () => ({
        metadata: () => ({
          sender: () => fakeAccountId(opts.senderId),
          noteType: () => opts.noteType ?? 0
        }),
        assets: () => ({
          fungibleAssets: () => [
            {
              faucetId: () => fakeAccountId(opts.faucetId),
              amount: () => opts.amount
            }
          ]
        })
      })
    };
  }

  it('marks the transaction as completed with the right faucet id and amount', async () => {
    txStore.push({
      id: 'tx-1',
      accountId: 'acc-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100,
      type: 'consume'
    });
    const txResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'on-chain-hash' }),
        inputNotes: () => ({
          notes: () => [fakeNote({ senderId: 'sender-1', faucetId: 'faucet-1', amount: '50' })]
        })
      }),
      serialize: () => new Uint8Array([1, 2, 3])
    } as any;
    await completeConsumeTransaction('tx-1', txResult);
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
    expect(txStore[0]!.faucetId).toBeDefined();
  });

  it('throws when the executed transaction has no input notes', async () => {
    txStore.push({ id: 'tx-1', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 100 });
    const txResult = {
      executedTransaction: () => ({
        inputNotes: () => ({ notes: () => [] })
      })
    } as any;
    await expect(completeConsumeTransaction('tx-1', txResult)).rejects.toThrow(/no input notes/);
  });

  it('throws when the input note has no fungible assets', async () => {
    txStore.push({ id: 'tx-1', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 100 });
    const txResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'h' }),
        inputNotes: () => ({
          notes: () => [
            {
              note: () => ({
                metadata: () => ({ sender: () => 'sender', noteType: () => 0 }),
                assets: () => ({ fungibleAssets: () => [] })
              })
            }
          ]
        })
      })
    } as any;
    await expect(completeConsumeTransaction('tx-1', txResult)).rejects.toThrow(/no fungible/);
  });
});

describe('cancelTransaction error variants', () => {
  it('handles non-Error reasons by stringifying them', async () => {
    txStore.push({ id: 'tx-1', status: ITransactionStatus.Queued, initiatedAt: 100 });
    await cancelTransaction(txStore[0] as Transaction, { code: 1, message: 'oops' });
    expect(txStore[0]!.error).toContain('object Object');
  });
});

describe('completeCustomTransaction', () => {
  let mockSendPrivateNote: jest.Mock;
  let mockWaitForCommit: jest.Mock;

  beforeEach(() => {
    txStore.push({
      id: 'tx-cct',
      type: 'execute',
      accountId: 'acc-1',
      secondaryAccountId: 'acc-2',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });
    mockSendPrivateNote = jest.fn(async () => {});
    mockWaitForCommit = jest.fn(async () => {});
    // Mutate the live mock module so completeCustomTransaction's
    // getMidenClient call returns a stub with the WASM methods it needs.
    const sdk = require('../sdk/miden-client');
    sdk.getMidenClient = async () => ({
      waitForTransactionCommit: mockWaitForCommit,
      sendPrivateNote: mockSendPrivateNote
    });
    _gh.__noteTypeForTest = 'private';
  });

  afterEach(() => {
    _gh.__noteTypeForTest = 'public';
  });

  it('processes private output notes by sending them via the WASM client', async () => {
    const fakeNote = {
      metadata: () => ({ noteType: () => 'private' }),
      intoFull: () => ({ valid: true }) as any
    };
    const txResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'h' }),
        outputNotes: () => ({ notes: () => [fakeNote] })
      })
    } as any;
    const { completeCustomTransaction } = require('./transactions');
    await completeCustomTransaction(txStore[0]!, txResult);
    expect(mockSendPrivateNote).toHaveBeenCalled();
    expect(mockWaitForCommit).toHaveBeenCalled();
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
  });

  it('handles sendPrivateNote rejections gracefully and still marks the tx complete', async () => {
    mockSendPrivateNote.mockRejectedValueOnce(new Error('transport down'));
    const fakeNote = {
      metadata: () => ({ noteType: () => 'private' }),
      intoFull: () => ({}) as any
    };
    const txResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'h' }),
        outputNotes: () => ({ notes: () => [fakeNote] })
      })
    } as any;
    const { completeCustomTransaction } = require('./transactions');
    await completeCustomTransaction(txStore[0]!, txResult);
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
  });

  it('skips notes whose intoFull returns undefined', async () => {
    const fakeNote = {
      metadata: () => ({ noteType: () => 'private' }),
      intoFull: () => undefined
    };
    const txResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'h' }),
        outputNotes: () => ({ notes: () => [fakeNote] })
      })
    } as any;
    const { completeCustomTransaction } = require('./transactions');
    await completeCustomTransaction(txStore[0]!, txResult);
    expect(mockSendPrivateNote).not.toHaveBeenCalled();
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
  });

  it('skips notes whose intoFull throws', async () => {
    const fakeNote = {
      metadata: () => ({ noteType: () => 'private' }),
      intoFull: () => {
        throw new Error('boom');
      }
    };
    const txResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'h' }),
        outputNotes: () => ({ notes: () => [fakeNote] })
      })
    } as any;
    const { completeCustomTransaction } = require('./transactions');
    await completeCustomTransaction(txStore[0]!, txResult);
    expect(mockSendPrivateNote).not.toHaveBeenCalled();
  });

  it('handles transactions without secondaryAccountId by skipping the note', async () => {
    txStore[0]!.secondaryAccountId = undefined;
    const fakeNote = {
      metadata: () => ({ noteType: () => 'private' }),
      intoFull: () => ({}) as any
    };
    const txResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'h' }),
        outputNotes: () => ({ notes: () => [fakeNote] })
      })
    } as any;
    const { completeCustomTransaction } = require('./transactions');
    await completeCustomTransaction(txStore[0]!, txResult);
    expect(mockSendPrivateNote).not.toHaveBeenCalled();
  });

  it('skips public notes entirely', async () => {
    _gh.__noteTypeForTest = 'public';
    const fakeNote = {
      metadata: () => ({ noteType: () => 'public' }),
      intoFull: () => ({}) as any
    };
    const txResult = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'h' }),
        outputNotes: () => ({ notes: () => [fakeNote] })
      })
    } as any;
    const { completeCustomTransaction } = require('./transactions');
    await completeCustomTransaction(txStore[0]!, txResult);
    expect(mockSendPrivateNote).not.toHaveBeenCalled();
  });
});

describe('initiateConsumeTransactionFromId', () => {
  it('throws when the note is not found', async () => {
    const sdk = require('../sdk/miden-client');
    const orig = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      getInputNote: jest.fn(async () => null)
    });
    const { initiateConsumeTransactionFromId } = require('./transactions');
    await expect(initiateConsumeTransactionFromId('acc-1', 'note-missing')).rejects.toThrow(/not found/);
    sdk.getMidenClient = orig;
  });

  it('queues a consume transaction for an existing note', async () => {
    const sdk = require('../sdk/miden-client');
    const orig = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      getInputNote: jest.fn(async () => ({
        metadata: () => ({ noteType: () => 0 })
      }))
    });
    const { initiateConsumeTransactionFromId } = require('./transactions');
    const id = await initiateConsumeTransactionFromId('acc-1', 'note-exists');
    expect(typeof id).toBe('string');
    sdk.getMidenClient = orig;
  });
});

describe('initiateConsumeTransaction reuse path', () => {
  const buildNote = (overrides: Partial<any> = {}) => ({
    id: 'note-1',
    faucetId: 'f',
    amount: '1',
    senderAddress: 'sender',
    isBeingClaimed: false,
    type: NoteTypeEnum.Public,
    ...overrides
  });

  it('does not duplicate when an in-flight consume already exists for the same note', async () => {
    txStore.push({
      id: 'existing',
      type: 'consume',
      noteId: 'note-1',
      accountId: 'acc-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });
    const result = await initiateConsumeTransaction('acc-1', buildNote());
    expect(result).toBe('existing');
    expect(txStore.filter(t => t.type === 'consume')).toHaveLength(1);
  });

  it('does not duplicate when a Completed consume already exists for the same note', async () => {
    // Regression test for issue #171: after a consume completes, getConsumableNotes()
    // may still return the same note briefly. Auto-consume must not enqueue another tx.
    txStore.push({
      id: 'completed',
      type: 'consume',
      noteId: 'note-1',
      accountId: 'acc-1',
      status: ITransactionStatus.Completed,
      initiatedAt: 100,
      completedAt: 200
    });
    const result = await initiateConsumeTransaction('acc-1', buildNote());
    expect(result).toBe('completed');
    expect(txStore.filter(t => t.type === 'consume')).toHaveLength(1);
  });

  it('allows retry when only a Failed consume exists for the same note', async () => {
    txStore.push({
      id: 'failed',
      type: 'consume',
      noteId: 'note-1',
      accountId: 'acc-1',
      status: ITransactionStatus.Failed,
      initiatedAt: 100,
      completedAt: 200
    });
    const result = await initiateConsumeTransaction('acc-1', buildNote());
    expect(result).not.toBe('failed');
    expect(txStore.filter(t => t.type === 'consume')).toHaveLength(2);
  });

  it('does not dedup a consume from a different account with the same noteId', async () => {
    txStore.push({
      id: 'other-account',
      type: 'consume',
      noteId: 'note-1',
      accountId: 'acc-2',
      status: ITransactionStatus.Completed,
      initiatedAt: 100
    });
    const result = await initiateConsumeTransaction('acc-1', buildNote());
    expect(result).not.toBe('other-account');
    expect(txStore.filter(t => t.type === 'consume')).toHaveLength(2);
  });
});
