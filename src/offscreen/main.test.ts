/* eslint-disable import/first */
/**
 * Coverage tests for `src/offscreen/main.ts` — the offscreen document that
 * boots the multi-threaded rayon WASM pool and answers OFFSCREEN_PROVE
 * requests over chrome.runtime.
 *
 * The module has NO exports; everything happens as top-level side effects at
 * import time (init() → getWasmOrThrow → initThreadPool → OFFSCREEN_READY) plus
 * a chrome.runtime.onMessage listener. So each scenario re-imports the module
 * with `jest.resetModules()` after arranging:
 *   - a hand-rolled `chrome` mock whose onMessage.addListener captures the
 *     registered listener so we can invoke it directly, and whose sendMessage
 *     we can make resolve or reject.
 *   - `self.crossOriginIsolated` and `navigator.hardwareConcurrency` globals.
 *   - a per-test-controllable `@miden-sdk/miden-sdk/lazy` mock (via the global
 *     `__off` control object) exposing getWasmOrThrow / initThreadPool /
 *     WebClient / TransactionResult / TransactionProver.
 *
 * The jest.mock factory below overrides the repo's default wasmMock.js mapping
 * (which doesn't export any of the symbols this module needs).
 */

import { encodeArg, OFFSCREEN_SIGN_REQUEST } from 'lib/miden/back/offscreen-codec';

type Listener = (msg: any, sender: any, sendResponse: (r?: any) => void) => boolean | undefined;

const G = globalThis as any;

// This spec has no static import/export, so without a module marker TS treats it
// as a global script and its top-level helpers (logSpy/flush/loadModule/…) collide
// with identically-named globals in sibling spec files (TS2451/TS2393). The empty
// export makes it a module so every top-level declaration is file-scoped. It is a
// pure module marker, not a test-helper export, hence the jest/no-export override.
// eslint-disable-next-line jest/no-export
export {};

// Override the moduleNameMapper → wasmMock.js binding for the lazy subpath.
// The factory decides `initThreadPool`'s presence at import time from the
// `hasInitThreadPool` flag (set before each `await import`), and delegates
// every call to jest.fns on the `__off` control object so per-test behaviour
// (resolve / reject / return values) is fully controllable.
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const g = globalThis as any;
  const mod: any = {
    getWasmOrThrow: (...a: any[]) => g.__off.getWasmOrThrow(...a),
    WebClient: class {
      constructor() {
        g.__off.webClientCtorCount++;
      }
      proveTransaction(...a: any[]) {
        return g.__off.proveTransaction(...a);
      }
    },
    TransactionResult: {
      deserialize: (...a: any[]) => g.__off.deserializeTxResult(...a)
    },
    // Slice 6a: the guardianPipeline DISPATCH deserializes the co-signed request
    // bytes back into a TransactionRequest before executing it.
    TransactionRequest: {
      deserialize: (...a: any[]) => g.__off.deserializeTxRequest(...a)
    },
    // Slice 7b: the sendPrivateNote DISPATCH re-hydrates the relayed note from the
    // raw bytes that crossed the boundary.
    Note: {
      deserialize: (...a: any[]) => g.__off.deserializeNote(...a)
    },
    TransactionProver: {
      deserialize: (...a: any[]) => g.__off.deserializeProver(...a),
      newLocalProver: (...a: any[]) => g.__off.newLocalProver(...a)
    }
  };
  // Single-threaded SDK builds simply don't export initThreadPool; model that
  // by omitting the property entirely so `typeof initThreadPool !== 'function'`.
  if (g.__off.hasInitThreadPool) {
    mod.initThreadPool = (...a: any[]) => g.__off.initThreadPool(...a);
  }
  return mod;
});

// The offscreen doc now owns the full client singleton (issue #260 §3.4); mock
// the SW-side accessor so OFFSCREEN_CALL dispatch is fully controllable and the
// real client graph never loads. Harmless to the OFFSCREEN_PROVE tests, which
// never touch getMidenClient. `withWasmClientLock` / `yieldWasmClientLock` are a
// real (tiny) mutex sharing one lock so W1's serialization of concurrent
// OFFSCREEN_CALLs — and follow-up #1's mutex-yield during the commit-wait sleep —
// are BOTH testable against the same lock; its closure state resets per test
// because loadModule() re-runs this factory after jest.resetModules().
jest.mock('lib/miden/sdk/miden-client', () => {
  const g = globalThis as any;
  let locked = false;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (!locked) {
      locked = true;
      return;
    }
    await new Promise<void>(resolve => waiters.push(resolve));
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else locked = false;
  };
  // Issue #775: eviction is not cancellation. The real lock rejects the WAITER
  // with a poisoned error and releases the mutex, while the operation keeps
  // running — which is the only state in which a corpse and its successor are
  // both live. `g.__off.evictHolder()` reproduces exactly that, so the offscreen
  // behaviours that depend on it (a stamp under the corpse's own id, a sign the
  // corpse must not get) are reachable from a test. Exported off the mock module
  // rather than the `__off` control object, whose contents are replaced per test.
  let evictCurrent: (() => void) | null = null;
  // Issue #775: each hold gets an IDENTITY, mirroring the real module, because the
  // behaviours under test turn on whether a yielding flow still owns the mutex.
  // A single shared token cannot express that — with one, an evicted flow's yield
  // still queues on `acquire()` and therefore can never observe a successor
  // holding the lock, which is the entire hazard.
  let currentHold: object | null = null;
  const withWasmClientLock = async <T>(op: (hold: object) => Promise<T>): Promise<T> => {
    await acquire();
    const hold = { mock: 'wasm-lock-hold' };
    currentHold = hold;
    let settled = false;
    const releaseOnce = (): void => {
      if (settled) return;
      settled = true;
      if (currentHold === hold) currentHold = null;
      release();
    };
    const evicted = new Promise<never>((_resolve, reject) => {
      evictCurrent = () => {
        // The operation is deliberately NOT awaited or cancelled here.
        releaseOnce();
        reject(new Error('WASM client poisoned (realm-error): evicted by the test harness'));
      };
    });
    try {
      return await Promise.race([op(hold), evicted]);
    } finally {
      releaseOnce();
    }
  };
  const __evictHolder = (): void => {
    const evict = evictCurrent;
    evictCurrent = null;
    if (evict) evict();
  };
  // Mirrors the real yieldWasmClientLock: release the lock, run the (WASM-free)
  // op, then reacquire before resolving — so a second op can win the lock while a
  // commit-wait sleeps, proving the yield actually releases it.
  //
  // A caller whose hold is no longer current has been EVICTED, and the real module
  // then runs the op without touching the mutex at all: releasing would hand away
  // a lock somebody else owns, and reacquiring would deadlock a flow nobody is
  // waiting on. So an evicted flow resumes IMMEDIATELY after its sleep, while the
  // successor still holds the lock — the window the corpse guards exist for.
  const yieldWasmClientLock = async <T>(op: () => Promise<T>, hold?: object): Promise<T> => {
    if (hold !== undefined && hold !== currentHold) return op();
    release();
    try {
      return await op();
    } finally {
      await acquire();
      if (hold !== undefined) currentHold = hold;
    }
  };
  // Test hook: true while the shared lock is held (used to assert the commit-wait
  // yielded it during the sleep).
  const isWasmClientBusy = (): boolean => locked;
  return {
    getMidenClient: (...a: any[]) => g.__off.getMidenClient(...a),
    withWasmClientLock,
    withWasmLockWatchdogPaused: async <T>(op: () => Promise<T>): Promise<T> => op(),
    yieldWasmClientLock,
    isWasmClientBusy,
    __evictHolder,
    getCurrentWasmLockHold: () => currentHold,
    onWasmClientPoisoned: (listener: () => void) => {
      g.__off.poisonedListeners = g.__off.poisonedListeners ?? [];
      g.__off.poisonedListeners.push(listener);
      return () => {};
    }
  };
});

// The endpoint-override cache is module-scoped, i.e. PER REALM, so the offscreen
// doc hydrates it itself at init and re-hydrates it on the SW's
// OFFSCREEN_RELOAD_ENDPOINTS nudge. Delegate to a control fn so a test can observe
// the call count and — where the ORDERING against client creation is what's under
// test — hold the load open with a deferred promise.
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const g = globalThis as any;
  return { loadEndpointOverrides: (...a: any[]) => g.__off.loadEndpointOverrides(...a) };
});

// Slice 5: the offscreen doc creates its client via `MidenClientInterface.create`
// (with the reverse-IPC sign stub + `useWorker:false`) instead of the SW
// singleton `getMidenClient`. Delegate `create` to the SAME `g.__off.getMidenClient`
// control fn so the existing "reuses client" / "S1 retry" assertions keep working;
// the create options are captured on `g.__off.createOptions` for the new assertions.
// `remoteProver` / `withDelegatedProveTimeout` must be part of this factory, not
// omitted: the guardian pipeline names its delegated prover EXPLICITLY and bounds the
// wait, and both helpers live in this module. A partial mock exporting only
// `MidenClientInterface` resolves them to `undefined`, so `remoteProver()` throws
// INSIDE the pipeline's own remote-prove catch — which reads that as "the remote
// prove failed" and silently re-proves locally. Every delegated guardian prove would
// then pass its assertions while never delegating at all, hiding precisely the
// regression these tests exist to catch (the same partial-mock trap that once
// silenced `sdk/prove-telemetry`; see `offscreen-realm.ts`).
jest.mock('lib/miden/sdk/miden-client-interface', () => {
  const g = globalThis as any;
  return {
    MidenClientInterface: {
      create: (opts: any) => {
        g.__off.createOptions.push(opts);
        g.__off.order.push('create');
        return g.__off.getMidenClient(opts);
      }
    },
    remoteProver: (...a: any[]) => g.__off.remoteProver(...a),
    // Pass-through: the wrapper's own timeout behaviour is covered in
    // miden-client-interface.test.ts. What matters here is only that the pipeline
    // routes its delegated prove THROUGH it, asserted via `guardianProveBounded`.
    withDelegatedProveTimeout: (p: Promise<unknown>) => {
      g.__off.guardianProveBounded = true;
      return p;
    }
  };
});

let capturedListener: Listener | undefined;
let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

function resetControl() {
  G.__off = {
    // Ordered log of the realm-startup steps whose SEQUENCE is load-bearing: the
    // endpoint-override load must precede both the WASM init and any client create,
    // because the client BAKES the effective endpoints in at creation time.
    order: [] as string[],
    loadEndpointOverrides: jest.fn(async () => {
      (globalThis as any).__off.order.push('loadEndpointOverrides');
    }),
    getWasmOrThrow: jest.fn(async () => {
      (globalThis as any).__off.order.push('getWasmOrThrow');
    }),
    hasInitThreadPool: true,
    initThreadPool: jest.fn(async () => {}),
    webClientCtorCount: 0,
    proveTransaction: jest.fn(async () => ({ serialize: () => new Uint8Array([1, 2, 3]) })),
    deserializeTxResult: jest.fn(() => ({ __txResult: true })),
    // Slice 6a: TransactionRequest.deserialize(trBytes) → a request handle the
    // guardianPipeline hands to executeRequest. Echo the bytes so the test can
    // assert the co-signed request crossed intact.
    deserializeTxRequest: jest.fn((b: Uint8Array) => ({ __trFromBytes: Array.from(b) })),
    // Slice 7b: Note.deserialize(noteBytes) → a live-Note handle the sendPrivateNote
    // DISPATCH hands to the client. Echo the bytes so the test can assert the note
    // crossed intact.
    deserializeNote: jest.fn((b: Uint8Array) => ({ __noteFromBytes: Array.from(b) })),
    deserializeProver: jest.fn(async (d: string) => ({ __fromDescriptor: d })),
    newLocalProver: jest.fn(() => ({ __local: true })),
    // The explicit REMOTE prover the guardian pipeline hands a delegated prove, so
    // the assertions can tell a real delegation from the SDK default-prover fallback
    // (`prove({})`) that never dispatches out of this realm. Overridden to
    // `undefined` by the test covering "no prover endpoint configured".
    remoteProver: jest.fn(() => ({ __remote: true })),
    // Set by the `withDelegatedProveTimeout` mock when the pipeline routes its
    // delegated prove through the bounded wrapper.
    guardianProveBounded: false,
    // OFFSCREEN_CALL dispatch: the offscreen-owned client's getAccount returns
    // an Account-like object exposing serialize() (the SDK's real serializer).
    clientGetAccount: jest.fn(async (_id: string) => ({ serialize: () => new Uint8Array([10, 20, 30]) })),
    // Slice-3 read methods on the offscreen-owned client.
    clientSyncState: jest.fn(async () => ({ __syncSummary: true })),
    // Slice-6b structural commit-wait on the offscreen-owned client (void).
    // Retained for back-compat; the follow-up #1 dispatch no longer calls it —
    // it drives the poll loop via client.client.syncChain + transactions.list below.
    clientWaitForTransactionCommit: jest.fn(async (_id: string) => {}),
    // Follow-up #1: the in-realm commit-wait poll loop drives these directly on the
    // raw client. `syncChain` is the chain-only sync each iteration; `transactionsList`
    // returns the id-filtered TransactionRecord[]. Default: a single committed record so
    // a plain commit-wait resolves on the first poll. Per-test overrides model pending →
    // committed, discarded, and never-committed (timeout).
    committedStatus: { transactionStatus: () => ({ isCommitted: () => true, isDiscarded: () => false }) },
    pendingStatus: { transactionStatus: () => ({ isCommitted: () => false, isDiscarded: () => false }) },
    discardedStatus: { transactionStatus: () => ({ isCommitted: () => false, isDiscarded: () => true }) },
    clientSyncChain: jest.fn(async () => ({ __syncSummary: true })),
    clientTransactionsList: jest.fn(async (_q: { ids: string[] }) => [(globalThis as any).__off.committedStatus]),
    clientExportNote: jest.fn(async (_id: string, _t: string) => new Uint8Array([44, 55, 66])),
    clientGetInputNoteDetails: jest.fn(async (_q: unknown) => [
      { noteId: '0xabc', senderAccountId: 'mtst1qsender', assets: [], noteType: 0, nullifier: '0xn', state: 2 }
    ]),
    clientGetTransactionCommitState: jest.fn(async (_txId: string) => 'committed'),
    // Slice-4 consumable-note DTOs on the offscreen-owned client.
    clientGetConsumableNoteDtos: jest.fn(async (_id: string) => [
      {
        noteId: '0xnote',
        nullifier: '0xnull',
        noteType: 1,
        senderAccountId: 'mtst1qsender',
        state: 2,
        assets: [{ amount: '100', faucetId: 'mtst1qfaucet' }],
        swapAttachment: null
      }
    ]),
    // Slice-5 consume: the offscreen-owned client's consumeNoteId returns a
    // TransactionResult-like object exposing serialize() (the offscreen DISPATCH
    // ships the serialized bytes back).
    clientConsumeNoteId: jest.fn(async (_dto: unknown) => ({ serialize: () => new Uint8Array([77, 88, 99]) })),
    // Slice-5b writes on the offscreen-owned client — each returns a
    // TransactionResult-like object exposing serialize() (the DISPATCH ships the
    // serialized bytes back).
    clientSendTransaction: jest.fn(async (_tx: unknown) => ({ serialize: () => new Uint8Array([11, 22, 33]) })),
    clientSwapTransaction: jest.fn(async (_tx: unknown) => ({ serialize: () => new Uint8Array([44, 55, 66, 77]) })),
    clientNewTransaction: jest.fn(async (_a: unknown, _b: unknown, _c: unknown) => ({
      serialize: () => new Uint8Array([88, 99])
    })),
    // Slice-7a deferred reach-through reads on the offscreen-owned client. The
    // live-record returns are shaped exactly as the shared reducers read them; the
    // sync height + pswap lineage are reached through the raw `.client`.
    clientGetSyncHeight: jest.fn(async () => 4242),
    clientSync: jest.fn(async () => ({ blockNum: () => 5000 })),
    clientLineage: jest.fn(async (_orderId: string) => ({
      orderId: () => '77',
      currentTipNoteId: () => ({ toString: () => '0xtip' }),
      currentDepth: () => 2,
      state: () => 1,
      remainingOffered: () => 10n,
      remainingRequested: () => 20n
    })),
    clientGetInputNote: jest.fn(async (_id: string) => ({ metadata: () => ({ noteType: () => 1 }) })),
    clientImportNoteBytes: jest.fn(async (_bytes: Uint8Array) => '0ximportedid'),
    clientDrainPrivateNoteTransport: jest.fn(async () => {}),
    clientImportRecoveryNoteBytes: jest.fn(async () => ({ imported: 1, failures: 0 })),
    clientRecoverPublicNotesRange: jest.fn(async () => ({ imported: 2, failures: 0 })),
    // Slice 7b: the private-note relay on the offscreen-owned client (void).
    clientSendPrivateNote: jest.fn(async (_note: unknown, _to: string) => {}),
    clientRelayPrivateNoteById: jest.fn(async (_noteId: string, _to: string) => {}),
    clientIsOutputNoteConsumed: jest.fn(async (_noteId: string) => false),
    // Slice 6a guardianPipeline: the RAW client transactions API the DISPATCH
    // drives directly (execute→prove→submit→apply on a pre-built request). The
    // default returns a TransactionExecution-like whose result serializes to
    // [55,66,77]; `prove` records the options it was called with (prover
    // selection assertions) and honors a per-test `guardianProveShouldFailOnce`
    // flag (the delegated remote→local fallback). Overridable per test.
    guardianProveCalls: [] as any[],
    guardianProveShouldFailOnce: false,
    guardianSubmitted: false,
    guardianApplied: false,
    guardianExecuteRequest: jest.fn(async (_accountId: string, _tr: unknown) => {
      const g2 = globalThis as any;
      return {
        result: { serialize: () => new Uint8Array([55, 66, 77]) },
        id: { toHex: () => 'guardian-exec-hash' },
        prove: jest.fn(async (options?: any) => {
          g2.__off.guardianProveCalls.push(options);
          if (g2.__off.guardianProveShouldFailOnce) {
            g2.__off.guardianProveShouldFailOnce = false;
            throw new Error('remote prover deadline expired');
          }
          return {
            submit: jest.fn(async () => {
              g2.__off.guardianSubmitted = true;
              return {
                apply: jest.fn(async () => {
                  g2.__off.guardianApplied = true;
                })
              };
            })
          };
        })
      };
    }),
    // Create options captured per MidenClientInterface.create call (slice 5).
    createOptions: [] as any[],
    // Issue #775: recovery marks a displaced client poisoned instead of freeing
    // it, so the client's own corpse guards keep firing for flows that still
    // hold it.
    clientMarkPoisoned: jest.fn(),
    getMidenClient: jest.fn(async () => ({
      markPoisoned: (...a: any[]) => (globalThis as any).__off.clientMarkPoisoned(...a),
      getAccount: (...a: any[]) => (globalThis as any).__off.clientGetAccount(...a),
      syncState: (...a: any[]) => (globalThis as any).__off.clientSyncState(...a),
      waitForTransactionCommit: (...a: any[]) => (globalThis as any).__off.clientWaitForTransactionCommit(...a),
      exportNote: (...a: any[]) => (globalThis as any).__off.clientExportNote(...a),
      getInputNoteDetails: (...a: any[]) => (globalThis as any).__off.clientGetInputNoteDetails(...a),
      getTransactionCommitState: (...a: any[]) => (globalThis as any).__off.clientGetTransactionCommitState(...a),
      getConsumableNoteDtos: (...a: any[]) => (globalThis as any).__off.clientGetConsumableNoteDtos(...a),
      consumeNoteId: (...a: any[]) => (globalThis as any).__off.clientConsumeNoteId(...a),
      sendTransaction: (...a: any[]) => (globalThis as any).__off.clientSendTransaction(...a),
      swapTransaction: (...a: any[]) => (globalThis as any).__off.clientSwapTransaction(...a),
      newTransaction: (...a: any[]) => (globalThis as any).__off.clientNewTransaction(...a),
      // Slice-7a: getInputNote / importNoteBytes are interface methods on the
      // offscreen-owned client; the DISPATCH reduces getInputNote in-realm.
      getInputNote: (...a: any[]) => (globalThis as any).__off.clientGetInputNote(...a),
      importNoteBytes: (...a: any[]) => (globalThis as any).__off.clientImportNoteBytes(...a),
      drainPrivateNoteTransport: (...a: any[]) => (globalThis as any).__off.clientDrainPrivateNoteTransport(...a),
      importRecoveryNoteBytes: (...a: any[]) => (globalThis as any).__off.clientImportRecoveryNoteBytes(...a),
      recoverPublicNotesRange: (...a: any[]) => (globalThis as any).__off.clientRecoverPublicNotesRange(...a),
      sendPrivateNote: (...a: any[]) => (globalThis as any).__off.clientSendPrivateNote(...a),
      relayPrivateNoteById: (...a: any[]) => (globalThis as any).__off.clientRelayPrivateNoteById(...a),
      isOutputNoteConsumed: (...a: any[]) => (globalThis as any).__off.clientIsOutputNoteConsumed(...a),
      // The raw client the guardian leaf pipeline + slice-7a sync-height/lineage
      // reads drive directly.
      client: {
        transactions: {
          executeRequest: (...a: any[]) => (globalThis as any).__off.guardianExecuteRequest(...a),
          // Follow-up #1: id-filtered transaction list the commit-wait poll loop reads.
          list: (...a: any[]) => (globalThis as any).__off.clientTransactionsList(...a)
        },
        // Follow-up #1: chain-only sync the commit-wait poll loop runs each iteration.
        syncChain: (...a: any[]) => (globalThis as any).__off.clientSyncChain(...a),
        getSyncHeight: (...a: any[]) => (globalThis as any).__off.clientGetSyncHeight(...a),
        sync: (...a: any[]) => (globalThis as any).__off.clientSync(...a),
        pswap: { lineage: (...a: any[]) => (globalThis as any).__off.clientLineage(...a) }
      }
    }))
  };
}

function installChromeMock() {
  capturedListener = undefined;
  G.chrome = {
    runtime: {
      sendMessage: jest.fn(() => Promise.resolve()),
      onMessage: {
        addListener: jest.fn((l: Listener) => {
          capturedListener = l;
        })
      }
    }
  };
}

function setCrossOriginIsolated(value: boolean) {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    value,
    configurable: true,
    writable: true
  });
}

function setHardwareConcurrency(value: number | undefined) {
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    value,
    configurable: true
  });
}

// Flush the microtask + macrotask queue enough times for the init() promise
// chain (two awaits) and the follow-up sendMessage().catch() to settle.
const flush = async () => {
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

/** Reset modules, arrange globals, import the module and let init() settle. */
async function loadModule(opts: { coi?: boolean; hwc?: number | undefined } = {}) {
  const coi = opts.coi ?? true;
  // Use an `in` check so an *explicit* `hwc: undefined` (exercising the `?? 4`
  // fallback) isn't clobbered by a destructuring default.
  const hwc = 'hwc' in opts ? opts.hwc : 8;
  jest.resetModules();
  installChromeMock();
  setCrossOriginIsolated(coi);
  setHardwareConcurrency(hwc);
  await import('./main');
  await flush();
}

beforeEach(() => {
  resetControl();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  delete G.chrome;
});

describe('offscreen/main — startup / init()', () => {
  it('boots the rayon pool and signals OFFSCREEN_READY (COI on, MT build, hwc known)', async () => {
    await loadModule({ coi: true, hwc: 8 });

    expect(G.__off.getWasmOrThrow).toHaveBeenCalledTimes(1);
    expect(G.__off.initThreadPool).toHaveBeenCalledWith(8);
    // COI on → no SharedArrayBuffer warning.
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('crossOriginIsolated=false'));
    // Timing + loaded log fired, plus the ready signal to the SW.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('initThreadPool(8) took'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('loaded'));
    expect(G.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_READY' });
    // Message listener registered.
    expect(typeof capturedListener).toBe('function');
  });

  // The endpoint-override cache lives in module scope, so it is PER REALM: the SW's
  // own load never reaches this document, and without one every getEffective*Url() /
  // getEffectiveNetworkName() here would answer the build default — wrong node for
  // every write/sync, and a bech32 prefix that disagrees with the SW's.
  it('hydrates the endpoint override FIRST, before the WASM/thread-pool init', async () => {
    await loadModule();

    expect(G.__off.loadEndpointOverrides).toHaveBeenCalledTimes(1);
    // Ordering, not just presence: the load has to complete before anything in this
    // realm can read an endpoint or encode an id.
    expect(G.__off.order[0]).toBe('loadEndpointOverrides');
    expect(G.__off.order).toContain('getWasmOrThrow');
    expect(G.__off.order.indexOf('loadEndpointOverrides')).toBeLessThan(G.__off.order.indexOf('getWasmOrThrow'));
  });

  it('warns when crossOriginIsolated is false (SAB unavailable)', async () => {
    await loadModule({ coi: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('crossOriginIsolated=false'));
    // Still brings up the pool and signals ready.
    expect(G.__off.initThreadPool).toHaveBeenCalledWith(8);
    expect(G.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_READY' });
  });

  it('defaults to 4 threads when navigator.hardwareConcurrency is undefined', async () => {
    await loadModule({ hwc: undefined });
    expect(G.__off.initThreadPool).toHaveBeenCalledWith(4);
  });

  it('warns and skips initThreadPool when the SDK build is single-threaded', async () => {
    resetControl();
    G.__off.hasInitThreadPool = false;
    await loadModule();
    expect(G.__off.initThreadPool).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('initThreadPool not exported'));
    // init() still resolves → OFFSCREEN_READY fires.
    expect(G.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_READY' });
  });

  it('swallows the OFFSCREEN_READY sendMessage rejection when the SW is not listening', async () => {
    resetControl();
    jest.resetModules();
    installChromeMock();
    setCrossOriginIsolated(true);
    setHardwareConcurrency(8);
    G.chrome.runtime.sendMessage = jest.fn(() => Promise.reject(new Error('no receiver')));
    await import('./main');
    await flush();
    // No unhandled rejection / no error logged from the swallowed .catch(()=>{}).
    expect(G.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_READY' });
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('init failed'), expect.anything());
  });

  it('logs the error and does not signal ready when init() fails', async () => {
    resetControl();
    G.__off.getWasmOrThrow = jest.fn(async () => {
      throw new Error('wasm load boom');
    });
    await loadModule();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('init failed'), expect.any(Error));
    expect(G.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  // Issue #260 flip-prep #4: the doc marks its own realm at module top so the
  // recursion guard (isInOffscreenDocument) can short-circuit isOffscreenAvailable
  // → false in-realm, making a write prove locally instead of re-dispatching
  // OFFSCREEN_PROVE to a non-existent in-doc handler.
  it('marks the realm as the offscreen document (__MIDEN_IN_OFFSCREEN_DOC__ = true) at module load', async () => {
    delete (G as any).__MIDEN_IN_OFFSCREEN_DOC__;
    await loadModule();
    expect((G as any).__MIDEN_IN_OFFSCREEN_DOC__).toBe(true);
  });
});

describe('offscreen/main — onMessage listener guard clauses', () => {
  it('ignores an undefined message (returns false, no response)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(undefined, {}, sendResponse);
    expect(ret).toBe(false);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('ignores a message not targeted at the offscreen doc (returns false)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!({ target: 'somewhere-else', type: 'OFFSCREEN_PROVE' }, {}, sendResponse);
    expect(ret).toBe(false);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('ignores a non-OFFSCREEN_PROVE message even when target matches (returns false)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!({ target: 'offscreen', type: 'SOMETHING_ELSE' }, {}, sendResponse);
    expect(ret).toBe(false);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe('offscreen/main — OFFSCREEN_PROVE handling', () => {
  const provReq = (extra: Record<string, unknown>) => ({
    target: 'offscreen',
    type: 'OFFSCREEN_PROVE',
    txResultB64: Buffer.from([9, 8, 7]).toString('base64'),
    ...extra
  });

  it('proves with a local prover when no descriptor is supplied (ok:true)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(provReq({ proverDescriptor: null }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    expect(G.__off.deserializeTxResult).toHaveBeenCalledTimes(1);
    expect(G.__off.newLocalProver).toHaveBeenCalledTimes(1);
    expect(G.__off.deserializeProver).not.toHaveBeenCalled();
    expect(G.__off.webClientCtorCount).toBe(1);

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(typeof resp.durationMs).toBe('number');
    // provenB64 round-trips the serialized [1,2,3] bytes.
    expect(Array.from(Buffer.from(resp.provenB64, 'base64'))).toEqual([1, 2, 3]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('prove duration_ms='));
  });

  it('deserializes the prover from the descriptor when one is supplied (ok:true)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(provReq({ proverDescriptor: 'remote|http://x|5000' }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    expect(G.__off.deserializeProver).toHaveBeenCalledWith('remote|http://x|5000');
    expect(G.__off.newLocalProver).not.toHaveBeenCalled();
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('reuses a single WebClient instance across successive prove calls', async () => {
    await loadModule();
    const r1 = jest.fn();
    capturedListener!(provReq({ proverDescriptor: null }), {}, r1);
    await flush();
    const r2 = jest.fn();
    capturedListener!(provReq({ proverDescriptor: null }), {}, r2);
    await flush();

    expect(r1.mock.calls[0][0].ok).toBe(true);
    expect(r2.mock.calls[0][0].ok).toBe(true);
    // getProver() cached the client → constructor ran exactly once.
    expect(G.__off.webClientCtorCount).toBe(1);
  });

  it('responds ok:false with the Error message when proving throws an Error', async () => {
    await loadModule();
    G.__off.proveTransaction = jest.fn(async () => {
      throw new Error('WASM exploded');
    });
    const sendResponse = jest.fn();
    capturedListener!(provReq({ proverDescriptor: null }), {}, sendResponse);
    await flush();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('prove failed'), expect.any(Error));
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'WASM exploded' });
  });

  it('responds ok:false with String(err) when the thrown value has no message', async () => {
    await loadModule();
    // Throw a plain string — no `.message` property → falls back to String(err).
    G.__off.proveTransaction = jest.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'raw failure string';
    });
    const sendResponse = jest.fn();
    capturedListener!(provReq({ proverDescriptor: null }), {}, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'raw failure string' });
  });

  it('chunk-encodes proven output larger than 0x8000 bytes', async () => {
    await loadModule();
    const big = new Uint8Array(0x9000).fill(0x42);
    G.__off.proveTransaction = jest.fn(async () => ({ serialize: () => big }));
    const sendResponse = jest.fn();
    capturedListener!(provReq({ proverDescriptor: null }), {}, sendResponse);
    await flush();

    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    const decoded = Buffer.from(resp.provenB64, 'base64');
    expect(decoded.length).toBe(0x9000);
    expect(decoded[0]).toBe(0x42);
    expect(decoded[0x9000 - 1]).toBe(0x42);
  });
});

describe('offscreen/main — OFFSCREEN_CALL dispatch (issue #260)', () => {
  const callReq = (extra: Record<string, unknown>) => ({
    target: 'offscreen',
    type: 'OFFSCREEN_CALL',
    op_id: 'op-abc',
    deadline_ms: 1000,
    argsB64: [],
    ...extra
  });

  it('dispatches getAccount, serializes the Account, and echoes op_id (ok:true)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(
      callReq({ method: 'getAccount', argsB64: [encodeArg('mtst1qqaccount')] }),
      {},
      sendResponse
    );
    expect(ret).toBe(true);
    await flush();

    // Arg decoded across the wire back to the original accountId.
    expect(G.__off.clientGetAccount).toHaveBeenCalledWith('mtst1qqaccount');
    // getMidenClient resolved the offscreen-owned client.
    expect(G.__off.getMidenClient).toHaveBeenCalledTimes(1);

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-abc');
    expect(typeof resp.durationMs).toBe('number');
    // resultB64 round-trips the serialized [10,20,30] Account bytes.
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([10, 20, 30]);
  });

  // Issue #260 flip-prep #3: when an op wins the WASM mutex and begins executing,
  // the doc posts OFFSCREEN_OP_STARTED (target sw, op_id) so the SW arms the write
  // deadline at execution start, not dispatch. Fire-and-forget, from inside the lock.
  it('posts OFFSCREEN_OP_STARTED (target sw + op_id) when the op begins executing', async () => {
    await loadModule();
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      posted.push(m);
      return undefined;
    });
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ op_id: 'op-start', method: 'getAccount', argsB64: [encodeArg('a')] }),
      {},
      sendResponse
    );
    await flush();

    const started = posted.find(m => m?.type === 'OFFSCREEN_OP_STARTED');
    expect(started).toBeTruthy();
    expect(started.target).toBe('sw');
    expect(started.op_id).toBe('op-start');
    // The dispatched op still completed normally.
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('does NOT post OFFSCREEN_OP_STARTED for an unknown method (never wins the mutex)', async () => {
    await loadModule();
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      posted.push(m);
      return undefined;
    });
    const sendResponse = jest.fn();
    capturedListener!(callReq({ op_id: 'op-x', method: 'frobnicate', argsB64: [] }), {}, sendResponse);
    await flush();

    expect(posted.find(m => m?.type === 'OFFSCREEN_OP_STARTED')).toBeUndefined();
    expect(sendResponse.mock.calls[0][0].errorCode).toBe('UNKNOWN_METHOD');
  });

  it('returns resultB64:null when getAccount finds no account', async () => {
    await loadModule();
    G.__off.clientGetAccount = jest.fn(async () => null);
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('missing')] }), {}, sendResponse);
    await flush();

    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-abc');
    expect(resp.resultB64).toBeNull();
  });

  it('reuses the offscreen-owned client across successive calls', async () => {
    await loadModule();
    const r1 = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('a')] }), {}, r1);
    await flush();
    const r2 = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('b')] }), {}, r2);
    await flush();

    expect(r1.mock.calls[0][0].ok).toBe(true);
    expect(r2.mock.calls[0][0].ok).toBe(true);
    // getOrCreateClient cached the client → getMidenClient ran exactly once.
    expect(G.__off.getMidenClient).toHaveBeenCalledTimes(1);
  });

  it('responds ok:false + UNKNOWN_METHOD for an unregistered method', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(callReq({ method: 'frobnicate', argsB64: [] }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.op_id).toBe('op-abc');
    expect(resp.errorCode).toBe('UNKNOWN_METHOD');
    // Never resolved a client for an unknown method.
    expect(G.__off.getMidenClient).not.toHaveBeenCalled();
  });

  it('responds ok:false with the Error message when the dispatched method throws', async () => {
    await loadModule();
    G.__off.clientGetAccount = jest.fn(async () => {
      throw new Error('store read boom');
    });
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('x')] }), {}, sendResponse);
    await flush();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("call 'getAccount' failed"), expect.any(Error));
    const resp = sendResponse.mock.calls[0][0];
    expect(resp).toEqual({ ok: false, op_id: 'op-abc', error: 'store read boom' });
  });

  it('preserves the SDK errorCode on the ok:false reply when a WRITE throws an apply-after-submit error (#260 funds-critical)', async () => {
    await loadModule();
    // The offscreen client runs `useWorker:false`, so a failed write throws the RAW
    // main-thread JsError still carrying the SDK's `errorCode` string (the exact
    // shape `extractSdkErrorCode` reads on the flag-off inline path). The catch must
    // ship that code across the bus, or the SW classifier reads undefined and
    // MISCLASSIFIES an on-chain-live tx as Failed → requeue → double-spend.
    const applyErr: Error & { errorCode?: string } = new Error('local apply failed after submit');
    applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
    G.__off.clientSendTransaction = jest.fn(async () => {
      throw applyErr;
    });
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'sendTransaction',
        argsB64: [
          encodeArg({
            accountId: 'mtst1qacc',
            secondaryAccountId: 'mtst1qrecipient',
            faucetId: 'mtst1qfaucet',
            noteType: 'public',
            amount: '1000',
            extraInputs: {}
          })
        ]
      }),
      {},
      sendResponse
    );
    await flush();

    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.op_id).toBe('op-abc');
    expect(resp.error).toContain('local apply failed after submit');
    // The stable code rides the reply → the SW re-attaches it → Completed, not Failed.
    expect(resp.errorCode).toBe('ApplyTransactionAfterSubmitFailed');
  });

  it('ignores an OFFSCREEN_CALL not targeted at the offscreen doc (returns false)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(
      {
        target: 'somewhere-else',
        type: 'OFFSCREEN_CALL',
        op_id: 'x',
        method: 'getAccount',
        argsB64: [],
        deadline_ms: null
      },
      {},
      sendResponse
    );
    expect(ret).toBe(false);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('W1: serializes concurrent OFFSCREEN_CALLs through the offscreen WASM mutex', async () => {
    await loadModule();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    G.__off.clientGetAccount = jest.fn(async (id: string) => {
      order.push(`start:${id}`);
      if (id === 'first') await firstGate;
      order.push(`end:${id}`);
      return { serialize: () => new Uint8Array([1]) };
    });

    const r1 = jest.fn();
    const r2 = jest.fn();
    capturedListener!(callReq({ op_id: 'op1', method: 'getAccount', argsB64: [encodeArg('first')] }), {}, r1);
    capturedListener!(callReq({ op_id: 'op2', method: 'getAccount', argsB64: [encodeArg('second')] }), {}, r2);
    await flush();

    // Second op is queued behind the first's lock — it has NOT begun dispatch.
    expect(order).toEqual(['start:first']);

    releaseFirst();
    await flush();

    // First fully completes and releases before the second even starts.
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    expect(r1.mock.calls[0][0].ok).toBe(true);
    expect(r2.mock.calls[0][0].ok).toBe(true);
  });

  it('dispatches syncState, runs the sync, and returns resultB64:null (SyncSummary discarded)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(callReq({ method: 'syncState', argsB64: [] }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    expect(G.__off.clientSyncState).toHaveBeenCalledTimes(1);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-abc');
    // The sync ran, but its SyncSummary is deliberately not serialized.
    expect(resp.resultB64).toBeNull();
  });

  it('drives the commit-wait poll loop in-realm (syncChain + id-filtered list) and resolves resultB64:null when committed', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(
      callReq({ method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
      {},
      sendResponse
    );
    expect(ret).toBe(true);
    await flush();

    // Follow-up #1: the wait no longer delegates to the SDK's waitFor — it drives the
    // poll loop against the OFFSCREEN-owned raw client (the realm that applied the tx),
    // reproducing waitFor's chain-sync + id-filter. The default status is committed, so
    // it resolves on the first poll WITHOUT ever sleeping (no yield needed).
    expect(G.__off.clientSyncChain).toHaveBeenCalledTimes(1);
    expect(G.__off.clientTransactionsList).toHaveBeenCalledWith({ ids: ['0xtxid'] });
    // The old delegate is never called anymore.
    expect(G.__off.clientWaitForTransactionCommit).not.toHaveBeenCalled();
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-abc');
    // The wait resolves void — nothing to serialize back to the SW.
    expect(resp.resultB64).toBeNull();
  });

  it('commit-wait tolerates a transient syncChain failure and still resolves when committed (matches SDK waitFor)', async () => {
    await loadModule();
    // syncChain throws (transient) but the id-filtered list still reports committed —
    // the loop must swallow the sync error and proceed, exactly as the SDK waitFor does.
    G.__off.clientSyncChain = jest.fn(async () => {
      throw new Error('node unreachable (transient)');
    });
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
      {},
      sendResponse
    );
    await flush();

    expect(G.__off.clientSyncChain).toHaveBeenCalled();
    expect(G.__off.clientTransactionsList).toHaveBeenCalledWith({ ids: ['0xtxid'] });
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.resultB64).toBeNull();
  });

  it('commit-wait keeps polling while pending, then resolves once the tx commits (follow-up #1)', async () => {
    await loadModule();
    jest.useFakeTimers();
    try {
      // Pending for the first two polls, committed on the third.
      G.__off.clientTransactionsList = jest
        .fn()
        .mockResolvedValueOnce([G.__off.pendingStatus])
        .mockResolvedValueOnce([G.__off.pendingStatus])
        .mockResolvedValue([G.__off.committedStatus]);

      const sendResponse = jest.fn();
      capturedListener!(
        callReq({ method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        sendResponse
      );

      // Advance through the 5s inter-poll sleeps until the commit is observed.
      for (let i = 0; i < 6 && sendResponse.mock.calls.length === 0; i++) {
        // eslint-disable-next-line no-await-in-loop
        await jest.advanceTimersByTimeAsync(5_000);
      }

      expect(G.__off.clientTransactionsList).toHaveBeenCalledTimes(3);
      const resp = sendResponse.mock.calls[0][0];
      expect(resp.ok).toBe(true);
      expect(resp.resultB64).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('commit-wait throws (ok:false) when the tx is DISCARDED (rejected)', async () => {
    await loadModule();
    G.__off.clientTransactionsList = jest.fn(async () => [G.__off.discardedStatus]);
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ method: 'waitForTransactionCommit', argsB64: [encodeArg('0xbadtx')] }),
      {},
      sendResponse
    );
    await flush();

    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain('Transaction rejected');
    expect(resp.error).toContain('0xbadtx');
  });

  it('commit-wait throws (ok:false) with a timeout error when the tx never commits', async () => {
    await loadModule();
    jest.useFakeTimers();
    try {
      // Never commits → the loop must give up at the 60s timeout ceiling.
      G.__off.clientTransactionsList = jest.fn(async () => [G.__off.pendingStatus]);
      const sendResponse = jest.fn();
      capturedListener!(
        callReq({ method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        sendResponse
      );

      // 60s / 5s = 12 sleeps before the timeout check throws.
      for (let i = 0; i < 15 && sendResponse.mock.calls.length === 0; i++) {
        // eslint-disable-next-line no-await-in-loop
        await jest.advanceTimersByTimeAsync(5_000);
      }

      const resp = sendResponse.mock.calls[0][0];
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain('Transaction confirmation timed out after 60000ms');
    } finally {
      jest.useRealTimers();
    }
  });

  it('follow-up #1: commit-wait RELEASES the offscreen WASM mutex during its inter-poll sleep so a second op runs', async () => {
    const miden = await import('lib/miden/sdk/miden-client');
    await loadModule();
    jest.useFakeTimers();
    try {
      // Keep the commit-wait pending so it stays in the sleep loop.
      G.__off.clientTransactionsList = jest.fn(async () => [G.__off.pendingStatus]);

      // op1: the commit-wait. It acquires the WASM mutex (via handleCall's
      // withWasmClientLock), polls once (pending), then sleeps — yielding the mutex.
      const r1 = jest.fn();
      capturedListener!(
        callReq({ op_id: 'op1-wait', method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        r1
      );
      await jest.advanceTimersByTimeAsync(0); // settle op1 into its first sleep

      // op1 has not resolved and is sleeping; the mutex must be FREE (yielded).
      expect(r1).not.toHaveBeenCalled();
      expect((miden as any).isWasmClientBusy()).toBe(false);

      // op2: a plain read fired WHILE op1 sleeps. If the yield didn't release the
      // mutex, op2 would queue behind op1 forever; with the yield it runs now.
      const r2 = jest.fn();
      capturedListener!(callReq({ op_id: 'op2-read', method: 'getAccount', argsB64: [encodeArg('acct')] }), {}, r2);
      await jest.advanceTimersByTimeAsync(0);

      // op2 completed DURING op1's sleep — proof the mutex was released.
      expect(r2).toHaveBeenCalledTimes(1);
      expect(r2.mock.calls[0][0].ok).toBe(true);
      expect(G.__off.clientGetAccount).toHaveBeenCalledWith('acct');
      // op1 is still waiting.
      expect(r1).not.toHaveBeenCalled();

      // Let op1 commit and finish so nothing is left dangling.
      G.__off.clientTransactionsList = jest.fn(async () => [G.__off.committedStatus]);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(r1).toHaveBeenCalledTimes(1);
      expect(r1.mock.calls[0][0].ok).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('follow-up #2: an interloper op that signs during the commit-wait sleep sees ITS op_id, and the commit-wait re-asserts its own after the yield', async () => {
    await loadModule();
    jest.useFakeTimers();
    try {
      // Keep the commit-wait pending so it stays in the sleep loop.
      G.__off.clientTransactionsList = jest.fn(async () => [G.__off.pendingStatus]);
      // The interloper write triggers a mid-execute sign via the reverse-IPC stub.
      G.__off.clientConsumeNoteId = jest.fn(async () => {
        const signCb = G.__off.createOptions[0].signCallback;
        await signCb(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]));
        return { serialize: () => new Uint8Array([9]) };
      });
      // Record the op_id tagged on each reverse-IPC sign request.
      const signOpIds: string[] = [];
      G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
        if (m?.type === OFFSCREEN_SIGN_REQUEST) {
          signOpIds.push(m.op_id);
          return { ok: true, sign_id: m.sign_id, signatureB64: Buffer.from([7]).toString('base64') };
        }
        return undefined; // OFFSCREEN_READY / OFFSCREEN_OP_STARTED etc.
      });

      // op1: the commit-wait. Settle it into its first sleep (mutex yielded).
      const r1 = jest.fn();
      capturedListener!(
        callReq({ op_id: 'op1-wait', method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        r1
      );
      await jest.advanceTimersByTimeAsync(0);

      // op2: an interloper WRITE fired during op1's sleep. Its mid-execute sign must be
      // tagged with op2's id — the ambient op_id is op2 while op2 owns the mutex.
      const r2 = jest.fn();
      capturedListener!(
        callReq({
          op_id: 'op2-sign',
          method: 'consumeNoteId',
          argsB64: [encodeArg({ accountId: 'a', noteId: 'n', noteIds: ['n'] })]
        }),
        {},
        r2
      );
      await jest.advanceTimersByTimeAsync(0);

      expect(r2).toHaveBeenCalledTimes(1);
      expect(r2.mock.calls[0][0].ok).toBe(true);
      expect(signOpIds).toEqual(['op2-sign']); // the interloper's sign saw ITS id

      // op1 resumes from the sleep and RE-ASSERTS its own op_id (op2 had cleared the
      // global on completion). Advance into op1's next sleep, then drive a sign
      // directly: it must carry op1's id — proof the invariant was restored. Without
      // the re-assert the ambient id would be null here and this sign would throw.
      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(0);
      const signCb = G.__off.createOptions[0].signCallback;
      await signCb(new Uint8Array([8]), new Uint8Array([8]));

      expect(signOpIds).toEqual(['op2-sign', 'op1-wait']);
      // op1 is still pending (never committed); no dangling assertion needed — the
      // realm-reset in afterEach tears it down.
      expect(r1).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('an EVICTED commit-wait stops re-asserting its op_id, so the live successor keeps its own (#775)', async () => {
    // The mirror image of follow-up #2, and the reason that re-assert is
    // conditional. The eviction rejects the SW-side caller but does not stop this
    // loop — the corpse keeps polling every 5 s for up to a minute. Re-asserting
    // unconditionally means each of those polls stamps a dead op's id over
    // whoever is genuinely running, and the ambient id is what tags a reverse-IPC
    // sign. The SW pauses the WRITE DEADLINE of the op a sign is tagged with, so
    // a live write's sign attributed to the corpse leaves the real write's
    // deadline running while it waits on the user.
    await loadModule();
    // AFTER loadModule: it resets the module registry, so an earlier import would
    // hand back a different mock instance with its own lock state.
    const miden: any = await import('lib/miden/sdk/miden-client');
    jest.useFakeTimers();
    try {
      // The corpse must be evicted while it is RUNNING and owns the lock, which
      // is the only state eviction actually targets — a holder suspended in a
      // yield is not the eviction target. Park its first poll to hold it there.
      let releasePoll!: () => void;
      const firstPoll = new Promise<void>(resolve => {
        releasePoll = resolve;
      });
      let polls = 0;
      G.__off.clientTransactionsList = jest.fn(async () => {
        if (++polls === 1) await firstPoll;
        return [G.__off.pendingStatus];
      });
      let releaseSuccessor!: (v: unknown) => void;
      G.__off.clientConsumeNoteId = jest.fn(
        () =>
          new Promise(resolve => {
            releaseSuccessor = resolve;
          })
      );
      const signOpIds: string[] = [];
      G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
        if (m?.type === OFFSCREEN_SIGN_REQUEST) {
          signOpIds.push(m.op_id);
          return { ok: true, sign_id: m.sign_id, signatureB64: Buffer.from([7]).toString('base64') };
        }
        return undefined;
      });

      const r1 = jest.fn();
      capturedListener!(
        callReq({ op_id: 'op1-evicted', method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        r1
      );
      await jest.advanceTimersByTimeAsync(0);

      // Evict exactly as lock recovery does: the SW-side caller's promise rejects
      // and the mutex frees, while the poll loop carries on running.
      miden.__evictHolder();
      for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(0);
      expect(r1).toHaveBeenCalledTimes(1);
      expect(r1.mock.calls[0][0].ok).toBe(false);

      // A live successor takes the now-free lock and parks mid-execute, so it is
      // the genuine owner of the ambient id for the whole window that follows.
      const r2 = jest.fn();
      capturedListener!(
        callReq({
          op_id: 'op2-live',
          method: 'consumeNoteId',
          argsB64: [encodeArg({ accountId: 'a', noteId: 'n', noteIds: ['n'] })]
        }),
        {},
        r2
      );
      await jest.advanceTimersByTimeAsync(0);

      // Let the corpse out of its parked poll. Its hold is stale now, so its
      // yield runs the sleep WITHOUT the mutex and it resumes straight into the
      // re-assert while the successor is still holding — several polls' worth of
      // chances to stamp its dead id over the live one.
      releasePoll();
      await jest.advanceTimersByTimeAsync(15_000);

      const signCb = G.__off.createOptions[0].signCallback;
      await signCb(new Uint8Array([8]), new Uint8Array([8]));
      expect(signOpIds).toEqual(['op2-live']);

      releaseSuccessor({ serialize: () => new Uint8Array([9]) });
      await jest.advanceTimersByTimeAsync(0);
      expect(r2.mock.calls[0][0].ok).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('dispatches exportNote and ships the serialized note bytes verbatim', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(
      callReq({ method: 'exportNote', argsB64: [encodeArg('note-x'), encodeArg('Details')] }),
      {},
      sendResponse
    );
    expect(ret).toBe(true);
    await flush();

    // Both args decoded across the wire.
    expect(G.__off.clientExportNote).toHaveBeenCalledWith('note-x', 'Details');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([44, 55, 66]);
  });

  it('dispatches getInputNoteDetails and JSON-encodes the plain DTO array', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(
      callReq({ method: 'getInputNoteDetails', argsB64: [encodeArg({ ids: ['0xabc'] })] }),
      {},
      sendResponse
    );
    expect(ret).toBe(true);
    await flush();

    // The plain-object query decoded back intact.
    expect(G.__off.clientGetInputNoteDetails).toHaveBeenCalledWith({ ids: ['0xabc'] });
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    // resultB64 is the UTF-8 JSON of the DTO array — decode + parse it back and
    // prove the numeric enums (noteType:0, state:2) and strings all survived.
    const decoded = JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'));
    expect(decoded).toEqual([
      { noteId: '0xabc', senderAccountId: 'mtst1qsender', assets: [], noteType: 0, nullifier: '0xn', state: 2 }
    ]);
  });

  // The read the send/swap retry guard is built on. It has to actually run in
  // this realm: the SW-side proxy previously answered a hardcoded 'not-found'
  // for the flag-on path, which `verifySendLanded` reads as "cannot prove it
  // landed" and retries through — so the guard was inert on the default path.
  it.each(['committed', 'pending', 'not-found'] as const)(
    'dispatches getTransactionCommitState and JSON-encodes %p',
    async expected => {
      await loadModule();
      G.__off.clientGetTransactionCommitState.mockResolvedValueOnce(expected);
      const sendResponse = jest.fn();
      const ret = capturedListener!(
        callReq({ method: 'getTransactionCommitState', argsB64: [encodeArg('0xtxid')] }),
        {},
        sendResponse
      );
      expect(ret).toBe(true);
      await flush();

      expect(G.__off.clientGetTransactionCommitState).toHaveBeenCalledWith('0xtxid');
      const resp = sendResponse.mock.calls[0][0];
      expect(resp.ok).toBe(true);
      expect(JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'))).toBe(expected);
    }
  );

  it('dispatches getConsumableNotes and JSON-encodes the reduced DTO array (issue #260 slice 4)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(
      callReq({ method: 'getConsumableNotes', argsB64: [encodeArg('mtst1qqaccount')] }),
      {},
      sendResponse
    );
    expect(ret).toBe(true);
    await flush();

    // accountId arg decoded across the wire; reduction ran on the offscreen client.
    expect(G.__off.clientGetConsumableNoteDtos).toHaveBeenCalledWith('mtst1qqaccount');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-abc');
    // resultB64 is UTF-8 JSON of the DTO array — the numeric enums (noteType:1,
    // state:2), nested asset strings and swapAttachment all survive the round-trip.
    const decoded = JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'));
    expect(decoded).toEqual([
      {
        noteId: '0xnote',
        nullifier: '0xnull',
        noteType: 1,
        senderAccountId: 'mtst1qsender',
        state: 2,
        assets: [{ amount: '100', faucetId: 'mtst1qfaucet' }],
        swapAttachment: null
      }
    ]);
  });

  // ─── Slice 7a: deferred reach-through reads ─────────────────────────────────
  it('dispatches getSyncHeight(fresh:false) → reads the last-synced height, JSON-encoded', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(callReq({ method: 'getSyncHeight', argsB64: [encodeArg(false)] }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    // Not fresh → getSyncHeight, never a network sync.
    expect(G.__off.clientGetSyncHeight).toHaveBeenCalledTimes(1);
    expect(G.__off.clientSync).not.toHaveBeenCalled();
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'))).toBe(4242);
  });

  it('dispatches getSyncHeight(fresh:true) → runs a network sync and returns its blockNum', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getSyncHeight', argsB64: [encodeArg(true)] }), {}, sendResponse);
    await flush();

    // Fresh → sync().blockNum(), never the cached getSyncHeight.
    expect(G.__off.clientSync).toHaveBeenCalledTimes(1);
    expect(G.__off.clientGetSyncHeight).not.toHaveBeenCalled();
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'))).toBe(5000);
  });

  it('dispatches getPswapLineage → reduces the live record in-realm to a JSON DTO', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getPswapLineage', argsB64: [encodeArg('77')] }), {}, sendResponse);
    await flush();

    // The order id decoded across the wire; the reduction ran on the offscreen client.
    expect(G.__off.clientLineage).toHaveBeenCalledWith('77');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    // Every field the callers read survives, BigInts as decimal strings.
    expect(JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'))).toEqual({
      orderId: '77',
      currentTipNoteId: '0xtip',
      currentDepth: 2,
      state: 1,
      remainingOffered: '10',
      remainingRequested: '20'
    });
  });

  it('dispatches getPswapLineage → returns resultB64:null when the order is not tracked', async () => {
    await loadModule();
    G.__off.clientLineage = jest.fn(async () => null);
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getPswapLineage', argsB64: [encodeArg('99')] }), {}, sendResponse);
    await flush();

    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.resultB64).toBeNull();
  });

  it('dispatches getInputNoteSummary → reduces the live record to its noteType (JSON DTO)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getInputNoteSummary', argsB64: [encodeArg('0xn')] }), {}, sendResponse);
    await flush();

    expect(G.__off.clientGetInputNote).toHaveBeenCalledWith('0xn');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'))).toEqual({ noteType: 1 });
  });

  it('dispatches getInputNoteSummary → returns resultB64:null for a not-found note', async () => {
    await loadModule();
    G.__off.clientGetInputNote = jest.fn(async () => null);
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getInputNoteSummary', argsB64: [encodeArg('missing')] }), {}, sendResponse);
    await flush();

    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.resultB64).toBeNull();
  });

  it('dispatches importNoteBytes → imports into the offscreen store and ships the id back as bytes', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const noteBytes = new Uint8Array([0xab, 0xcd, 0xef]);
    capturedListener!(callReq({ method: 'importNoteBytes', argsB64: [encodeArg(noteBytes)] }), {}, sendResponse);
    await flush();

    // The raw note bytes crossed intact and were imported into THIS client's store.
    expect(G.__off.clientImportNoteBytes).toHaveBeenCalledTimes(1);
    expect(Array.from(G.__off.clientImportNoteBytes.mock.calls[0][0])).toEqual([0xab, 0xcd, 0xef]);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(Buffer.from(resp.resultB64, 'base64').toString('utf8')).toBe('0ximportedid');
  });

  it('dispatches proposal-note import and restores note bytes', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const encodedNotes = [Buffer.from([1, 2]).toString('base64'), Buffer.from([3]).toString('base64')];
    const ret = capturedListener!(
      callReq({ method: 'importRecoveryNoteBytes', argsB64: [encodeArg(encodedNotes)] }),
      {},
      sendResponse
    );
    expect(ret).toBe(true);
    await flush();

    expect(G.__off.clientImportRecoveryNoteBytes).toHaveBeenCalledTimes(1);
    expect(G.__off.clientImportRecoveryNoteBytes.mock.calls[0][0]).toEqual([
      new Uint8Array([1, 2]),
      new Uint8Array([3])
    ]);
    const response = sendResponse.mock.calls[0][0];
    expect(JSON.parse(Buffer.from(response.resultB64, 'base64').toString('utf8'))).toEqual({
      imported: 1,
      failures: 0
    });
  });

  it('dispatches a public-backfill range with its bounds and note page', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(
      callReq({
        method: 'recoverPublicNotesRange',
        argsB64: [encodeArg('mtst1guardian'), encodeArg(1000), encodeArg(200_999), encodeArg(200)]
      }),
      {},
      sendResponse
    );
    expect(ret).toBe(true);
    await flush();

    expect(G.__off.clientRecoverPublicNotesRange).toHaveBeenCalledWith('mtst1guardian', 1000, 200_999, 200);
    const response = sendResponse.mock.calls[0][0];
    expect(JSON.parse(Buffer.from(response.resultB64, 'base64').toString('utf8'))).toEqual({
      imported: 2,
      failures: 0
    });
  });

  // An older service worker paired with a newer offscreen bundle sends three
  // args; that has to mean the first page, not `undefined` reaching the SDK.
  it('defaults a missing note page to the first one', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'recoverPublicNotesRange',
        argsB64: [encodeArg('mtst1guardian'), encodeArg(1000), encodeArg(200_999)]
      }),
      {},
      sendResponse
    );
    await flush();

    expect(G.__off.clientRecoverPublicNotesRange).toHaveBeenCalledWith('mtst1guardian', 1000, 200_999, 0);
  });

  it('dispatches the private-note transport drain with a null result', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(callReq({ method: 'drainPrivateNoteTransport', argsB64: [] }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    expect(G.__off.clientDrainPrivateNoteTransport).toHaveBeenCalledTimes(1);
    const response = sendResponse.mock.calls[0][0];
    expect(response.ok).toBe(true);
    expect(response.resultB64).toBeNull();
  });

  it('dispatches getSerializedInputNoteDetails → reduces each live record in-realm to the wire DTO array', async () => {
    await loadModule();
    // A per-id live record carrying the detail reach-through. Empty fungibleAssets
    // keeps the reduction off the (unmocked) SDK bech32 helper; state/nullifier/noteId
    // still prove the in-realm reduction + per-id iteration, and 'missing' is skipped.
    G.__off.clientGetInputNote = jest.fn(async (id: string) =>
      id === 'missing'
        ? null
        : {
            details: () => ({ assets: () => ({ fungibleAssets: () => [] }) }),
            state: () => ({ toString: () => 'Invalid' }),
            nullifier: () => ({ toString: () => `0x${id}` })
          }
    );
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ method: 'getSerializedInputNoteDetails', argsB64: [encodeArg(['n1', 'missing', 'n2'])] }),
      {},
      sendResponse
    );
    await flush();

    // One getInputNote per requested id, run against the offscreen-owned client.
    expect(G.__off.clientGetInputNote).toHaveBeenCalledTimes(3);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    // resultB64 is UTF-8 JSON of the wire DTO array; the not-found note is skipped.
    expect(JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'))).toEqual([
      { noteId: 'n1', state: 'Invalid', assets: [], nullifier: '0xn1' },
      { noteId: 'n2', state: 'Invalid', assets: [], nullifier: '0xn2' }
    ]);
  });

  it('getInputNoteDetails maps a JSON-null query arg back to undefined for the SDK', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    // encodeArg(undefined) → 's:null'; decodeArg → null; dispatch does `?? undefined`.
    capturedListener!(callReq({ method: 'getInputNoteDetails', argsB64: [encodeArg(undefined)] }), {}, sendResponse);
    await flush();

    expect(G.__off.clientGetInputNoteDetails).toHaveBeenCalledWith(undefined);
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('dispatches sendPrivateNote → re-hydrates the note from bytes and relays it on THIS client (void result)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const noteBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    capturedListener!(
      callReq({ method: 'sendPrivateNote', argsB64: [encodeArg(noteBytes), encodeArg('mtst1qrecipient')] }),
      {},
      sendResponse
    );
    await flush();

    // The raw note bytes crossed intact and were re-hydrated via Note.deserialize...
    expect(G.__off.deserializeNote).toHaveBeenCalledTimes(1);
    expect(Array.from(G.__off.deserializeNote.mock.calls[0][0])).toEqual([0xde, 0xad, 0xbe, 0xef]);
    // ...then relayed on THIS (offscreen) client with the re-hydrated note + recipient.
    expect(G.__off.clientSendPrivateNote).toHaveBeenCalledTimes(1);
    expect(G.__off.clientSendPrivateNote.mock.calls[0][0]).toEqual({ __noteFromBytes: [0xde, 0xad, 0xbe, 0xef] });
    expect(G.__off.clientSendPrivateNote.mock.calls[0][1]).toBe('mtst1qrecipient');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    // A relay — nothing to serialize back.
    expect(resp.resultB64).toBeNull();
  });

  it('dispatches relayPrivateNoteById → re-pushes on THIS client with no note bytes to re-hydrate', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ method: 'relayPrivateNoteById', argsB64: [encodeArg('0xnote'), encodeArg('mtst1qrecipient')] }),
      {},
      sendResponse
    );
    await flush();

    // The sweep runs long after the sending session, so it carries ids only — the
    // note is resolved from THIS realm's store, which is where it was applied.
    expect(G.__off.deserializeNote).not.toHaveBeenCalled();
    expect(G.__off.clientRelayPrivateNoteById).toHaveBeenCalledWith('0xnote', 'mtst1qrecipient');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.resultB64).toBeNull();
  });

  it('dispatches isOutputNoteConsumed → returns the receipt as bytes', async () => {
    await loadModule();
    G.__off.clientIsOutputNoteConsumed.mockResolvedValueOnce(true);
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'isOutputNoteConsumed', argsB64: [encodeArg('0xnote')] }), {}, sendResponse);
    await flush();

    expect(G.__off.clientIsOutputNoteConsumed).toHaveBeenCalledWith('0xnote');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(Buffer.from(resp.resultB64, 'base64').toString()).toBe('true');
  });

  it('serializes concurrent slice-3 reads through the same offscreen WASM mutex', async () => {
    await loadModule();
    const order: string[] = [];
    let releaseSync!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseSync = resolve;
    });
    G.__off.clientSyncState = jest.fn(async () => {
      order.push('sync:start');
      await gate;
      order.push('sync:end');
      return { __syncSummary: true };
    });
    G.__off.clientExportNote = jest.fn(async () => {
      order.push('export:run');
      return new Uint8Array([1]);
    });

    const r1 = jest.fn();
    const r2 = jest.fn();
    capturedListener!(callReq({ op_id: 'op1', method: 'syncState', argsB64: [] }), {}, r1);
    capturedListener!(
      callReq({ op_id: 'op2', method: 'exportNote', argsB64: [encodeArg('n'), encodeArg('Details')] }),
      {},
      r2
    );
    await flush();

    // exportNote is queued behind syncState's WASM lock — it has NOT run yet.
    expect(order).toEqual(['sync:start']);
    releaseSync();
    await flush();
    expect(order).toEqual(['sync:start', 'sync:end', 'export:run']);
    expect(r1.mock.calls[0][0].ok).toBe(true);
    expect(r2.mock.calls[0][0].ok).toBe(true);
  });

  it('creates the offscreen client with the reverse-IPC sign stub + useWorker:false (slice 5)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('a')] }), {}, sendResponse);
    await flush();

    // MidenClientInterface.create ran once with the two Slice-5 overrides.
    expect(G.__off.createOptions.length).toBe(1);
    const opts = G.__off.createOptions[0];
    expect(opts.useWorker).toBe(false);
    expect(typeof opts.signCallback).toBe('function');
  });

  it('dispatches consumeNoteId (whole-op write) and serializes the TransactionResult (slice 5a)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const dto = { accountId: 'mtst1qacc', noteId: '0xn1', noteIds: ['0xn1', '0xn2'], delegateTransaction: false };
    const ret = capturedListener!(callReq({ method: 'consumeNoteId', argsB64: [encodeArg(dto)] }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    // The plain consume DTO decoded across the wire and drove the offscreen client.
    expect(G.__off.clientConsumeNoteId).toHaveBeenCalledWith(dto);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-abc');
    // resultB64 round-trips the serialized [77,88,99] TransactionResult bytes.
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([77, 88, 99]);
  });

  it('dispatches sendTransaction (whole-op write), re-widens the string amount to BigInt, serializes the result (slice 5b)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const dto = {
      accountId: 'mtst1qacc',
      secondaryAccountId: 'mtst1qrecipient',
      faucetId: 'mtst1qfaucet',
      noteType: 'public',
      amount: '1000',
      delegateTransaction: false,
      extraInputs: { recallBlocks: 100 }
    };
    const ret = capturedListener!(callReq({ method: 'sendTransaction', argsB64: [encodeArg(dto)] }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    // The DTO decoded across the wire; the string amount was re-widened to a BigInt
    // so the reconstructed row matches what the SDK reads on the SW-inline path.
    expect(G.__off.clientSendTransaction).toHaveBeenCalledTimes(1);
    const receivedTx = G.__off.clientSendTransaction.mock.calls[0][0];
    expect(typeof receivedTx.amount).toBe('bigint');
    expect(receivedTx.amount).toBe(1000n);
    expect(receivedTx.accountId).toBe('mtst1qacc');
    expect(receivedTx.secondaryAccountId).toBe('mtst1qrecipient');
    expect(receivedTx.noteType).toBe('public');
    expect(receivedTx.extraInputs).toEqual({ recallBlocks: 100 });
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-abc');
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([11, 22, 33]);
  });

  // PR #524: the staged send's per-step stamps are the one thing the SW still needs
  // MID-flight, so they reverse across the bus tagged with the ambient op_id (the
  // same attribution the sign stub uses) instead of riding the final result.
  it('sendTransaction posts an OFFSCREEN_STAGE_EVENT (target sw + ambient op_id) per stage, fire-and-forget (PR #524)', async () => {
    await loadModule();
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      posted.push(m);
      return undefined;
    });
    // The offscreen client drives its onStage hook exactly as the SDK's staged
    // execute → prove → submit pipeline does.
    G.__off.clientSendTransaction = jest.fn(async (_tx: unknown, onStage?: (s: string) => Promise<void> | void) => {
      await onStage?.('executing');
      await onStage?.('proving');
      await onStage?.('submitting');
      return { serialize: () => new Uint8Array([11, 22, 33]) };
    });
    const sendResponse = jest.fn();
    const dto = {
      accountId: 'mtst1qacc',
      secondaryAccountId: 'mtst1qrecipient',
      faucetId: 'mtst1qfaucet',
      noteType: 'public',
      amount: '1000',
      delegateTransaction: false,
      extraInputs: { recallBlocks: 100 }
    };
    capturedListener!(
      callReq({ op_id: 'op-stage', method: 'sendTransaction', argsB64: [encodeArg(dto)] }),
      {},
      sendResponse
    );
    await flush();

    const stageEvents = posted.filter(m => m?.type === 'OFFSCREEN_STAGE_EVENT');
    expect(stageEvents.map(m => m.stage)).toEqual(['executing', 'proving', 'submitting']);
    // Every stamp is SW-targeted (the doc's own `target === 'offscreen'` listener
    // can never pick it up) and carries THIS op's ambient id.
    expect(stageEvents.every(m => m.target === 'sw' && m.op_id === 'op-stage')).toBe(true);
    // The write itself completed normally — the stamps rode alongside it.
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
    expect(Array.from(Buffer.from(sendResponse.mock.calls[0][0].resultB64, 'base64'))).toEqual([11, 22, 33]);
  });

  it('a stage-event post failure NEVER reaches the write (rejects and synchronous throws are both swallowed)', async () => {
    await loadModule();
    // Model both failure modes on the SAME channel the OP_STARTED signal uses: a
    // rejected promise (no SW receiver) and a synchronous throw (torn-down port).
    let call = 0;
    G.chrome.runtime.sendMessage = jest.fn((_m: any) => {
      call += 1;
      if (call % 2 === 0) throw new Error('port closed');
      return Promise.reject(new Error('no receiver'));
    });
    G.__off.clientSendTransaction = jest.fn(async (_tx: unknown, onStage?: (s: string) => Promise<void> | void) => {
      await onStage?.('executing');
      await onStage?.('proving');
      await onStage?.('submitting');
      return { serialize: () => new Uint8Array([11, 22, 33]) };
    });
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-stage-fail',
        method: 'sendTransaction',
        argsB64: [encodeArg({ accountId: 'a', amount: '1', extraInputs: {} })]
      }),
      {},
      sendResponse
    );
    await flush();

    // Losing a stamp costs one blank duration in the UI; it must never fail a
    // funds-moving send.
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('dispatches swapTransaction (whole-op write), re-widens both string amounts to BigInt, serializes the result (slice 5b)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const dto = {
      accountId: 'mtst1qacc',
      faucetId: 'mtst1qoffered',
      amount: '500',
      delegateTransaction: false,
      extraInputs: { requestedFaucetId: 'mtst1qrequested', requestedAmount: '250' }
    };
    const ret = capturedListener!(callReq({ method: 'swapTransaction', argsB64: [encodeArg(dto)] }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    expect(G.__off.clientSwapTransaction).toHaveBeenCalledTimes(1);
    const receivedTx = G.__off.clientSwapTransaction.mock.calls[0][0];
    // Offered amount AND requested amount both re-widened to BigInt.
    expect(receivedTx.amount).toBe(500n);
    expect(typeof receivedTx.extraInputs.requestedAmount).toBe('bigint');
    expect(receivedTx.extraInputs.requestedAmount).toBe(250n);
    expect(receivedTx.extraInputs.requestedFaucetId).toBe('mtst1qrequested');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([44, 55, 66, 77]);
  });

  it('dispatches newTransaction (execute) with positional args — requestBytes as raw bytes — and serializes the result (slice 5b)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const requestBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const ret = capturedListener!(
      callReq({
        method: 'newTransaction',
        argsB64: [encodeArg('mtst1qacc'), encodeArg(requestBytes), encodeArg(true)]
      }),
      {},
      sendResponse
    );
    expect(ret).toBe(true);
    await flush();

    expect(G.__off.clientNewTransaction).toHaveBeenCalledTimes(1);
    const [accountId, bytes, delegate] = G.__off.clientNewTransaction.mock.calls[0];
    expect(accountId).toBe('mtst1qacc');
    // requestBytes crossed as RAW bytes (Uint8Array), intact.
    expect(bytes instanceof Uint8Array).toBe(true);
    expect(Array.from(bytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(delegate).toBe(true);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([88, 99]);
  });

  it('newTransaction maps a JSON-null delegate arg back to undefined for the SDK (slice 5b)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const requestBytes = new Uint8Array([1, 2]);
    // encodeArg(undefined) → 's:null'; decodeArg → null; dispatch does `?? undefined`.
    capturedListener!(
      callReq({
        method: 'newTransaction',
        argsB64: [encodeArg('mtst1qacc'), encodeArg(requestBytes), encodeArg(undefined)]
      }),
      {},
      sendResponse
    );
    await flush();

    const [, , delegate] = G.__off.clientNewTransaction.mock.calls[0];
    expect(delegate).toBeUndefined();
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('consumeNoteId signs mid-execute via the reverse-IPC stub, tagged with the ambient op_id (slice 5)', async () => {
    await loadModule();
    // Make the mock client's consumeNoteId invoke the reverse-IPC sign stub with
    // sample (pubkey, signingInputs) bytes, exactly as the SDK does mid-execute.
    let signatureSeen: Uint8Array | null = null;
    G.__off.clientConsumeNoteId = jest.fn(async () => {
      const signCb = G.__off.createOptions[0].signCallback;
      signatureSeen = await signCb(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]));
      return { serialize: () => new Uint8Array([77, 88, 99]) };
    });
    // Intercept the OFFSCREEN_SIGN_REQUEST the stub posts and answer with a signature.
    let signReq: any = null;
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      if (m?.type === OFFSCREEN_SIGN_REQUEST) {
        signReq = m;
        return { ok: true, sign_id: m.sign_id, signatureB64: Buffer.from([9, 9, 9]).toString('base64') };
      }
      return undefined; // OFFSCREEN_READY etc.
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-sign',
        method: 'consumeNoteId',
        argsB64: [encodeArg({ accountId: 'a', noteId: 'n', noteIds: ['n'] })]
      }),
      {},
      sendResponse
    );
    await flush();

    // The stub reversed the sign to the SW, tagged with the write op's ambient id.
    expect(signReq).not.toBeNull();
    expect(signReq.target).toBe('sw');
    expect(signReq.type).toBe(OFFSCREEN_SIGN_REQUEST);
    expect(signReq.op_id).toBe('op-sign');
    expect(typeof signReq.sign_id).toBe('string');
    // Only raw bytes crossed — the exact (pubkey, signingInputs) the SDK handed the stub.
    expect(Array.from(Buffer.from(signReq.publicKeyB64, 'base64'))).toEqual([1, 2, 3]);
    expect(Array.from(Buffer.from(signReq.signingInputsB64, 'base64'))).toEqual([4, 5, 6]);
    // The SW's signature bytes flowed back into the SDK sign call.
    expect(signatureSeen).not.toBeNull();
    expect(Array.from(signatureSeen!)).toEqual([9, 9, 9]);
    // And the consume completed, shipping the serialized result.
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('consumeNoteId sign stub throws when the SW responds ok:false (execute fails)', async () => {
    await loadModule();
    G.__off.clientConsumeNoteId = jest.fn(async () => {
      const signCb = G.__off.createOptions[0].signCallback;
      // The stub must throw so the SDK execute fails; surface that as the op error.
      await signCb(new Uint8Array([1]), new Uint8Array([2]));
      return { serialize: () => new Uint8Array([0]) };
    });
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      if (m?.type === OFFSCREEN_SIGN_REQUEST) {
        return { ok: false, sign_id: m.sign_id, error: 'vault locked', reason: 'locked' };
      }
      return undefined;
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ method: 'consumeNoteId', argsB64: [encodeArg({ accountId: 'a', noteId: 'n', noteIds: ['n'] })] }),
      {},
      sendResponse
    );
    await flush();

    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain('offscreen sign failed');
  });

  it('the reverse-IPC sign stub throws when invoked with no OFFSCREEN_CALL in flight (no ambient op_id)', async () => {
    await loadModule();
    // Run (and finish) a dispatch so the client is created + createOptions captured;
    // after it completes, the ambient op_id is cleared back to null.
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('a')] }), {}, sendResponse);
    await flush();

    const signCb = G.__off.createOptions[0].signCallback;
    await expect(signCb(new Uint8Array([1]), new Uint8Array([2]))).rejects.toThrow('no ambient op_id');
  });

  it('S1: a failed client-create is not cached — the next call retries within the same doc', async () => {
    await loadModule();
    G.__off.getMidenClient = jest
      .fn()
      .mockRejectedValueOnce(new Error('genesis fetch failed'))
      .mockResolvedValueOnce({ getAccount: (...a: any[]) => G.__off.clientGetAccount(...a) });

    const r1 = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('a')] }), {}, r1);
    await flush();
    expect(r1.mock.calls[0][0].ok).toBe(false);
    expect(r1.mock.calls[0][0].error).toContain('genesis fetch failed');

    const r2 = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('a')] }), {}, r2);
    await flush();
    expect(r2.mock.calls[0][0].ok).toBe(true);
    // The rejected create was not cached → getMidenClient ran again (retry).
    expect(G.__off.getMidenClient).toHaveBeenCalledTimes(2);
  });

  // ─── Slice 6a: guardianPipeline (the guardian write LEAF pipeline) ──────────
  it('guardianPipeline: deserializes the co-signed request, runs execute→prove(local)→submit→apply, ships the serialized result', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const trBytes = new Uint8Array([1, 2, 3, 4]);
    capturedListener!(
      callReq({
        op_id: 'op-g',
        method: 'guardianPipeline',
        argsB64: [encodeArg('mtst1qguardian'), encodeArg(trBytes), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await flush();

    // The fully-signed, guardian-co-signed request crossed as bytes and was
    // deserialized back into a TransactionRequest in-realm (§4.0).
    expect(G.__off.deserializeTxRequest).toHaveBeenCalledTimes(1);
    expect(Array.from(G.__off.deserializeTxRequest.mock.calls[0][0])).toEqual([1, 2, 3, 4]);
    // executeRequest got the accountId + the deserialized request (NOT a bundled
    // MidenClientInterface write method — the request is pre-built).
    expect(G.__off.guardianExecuteRequest).toHaveBeenCalledTimes(1);
    const [acct, tr] = G.__off.guardianExecuteRequest.mock.calls[0];
    expect(acct).toBe('mtst1qguardian');
    expect(tr).toEqual({ __trFromBytes: [1, 2, 3, 4] });
    // Non-delegated → proved with an explicit newLocalProver (no mobile branch).
    expect(G.__off.newLocalProver).toHaveBeenCalledTimes(1);
    expect(G.__off.guardianProveCalls).toEqual([{ prover: { __local: true } }]);
    // submit + apply both ran in-realm.
    expect(G.__off.guardianSubmitted).toBe(true);
    expect(G.__off.guardianApplied).toBe(true);
    // Only the serialized TransactionResult (executedTx.result) crossed back.
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-g');
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([55, 66, 77]);
  });

  it('guardianPipeline (delegated): proves with an EXPLICIT remote prover under the bounded wait, never a local prover, then submits/applies', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'guardianPipeline',
        argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([9])), encodeArg(true)]
      }),
      {},
      sendResponse
    );
    await flush();

    // A delegated prove must NAME its remote prover. `prove({})` — the empty form —
    // selects the SDK's default-prover fallback, which requires an initialized client
    // and so never dispatches from this prover-only realm: the remote prover logs no
    // request and the await never settles, hanging the write until the service
    // worker's deadline kills the document (#718).
    expect(G.__off.remoteProver).toHaveBeenCalledTimes(1);
    expect(G.__off.guardianProveCalls).toEqual([{ prover: { __remote: true } }]);
    // ...and it must be BOUNDED, or nothing can convert a silent prover into the
    // rejection the local fallback needs.
    expect(G.__off.guardianProveBounded).toBe(true);
    expect(G.__off.newLocalProver).not.toHaveBeenCalled();
    expect(G.__off.guardianApplied).toBe(true);
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('guardianPipeline (delegated): falls back to the SDK default prove({}) only when no prover endpoint resolves', async () => {
    await loadModule();
    // `remoteProver()` returns undefined when the effective network has no prover
    // URL. There is nothing to name in that case, so the empty form is correct — it
    // is the only shape that preserves the pre-existing behaviour for a network
    // without a prover, and it must NOT become a local prove.
    G.__off.remoteProver = jest.fn(() => undefined);
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'guardianPipeline',
        argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([9])), encodeArg(true)]
      }),
      {},
      sendResponse
    );
    await flush();

    expect(G.__off.guardianProveCalls).toEqual([{}]);
    expect(G.__off.guardianProveBounded).toBe(true);
    expect(G.__off.newLocalProver).not.toHaveBeenCalled();
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('guardianPipeline (delegated): a remote prove failure re-proves locally with newLocalProver (matches inline fallback)', async () => {
    await loadModule();
    G.__off.guardianProveShouldFailOnce = true;
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'guardianPipeline',
        argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([9])), encodeArg(true)]
      }),
      {},
      sendResponse
    );
    await flush();

    // First attempt: the explicit remote prover threw. Second: local newLocalProver.
    expect(G.__off.guardianProveCalls[0]).toEqual({ prover: { __remote: true } });
    expect(G.__off.guardianProveCalls[1]).toEqual({ prover: { __local: true } });
    expect(G.__off.newLocalProver).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('delegated guardian prove failed'), expect.any(Error));
    expect(G.__off.guardianApplied).toBe(true);
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('guardianPipeline: preserves the SDK errorCode when the pipeline throws apply-after-submit (slice 6a funds-critical)', async () => {
    await loadModule();
    // useWorker:false → a failed pipeline throws the RAW main-thread JsError still
    // carrying `errorCode`; the catch must ship it so the SW re-attaches it and the
    // GUARDIAN classifier marks the tx Completed, never Failed → requeue → double-spend.
    const applyErr: Error & { errorCode?: string } = new Error('local apply failed after submit');
    applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
    G.__off.guardianExecuteRequest = jest.fn(async () => {
      throw applyErr;
    });
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'guardianPipeline',
        argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await flush();

    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain('local apply failed after submit');
    expect(resp.errorCode).toBe('ApplyTransactionAfterSubmitFailed');
  });

  it('guardianPipeline: the executeRequest keystore sign reverses to the SW via OFFSCREEN_SIGN_REQUEST tagged with the op_id', async () => {
    await loadModule();
    let signatureSeen: Uint8Array | null = null;
    G.__off.guardianExecuteRequest = jest.fn(async () => {
      const signCb = G.__off.createOptions[0].signCallback;
      signatureSeen = await signCb(new Uint8Array([1, 2]), new Uint8Array([3, 4]));
      return {
        result: { serialize: () => new Uint8Array([55, 66, 77]) },
        id: { toHex: () => 'h' },
        prove: async () => ({ submit: async () => ({ apply: async () => {} }) })
      };
    });
    let signReq: any = null;
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      if (m?.type === OFFSCREEN_SIGN_REQUEST) {
        signReq = m;
        return { ok: true, sign_id: m.sign_id, signatureB64: Buffer.from([7, 7]).toString('base64') };
      }
      return undefined;
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-gsign',
        method: 'guardianPipeline',
        argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await flush();

    // The mid-execute sign reversed to the SW over the EXISTING channel, tagged
    // with the guardian op's ambient id — no new IPC channel.
    expect(signReq).not.toBeNull();
    expect(signReq.type).toBe(OFFSCREEN_SIGN_REQUEST);
    expect(signReq.op_id).toBe('op-gsign');
    expect(Array.from(Buffer.from(signReq.publicKeyB64, 'base64'))).toEqual([1, 2]);
    expect(Array.from(signatureSeen!)).toEqual([7, 7]);
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  // PR #524 × slice 6a. Guardian is the wallet's DEFAULT account type, so the leaf
  // that runs here must stamp the same three boundaries `runGuardianPipeline`
  // stamps SW-inline — otherwise the default send flow renders a blank duration on
  // every step (and the step highlight never reaches `submitting`) on the one build
  // that defaults the flag ON. Unlike the send dispatch, no SDK `onStage` hook is
  // involved: this pipeline drives the raw transactions API, so it posts the stamps
  // itself, and the assertion is on the INTERLEAVING with execute / prove / submit.
  it('guardianPipeline posts an OFFSCREEN_STAGE_EVENT at the same three boundaries the inline pipeline stamps', async () => {
    await loadModule();
    const timeline: string[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      if (m?.type === 'OFFSCREEN_STAGE_EVENT') timeline.push(`stage:${m.stage}|${m.target}|${m.op_id}`);
      return undefined;
    });
    G.__off.guardianExecuteRequest = jest.fn(async () => {
      timeline.push('executeRequest');
      return {
        result: { serialize: () => new Uint8Array([55, 66, 77]) },
        id: { toHex: () => 'h' },
        prove: async () => {
          timeline.push('prove');
          return {
            submit: async () => {
              timeline.push('submit');
              return { apply: async () => timeline.push('apply') };
            }
          };
        }
      };
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-gstage',
        method: 'guardianPipeline',
        argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await flush();

    // Each stamp precedes the step it opens, every stamp is SW-targeted (so this
    // doc's own `target === 'offscreen'` listener can never pick it back up) and
    // carries THIS op's ambient id.
    expect(timeline).toEqual([
      'stage:executing|sw|op-gstage',
      'executeRequest',
      'stage:proving|sw|op-gstage',
      'prove',
      'stage:submitting|sw|op-gstage',
      'submit',
      'apply'
    ]);
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  // The settled guard in `postStageEvent`. The stamp is addressed correctly — it
  // carries the id of the dispatch that fired it — but it is about a step whose
  // outcome the SW already has, and replaying it would rewind that row's stage
  // (or, for 'submitting', re-arm may-have-submitted on a row already
  // adjudicated). Deliberately NOT the loud failure the sign stub raises for a
  // missing id: a stamp is telemetry, a signature is the transaction.
  it('a stage stamp fired after its dispatch settled is dropped, not posted', async () => {
    await loadModule();
    // Capture the `onStage` hook the send dispatch hands the client, then let the
    // op finish — which clears the ambient op_id back to null.
    let capturedOnStage: ((s: string) => void) | undefined;
    G.__off.clientSendTransaction = jest.fn(async (_tx: unknown, onStage?: (s: string) => void) => {
      capturedOnStage = onStage;
      return { serialize: () => new Uint8Array([11, 22, 33]) };
    });
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-settled',
        method: 'sendTransaction',
        argsB64: [encodeArg({ accountId: 'a', amount: '1', extraInputs: {} })]
      }),
      {},
      sendResponse
    );
    await flush();
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);

    // Now fire a late stamp, outside any op.
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      posted.push(m);
      return undefined;
    });
    expect(() => capturedOnStage!('proving')).not.toThrow();
    await flush();

    // Nothing crossed the bus — in particular nothing addressed to a row the SW
    // has already been told the outcome of.
    expect(posted).toEqual([]);
  });

  // The other half of the same rule (issue #775): a dispatch that is STILL
  // RUNNING keeps stamping, and does so under its OWN id even after a successor
  // has taken over the ambient one. Reading the ambient id at post time is what
  // put an evicted send's 'submitting' stamp on the successor's row — and
  // `stageStampFor` turns that into `markMayHaveSubmitted`, so the wallet
  // refused to retry a send that had never been broadcast.
  it('a still-running evicted dispatch stamps under its own op_id, not the successor ambient one', async () => {
    await loadModule();
    // AFTER loadModule: it resets the module registry, so an earlier import
    // would hand back a different mock instance with its own lock state.
    const miden: any = await import('lib/miden/sdk/miden-client');
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      if (m?.type === 'OFFSCREEN_STAGE_EVENT') posted.push(`${m.stage}|${m.op_id}`);
      return undefined;
    });

    // The first send parks mid-flight, holding its onStage hook.
    let capturedOnStage: ((s: string) => void) | undefined;
    let releaseFirst!: () => void;
    const firstParked = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    G.__off.clientSendTransaction = jest.fn(async (_tx: unknown, onStage?: (s: string) => void) => {
      capturedOnStage = onStage;
      await firstParked;
      return { serialize: () => new Uint8Array([1]) };
    });
    const firstResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-displaced',
        method: 'sendTransaction',
        argsB64: [encodeArg({ accountId: 'a', amount: '1', extraInputs: {} })]
      }),
      {},
      firstResponse
    );
    await flush();

    // Recovery evicts it: the waiter fails and the mutex frees, but the send is
    // still in there, still holding an onStage hook.
    miden.__evictHolder();
    await flush();
    expect(firstResponse.mock.calls[0][0].ok).toBe(false);

    // The successor now owns the lock and the ambient id.
    let finishSuccessor!: (result: unknown) => void;
    G.__off.clientSendTransaction = jest.fn(
      () =>
        new Promise(resolve => {
          finishSuccessor = resolve;
        })
    );
    const secondResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-successor',
        method: 'sendTransaction',
        argsB64: [encodeArg({ accountId: 'a', amount: '1', extraInputs: {} })]
      }),
      {},
      secondResponse
    );
    await flush();

    capturedOnStage!('submitting');
    await flush();

    // Its own row — which is genuinely may-have-submitted — and not the
    // successor's, which has broadcast nothing.
    expect(posted).toEqual(['submitting|op-displaced']);

    releaseFirst();
    finishSuccessor({ serialize: () => new Uint8Array([2]) });
    await flush();
    expect(secondResponse.mock.calls[0][0].ok).toBe(true);
  });
});

// --- OFFSCREEN_RELOAD_ENDPOINTS: developer endpoint overrides in this realm ---
//
// The SW nudges this realm when the saved override changes, because BOTH the
// override cache and the client singleton are module-scoped — the SW's own
// loadEndpointOverrides() + resetMidenClient() reach only the SW realm, while
// flag-on it is the client HERE that talks to the node.
describe('offscreen/main — OFFSCREEN_RELOAD_ENDPOINTS (endpoint overrides)', () => {
  const callReq = (extra: Record<string, unknown>) => ({
    target: 'offscreen',
    type: 'OFFSCREEN_CALL',
    op_id: 'op-endpoints',
    deadline_ms: 1000,
    argsB64: [],
    ...extra
  });
  const reloadReq = { target: 'offscreen', type: 'OFFSCREEN_RELOAD_ENDPOINTS' };

  it('holds client creation until the override load resolves (the client bakes the endpoints in)', async () => {
    // A load that never settles until we release it: if the client were created
    // without awaiting it, it would bind to the build-default endpoints.
    let releaseLoad!: () => void;
    G.__off.loadEndpointOverrides = jest.fn(
      () =>
        new Promise<void>(resolve => {
          releaseLoad = () => {
            G.__off.order.push('loadEndpointOverrides');
            resolve();
          };
        })
    );

    await loadModule();
    // init() itself is parked on the load — the WASM init hasn't even started.
    expect(G.__off.getWasmOrThrow).not.toHaveBeenCalled();

    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('mtst1qqaccount')] }), {}, sendResponse);
    await flush();
    expect(G.__off.createOptions).toHaveLength(0);

    releaseLoad();
    await flush();

    expect(G.__off.createOptions).toHaveLength(1);
    expect(G.__off.order.indexOf('loadEndpointOverrides')).toBeLessThan(G.__off.order.indexOf('create'));
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
    // Memoized: init() and getOrCreateClient() awaited the SAME storage read.
    expect(G.__off.loadEndpointOverrides).toHaveBeenCalledTimes(1);
  });

  it('re-reads the override and drops the client, so the NEXT call rebuilds against it', async () => {
    await loadModule();

    const r1 = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('a')] }), {}, r1);
    await flush();
    expect(r1.mock.calls[0][0].ok).toBe(true);
    expect(G.__off.createOptions).toHaveLength(1);
    expect(G.__off.loadEndpointOverrides).toHaveBeenCalledTimes(1);

    // Hold the RELOAD's read open so the rebuild ordering is observable. init() is
    // long settled by now, so nothing but getOrCreateClient's own await can gate the
    // second create.
    let releaseReload!: () => void;
    G.__off.loadEndpointOverrides.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseReload = () => resolve();
        })
    );

    const ack = jest.fn();
    const ret = capturedListener!(reloadReq, {}, ack);
    // Async response promised, like the other two message families.
    expect(ret).toBe(true);
    await flush();
    expect(G.__off.loadEndpointOverrides).toHaveBeenCalledTimes(2);
    expect(ack).not.toHaveBeenCalled();

    // A call racing the in-flight reload must NOT get a client built on the
    // pre-reload endpoints.
    const r2 = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('b')] }), {}, r2);
    await flush();
    expect(G.__off.createOptions).toHaveLength(1);

    releaseReload();
    await flush();

    expect(ack).toHaveBeenCalledWith({ ok: true });
    // The dropped singleton was rebuilt — with the same slice-5 create options.
    expect(G.__off.createOptions).toHaveLength(2);
    expect(G.__off.createOptions[1].useWorker).toBe(false);
    expect(typeof G.__off.createOptions[1].signCallback).toBe('function');
    expect(r2.mock.calls[0][0].ok).toBe(true);
  });

  it('leaves an in-flight write untouched — it finishes on the client it already captured', async () => {
    await loadModule();
    let finishWrite!: (result: unknown) => void;
    G.__off.clientConsumeNoteId = jest.fn(
      () =>
        new Promise(resolve => {
          finishWrite = resolve;
        })
    );

    const write = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-write',
        method: 'consumeNoteId',
        argsB64: [encodeArg({ accountId: 'acc', noteId: 'n', noteIds: ['n'] })]
      }),
      {},
      write
    );
    await flush();
    expect(G.__off.createOptions).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();

    const ack = jest.fn();
    capturedListener!(reloadReq, {}, ack);
    await flush();

    // The reload acknowledged WITHOUT waiting on the write (it takes no WASM lock)
    // and without disturbing it: still in flight, still one client.
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(write).not.toHaveBeenCalled();
    expect(G.__off.createOptions).toHaveLength(1);

    finishWrite({ serialize: () => new Uint8Array([77, 88, 99]) });
    await flush();
    const resp = write.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([77, 88, 99]);
  });

  it('answers ok:false (never drops the response) when the reload throws, and stays usable', async () => {
    await loadModule();
    G.__off.loadEndpointOverrides.mockImplementationOnce(() => Promise.reject(new Error('storage exploded')));

    const ack = jest.fn();
    capturedListener!(reloadReq, {}, ack);
    await flush();

    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'storage exploded' });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('endpoint-override reload failed'),
      expect.any(Error)
    );

    // The failed read must not poison the memo — the next call still gets a client.
    const r = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('a')] }), {}, r);
    await flush();
    expect(r.mock.calls[0][0].ok).toBe(true);
    expect(G.__off.createOptions).toHaveLength(1);
  });
});

// --- Lock recovery in THIS realm (issue #775) -------------------------------
//
// `disposeAllInstances()` reaches only `midenClientSingleton`, which this realm
// deliberately does not use — so recovery fires a realm-local hook and main.ts
// is what makes it mean anything here. This is the realm the recorded trap
// happened in, so each strand of that hook gets its own test.
describe('offscreen/main — WASM lock recovery hook', () => {
  const firePoisoned = () => {
    for (const listener of G.__off.poisonedListeners ?? []) listener();
  };

  const callReq = (extra: Record<string, unknown>) => ({
    target: 'offscreen',
    type: 'OFFSCREEN_CALL',
    op_id: 'op-1',
    method: 'getAccount',
    argsB64: [encodeArg('acc')],
    ...extra
  });

  it('registers the hook at module load', async () => {
    await loadModule();
    expect(G.__off.poisonedListeners).toHaveLength(1);
  });

  it('drops the client so the next call rebuilds, and MARKS the displaced one poisoned', async () => {
    await loadModule();
    const r1 = jest.fn();
    capturedListener!(callReq({}), {}, r1);
    await flush();
    expect(G.__off.createOptions).toHaveLength(1);

    firePoisoned();
    await flush();

    // Marking is what keeps the client's own corpse guards live for a flow that
    // already holds it: dropping the module reference hides the client from the
    // next caller but leaves an evicted dispatch looking like a healthy owner,
    // free to release the successor's mutex or pause its watchdog.
    expect(G.__off.clientMarkPoisoned).toHaveBeenCalledTimes(1);

    const r2 = jest.fn();
    capturedListener!(callReq({ op_id: 'op-2' }), {}, r2);
    await flush();
    expect(r2.mock.calls[0][0].ok).toBe(true);
    expect(G.__off.createOptions).toHaveLength(2);
    expect(G.__off.createOptions[1].useWorker).toBe(false);
  });

  it('drops the memoized PROVE client too — it shares the WASM instance that trapped', async () => {
    await loadModule();
    const p1 = jest.fn();
    capturedListener!(
      { target: 'offscreen', type: 'OFFSCREEN_PROVE', txResultB64: Buffer.from([9]).toString('base64') },
      {},
      p1
    );
    await flush();
    expect(p1.mock.calls[0][0].ok).toBe(true);
    expect(G.__off.webClientCtorCount).toBe(1);

    firePoisoned();
    await flush();

    const p2 = jest.fn();
    capturedListener!(
      { target: 'offscreen', type: 'OFFSCREEN_PROVE', txResultB64: Buffer.from([9]).toString('base64') },
      {},
      p2
    );
    await flush();
    expect(p2.mock.calls[0][0].ok).toBe(true);
    // A second construction: the trapped prover was not handed out again. It has
    // no other reset path — `OFFSCREEN_PROVE` runs outside the mutex, so it gets
    // neither the watchdog nor the eviction that a CALL gets.
    expect(G.__off.webClientCtorCount).toBe(2);
  });

  it('a no-op fire (nothing built yet) neither logs nor breaks the next call', async () => {
    await loadModule();
    firePoisoned();
    await flush();
    expect(G.__off.clientMarkPoisoned).not.toHaveBeenCalled();

    const r = jest.fn();
    capturedListener!(callReq({}), {}, r);
    await flush();
    expect(r.mock.calls[0][0].ok).toBe(true);
  });

  it('a create in flight when the poisoning lands resolves to an ALREADY-marked client (#775 F-056)', async () => {
    await loadModule();
    const orderLog: string[] = [];
    G.__off.clientMarkPoisoned.mockImplementation(() => orderLog.push('marked'));
    G.__off.clientGetAccount.mockImplementation(async () => {
      orderLog.push('used');
      return undefined;
    });

    // Gate the create so the poisoning lands while it is in flight, with a
    // dispatch already awaiting the memoized promise.
    let releaseCreate!: (c: unknown) => void;
    const gate = new Promise<unknown>(resolve => {
      releaseCreate = resolve;
    });
    G.__off.getMidenClient.mockReturnValueOnce(gate);
    const r1 = jest.fn();
    capturedListener!(callReq({}), {}, r1);
    await flush();

    // What both replace paths do before notifying: bump the cross-module
    // generation, then fire the realm hook.
    const { bumpWasmClientGeneration } = require('lib/miden/sdk/wasm-client-poison');
    bumpWasmClientGeneration();
    firePoisoned();
    await flush();

    releaseCreate({
      markPoisoned: (...a: unknown[]) => G.__off.clientMarkPoisoned(...a),
      getAccount: (...a: unknown[]) => G.__off.clientGetAccount(...a)
    });
    await flush();

    // The awaiting dispatch is ahead of the poison hook's own late
    // `.then(markPoisoned)` in the microtask queue — the generation check
    // inside the create chain is what guarantees the mark lands FIRST.
    expect(orderLog[0]).toBe('marked');
    expect(orderLog).toContain('used');
    expect(r1.mock.calls[0][0].ok).toBe(true);
  });

  it('refuses a sign from the displaced client, even while a successor op makes the ambient id look valid', async () => {
    await loadModule();
    const signed: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      if (m?.type === OFFSCREEN_SIGN_REQUEST) {
        signed.push(m);
        return { ok: true, sign_id: m.sign_id, signatureB64: Buffer.from([7]).toString('base64') };
      }
      return undefined;
    });

    const r1 = jest.fn();
    capturedListener!(callReq({ op_id: 'op-corpse' }), {}, r1);
    await flush();
    const corpseSign = G.__off.createOptions[0].signCallback;

    firePoisoned();
    await flush();

    // A successor takes the lock and publishes ITS op_id as the ambient one, so
    // the corpse's sign can no longer be caught by the no-ambient-id guard —
    // the id it would read is real, just not its own.
    let finishSuccessor!: (result: unknown) => void;
    G.__off.clientConsumeNoteId = jest.fn(
      () =>
        new Promise(resolve => {
          finishSuccessor = resolve;
        })
    );
    const r2 = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-successor',
        method: 'consumeNoteId',
        argsB64: [encodeArg({ accountId: 'a', noteId: 'n', noteIds: ['n'] })]
      }),
      {},
      r2
    );
    await flush();

    await expect(corpseSign(new Uint8Array([1]), new Uint8Array([2]))).rejects.toThrow(
      'poisoned by WASM lock recovery'
    );
    // Nothing reversed to the SW: a signature tagged 'op-successor' would pause
    // that op's write deadline, and a failure would land a `locked` reason in its
    // slot for the SW to re-tag onto its error.
    expect(signed).toHaveLength(0);

    // The REBUILT client's sign is unaffected — the token is per client.
    const liveSign = G.__off.createOptions[1].signCallback;
    await expect(liveSign(new Uint8Array([3]), new Uint8Array([4]))).resolves.toEqual(new Uint8Array([7]));
    expect(signed).toHaveLength(1);
    expect(signed[0].op_id).toBe('op-successor');

    finishSuccessor({ serialize: () => new Uint8Array([5]) });
    await flush();
    expect(r2.mock.calls[0][0].ok).toBe(true);
  });

  it('still answers the SW when the thrown value has a throwing `reason` accessor', async () => {
    // The failure reply is built from a value of unknown provenance. Reading
    // `.reason` (or `.name`) unguarded lets a foreign accessor throw out of the
    // catch, and then `sendResponse` never runs at all — the SW waits out its
    // per-op deadline and kills the realm instead of getting the failure it is
    // owed. Both reads go through the guarded helpers for that reason.
    await loadModule();
    G.__off.clientGetAccount = jest.fn(async () => {
      // Not an Error on purpose: a plain object is what a foreign realm can
      // throw, and it is the only way to give `reason` a hostile accessor.
      // eslint-disable-next-line no-throw-literal
      throw {
        name: 'WasmClientPoisonedError',
        message: 'evicted',
        get reason(): string {
          throw new Error('accessor from a foreign realm');
        }
      };
    });
    const r = jest.fn();
    capturedListener!(callReq({ op_id: 'op-hostile' }), {}, r);
    await flush();

    const resp = r.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.op_id).toBe('op-hostile');
    // The class still crosses — that is what makes the SW treat the op as
    // abandoned-outcome-unknown rather than plainly failed — and the
    // unreadable reason simply drops, where the SW's own fallback covers it.
    expect(resp.errorName).toBe('WasmClientPoisonedError');
    expect(resp.errorReason).toBeUndefined();
  });

  it('still answers the SW when EVERY field of the thrown value throws on read', async () => {
    // The worst case of the same hazard: `name`, `message` and the code the
    // classifier reads are all hostile accessors. There is nothing left to
    // report, but the one thing that must still happen is the reply — a silent
    // catch here is indistinguishable to the SW from a wedged realm, and it pays
    // the full per-op deadline before killing the document to find out.
    await loadModule();
    G.__off.clientGetAccount = jest.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw {
        get name(): string {
          throw new Error('hostile name');
        },
        get message(): string {
          throw new Error('hostile message');
        },
        get errorCode(): string {
          throw new Error('hostile code');
        }
      };
    });
    const r = jest.fn();
    capturedListener!(callReq({ op_id: 'op-all-hostile' }), {}, r);
    await flush();

    const resp = r.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.op_id).toBe('op-all-hostile');
    // A placeholder rather than a crash, and no class claimed for a value that
    // would not name one.
    expect(typeof resp.error).toBe('string');
    expect(resp.errorName).toBeUndefined();
    expect(resp.errorCode).toBeUndefined();
  });

  it('leaves the ambient op_id clear when the evicted op unwinds, so a corpse sign has nothing to borrow', async () => {
    await loadModule();
    const signed: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      if (m?.type === OFFSCREEN_SIGN_REQUEST) {
        signed.push(m);
        return { ok: true, sign_id: m.sign_id, signatureB64: Buffer.from([7]).toString('base64') };
      }
      return undefined;
    });

    // An op whose dispatch REJECTS unwinds through handleCall's catch — the same
    // path an eviction takes, where the locked section's own finally never runs.
    G.__off.clientGetAccount = jest.fn(async () => {
      throw new Error('evicted');
    });
    const r = jest.fn();
    capturedListener!(callReq({ op_id: 'op-evicted' }), {}, r);
    await flush();
    expect(r.mock.calls[0][0].ok).toBe(false);

    const signCb = G.__off.createOptions[0].signCallback;
    await expect(signCb(new Uint8Array([1]), new Uint8Array([2]))).rejects.toThrow('no ambient op_id');
    expect(signed).toHaveLength(0);
  });

  it('resolves the client INSIDE the lock, so an op queued behind a poisoned holder gets the rebuilt one', async () => {
    await loadModule();
    // Op A holds the lock; op B queues behind it. Recovery lands while B waits.
    let finishA!: (result: unknown) => void;
    G.__off.clientConsumeNoteId = jest.fn(
      () =>
        new Promise(resolve => {
          finishA = resolve;
        })
    );

    const a = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-a',
        method: 'consumeNoteId',
        argsB64: [encodeArg({ accountId: 'acc', noteId: 'n', noteIds: ['n'] })]
      }),
      {},
      a
    );
    await flush();
    const b = jest.fn();
    capturedListener!(callReq({ op_id: 'op-b' }), {}, b);
    await flush();
    expect(G.__off.createOptions).toHaveLength(1);

    firePoisoned();
    await flush();
    finishA({ serialize: () => new Uint8Array([1]) });
    await flush();

    expect(b.mock.calls[0][0].ok).toBe(true);
    // B ran on a client created AFTER the poisoning. Reading the slot before
    // queueing would have pinned it to the poisoned one — and the ops most
    // likely to be queued are precisely those waiting behind the holder that
    // trapped.
    expect(G.__off.createOptions).toHaveLength(2);
  });
});

// --- Connectivity reports: this realm reports, it does NOT write the snapshot ---
//
// `lib/miden/activity/connectivity-state` is module-scoped — per realm — and mirrors
// the WHOLE snapshot to one shared storage key. Both realms mark into it (the SW from
// sync-manager, this realm from `proveWithFallback` around every write it executes),
// so a blind write here replaces the SW's node/network categorization wholesale. This
// realm therefore installs a REPORTER at module load and forwards each observation.
describe('offscreen/main — connectivity reports (issue #260 single writer)', () => {
  /** The connectivity-state module instance THIS loaded copy of main.ts installed its
   * reporter on. Must be imported after `loadModule()` — `jest.resetModules()` gives
   * each load a fresh registry, so a static import would be a different instance. */
  const connectivityState = () => import('lib/miden/activity/connectivity-state');

  const connectivityPosts = (posted: any[]) => posted.filter(m => m?.type === 'OFFSCREEN_CONNECTIVITY_EVENT');

  function capturePosts(): any[] {
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      posted.push(m);
      return undefined;
    });
    return posted;
  }

  it('installs a reporter at load, so a mark posts an SW-targeted event instead of writing storage', async () => {
    await loadModule();
    const posted = capturePosts();

    const { markConnectivityIssue, getConnectivityState } = await connectivityState();
    markConnectivityIssue('prover');
    await flush();

    expect(connectivityPosts(posted)).toEqual([
      { target: 'sw', type: 'OFFSCREEN_CONNECTIVITY_EVENT', category: 'prover', active: true }
    ]);
    // Reported, not applied locally: this realm's snapshot stays empty, which is what
    // keeps it out of the shared storage key the SW owns.
    expect(getConnectivityState().prover.active).toBe(false);
  });

  it('posts a clear as `active: false`', async () => {
    await loadModule();
    const posted = capturePosts();

    const { clearConnectivityIssue } = await connectivityState();
    clearConnectivityIssue('prover');
    await flush();

    expect(connectivityPosts(posted)).toEqual([
      { target: 'sw', type: 'OFFSCREEN_CONNECTIVITY_EVENT', category: 'prover', active: false }
    ]);
  });

  // Drop-safety: the post is fire-and-forget with no delivery guarantee, so the value
  // is re-sent on EVERY prove. Suppressing repeats here would let one lost clear latch
  // the banner active permanently — nothing else would ever re-send it.
  it('re-posts on every mark/clear, not only on transitions', async () => {
    await loadModule();
    const posted = capturePosts();

    const { markConnectivityIssue, clearConnectivityIssue } = await connectivityState();
    markConnectivityIssue('prover');
    markConnectivityIssue('prover');
    clearConnectivityIssue('prover');
    clearConnectivityIssue('prover');
    await flush();

    expect(connectivityPosts(posted).map(m => m.active)).toEqual([true, true, false, false]);
  });

  // These marks run INSIDE `proveWithFallback`'s success/failure handlers, so a throw
  // out of the post would be read as a prove failure — a funds-path consequence for a
  // banner update. Both failure modes of the channel must be absorbed.
  //
  // The double is keyed on the MESSAGE, deliberately not on a call counter.
  // `chrome.runtime.sendMessage` is a shared global that this module also posts
  // `OFFSCREEN_READY` to once `ensureInit()` settles (main.ts), and a counter made
  // which failure branch each connectivity post took depend on whether that unrelated
  // post had already landed — i.e. on scheduling. Keying on the message pins the mark
  // to the rejected-promise path and the clear to the synchronous throw whatever else
  // the module posts, and the `posted` assertion below turns a stray post into an
  // explicit failure rather than a silent branch swap.
  it('a post failure NEVER reaches the prove (rejection and synchronous throw both swallowed)', async () => {
    await loadModule();
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn((m: any) => {
      if (m?.type !== 'OFFSCREEN_CONNECTIVITY_EVENT') return Promise.resolve(undefined);
      posted.push(m);
      // The two ways this channel fails: no SW receiver (the returned promise rejects)
      // and a torn-down port (a synchronous throw). The rejection is deferred a tick
      // rather than pre-rejected, which is both what the real `chrome.runtime.sendMessage`
      // does — it resolves/rejects once the receiver has (not) answered — and what keeps
      // the fixture from depending on WHEN the handler is attached: the promise is still
      // pending when it is returned, so the only way its rejection can escape is a
      // production path that never attaches one.
      if (m.active === true) {
        return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('no receiver')), 0));
      }
      throw new Error('port closed');
    });

    const { markConnectivityIssue, clearConnectivityIssue } = await connectivityState();
    expect(() => markConnectivityIssue('prover')).not.toThrow();
    expect(() => clearConnectivityIssue('prover')).not.toThrow();
    await flush();

    // Exactly the two posts this test provoked, in order — so an extra connectivity
    // post from anywhere else fails here instead of shifting the fixture underneath it.
    expect(posted.map(m => m.active)).toEqual([true, false]);
    // A rejected post is swallowed silently — no reporter-threw warning was logged.
    expect(warnSpy).not.toHaveBeenCalledWith('[connectivity-state] reporter threw:', expect.anything());
  });
});

// --- E2E prove markers: what this realm reports while a write is in flight ----
//
// The offscreen document is the realm that runs every wallet write and the only one
// the Playwright harness cannot attach a console to (a hidden target, absent from
// `context.pages()`). Settle-time prove telemetry cannot cover a write that never
// returns — it records once a prove FINISHES — so these markers, relayed to the
// service worker as they happen, are the only record of where a hang stopped (#718).
//
// The regression this guards is specifically the GUARDIAN pipeline: it drives the raw
// `client.client.transactions` API itself rather than going through the instrumented
// `MidenClientInterface`, so before this it narrated nothing at all — and a guardian
// write is the wallet's DEFAULT account type.
describe('offscreen/main — E2E prove markers (#718)', () => {
  const markerLines = (posted: any[]): string[] =>
    posted.filter(m => m?.type === 'OFFSCREEN_PROVE_MARKER').map(m => String(m.line));

  function capturePosts(): any[] {
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      posted.push(m);
      return undefined;
    });
    return posted;
  }

  const callReq = (extra: Record<string, unknown>) => ({
    target: 'offscreen',
    type: 'OFFSCREEN_CALL',
    op_id: 'op-markers',
    deadline_ms: 1000,
    argsB64: [],
    ...extra
  });

  // `PROVE_TIMING_ENABLED` is captured at MODULE LOAD, so the env var has to be set
  // before the import that `loadModule()` performs — not inside the test body.
  const withE2EFlag = async (value: string | undefined, run: () => Promise<void>) => {
    const previous = process.env.MIDEN_E2E_TEST;
    if (value === undefined) delete process.env.MIDEN_E2E_TEST;
    else process.env.MIDEN_E2E_TEST = value;
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env.MIDEN_E2E_TEST;
      else process.env.MIDEN_E2E_TEST = previous;
    }
  };

  it('relays a guardian pipeline\u2019s per-call markers to the SW, naming every boundary a hang can stop at', async () => {
    await withE2EFlag('true', async () => {
      await loadModule();
      const posted = capturePosts();
      capturedListener!(
        callReq({
          method: 'guardianPipeline',
          argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([9])), encodeArg(true)]
        }),
        {},
        jest.fn()
      );
      await flush();

      const lines = markerLines(posted);
      // The op ENVELOPE — where a write waits on the WASM mutex, hydrates WASM and
      // builds the client. Without these a write that never started is
      // indistinguishable from one wedged inside the SDK.
      expect(lines.some(l => l.includes("call 'guardianPipeline' op=op-markers entered"))).toBe(true);
      // The client is resolved INSIDE the lock (issue #775), so the boundaries
      // are: await the mutex → win it and build/fetch the client → dispatch.
      expect(lines.some(l => l.includes("call 'guardianPipeline' init ready; awaiting WASM mutex"))).toBe(true);
      expect(lines.some(l => l.includes("call 'guardianPipeline' won WASM mutex; getting client"))).toBe(true);
      expect(lines.some(l => l.includes("call 'guardianPipeline' client ready; dispatching"))).toBe(true);
      // The pipeline's own boundaries, including which prover the delegated prove
      // named — the distinction between a real delegation and the default-prover
      // fallback that never dispatches out of this realm.
      expect(lines.some(l => l.includes('guardianPipeline entered delegateTransaction=true'))).toBe(true);
      expect(lines.some(l => l.includes('guardianPipeline calling executeRequest'))).toBe(true);
      expect(lines.some(l => l.includes('guardianPipeline delegated prove, remoteProver=set'))).toBe(true);
      expect(lines.some(l => l.includes('guardianPipeline prove returned; submitting'))).toBe(true);
      expect(lines.some(l => l.includes('guardianPipeline apply returned'))).toBe(true);
      // Every line carries the `[prove-timing]` prefix the harness probe greps for.
      expect(lines.every(l => l.startsWith('[prove-timing] '))).toBe(true);
    });
  });

  it('records nothing at all when the E2E flag is off (production builds)', async () => {
    await withE2EFlag(undefined, async () => {
      await loadModule();
      const posted = capturePosts();
      capturedListener!(
        callReq({
          method: 'guardianPipeline',
          argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([9])), encodeArg(false)]
        }),
        {},
        jest.fn()
      );
      await flush();

      expect(markerLines(posted)).toEqual([]);
    });
  });
});
