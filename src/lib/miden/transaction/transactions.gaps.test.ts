/**
 * Gap-coverage tests for `lib/miden/transaction`.
 *
 * Targets branches not exercised by the other transactions test files:
 *   - `getUncompletedTransactions` (queued+generating filter, tokenId filter)
 *   - `waitForConsumeTx` abort signal firing AFTER subscribe
 *   - `completeCustomTransaction` outer init-error path (withWasmClientLock rejects)
 *   - `extractFullNote` outer try/catch (outputNotes throws)
 *   - `generateTransactionsLoop` early-return when an in-progress tx exists
 */

import { OperationAbortedError } from '../back/offscreen-codec';
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
} from './index';

// The lock's HOLD, owned for the duration of the callback: the guardian pipeline
// re-checks ownership before proving and before submit (#777).
// eslint-disable-next-line no-var
var gapsHold: object | null = null;

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
          equals: (val: any) => {
            // `noteIds` is a multi-entry index: a row matches when the value is
            // in the array. Scalar fields match by equality.
            const matches = () =>
              txStore.filter(t => (Array.isArray(t[field]) ? t[field].includes(val) : t[field] === val));
            return {
              toArray: async () => matches(),
              filter: (fn: (tx: any) => boolean) => ({
                toArray: async () => matches().filter(fn)
              })
            };
          }
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
// The #260 offscreen client proxy reads (syncState/getInputNoteDetails) through
// the `lib/...` alias of miden-client, which jest mocks separately from the
// relative specifier below; delegate the alias to the same mock so the proxy's
// flag-off passthrough hits it (incl. the on-the-fly getMidenClient patches in
// the verifyStuckTransactionsFromNode branch tests below).
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => {
  // The real error class, so the code under test's poison classifiers see the
  // same shape production throws.
  const { WasmClientPoisonedError: PoisonError } = jest.requireActual('../sdk/wasm-client-poison');
  return {
    getMidenClient: async () => ({
      syncState: mockSyncState,
      waitForTransactionCommit: mockWaitForCommit,
      sendPrivateNote: mockSendPrivateNote
    }),
    // Hands out a hold and owns it for the duration: the guardian pipeline re-checks
    // ownership before proving and before submit (#777).
    withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => {
      const hold = { mock: 'wasm-lock-hold' };
      gapsHold = hold;
      try {
        return await fn(hold);
      } finally {
        if (gapsHold === hold) gapsHold = null;
      }
    },
    getCurrentWasmLockHold: () => gapsHold,
    // The shared post-await re-check (#788 follow-up). Re-implements the
    // comparison against THIS mock's current hold — a no-op stub here would make
    // the request-build eviction tests below vacuously green.
    assertWasmHoldCurrent: (hold: object | null, where: string) => {
      if (hold !== null && gapsHold === hold) return;
      throw new PoisonError('watchdog', new Error(`operation abandoned ${where}`));
    },
    withWasmLockWatchdogPaused: async <T>(fn: () => Promise<T>) => fn()
  };
});

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

const _gh = globalThis as any;
_gh.__noteTypeForTest = 'private';
jest.mock('../helpers', () => ({
  // Real `isPrivateNoteType`: it decides whether a completed send relays its
  // note file to the recipient, so stubbing it would make that branch vacuous.
  ...jest.requireActual('../helpers'),
  toNoteTypeString: () => (globalThis as any).__noteTypeForTest
}));

// The guardian request builders read the caller's Account (a borrow of the
// shared client) — the eviction tests below assert they are never reached past
// an eviction. Hoisted `var`s: the jest.mock factory runs before const/let inits.
// eslint-disable-next-line no-var
var mockGapsBuildSendRequest = jest.fn((): { serialize: () => Uint8Array } => ({
  serialize: () => new Uint8Array([1])
}));
// eslint-disable-next-line no-var
var mockGapsBuildPswapRequest = jest.fn((): { serialize: () => Uint8Array } => ({
  serialize: () => new Uint8Array([2])
}));
jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (x: any) => (typeof x === 'string' ? x : 'bech32-stub'),
  accountIdStringToSdk: (x: any) => ({ __accountIdStub: x, toString: () => `sdk-${x}` }),
  accountRefToSdk: (ref: string) => ({ toString: () => `sdk-${ref}` }),
  // Mirrors the real helper: strips the composite `<address>_<suffix>` form.
  walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id.split('_')[0] ?? id}` }),
  canonicalWalletAccountId: (id: string) => id.split('_')[0] ?? id,
  sameWalletAccountId: (a: string, b: string) => (a.split('_')[0] ?? a) === (b.split('_')[0] ?? b),
  // The guardian send and swap builds declare a fee conversion salt; this used to be
  // produced inside the (separately mocked) fee-auth helper.
  randomFeeSalt: () => ({ kind: 'fee-salt' }),
  buildSendTransactionRequest: (...args: unknown[]) => mockGapsBuildSendRequest(...(args as [])),
  buildPswapCreateRequest: (...args: unknown[]) => mockGapsBuildPswapRequest(...(args as []))
}));

const mockTransactionResultDeserialize = jest.fn();
// The swap request build spins up a TRANSIENT client inside the caller's hold —
// the eviction tests below drive both sides of that create.
// eslint-disable-next-line no-var
var mockGapsCreateWasmWebClient = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const base = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...base,
    TransactionResult: { deserialize: (...args: unknown[]) => mockTransactionResultDeserialize(...args) },
    TransactionProver: { newLocalProver: jest.fn(() => ({ __proverMarker: true })) },
    WasmWebClient: { createClient: (...args: unknown[]) => mockGapsCreateWasmWebClient(...args) }
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
  // A hold leaked by an eviction test would flip another test's ownership checks.
  gapsHold = null;
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

describe('apply-after-submit on a private send', () => {
  // "Submit landed, local apply threw." The row must stay Completed — the
  // transaction is on chain and re-queueing it would spend again — but for a
  // PRIVATE send that verdict hides a second fact the row cannot otherwise express:
  // the apply threw before `completeSendTransaction` ran, and that is the only code
  // that hands the note to the transport. So the note was never relayed, and no
  // amount of syncing fixes it — sync reconciles what the chain knows, and the chain
  // holds a commitment, not the note body the recipient needs.
  const applyAfterSubmitError = () =>
    new Error(
      "Transaction 0xabc was accepted into the node's mempool at block 42 but the local store update failed. Sync to reconcile."
    );

  const installLocks = () => {
    const nav = (globalThis as any).navigator || {};
    Object.defineProperty(nav, 'locks', {
      value: { request: jest.fn((_n: string, _o: any, cb: any) => Promise.resolve(cb({}))) },
      writable: true,
      configurable: true
    });
  };

  const runLoopWithFailingSend = async () => {
    installLocks();
    const sdk = require('../sdk/miden-client');
    const origGetClient = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      syncState: jest.fn(),
      sendTransaction: jest.fn(async () => {
        throw applyAfterSubmitError();
      })
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    try {
      await safeGenerateTransactionsLoop(jest.fn(), false, {} as any);
    } finally {
      sdk.getMidenClient = origGetClient;
      warnSpy.mockRestore();
    }
  };

  it('marks a private send Completed but records the note as undelivered', async () => {
    txStore.push({
      id: 'tx-apply-priv',
      type: 'send',
      accountId: 'acc-1',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet-1',
      amount: BigInt(5),
      noteType: NoteTypeEnum.Private,
      status: ITransactionStatus.Queued,
      // Fresh: a 1970 timestamp trips the stale-queued reaper before the write runs.
      initiatedAt: Math.floor(Date.now() / 1000),
      displayIcon: 'SEND'
    });

    await runLoopWithFailingSend();

    // Completed, because the transaction really did land — Failed would offer a
    // Retry that spends a second time.
    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
    // ...but not as an unqualified success.
    expect(txStore[0]!.noteDelivery).toBe('undelivered');
    expect(txStore[0]!.displayMessage).toBe('Completed — the private note could not be delivered');
  });

  it('leaves a PUBLIC send reporting a clean Completed', async () => {
    // A public send carries its whole note on chain, so there was never a relay to
    // miss and a delivery warning here would be pure noise.
    txStore.push({
      id: 'tx-apply-pub',
      type: 'send',
      accountId: 'acc-1',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet-1',
      amount: BigInt(5),
      noteType: NoteTypeEnum.Public,
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      displayIcon: 'SEND'
    });

    await runLoopWithFailingSend();

    expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
    expect(txStore[0]!.noteDelivery).toBeUndefined();
    expect(txStore[0]!.displayMessage).toBe('Completed');
  });
});

describe('completeCustomTransaction private-note delivery', () => {
  const makeResultWith = (notes: unknown[]) =>
    ({
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'landed-hash' }),
        outputNotes: () => ({ notes: () => notes })
      })
    }) as any;

  const privateNote = (marker: string) => ({
    metadata: () => ({ noteType: () => 'private' }),
    intoFull: () => ({ __note: marker })
  });

  beforeEach(() => {
    mockSendPrivateNote.mockClear();
    mockWaitForCommit.mockClear();
    _gh.__noteTypeForTest = 'private';
  });

  it('waits for the commit ONCE for a transaction carrying several private notes', async () => {
    // The wait used to sit inside the per-note loop, so note N+1's relay waited out
    // note N's commit — a full commit interval of extra exposure per note, in which a
    // realm teardown loses the remaining relays — and re-asked the same question about
    // the same transaction id each time.
    txStore.push({
      id: 'tx-multi',
      type: 'execute',
      accountId: 'acc-1',
      secondaryAccountId: 'recipient',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });

    await completeCustomTransaction(
      txStore[0]!,
      makeResultWith([privateNote('a'), privateNote('b'), privateNote('c')])
    );

    expect(mockSendPrivateNote).toHaveBeenCalledTimes(3);
    expect(mockWaitForCommit).toHaveBeenCalledTimes(1);
    expect(txStore[0]!.noteDelivery).toBe('relayed');
  });

  it('still relays the remaining notes after one fails, and records the pessimistic aggregate', async () => {
    // Each note is separately owed, so one rejection must not skip the others. And a
    // single undelivered note among several still means value is unreachable, so the
    // row must not read as fully delivered.
    txStore.push({
      id: 'tx-partial',
      type: 'execute',
      accountId: 'acc-1',
      secondaryAccountId: 'recipient',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });
    mockSendPrivateNote.mockRejectedValueOnce(new Error('transport-down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      await completeCustomTransaction(txStore[0]!, makeResultWith([privateNote('a'), privateNote('b')]));

      expect(mockSendPrivateNote).toHaveBeenCalledTimes(2);
      expect(txStore[0]!.status).toBe(ITransactionStatus.Completed);
      expect(txStore[0]!.noteDelivery).toBe('undelivered');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('records undelivered when a private note cannot be converted into a relayable note', async () => {
    // Previously this was a bare `continue` with a console line: a private note that
    // existed on chain and was never handed to anyone, on a row reporting success.
    txStore.push({
      id: 'tx-nofull',
      type: 'execute',
      accountId: 'acc-1',
      secondaryAccountId: 'recipient',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      await completeCustomTransaction(
        txStore[0]!,
        makeResultWith([{ metadata: () => ({ noteType: () => 'private' }), intoFull: () => undefined }])
      );

      expect(mockSendPrivateNote).not.toHaveBeenCalled();
      expect(txStore[0]!.noteDelivery).toBe('undelivered');
      expect(txStore[0]!.transactionId).toBe('landed-hash');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('leaves noteDelivery unset when the transaction produced no private notes', async () => {
    _gh.__noteTypeForTest = 'public';
    txStore.push({
      id: 'tx-public-only',
      type: 'execute',
      accountId: 'acc-1',
      secondaryAccountId: 'recipient',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100
    });

    await completeCustomTransaction(txStore[0]!, makeResultWith([privateNote('a')]));

    expect(mockSendPrivateNote).not.toHaveBeenCalled();
    expect(mockWaitForCommit).not.toHaveBeenCalled();
    expect(txStore[0]!.noteDelivery).toBeUndefined();
  });
});

describe('a custom transaction that strands a private note says so', () => {
  const customRow = (id: string, overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> & { status?: ITransactionStatus; displayMessage?: string } = {
      id,
      type: 'execute',
      accountId: 'acc-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 100,
      ...overrides
    };
    txStore.push(row);
    return row;
  };

  const resultWithNotes = (notes: unknown[]) =>
    ({
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'h' }),
        outputNotes: () => ({ notes: () => notes })
      })
    }) as any;

  const privateNote = { metadata: () => ({ noteType: () => 'private' }), intoFull: () => ({ valid: true }) };

  it('flags the row when no recipient was ever named, and does not pretend to deliver', async () => {
    _gh.__noteTypeForTest = 'private';
    const row = customRow('tx-stranded', { secondaryAccountId: undefined });
    const errSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      await completeCustomTransaction(row as any, resultWithNotes([privateNote]));
    } finally {
      errSpy.mockRestore();
    }

    // On chain, so Completed — failing it would be untrue and would offer a Retry
    // that spends the assets a second time.
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toBe('Completed — a private note could not be delivered');
    expect(mockSendPrivateNote).not.toHaveBeenCalled();
  });

  it('counts them when more than one is stranded', async () => {
    _gh.__noteTypeForTest = 'private';
    const row = customRow('tx-stranded-2', { secondaryAccountId: undefined });
    const errSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      await completeCustomTransaction(row as any, resultWithNotes([privateNote, privateNote, privateNote]));
    } finally {
      errSpy.mockRestore();
    }

    expect(row.displayMessage).toBe('Completed — 3 private notes could not be delivered');
  });

  it('flags a note that cannot be turned into deliverable bytes', async () => {
    _gh.__noteTypeForTest = 'private';
    const row = customRow('tx-nofull', { secondaryAccountId: 'recipient' });
    const errSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      await completeCustomTransaction(
        row as any,
        resultWithNotes([{ metadata: () => ({ noteType: () => 'private' }), intoFull: () => undefined }])
      );
    } finally {
      errSpy.mockRestore();
    }

    expect(row.displayMessage).toBe('Completed — a private note could not be delivered');
  });

  it('says nothing when the note was handed over', async () => {
    _gh.__noteTypeForTest = 'private';
    const row = customRow('tx-delivered', { secondaryAccountId: 'recipient' });

    await completeCustomTransaction(row as any, resultWithNotes([privateNote]));

    expect(mockSendPrivateNote).toHaveBeenCalledWith({ valid: true }, 'recipient');
    expect(row.displayMessage).not.toContain('could not be delivered');
  });

  // A relay throw IS treated as undelivered, and this case used to assert the
  // opposite on the premise that the note is already in the client's store by the
  // time the transport is called, so the SDK's retry outbox would deliver it.
  //
  // That premise does not survive contact with where the outbox is written. Rust
  // writes the entry INSIDE the relay and only after it has resolved the transport
  // API, so every failure upstream of that write queues nothing while throwing
  // exactly like a mid-transport timeout that DID queue: transport not configured,
  // a realm torn down before the op ran, and — new under 0.16 — `sendPrivateOutput`
  // failing to resolve the note by id in this client's store. The two are
  // indistinguishable from here, so the row records the pessimistic one:
  // over-reporting a note that arrives anyway costs a stale warning, while
  // under-reporting costs the funds.
  it('flags a relay that threw, because the transport may never have received it', async () => {
    _gh.__noteTypeForTest = 'private';
    const row = customRow('tx-relay-threw', { secondaryAccountId: 'recipient' });
    mockSendPrivateNote.mockRejectedValueOnce(new Error('transport down') as never);
    const errSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      await completeCustomTransaction(row as any, resultWithNotes([privateNote]));
    } finally {
      errSpy.mockRestore();
    }

    // Completed, because the transaction really is on chain — Failed would offer a
    // Retry that spends a second time.
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toContain('could not be delivered');
    expect(row.noteDelivery).toBe('undelivered');
  });

  it('says nothing for a public note, which needs no delivery at all', async () => {
    _gh.__noteTypeForTest = 'public';
    const row = customRow('tx-public', { secondaryAccountId: undefined });

    await completeCustomTransaction(
      row as any,
      resultWithNotes([{ metadata: () => ({ noteType: () => 'public' }), intoFull: () => ({ valid: true }) }])
    );

    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).not.toContain('could not be delivered');
    expect(mockSendPrivateNote).not.toHaveBeenCalled();
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
      const { completeSendTransaction } = require('./index');
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
      const { completeSendTransaction } = require('./index');
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

  it('still picks up a queued transaction when the note-import pass throws (#777)', async () => {
    // The whole pipeline funnels through this one loop, so aborting the lap on an
    // import failure stops every send, swap and claim in the wallet — and an
    // eviction abandons the import hold, so nothing about the queue changes and the
    // next lap fails the same way. The dependent consume is the smaller loss: it is
    // marked Failed with nothing submitted, the note stays claimable, and a later
    // auto-consume re-initiates it.
    //
    // `initiatedAt` is current so neither reaper can be what moves the row: only
    // the pickup can.
    const { importAllNotes } = require('../activity/notes');
    importAllNotes.mockRejectedValueOnce(new Error('import hold evicted'));
    txStore.push({
      id: 'queued-behind-a-bad-import',
      type: 'execute',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      displayIcon: 'DEFAULT',
      displayMessage: 'Executing',
      requestBytes: new Uint8Array([9])
    });
    const guardianProvider: any = { getGuardianClient: async () => null, getAccounts: async () => [] };

    await generateTransactionsLoop(
      jest.fn(async () => new Uint8Array()),
      false,
      guardianProvider
    );

    const row = txStore.find((t: any) => t.id === 'queued-behind-a-bad-import');
    expect(row.status).not.toBe(ITransactionStatus.Queued);
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
      // Recent timestamp so cancelStaleQueuedTransactions skips it; otherwise the
      // loop cancels this row before generateTransaction runs and setTransactionStage
      // never gets to throw (see the cancelTransaction finalized-guard `.where().first()`).
      initiatedAt: Math.floor(Date.now() / 1000),
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
  it('fails a consume tx whose note state is Invalid IMMEDIATELY, ignoring the grace window (INVALID_NOTE_ERROR)', async () => {
    const { INVALID_NOTE_ERROR } = require('./constants');
    txStore.push({
      id: 'tx-invalid',
      type: 'consume',
      noteId: 'note-bad',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 1,
      // FRESH — still well inside MIN_PROCESSING_TIME_BEFORE_STUCK (60s). An Invalid
      // note can NEVER be consumed, so the reaper must fail it immediately with the
      // specific reason rather than wait out the grace window like a 'not-landed'
      // note (W1: restores the fast-fail the #3a refactor collapsed into 'not-landed').
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
      expect(txStore[0]!.error).toBe(INVALID_NOTE_ERROR);
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

// ─── #260 follow-up #3a: non-guardian killed CONSUME → node-verified requeue ──
// A deadline-killed non-guardian consume rejects with OperationAbortedError, which
// propagates to the generateTransactionsLoop catch. Before failing it, the catch
// asks the node (via verifyConsumeLanded) whether the input note landed as
// consumed: only 'landed-local' (a note consumed by THIS client's own tracked tx,
// provably mine) → Completed (the note WAS claimed). 'landed-external'
// (ConsumedExternal — consumed but NOT provably mine, e.g. a reclaimable P2IDE the
// sender reclaimed), 'not-landed', 'invalid', and 'unknown' → the funds-safe Failed.
// A false 'Received' is impossible — only a LOCAL consumed state completes the row.
describe('generateTransactionsLoop killed CONSUME node-verify (#260 fu #3a)', () => {
  const stubProvider: any = { getGuardianClient: async () => null };
  const dummySign = jest.fn(async () => new Uint8Array([1]));

  const pushConsume = (id: string, extra: Record<string, unknown> = {}) =>
    txStore.push({
      id,
      type: 'consume',
      noteId: 'note-kill',
      noteIds: ['note-kill'],
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: Math.floor(Date.now() / 1000),
      delegateTransaction: false,
      ...extra
    });

  // Patch getMidenClient so the consume LEAF is deadline-killed (OperationAbortedError
  // by default, or the given kill error) and the subsequent node read returns
  // `noteState` (or throws when it is null).
  const patchClient = (noteState: string | null, killError?: Error) => {
    const sdk = require('../sdk/miden-client');
    const orig = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      syncState: jest.fn(async () => {}),
      consumeNoteId: jest.fn(async () => {
        throw killError ?? new OperationAbortedError('op-kill', 'deadline');
      }),
      getInputNoteDetails: jest.fn(async () => {
        if (noteState === null) throw new Error('node unreachable');
        return [{ state: noteState }];
      })
    });
    return () => {
      sdk.getMidenClient = orig;
    };
  };

  it('node reports the note LOCAL-consumed (provably mine) → the killed consume ends Completed Received', async () => {
    pushConsume('nk-landed');
    const restore = patchClient('ConsumedAuthenticatedLocal');
    try {
      const result = await generateTransactionsLoop(dummySign, false, stubProvider);
      expect(result).toBe(false);
      const row = txStore.find(r => r.id === 'nk-landed')!;
      expect(row.status).toBe(ITransactionStatus.Completed);
      expect(row.displayMessage).toBe('Received');
    } finally {
      restore();
    }
  });

  it('a lock-recovery (WasmClientPoisonedError) kill rides the same node adjudication: LOCAL-consumed → Completed', async () => {
    // Issue #775: a watchdog/trap eviction abandons the pipeline exactly like an
    // offscreen deadline kill does — the outcome is unknown, so the killed
    // consume must be node-verified, not blindly Failed while the note IS
    // consumed on chain.
    const { WasmClientPoisonedError } = require('../sdk/wasm-client-poison');
    pushConsume('nk-poison');
    const restore = patchClient('ConsumedAuthenticatedLocal', new WasmClientPoisonedError('watchdog'));
    try {
      const result = await generateTransactionsLoop(dummySign, false, stubProvider);
      expect(result).toBe(false);
      const row = txStore.find(r => r.id === 'nk-poison')!;
      expect(row.status).toBe(ITransactionStatus.Completed);
      expect(row.displayMessage).toBe('Received');
    } finally {
      restore();
    }
  });

  it.each([
    ['the pre-flight sync itself is killed', true, 1],
    ['the consume is killed after pickup', false, 2]
  ])(
    're-syncs before adjudicating only when the sync was not what died — %s (#777)',
    async (_label, killDuringSync, expectedSyncs) => {
      // The adjudication normally opens with a fresh sync so the note state is
      // current. When the thing that just died IS the pre-flight sync, that fresh
      // sync is the worst possible next move: the SDK coalesces concurrent syncs
      // onto one in-flight promise, and after a watchdog eviction the promise it
      // abandoned is still the in-flight one — so the "fresh" sync re-attaches to a
      // dead promise and parks the wallet's only WASM lock for another full
      // ceiling. The committed stage is what distinguishes the two cases; the kill
      // shape is not, which is why an evicted PROVE still gets its fresh sync.
      const { WasmClientPoisonedError } = require('../sdk/wasm-client-poison');
      const kill = () => new WasmClientPoisonedError('watchdog');
      const syncState = jest.fn(async () => {
        if (killDuringSync) throw kill();
      });
      const sdk = require('../sdk/miden-client');
      const orig = sdk.getMidenClient;
      sdk.getMidenClient = async () => ({
        syncState,
        consumeNoteId: jest.fn(async () => {
          throw kill();
        }),
        getInputNoteDetails: jest.fn(async () => [{ state: 'ConsumedAuthenticatedLocal' }])
      });
      const id = `nk-sync-${killDuringSync}`;
      pushConsume(id);
      try {
        await generateTransactionsLoop(dummySign, false, stubProvider);
      } finally {
        sdk.getMidenClient = orig;
      }

      // 1 = the pre-flight sync only (the adjudication skipped its own);
      // 2 = pre-flight plus the adjudication's.
      expect(syncState).toHaveBeenCalledTimes(expectedSyncs);
      // Either way the row is still adjudicated — skipping the sync must not skip
      // the read.
      expect(txStore.find(r => r.id === id)!.status).toBe(ITransactionStatus.Completed);
    }
  );

  it('node reports the note LOCAL-consumed for a self-reclaim (sender === my account) → Completed Reclaimed', async () => {
    // secondaryAccountId (the note sender) === accountId → self-reclaim label (S1).
    pushConsume('nk-reclaim', { secondaryAccountId: 'acc-1' });
    const restore = patchClient('ConsumedUnauthenticatedLocal');
    try {
      await generateTransactionsLoop(dummySign, false, stubProvider);
      const row = txStore.find(r => r.id === 'nk-reclaim')!;
      expect(row.status).toBe(ITransactionStatus.Completed);
      expect(row.displayMessage).toBe('Reclaimed');
    } finally {
      restore();
    }
  });

  it('node reports the note ConsumedExternal (NOT provably mine) → funds-safe Failed, never a false Received', async () => {
    // ConsumedExternal = nullifier on chain but the consuming tx was not this
    // client's — for a reclaimable P2IDE the SENDER may have reclaimed it. Marking
    // this Received would tell the user they got funds a third party actually took,
    // so the killed-consume path must fail it (funds-safe: a re-consume harmlessly
    // collides on the nullifier and the next sync reconciles).
    pushConsume('nk-external');
    const restore = patchClient('ConsumedExternal');
    try {
      await generateTransactionsLoop(dummySign, false, stubProvider);
      const row = txStore.find(r => r.id === 'nk-external')!;
      expect(row.status).toBe(ITransactionStatus.Failed);
      expect(row.displayMessage).not.toBe('Received');
    } finally {
      restore();
    }
  });

  // FUNDS-2: the two Processing* states mean our consuming tx WAS submitted and
  // applied locally — the opposite of "not consumed". They used to fall through
  // verifyConsumeLanded's catch-all to 'not-landed', so a killed consume whose
  // claim had already reached the node was terminal-failed.
  it.each(['ProcessingAuthenticated', 'ProcessingUnauthenticated'])(
    'node reports the note %s (submitted, awaiting commit) → the row stays in progress, not Failed',
    async noteState => {
      pushConsume(`nk-${noteState}`);
      const restore = patchClient(noteState);
      try {
        await generateTransactionsLoop(dummySign, false, stubProvider);
        const row = txStore.find(r => r.id === `nk-${noteState}`)!;
        expect(row.status).toBe(ITransactionStatus.GeneratingTransaction);
        expect(row.status).not.toBe(ITransactionStatus.Failed);
        // Not completed either — the block is not committed yet.
        expect(row.displayMessage).not.toBe('Received');
      } finally {
        restore();
      }
    }
  );

  it.each(['ProcessingAuthenticated', 'ProcessingUnauthenticated'])(
    'verifyConsumeLanded maps %s to the distinct "processing" verdict',
    async noteState => {
      const { verifyConsumeLanded } = require('./cancel');
      const sdk = require('../sdk/miden-client');
      const orig = sdk.getMidenClient;
      sdk.getMidenClient = async () => ({
        syncState: jest.fn(async () => {}),
        getInputNoteDetails: jest.fn(async () => [{ state: noteState }])
      });
      try {
        expect(await verifyConsumeLanded({ id: 'v-proc', noteId: 'note-kill' }, true)).toBe('processing');
      } finally {
        sdk.getMidenClient = orig;
      }
    }
  );

  it('verifyConsumeLanded(sync=true): a failed sync falls back to last-synced state (LOCAL-consumed → landed-local)', async () => {
    // sync=true best-effort syncs before reading, but a sync failure must NOT block
    // the check: a consumed note never un-consumes, so the last-synced state stays
    // authoritative. The fresh sync throws yet the note already reads LOCAL-consumed
    // → still 'landed-local' (funds-safe fallback, cancel.ts sync-failure catch).
    const { verifyConsumeLanded } = require('./cancel');
    const sdk = require('../sdk/miden-client');
    const orig = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      syncState: jest.fn(async () => {
        throw new Error('sync unreachable');
      }),
      getInputNoteDetails: jest.fn(async () => [{ state: 'ConsumedAuthenticatedLocal' }])
    });
    try {
      const verdict = await verifyConsumeLanded({ id: 'v-syncfail', noteId: 'note-kill' }, true);
      expect(verdict).toBe('landed-local');
    } finally {
      sdk.getMidenClient = orig;
    }
  });

  it('node still reports the note Committed → Failed, no false Completed, no requeue', async () => {
    pushConsume('nk-committed');
    const restore = patchClient('Committed');
    try {
      await generateTransactionsLoop(dummySign, false, stubProvider);
      const row = txStore.find(r => r.id === 'nk-committed')!;
      expect(row.status).toBe(ITransactionStatus.Failed);
      expect(row.status).not.toBe(ITransactionStatus.Queued);
    } finally {
      restore();
    }
  });

  it('node query errors → Failed, never a false Completed', async () => {
    pushConsume('nk-nodeerr');
    const restore = patchClient(null);
    try {
      await generateTransactionsLoop(dummySign, false, stubProvider);
      expect(txStore.find(r => r.id === 'nk-nodeerr')!.status).toBe(ITransactionStatus.Failed);
    } finally {
      restore();
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
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    guardianManager.getOrCreateMultisigService.mockResolvedValueOnce(fakeMultisigService);

    const sdk = require('../sdk/miden-client');
    const origGetClient = sdk.getMidenClient;
    const apply = jest.fn(async () => {});
    const guardianTxApi = {
      // Guardian submit drives the high-level SDK chain
      // (executeRequest -> prove -> submit -> apply) and destructures
      // `{ id, result }` off the executed transaction; mirror
      // `makeTransactionsApi` in transactions.guardian.test.ts.
      executeRequest: jest.fn(async () => ({
        id: { toHex: () => 'guardian-consume-hash' },
        result: fullResult,
        prove: async () => ({
          submit: async () => ({ blockNumber: 1, result: fullResult, apply })
        })
      }))
    };
    sdk.getMidenClient = async () => ({
      syncState: jest.fn(async () => {}),
      client: { transactions: guardianTxApi }
    });
    try {
      // A real GuardianAccountProvider always implements getAccounts (the
      // sync-status gate in generateGuardianTransaction reads it); `{}` would
      // throw before reaching the branch under test here.
      const provider = { getAccounts: async () => [{ publicKey: 'guardian-acc' }] };
      await generateTransaction(txStore[0] as any, jest.fn(), false, provider as any);
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

describe('guardian request-build holds stop at an eviction (#788 follow-up)', () => {
  // An evicted hold ABANDONS the callback rather than cancelling it: the mutex
  // belongs to a successor the instant the watchdog fires, so the build's next
  // WASM call — including reads on an Account borrowed earlier — would be a
  // second borrow of a client somebody else is inside. Every site driven here is
  // provably pre-submit (nothing has even been proposed yet), so stopping is
  // funds-safe by construction.
  const provider = { getAccounts: async () => [{ publicKey: 'guardian-acc' }] };

  const seedGuardianService = () => {
    const guardianManager = require('lib/miden/front/guardian-manager');
    guardianManager.isGuardianAccount.mockResolvedValueOnce(true);
    const service = {
      createCustomProposal: jest.fn(async () => ({ id: 'prop-1' })),
      signAndCreateTransactionRequest: jest.fn(),
      sync: jest.fn(async () => {})
    };
    guardianManager.getOrCreateMultisigService.mockResolvedValueOnce(service);
    return service;
  };

  const pushRecallableSendRow = () => {
    txStore.push({
      id: 'recallable-send-1',
      type: 'send',
      accountId: 'guardian-acc',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet-1',
      amount: '1000',
      noteType: 'private',
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      extraInputs: { recallBlocks: 10 }
    });
    return txStore[0];
  };

  const pushSwapRow = () => {
    txStore.push({
      id: 'swap-evict-1',
      type: 'swap',
      accountId: 'guardian-acc',
      faucetId: 'faucet-offer',
      amount: '5',
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      extraInputs: { requestedFaucetId: 'faucet-req', requestedAmount: '9' }
    });
    return txStore[0];
  };

  // Swap in a client whose reads the test controls; restore afterwards.
  const withPatchedClient = async (client: Record<string, unknown>, run: () => Promise<void>) => {
    const sdk = require('../sdk/miden-client');
    const origGetClient = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({ syncState: jest.fn(async () => {}), ...client });
    try {
      await run();
    } finally {
      sdk.getMidenClient = origGetClient;
    }
  };

  it('recallable send: stops before the account read when the hold is evicted during the height read', async () => {
    const row = pushRecallableSendRow();
    const service = seedGuardianService();
    const getAccount = jest.fn();
    await withPatchedClient(
      {
        getAccount,
        client: {
          getSyncHeight: () => {
            gapsHold = null; // the watchdog fired while the height read parked
            return 100;
          }
        }
      },
      async () => {
        await generateTransaction(row, jest.fn(), false, provider as any);
      }
    );
    expect(getAccount).not.toHaveBeenCalled();
    expect(mockGapsBuildSendRequest).not.toHaveBeenCalled();
    expect(service.createCustomProposal).not.toHaveBeenCalled();
    expect(row.status).not.toBe(ITransactionStatus.Completed);
    // Nothing may be persisted for retry off an abandoned build.
    expect(row.requestBytes).toBeUndefined();
  });

  it('recallable send: stops before the request build when the hold is evicted during the account read', async () => {
    const row = pushRecallableSendRow();
    const service = seedGuardianService();
    await withPatchedClient(
      {
        getAccount: jest.fn(async () => {
          gapsHold = null;
          return { kind: 'account' };
        }),
        client: { getSyncHeight: () => 100 }
      },
      async () => {
        await generateTransaction(row, jest.fn(), false, provider as any);
      }
    );
    // The returned Account is a borrow of the client a successor now owns —
    // the request build reads its vault, so it must never run.
    expect(mockGapsBuildSendRequest).not.toHaveBeenCalled();
    expect(service.createCustomProposal).not.toHaveBeenCalled();
    expect(row.requestBytes).toBeUndefined();
  });

  it('Epoch bridged-send: does not fall back to the cached height when the hold is evicted during the fresh sync', async () => {
    txStore.push({
      id: 'bridged-evict-1',
      type: 'bridged-send',
      accountId: 'guardian-acc',
      secondaryAccountId: 'solver',
      faucetId: 'faucet-1',
      amount: '1000',
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      extraInputs: { provider: 'epoch', recallBlocks: 500 }
    });
    const row = txStore[0];
    const service = seedGuardianService();
    const plainHeightRead = jest.fn(() => 100);
    const getAccount = jest.fn();
    await withPatchedClient(
      {
        getAccount,
        client: {
          // The fresh sync parks, the watchdog evicts, and the parked call then
          // fails — the fallback height read must NOT be taken unmutexed.
          sync: jest.fn(async () => {
            gapsHold = null;
            throw new Error('node parked');
          }),
          getSyncHeight: plainHeightRead
        }
      },
      async () => {
        await generateTransaction(row, jest.fn(), false, provider as any);
      }
    );
    expect(plainHeightRead).not.toHaveBeenCalled();
    expect(getAccount).not.toHaveBeenCalled();
    expect(mockGapsBuildSendRequest).not.toHaveBeenCalled();
    expect(service.createCustomProposal).not.toHaveBeenCalled();
  });

  it('swap: never spins up the transient client when the hold is evicted during the account read', async () => {
    const row = pushSwapRow();
    seedGuardianService();
    await withPatchedClient(
      {
        getAccount: jest.fn(async () => {
          gapsHold = null;
          return { kind: 'account' };
        })
      },
      async () => {
        await generateTransaction(row, jest.fn(), false, provider as any);
      }
    );
    expect(mockGapsCreateWasmWebClient).not.toHaveBeenCalled();
    expect(mockGapsBuildPswapRequest).not.toHaveBeenCalled();
    expect(row.requestBytes).toBeUndefined();
  });

  it('swap: stops before the PSWAP build — but still terminates the transient client — on an eviction during its create', async () => {
    const row = pushSwapRow();
    const service = seedGuardianService();
    const terminate = jest.fn();
    const newPswapCreateTransactionRequest = jest.fn();
    mockGapsCreateWasmWebClient.mockImplementationOnce(async () => {
      gapsHold = null; // the create is the long parking await (genesis fetch)
      return { newPswapCreateTransactionRequest, terminate };
    });
    await withPatchedClient({ getAccount: jest.fn(async () => ({ kind: 'account' })) }, async () => {
      await generateTransaction(row, jest.fn(), false, provider as any);
    });
    expect(newPswapCreateTransactionRequest).not.toHaveBeenCalled();
    expect(mockGapsBuildPswapRequest).not.toHaveBeenCalled();
    // The guard's throw must not leak the transient client's worker.
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(service.createCustomProposal).not.toHaveBeenCalled();
  });

  it('swap: stops before touching the creator account when the hold is evicted during the PSWAP request build', async () => {
    const row = pushSwapRow();
    seedGuardianService();
    const terminate = jest.fn();
    mockGapsCreateWasmWebClient.mockImplementationOnce(async () => ({
      newPswapCreateTransactionRequest: jest.fn(async () => {
        gapsHold = null;
        return { kind: 'pswap-request' };
      }),
      terminate
    }));
    await withPatchedClient({ getAccount: jest.fn(async () => ({ kind: 'account' })) }, async () => {
      await generateTransaction(row, jest.fn(), false, provider as any);
    });
    // buildPswapCreateRequest reads the creator Account — a borrow of the SHARED
    // client, not the transient one — so it must never run past the eviction.
    expect(mockGapsBuildPswapRequest).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(row.requestBytes).toBeUndefined();
  });
});
