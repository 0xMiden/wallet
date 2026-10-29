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

import {
  encodeArg,
  OFFSCREEN_SIGN_REQUEST,
  OFFSCREEN_SUBMIT_GATE,
  OFFSCREEN_STORAGE_HEALTH
} from 'lib/miden/back/offscreen-codec';

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

jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual('lib/settings/helpers'),
  isCrashReportingEnabledAsync: jest.fn(async () => true)
}));

jest.mock('lib/miden-chain/native-asset', () => ({
  cacheScope: () => 'offscreen-rpc|devnet',
  captureNativeAssetSnapshot: (scope: string) => ({ scope, revision: 0 }),
  setNativeAssetPublisher: (publisher: (id: string, scope: string) => Promise<void>) => {
    G.__off.nativePublisher = publisher;
  },
  recordSyncedFeeFaucetId: jest.fn(async (id: string, snapshot: { scope: string }, assertLive: () => void) => {
    assertLive();
    try {
      await G.__off.nativePublisher(id, snapshot.scope);
    } catch {
      return false;
    }
    assertLive();
    return true;
  })
}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const g = globalThis as any;
  const mod: any = {
    getWasmOrThrow: (...a: any[]) => g.__off.getWasmOrThrow(...a),
    NoteType: { Private: 0, Public: 1 },
    NoteFile: { deserialize: (bytes: Uint8Array) => g.__off.deserializeAcquiredNoteFile(bytes) },
    FeltArray: class {
      constructor(readonly elements: unknown[]) {}
    },
    Poseidon2: {
      hashElements: () => ({ toHex: () => 'cd'.repeat(32), toFelts: () => [1, 2, 3, 4] })
    },
    Address: {
      fromAccountId: (accountId: { canonical: string }) => ({ toBech32: () => accountId.canonical })
    },
    NetworkId: { testnet: () => 'testnet' },
    InputNoteState: {
      Invalid: 3,
      ConsumedAuthenticatedLocal: 'local-auth',
      ConsumedUnauthenticatedLocal: 'local-unauth'
    },
    WebClient: class {
      constructor() {
        g.__off.webClientCtorCount++;
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
    },
    // #945: a worker proof comes back as bytes and is rebuilt here for submitProven.
    ProvenTransaction: {
      deserialize: (bytes: Uint8Array) => g.__off.deserializeProof(bytes)
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
  const { WasmClientPoisonedError: PoisonError } = jest.requireActual('lib/miden/sdk/wasm-client-poison');
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
  // The newest hold's own operation, which an eviction abandons rather than settles:
  // what it rejects with is the abandoned flow's outcome, not the waiter's (#945).
  let lastRunning: Promise<unknown> | null = null;
  // Issue #775: each hold gets an IDENTITY, mirroring the real module, because the
  // behaviours under test turn on whether a yielding flow still owns the mutex.
  // A single shared token cannot express that — with one, an evicted flow's yield
  // still queues on `acquire()` and therefore can never observe a successor
  // holding the lock, which is the entire hazard.
  let currentHold: object | null = null;
  // Holds that were EVICTED. The real module sets `killed` on the holder, and its
  // in-flight yield then reacquires, sees the flag and hands the mutex straight
  // back WITHOUT becoming owner again. Modelling only the release let an evicted
  // flow reclaim ownership on the way out of its sleep, which made every
  // hold-liveness guard downstream of a yield look satisfied — the corpse read as
  // the legitimate owner, which is exactly the state those guards exist to reject.
  const deadHolds = new WeakSet<object>();
  const lockOptionsSeen: Array<unknown> = [];
  const withWasmClientLock = async <T>(op: (hold: object) => Promise<T>, options?: unknown): Promise<T> => {
    lockOptionsSeen.push(options);
    await acquire();
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
        deadHolds.add(hold);
        releaseOnce();
        // The REAL class, not a look-alike `Error`. `handleCall` forwards
        // `errorName`/`errorReason` only for `WasmClientPoisonedError`, and the SW's
        // kill classifiers key off exactly that — so a plain error made every
        // eviction test here silently assert the ORDINARY-failure path, which is the
        // one shape the poison contract exists to keep it out of.
        reject(new PoisonError('realm-error', new Error('evicted by the test harness')));
      };
    });
    // `aborted` is the real hold's eviction signal, which `proveInWorker` hands the
    // transport as its cancel (#945).
    const hold = { mock: 'wasm-lock-hold', aborted: evicted };
    currentHold = hold;
    try {
      const running = op(hold);
      lastRunning = running;
      return await Promise.race([running, evicted]);
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
      if (hold !== undefined && !deadHolds.has(hold)) {
        currentHold = hold;
      } else {
        // Evicted while suspended: this flow must not resume as owner.
        release();
      }
    }
  };
  // Test hook: true while the shared lock is held (used to assert the commit-wait
  // yielded it during the sleep).
  const isWasmClientBusy = (): boolean => locked;
  return {
    getMidenClient: (...a: any[]) => g.__off.getMidenClient(...a),
    withWasmClientLock,
    tryWithWasmClientLock: async <T>(
      op: (hold: object) => Promise<T>,
      options?: unknown
    ): Promise<{ ran: false } | { ran: true; value: T }> => {
      if (locked) return { ran: false };
      return { ran: true, value: await withWasmClientLock(op, options) };
    },
    lockOptionsSeen,
    withWasmLockWatchdogPaused: async <T>(op: () => Promise<T>): Promise<T> => op(),
    yieldWasmClientLock,
    isWasmClientBusy,
    __evictHolder,
    __lastRunning: () => lastRunning,
    getCurrentWasmLockHold: () => currentHold,
    // #788 follow-up: the shared post-await ownership re-check the dispatches run.
    // Re-implements the REAL comparison against this mock's own `currentHold` —
    // a no-op here would satisfy every eviction test below vacuously, because the
    // guards under test could then never fire.
    assertWasmHoldCurrent: (hold: object | null, where: string, step?: string): void => {
      if (hold !== null && hold === currentHold) return;
      throw new PoisonError('watchdog', new Error(`operation abandoned ${where}${step ? `, ${step}` : ''}`));
    },
    onWasmClientPoisoned: (listener: () => void) => {
      g.__off.poisonedListeners = g.__off.poisonedListeners ?? [];
      g.__off.poisonedListeners.push(listener);
      return () => {};
    }
  };
});

// `local-prove-transport` imports the lock module by its RELATIVE path, which jest
// keys apart from the `lib/...` alias above (the root `__mocks__/lib/...` manual mock
// is bound to the alias). Point the relative id at the same mock instance, so the
// worker-prove helper sees this file's holds (#945).
jest.mock('../lib/miden/sdk/miden-client', () => jest.requireMock('lib/miden/sdk/miden-client'));

// An offscreen document has no chrome.storage, so every storage call rejects here as it does
// in the real realm. The REAL effective-endpoints module runs on top of it: a stub of it hid
// #1482, where this realm silently ran on the build's network.
jest.mock('lib/platform/storage-adapter', () => {
  const g = globalThis as any;
  const refuse = async () => {
    g.__off.storageCalls++;
    throw new TypeError("Cannot read properties of undefined (reading 'local')");
  };
  return { getStorageProvider: () => ({ get: refuse, set: refuse, remove: refuse }) };
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
        // What `create` bakes into the client, read from this realm's effective-endpoints.
        const endpoints = jest.requireActual('lib/miden-chain/effective-endpoints');
        g.__off.createEndpoints.push({
          network: endpoints.getEffectiveNetworkName(),
          rpcUrl: endpoints.getEffectiveRpcUrl(),
          proverUrl: endpoints.getEffectiveProverUrl(),
          noteTransportUrl: endpoints.getEffectiveNoteTransportUrl(),
          feeFaucetId: endpoints.getEffectiveFeeFaucetId()
        });
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

jest.mock('lib/miden/swap/balance', () => {
  const g = globalThis as any;
  return {
    readSwapFeeContext: (...a: any[]) => g.__off.readSwapFeeContext(...a),
    assertSwapFeeContextMatches: (...a: any[]) => g.__off.assertSwapFeeContextMatches(...a)
  };
});

// The dry run's request preparation, which reads the account through the client, answered per test.
jest.mock('lib/miden/sdk/custom-request', () => ({
  prepareCustomRequestBytes: (...a: any[]) => (globalThis as any).__off.prepareCustomRequestBytes(...a)
}));

// #945: every local prove in this document goes to the prove worker client, which
// is replaced here by a fake transport. The default proof bytes are [1, 2, 3].
const mockProveTransport = {
  prove: jest.fn(async (_request: { txResult: Uint8Array }, _options?: object) => ({
    proven: new Uint8Array([1, 2, 3]),
    durationMs: 42
  })),
  prewarm: jest.fn(),
  // How many `ProveWorkerClient` instances main.ts constructed. main.ts builds exactly
  // one at module top and reuses it for every OFFSCREEN_PROVE, so this stays 1 per
  // `loadModule()` regardless of how many prove requests a test sends.
  ctorCount: 0
};

jest.mock('./prove-worker-client', () => ({
  ProveWorkerClient: class {
    constructor() {
      mockProveTransport.ctorCount++;
    }
    prove(request: { txResult: Uint8Array }, options?: object) {
      return mockProveTransport.prove(request, options);
    }
    prewarm() {
      mockProveTransport.prewarm();
    }
  }
}));

// What a service worker on the build's own network sends with every call (#1482).
const SW_ENDPOINTS = { override: null, feeFaucetId: undefined };

let capturedListener: Listener | undefined;
let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

function resetControl() {
  G.__off = {
    storageCalls: 0,
    // One entry per client build: the effective endpoints at the moment `create` ran.
    createEndpoints: [] as any[],
    getWasmOrThrow: jest.fn(async () => {}),
    hasInitThreadPool: true,
    initThreadPool: jest.fn(async () => {}),
    webClientCtorCount: 0,
    deserializeTxResult: jest.fn(() => ({ __txResult: true })),
    // Slice 6a: TransactionRequest.deserialize(trBytes) → a request handle the
    // guardianPipeline hands to executeRequest. Echo the bytes so the test can
    // assert the co-signed request crossed intact.
    deserializeTxRequest: jest.fn((b: Uint8Array) => ({ __trFromBytes: Array.from(b), authArg: () => undefined })),
    // The dry run's request preparation; the bytes pass through unless a test holds or changes them.
    prepareCustomRequestBytes: jest.fn(async (_client: unknown, _account: string, bytes: Uint8Array) => bytes),
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
    clientGetDetailsCommitmentMatches: jest.fn(async (_commitments: string[]) => [
      {
        notes: [
          { noteId: '0xreal', senderAccountId: 'mtst1qsender', assets: [], noteType: 0, nullifier: '0xn', state: 2 }
        ],
        uncommitted: 1
      }
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
    clientBuildPswapCancelRequest: jest.fn(
      async (_accountId: string, _noteId: string) => new Uint8Array([20, 14, 7, 6])
    ),
    // Slice-5 consume: the offscreen-owned client's consumeNoteId returns a
    // TransactionResult-like object exposing serialize() (the offscreen DISPATCH
    // ships the serialized bytes back).
    clientConsumeNoteId: jest.fn(async (_dto: unknown) => ({ serialize: () => new Uint8Array([77, 88, 99]) })),
    // Slice-5b writes on the offscreen-owned client — each returns a
    // TransactionResult-like object exposing serialize() (the DISPATCH ships the
    // serialized bytes back).
    clientSendTransaction: jest.fn(async (_tx: unknown) => ({ serialize: () => new Uint8Array([11, 22, 33]) })),
    clientSwapTransaction: jest.fn(async (_tx: unknown) => ({ serialize: () => new Uint8Array([44, 55, 66, 77]) })),
    readSwapFeeContext: jest.fn(async (scope: string) => ({
      scope,
      nativeAssetId: 'mtst1qfee',
      feeFaucetId: null,
      baseFee: 7n
    })),
    assertSwapFeeContextMatches: jest.fn((queued: any, current: any, expectedScope: string) => {
      if (
        queued.scope !== expectedScope ||
        current.scope !== expectedScope ||
        queued.nativeAssetId !== current.nativeAssetId ||
        queued.feeFaucetId !== current.feeFaucetId ||
        queued.baseFee !== current.baseFee
      ) {
        throw new Error('swapBalanceUnavailable');
      }
      return current;
    }),
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
    clientGetInputNote: jest.fn(async (_id: string) => ({
      metadata: () => ({ noteType: () => 1 }),
      details: () => {
        throw new Error('note details unavailable');
      }
    })),
    clientImportNoteBytes: jest.fn(async (_bytes: Uint8Array) => '0ximportedid'),
    clientDrainPrivateNoteTransport: jest.fn(async () => {}),
    clientImportGuardianHistoryP2ideNotes: jest.fn(async () => undefined),
    clientDecodeGuardianHistory: jest.fn(async (_encoded: string) => ({
      accountId: 'account',
      inputNotes: [],
      outputNotes: []
    })),
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
    // Overridable so a test can choose between a transport-shaped failure (which
    // is what marks a prover outage) and a semantic one (which must not).
    guardianProveFailureMessage: 'remote prover deadline expired',
    // When set, the failing prove throws this instead of an Error carrying the message above.
    guardianProveError: undefined as Error | undefined,
    guardianSubmitted: false,
    guardianApplied: false,
    // #1233: the apply retry's read of the local account, on the raw client the pipeline drives.
    // Default: no such account, so a retry fails closed and the older tests keep wrapping.
    clientAccountsGet: jest.fn(async (_accountId: unknown): Promise<unknown> => null),
    deserializeProof: jest.fn((bytes: Uint8Array) => ({ __proofFromBytes: Array.from(bytes) })),
    // #945: a worker proof is submitted through submitProven with the result it proves.
    guardianSubmitProven: jest.fn(async (_proof: unknown, _result: unknown) => {
      G.__off.guardianSubmitted = true;
      return {
        apply: jest.fn(async () => {
          G.__off.guardianApplied = true;
        })
      };
    }),
    guardianExecuteRequest: jest.fn(async (_accountId: string, _tr: unknown) => {
      const g2 = globalThis as any;
      return {
        result: {
          serialize: () => new Uint8Array([55, 66, 77]),
          executedTransaction: () => ({ inputNotes: () => ({ notes: () => [] }), userOutputNotes: () => [] })
        },
        id: { toHex: () => 'guardian-exec-hash' },
        prove: jest.fn(async (options?: any) => {
          g2.__off.guardianProveCalls.push(options);
          // #945: no local prove may run on this document's thread.
          if (options?.prover?.__local) throw new Error('in-realm prove reached');
          if (g2.__off.guardianProveShouldFailOnce) {
            g2.__off.guardianProveShouldFailOnce = false;
            throw g2.__off.guardianProveError ?? new Error(g2.__off.guardianProveFailureMessage);
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
    // Set by a test to model the client being poisoned under a live flow — a trap
    // taken by ANOTHER flow marks the shared client, and the corpse guards read it.
    clientIsDisposed: false,
    // Per-BUILD identity, so a rebuild is observable. The shared `clientIsDisposed`
    // flag alone cannot tell "the poll kept using the poisoned client" from "the poll
    // rebuilt and used the new one" — every build reads the same flag and every call
    // lands on the same control spy. `disposedBuilds` disposes ONE build, and
    // `listBuilds` records which build each `transactions.list` came from.
    clientBuilds: 0,
    disposedBuilds: new Set<number>(),
    listBuilds: [] as number[],
    getMidenClient: jest.fn(async () => {
      const build = ++(globalThis as any).__off.clientBuilds;
      const instance = {
        __build: build,
        get isDisposed() {
          const off = (globalThis as any).__off;
          return off.clientIsDisposed || off.disposedBuilds.has(build);
        },
        markPoisoned: (...a: any[]) => (globalThis as any).__off.clientMarkPoisoned(...a),
        getAccount: (...a: any[]) => (globalThis as any).__off.clientGetAccount(...a),
        syncState: async (...a: any[]) => {
          const sync = (globalThis as any).__off.clientSyncState;
          const { syncAndRecordFeeFaucet } = jest.requireActual('lib/miden/sdk/sync-and-record-fee-faucet');
          const summary = await syncAndRecordFeeFaucet(
            instance.client,
            () => sync(...a),
            typeof a[0] === 'function' ? a[0] : () => {}
          );
          if (typeof summary?.blockNum === 'function') return summary;
          return { ...summary, blockNum: () => 5000 };
        },
        waitForTransactionCommit: (...a: any[]) => (globalThis as any).__off.clientWaitForTransactionCommit(...a),
        exportNote: (...a: any[]) => (globalThis as any).__off.clientExportNote(...a),
        getInputNoteDetails: (...a: any[]) => (globalThis as any).__off.clientGetInputNoteDetails(...a),
        getDetailsCommitmentMatches: (...a: any[]) => (globalThis as any).__off.clientGetDetailsCommitmentMatches(...a),
        getTransactionCommitState: (...a: any[]) => (globalThis as any).__off.clientGetTransactionCommitState(...a),
        getConsumableNoteDtos: (...a: any[]) => (globalThis as any).__off.clientGetConsumableNoteDtos(...a),
        buildPswapCancelRequest: (...a: any[]) => (globalThis as any).__off.clientBuildPswapCancelRequest(...a),
        consumeNoteId: (...a: any[]) => (globalThis as any).__off.clientConsumeNoteId(...a),
        sendTransaction: (...a: any[]) => (globalThis as any).__off.clientSendTransaction(...a),
        swapTransaction: (...a: any[]) => (globalThis as any).__off.clientSwapTransaction(...a),
        newTransaction: (...a: any[]) => (globalThis as any).__off.clientNewTransaction(...a),
        // Slice-7a: getInputNote / importNoteBytes are interface methods on the
        // offscreen-owned client; the DISPATCH reduces getInputNote in-realm.
        getInputNote: (...a: any[]) => (globalThis as any).__off.clientGetInputNote(...a),
        importNoteBytes: (...a: any[]) => (globalThis as any).__off.clientImportNoteBytes(...a),
        drainPrivateNoteTransport: (...a: any[]) => (globalThis as any).__off.clientDrainPrivateNoteTransport(...a),
        importGuardianHistoryP2ideNotes: G.__off.clientImportGuardianHistoryP2ideNotes,
        decodeGuardianHistory: (...a: any[]) => (globalThis as any).__off.clientDecodeGuardianHistory(...a),
        importRecoveryNoteBytes: (...a: any[]) => (globalThis as any).__off.clientImportRecoveryNoteBytes(...a),
        recoverPublicNotesRange: (...a: any[]) => (globalThis as any).__off.clientRecoverPublicNotesRange(...a),
        sendPrivateNote: (...a: any[]) => (globalThis as any).__off.clientSendPrivateNote(...a),
        relayPrivateNoteById: (...a: any[]) => (globalThis as any).__off.clientRelayPrivateNoteById(...a),
        isOutputNoteConsumed: (...a: any[]) => (globalThis as any).__off.clientIsOutputNoteConsumed(...a),
        // The raw client the guardian leaf pipeline + slice-7a sync-height/lineage
        // reads drive directly.
        client: {
          feeFaucetId: jest.fn(async () => ({ toString: () => '0x817edea77acc5d71616e493afecea3' })),
          transactions: {
            executeRequest: (...a: any[]) => (globalThis as any).__off.guardianExecuteRequest(...a),
            submitProven: (proof: unknown, result: unknown) => G.__off.guardianSubmitProven(proof, result),
            // Follow-up #1: id-filtered transaction list the commit-wait poll loop reads.
            list: (...a: any[]) => {
              (globalThis as any).__off.listBuilds.push(build);
              return (globalThis as any).__off.clientTransactionsList(...a);
            }
          },
          // Follow-up #1: chain-only sync the commit-wait poll loop runs each iteration.
          syncChain: (...a: any[]) => (globalThis as any).__off.clientSyncChain(...a),
          getSyncHeight: (...a: any[]) => (globalThis as any).__off.clientGetSyncHeight(...a),
          sync: (...a: any[]) => (globalThis as any).__off.clientSync(...a),
          accounts: { get: (...a: any[]) => (globalThis as any).__off.clientAccountsGet(...a) },
          pswap: {
            lineage: (orderId: string) => G.__off.clientLineage(orderId),
            lineages: () => G.__off.clientLineages()
          }
        }
      };
      jest
        .requireActual('lib/miden/sdk/sync-and-record-fee-faucet')
        .bindFeeFaucetClientScope(instance.client, 'offscreen-rpc|devnet');
      return instance;
    })
  };
}

function installChromeMock() {
  capturedListener = undefined;
  G.chrome = {
    runtime: {
      // The Guardian leaf submits only once the service worker opens its submit gate (#1644).
      sendMessage: jest.fn((m?: { type?: string }) =>
        Promise.resolve(
          m?.type === OFFSCREEN_STORAGE_HEALTH
            ? { status: 'healthy', epoch: 0 }
            : m?.type === OFFSCREEN_SUBMIT_GATE
              ? { ok: true }
              : undefined
        )
      ),
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
  mockProveTransport.prove.mockClear();
  mockProveTransport.prewarm.mockClear();
  mockProveTransport.ctorCount = 0;
  G.__off.clientIsDisposed = false;
  G.__off.disposedBuilds = new Set<number>();
  G.__off.listBuilds = [];
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

describe('offscreen/main — OFFSCREEN_CALL dispatch (issue #260)', () => {
  const callReq = (extra: Record<string, unknown>) => ({
    target: 'offscreen',
    type: 'OFFSCREEN_CALL',
    op_id: 'op-abc',
    deadline_ms: 1000,
    argsB64: [],
    endpoints: SW_ENDPOINTS,
    ...extra
  });

  it('getInputNoteDetails maps a JSON-null query arg back to undefined for the SDK', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    // encodeArg(undefined) → 's:null'; decodeArg → null; dispatch does `?? undefined`.
    capturedListener!(callReq({ method: 'getInputNoteDetails', argsB64: [encodeArg(undefined)] }), {}, sendResponse);
    await flush();

    expect(G.__off.clientGetInputNoteDetails).toHaveBeenCalledWith(undefined, expect.any(Function));
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  // Both relays run on the SW client (`midenClientProxy`), so this realm no longer answers them.
  it.each([
    ['sendPrivateNote', [encodeArg(new Uint8Array([0xde, 0xad])), encodeArg('mtst1qrecipient')]],
    ['relayPrivateNoteById', [encodeArg('0xnote'), encodeArg('mtst1qrecipient')]]
  ])('answers %s as an unknown method, relaying nothing', async (method, argsB64) => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method, argsB64 }), {}, sendResponse);
    await flush();

    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'UNKNOWN_METHOD' });
    expect(G.__off.clientSendPrivateNote).not.toHaveBeenCalled();
    expect(G.__off.clientRelayPrivateNoteById).not.toHaveBeenCalled();
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
    const dto = {
      accountId: 'mtst1qacc',
      noteId: '0xn1',
      noteIds: ['0xn1', '0xn2'],
      delegateTransaction: false
    };
    const ret = capturedListener!(callReq({ method: 'consumeNoteId', argsB64: [encodeArg(dto)] }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    // The plain consume DTO decoded across the wire and drove the offscreen client.
    expect(G.__off.clientConsumeNoteId).toHaveBeenCalledWith(dto, expect.any(Function));
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
      extraInputs: {
        recallBlocks: 100,
        oneClick: {
          fundingDeadline: '2026-10-22T12:00:00.000Z',
          quote: { quote: { deadline: '2026-10-22T12:10:00.000Z' } }
        }
      }
    };
    const ret = capturedListener!(callReq({ method: 'sendTransaction', argsB64: [encodeArg(dto)] }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    // The DTO decoded across the wire; the string amount was re-widened to a BigInt
    // so the reconstructed row matches what the SDK reads on the SW-inline path.
    expect(G.__off.clientSendTransaction).toHaveBeenCalledTimes(1);
    expect(G.__off.clientSendTransaction).toHaveBeenCalledWith(expect.anything(), expect.any(Function));
    const receivedTx = G.__off.clientSendTransaction.mock.calls[0][0];
    expect(typeof receivedTx.amount).toBe('bigint');
    expect(receivedTx.amount).toBe(1000n);
    expect(receivedTx.accountId).toBe('mtst1qacc');
    expect(receivedTx.secondaryAccountId).toBe('mtst1qrecipient');
    expect(receivedTx.noteType).toBe('public');
    expect(receivedTx.extraInputs).toEqual({
      recallBlocks: 100,
      oneClick: {
        fundingDeadline: '2026-10-22T12:00:00.000Z',
        quote: { quote: { deadline: '2026-10-22T12:10:00.000Z' } }
      }
    });
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-abc');
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([11, 22, 33]);
  });

  it('sendTransaction: an evicted dispatch still serializes its result — post-submit is never guarded (#788)', async () => {
    // `client.sendTransaction` is execute→prove→submit→apply in one opaque call,
    // so when control returns here the transaction may already be broadcast.
    // Completing beats aborting past a possible submit — a hold re-check before
    // the serialize would abandon a write the network may have accepted — so this
    // dispatch deliberately has NONE. Pinned so a future guard sweep doesn't add
    // one.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    const serializeSpy = jest.fn(() => new Uint8Array([11, 22, 33]));
    let releaseWrite!: () => void;
    const parkedWrite = new Promise<void>(resolve => {
      releaseWrite = resolve;
    });
    G.__off.clientSendTransaction = jest.fn(async () => {
      await parkedWrite;
      return { serialize: serializeSpy };
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-send-evicted',
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

    miden.__evictHolder();
    releaseWrite();
    await flush();

    // The corpse finished its serialize; the SW was answered by the eviction's
    // poison classification, which is what tells it the submit may have landed.
    expect(serializeSpy).toHaveBeenCalledTimes(1);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.errorName).toBe('WasmClientPoisonedError');
  });

  // PR #524: the staged send's per-step stamps are the one thing the SW still needs
  // MID-flight, so they reverse across the bus tagged with the ambient op_id (the
  // same attribution the sign stub uses) instead of riding the final result.
  it('sendTransaction posts an OFFSCREEN_STAGE_EVENT (target sw + ambient op_id) per stage, fire-and-forget (PR #524)', async () => {
    await loadModule();
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      posted.push(m);
      return m?.type === OFFSCREEN_SUBMIT_GATE ? { ok: true } : undefined;
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

  // #1081: each write's 'submitting' stamp carries the evidence its leaf read, so the service worker can record what
  // the attempt was.
  it.each<[string, string[]]>([
    ['consumeNoteId', [encodeArg({ accountId: 'mtst1qacc', noteId: '0xn1', noteIds: ['0xn1'] })]],
    [
      'sendTransaction',
      [
        encodeArg({
          accountId: 'mtst1qacc',
          secondaryAccountId: 'mtst1qrecipient',
          faucetId: 'mtst1qfaucet',
          noteType: 'public',
          amount: '1',
          extraInputs: {}
        })
      ]
    ],
    [
      'swapTransaction',
      [
        encodeArg({
          accountId: 'mtst1qacc',
          faucetId: 'mtst1qoffered',
          amount: '1',
          extraInputs: { requestedFaucetId: 'mtst1qrequested', requestedAmount: '2' },
          swapFeeContext: {
            scope: 'testnet|queued-endpoint',
            nativeAssetId: 'mtst1qfee',
            feeFaucetId: null,
            baseFee: '7'
          }
        })
      ]
    ],
    ['newTransaction', [encodeArg('mtst1qacc'), encodeArg(new Uint8Array([1])), encodeArg(true)]]
  ])('%s posts its submitting stamp with the evidence the leaf read (#1081)', async (method, argsB64) => {
    await loadModule();
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      posted.push(m);
      return m?.type === OFFSCREEN_SUBMIT_GATE ? { ok: true } : undefined;
    });
    const leaf = jest.fn(async (...args: unknown[]) => {
      const onStage = args.find(arg => typeof arg === 'function');
      if (typeof onStage === 'function') await onStage('submitting', { evidence: { refBlock: 9 } });
      return { serialize: () => new Uint8Array([1]) };
    });
    const leaves: Record<string, string> = {
      consumeNoteId: 'clientConsumeNoteId',
      sendTransaction: 'clientSendTransaction',
      swapTransaction: 'clientSwapTransaction',
      newTransaction: 'clientNewTransaction'
    };
    G.__off[leaves[method]!] = leaf;
    const sendResponse = jest.fn();
    capturedListener!(callReq({ op_id: 'op-evidence', method, argsB64 }), {}, sendResponse);
    await flush();

    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'OFFSCREEN_STAGE_EVENT',
        op_id: 'op-evidence',
        stage: 'submitting',
        evidence: { refBlock: 9 }
      })
    );
  });

  it.each(['consumeNoteId', 'sendTransaction', 'swapTransaction', 'newTransaction'])(
    '%s waits for independent recovery ACK before its network submit',
    async method => {
      await loadModule();
      let acknowledge: ((reply: { ok: boolean }) => void) | undefined;
      G.chrome.runtime.sendMessage = jest.fn((message: { type?: string }) =>
        message.type === OFFSCREEN_SUBMIT_GATE
          ? new Promise<{ ok: boolean }>(resolve => {
              acknowledge = resolve;
            })
          : Promise.resolve(undefined)
      );
      const submitted = jest.fn();
      const leaf = async (...args: unknown[]) => {
        const onStage = args.find(arg => typeof arg === 'function');
        if (typeof onStage === 'function') await onStage('submitting', { evidence: { refBlock: 9 } });
        submitted();
        return { serialize: () => new Uint8Array([1]) };
      };
      const leaves: Record<string, string> = {
        consumeNoteId: 'clientConsumeNoteId',
        sendTransaction: 'clientSendTransaction',
        swapTransaction: 'clientSwapTransaction',
        newTransaction: 'clientNewTransaction'
      };
      G.__off[leaves[method]!] = leaf;
      const dto = {
        accountId: 'mtst1qacc',
        secondaryAccountId: 'mtst1qrecipient',
        noteId: '0xn1',
        noteIds: ['0xn1'],
        faucetId: 'mtst1qfaucet',
        noteType: 'public',
        amount: '1',
        extraInputs: { requestedFaucetId: 'mtst1qrequested', requestedAmount: '2' },
        swapFeeContext: {
          scope: 'testnet|queued-endpoint',
          nativeAssetId: 'mtst1qfee',
          feeFaucetId: null,
          baseFee: '7'
        }
      };
      const argsB64 =
        method === 'newTransaction'
          ? [encodeArg('mtst1qacc'), encodeArg(new Uint8Array([1])), encodeArg(true)]
          : [encodeArg(dto)];
      const sendResponse = jest.fn();
      capturedListener!(callReq({ op_id: 'op-recovery', method, argsB64 }), {}, sendResponse);
      await flush();
      expect(submitted).not.toHaveBeenCalled();
      expect(acknowledge).toBeDefined();
      acknowledge?.({ ok: false });
      await waitForReply(sendResponse);
      expect(submitted).not.toHaveBeenCalled();
      expect(sendResponse.mock.calls[0][0].ok).toBe(false);
    }
  );

  it('a stage-event post failure NEVER reaches the write (rejects and synchronous throws are both swallowed)', async () => {
    await loadModule();
    // Model both failure modes on the SAME channel the OP_STARTED signal uses: a
    // rejected promise (no SW receiver) and a synchronous throw (torn-down port).
    let call = 0;
    G.chrome.runtime.sendMessage = jest.fn((message: { type?: string }) => {
      if (message.type === OFFSCREEN_SUBMIT_GATE) return Promise.resolve({ ok: true });
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
    G.__off.readSwapFeeContext.mockResolvedValue({
      scope: 'testnet|queued-endpoint',
      nativeAssetId: 'mtst1qfee',
      feeFaucetId: null,
      baseFee: 7n
    });
    const dto = {
      accountId: 'mtst1qacc',
      faucetId: 'mtst1qoffered',
      amount: '500',
      delegateTransaction: false,
      extraInputs: {
        requestedFaucetId: 'mtst1qrequested',
        requestedAmount: '250',
        balanceScope: 'testnet|queued-endpoint'
      },
      swapFeeContext: {
        scope: 'testnet|queued-endpoint',
        nativeAssetId: 'mtst1qfee',
        feeFaucetId: null,
        baseFee: '7'
      }
    };
    const ret = capturedListener!(callReq({ method: 'swapTransaction', argsB64: [encodeArg(dto)] }), {}, sendResponse);
    expect(ret).toBe(true);
    await flush();

    expect(G.__off.readSwapFeeContext).toHaveBeenCalledWith('testnet|queued-endpoint');
    expect(G.__off.clientSwapTransaction).toHaveBeenCalledTimes(1);
    expect(G.__off.clientSwapTransaction).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
      scope: 'testnet|queued-endpoint',
      nativeAssetId: 'mtst1qfee',
      feeFaucetId: null,
      baseFee: 7n
    });
    const receivedTx = G.__off.clientSwapTransaction.mock.calls[0][0];
    // Offered amount AND requested amount both re-widened to BigInt.
    expect(receivedTx.amount).toBe(500n);
    expect(typeof receivedTx.extraInputs.requestedAmount).toBe('bigint');
    expect(receivedTx.extraInputs.requestedAmount).toBe(250n);
    expect(receivedTx.extraInputs.requestedFaucetId).toBe('mtst1qrequested');
    expect(receivedTx.extraInputs.balanceScope).toBe('testnet|queued-endpoint');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([44, 55, 66, 77]);
  });

  it('rejects swap submission when the protocol fee asset changed since the queued balance check', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    G.__off.readSwapFeeContext.mockResolvedValue({
      scope: 'testnet|queued-endpoint',
      nativeAssetId: 'mtst1qchanged-fee',
      feeFaucetId: null,
      baseFee: 7n
    });
    const dto = {
      accountId: 'mtst1qacc',
      faucetId: 'mtst1qoffered',
      amount: '500',
      delegateTransaction: false,
      extraInputs: {
        requestedFaucetId: 'mtst1qrequested',
        requestedAmount: '250',
        balanceScope: 'testnet|queued-endpoint'
      },
      swapFeeContext: {
        scope: 'testnet|queued-endpoint',
        nativeAssetId: 'mtst1qfee',
        feeFaucetId: null,
        baseFee: '7'
      }
    };

    capturedListener!(callReq({ method: 'swapTransaction', argsB64: [encodeArg(dto)] }), {}, sendResponse);
    await flush();

    expect(G.__off.assertSwapFeeContextMatches).toHaveBeenCalledWith(
      { scope: 'testnet|queued-endpoint', nativeAssetId: 'mtst1qfee', feeFaucetId: null, baseFee: 7n },
      { scope: 'testnet|queued-endpoint', nativeAssetId: 'mtst1qchanged-fee', feeFaucetId: null, baseFee: 7n },
      'testnet|queued-endpoint'
    );
    expect(G.__off.clientSwapTransaction).not.toHaveBeenCalled();
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, error: 'swapBalanceUnavailable' });
  });

  it('rejects swap submission when offscreen fee discovery is older than the queued fee', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    G.__off.readSwapFeeContext.mockResolvedValue({
      scope: 'testnet|queued-endpoint',
      nativeAssetId: 'mtst1qfee',
      feeFaucetId: null,
      baseFee: 5n
    });
    const dto = {
      accountId: 'mtst1qacc',
      faucetId: 'mtst1qoffered',
      amount: '500',
      delegateTransaction: false,
      extraInputs: {
        requestedFaucetId: 'mtst1qrequested',
        requestedAmount: '250',
        balanceScope: 'testnet|queued-endpoint'
      },
      swapFeeContext: {
        scope: 'testnet|queued-endpoint',
        nativeAssetId: 'mtst1qfee',
        feeFaucetId: null,
        baseFee: '7'
      }
    };

    capturedListener!(callReq({ method: 'swapTransaction', argsB64: [encodeArg(dto)] }), {}, sendResponse);
    await flush();

    expect(G.__off.clientSwapTransaction).not.toHaveBeenCalled();
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, error: 'swapBalanceUnavailable' });
  });

  it.each(['sendTransaction', 'swapTransaction', 'consumeNoteId', 'newTransaction'])(
    '%s: a result that cannot serialize after the submit replies untagged (#1081)',
    async method => {
      await loadModule();
      const unserializable = {
        serialize: () => {
          throw new Error('serialize failed');
        }
      };
      G.__off.clientSendTransaction = jest.fn(async () => unserializable);
      G.__off.clientSwapTransaction = jest.fn(async () => unserializable);
      G.__off.clientConsumeNoteId = jest.fn(async () => unserializable);
      G.__off.clientNewTransaction = jest.fn(async () => unserializable);
      const sendResponse = jest.fn();
      const args: Record<string, unknown[]> = {
        sendTransaction: [
          {
            accountId: 'a',
            secondaryAccountId: 'b',
            faucetId: 'f',
            noteType: 'public',
            amount: '1',
            extraInputs: {}
          }
        ],
        swapTransaction: [
          {
            accountId: 'a',
            faucetId: 'f',
            amount: '1',
            extraInputs: { requestedFaucetId: 'g', requestedAmount: '2' },
            swapFeeContext: {
              scope: 'testnet|queued-endpoint',
              nativeAssetId: 'mtst1qfee',
              feeFaucetId: null,
              baseFee: '7'
            }
          }
        ],
        consumeNoteId: [{ accountId: 'a', noteId: 'n', noteIds: ['n'] }],
        newTransaction: ['a', new Uint8Array([1]), false]
      };
      capturedListener!(callReq({ method, argsB64: args[method]!.map(encodeArg) }), {}, sendResponse);
      await flush();
      expect(sendResponse.mock.calls[0][0].ok).toBe(false);
      expect(sendResponse.mock.calls[0][0].errorBeforeSubmit).toBeUndefined();
    }
  );

  it.each(['sendTransaction', 'swapTransaction'])(
    '%s: an amount that cannot decode replies tagged, before the leaf runs (#1081)',
    async method => {
      await loadModule();
      const sendResponse = jest.fn();
      const dtos: Record<string, object> = {
        sendTransaction: {
          accountId: 'a',
          secondaryAccountId: 'b',
          faucetId: 'f',
          noteType: 'public',
          amount: 'not-a-number',
          extraInputs: {}
        },
        swapTransaction: {
          accountId: 'a',
          faucetId: 'f',
          amount: '1',
          extraInputs: { requestedFaucetId: 'g', requestedAmount: 'not-a-number' },
          swapFeeContext: {
            scope: 'testnet|queued-endpoint',
            nativeAssetId: 'mtst1qfee',
            feeFaucetId: null,
            baseFee: '7'
          }
        }
      };
      capturedListener!(callReq({ method, argsB64: [encodeArg(dtos[method])] }), {}, sendResponse);
      await flush();
      expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, errorBeforeSubmit: true });
      const leaves: Record<string, jest.Mock> = {
        sendTransaction: G.__off.clientSendTransaction,
        swapTransaction: G.__off.clientSwapTransaction
      };
      expect(leaves[method]).not.toHaveBeenCalled();
    }
  );

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
      callReq({
        method: 'consumeNoteId',
        argsB64: [encodeArg({ accountId: 'a', noteId: 'n', noteIds: ['n'] })]
      }),
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

  it.each([
    [
      'the client build',
      () => {
        G.__off.getMidenClient = jest.fn(async () => {
          throw new Error('genesis fetch failed');
        });
      },
      [encodeArg('a'), encodeArg(new Uint8Array([1])), encodeArg(false)],
      'genesis fetch failed'
    ],
    [
      'init',
      () => {
        G.__off.getWasmOrThrow = jest.fn(async () => {
          throw new Error('wasm load failed');
        });
      },
      [encodeArg('a'), encodeArg(new Uint8Array([1])), encodeArg(false)],
      'wasm load failed'
    ],
    ['the argument decode', () => {}, ['x:not-an-encoded-argument'], 'unrecognized argument tag']
  ])('a failure in %s, before any leaf runs, replies tagged (#1081)', async (_step, arrange, argsB64, reason) => {
    arrange();
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'newTransaction', argsB64 }), {}, sendResponse);
    await flush();
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, errorBeforeSubmit: true });
    expect(sendResponse.mock.calls[0][0].error).toContain(reason);
    expect(G.__off.clientNewTransaction).not.toHaveBeenCalled();
  });

  // ─── Slice 6a: guardianPipeline (the guardian write LEAF pipeline) ──────────
  it('guardianPipeline sends only closed observations from the exact executed request on rejection', async () => {
    await loadModule();
    const original = new Error('ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH private 0xabcdef');
    G.__off.guardianExecuteRequest.mockRejectedValueOnce(original);
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'execution-diagnostic-op',
        method: 'guardianPipeline',
        argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1, 2, 3, 4])), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await flush();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      op_id: 'execution-diagnostic-op',
      errorTransactionExecution: {
        executionRoute: 'guardian_signed_request',
        authObservation: 'observed',
        authArgPresence: 'absent',
        authLayout: 'absent',
        commitmentMatch: 'unavailable',
        accountAuthCode: 'unavailable'
      }
    });
    expect(G.__off.deserializeTxRequest).toHaveBeenCalledTimes(1);
    expect(G.__off.guardianExecuteRequest.mock.calls[0]?.[1]).toBe(G.__off.deserializeTxRequest.mock.results[0]?.value);
    expect(G.__off.guardianSubmitted).toBe(false);
  });

  it('guardianPipeline: deserializes the co-signed request, proves in the prove worker, submits the proof and applies', async () => {
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
    expect(tr).toEqual(expect.objectContaining({ __trFromBytes: [1, 2, 3, 4] }));
    // Non-delegated: prewarmed at entry, proved once in the worker from the exact
    // serialized result, and never proved on this document's thread (#945).
    expect(mockProveTransport.prewarm).toHaveBeenCalledTimes(1);
    expect(mockProveTransport.prove).toHaveBeenCalledTimes(1);
    expect(mockProveTransport.prove.mock.calls[0]?.[0]).toEqual({ txResult: new Uint8Array([55, 66, 77]) });
    expect(G.__off.guardianProveCalls).toEqual([]);
    expect(G.__off.newLocalProver).not.toHaveBeenCalled();
    const executed = await G.__off.guardianExecuteRequest.mock.results[0].value;
    expect(G.__off.guardianSubmitProven).toHaveBeenCalledWith({ __proofFromBytes: [1, 2, 3] }, executed.result);
    // submit + apply both ran in-realm.
    expect(G.__off.guardianSubmitted).toBe(true);
    expect(G.__off.guardianApplied).toBe(true);
    // Only the serialized TransactionResult (executedTx.result) crossed back.
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-g');
    expect(Array.from(Buffer.from(resp.resultB64, 'base64'))).toEqual([55, 66, 77]);
  });

  it('guardianPipeline: refuses an expired 1Click quote after proving and before submit', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-g-expired',
        method: 'guardianPipeline',
        argsB64: [
          encodeArg('mtst1qguardian'),
          encodeArg(new Uint8Array([1, 2, 3, 4])),
          encodeArg(false),
          encodeArg(null),
          encodeArg('2000-01-01T00:00:00.000Z'),
          encodeArg(true)
        ]
      }),
      {},
      sendResponse
    );
    await flush();

    expect(mockProveTransport.prove).toHaveBeenCalledTimes(1);
    expect(G.__off.guardianSubmitProven).not.toHaveBeenCalled();
    expect(G.__off.guardianSubmitted).not.toBe(true);
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, errorBeforeSubmit: true });
    expect(sendResponse.mock.calls[0][0].error).toContain('expired');
  });

  it('guardianPipeline: stops before proving when the hold is evicted during executeRequest (#777)', async () => {
    // `executeRequest` is a network round trip on the NORMAL ceiling — the pause
    // brackets in this pipeline cover proving, not this — so a node that accepts and
    // never answers is evicted here. An eviction abandons the callback rather than
    // stopping it, so what resumes would prove and submit with no mutex held,
    // alongside the successor that legitimately holds it. Both checks sit at points
    // that are provably pre-submit, so refusing cannot orphan a broadcast tx.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    let releaseExecute!: () => void;
    const parkedExecute = new Promise<void>(resolve => {
      releaseExecute = resolve;
    });
    const realExecute = G.__off.guardianExecuteRequest;
    G.__off.guardianExecuteRequest = jest.fn(async (...args: unknown[]) => {
      await parkedExecute;
      return realExecute(...args);
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-g-evicted',
        method: 'guardianPipeline',
        argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await flush();

    miden.__evictHolder();
    releaseExecute();
    await flush();

    // Nothing proved, nothing submitted, nothing applied.
    expect(G.__off.newLocalProver).not.toHaveBeenCalled();
    expect(mockProveTransport.prove).not.toHaveBeenCalled();
    expect(G.__off.guardianSubmitted).toBe(false);
    expect(G.__off.guardianApplied).toBe(false);
    expect(sendResponse.mock.calls[0][0].ok).toBe(false);
  });

  it('guardianPipeline: stops before SUBMIT when the hold is evicted during the worker prove (#777, #945)', async () => {
    // The prove is the longest await in the pipeline, and with the worker the
    // watchdog can fire while it runs, so the check after it is the last thing
    // between an abandoned pipeline and an irreversible broadcast.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    let releaseProve!: () => void;
    mockProveTransport.prove.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseProve = () => resolve({ proven: new Uint8Array([1]), durationMs: 1 });
        })
    );

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-g-evicted-prove',
        method: 'guardianPipeline',
        argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await flush();
    expect(mockProveTransport.prove).toHaveBeenCalledTimes(1);

    miden.__evictHolder();
    releaseProve();
    await flush();

    expect(G.__off.guardianSubmitProven).not.toHaveBeenCalled();
    expect(G.__off.guardianSubmitted).toBe(false);
    expect(G.__off.guardianApplied).toBe(false);
    expect(sendResponse.mock.calls[0][0].ok).toBe(false);
  });

  it('guardianPipeline: an eviction cancels the worker prove, and the abandoned dispatch fails as poisoned (#945)', async () => {
    // The reply is the waiter's, which the eviction settles first, so only the
    // abandoned dispatch itself can say the cancel reached it as poison.
    await loadModule();
    const miden = jest.requireMock<
      typeof import('lib/miden/sdk/miden-client') & {
        __evictHolder: () => void;
        __lastRunning: () => Promise<unknown> | null;
      }
    >('lib/miden/sdk/miden-client');
    // A worker that answers only through the cancel, as the real client does on an eviction.
    mockProveTransport.prove.mockImplementationOnce(async (_request, options) => {
      const cancel: unknown = options && Reflect.get(options, 'cancel');
      if (cancel instanceof Promise) await cancel;
      throw new Error('no cancel reached the transport');
    });

    capturedListener!(
      callReq({
        op_id: 'op-g-cancelled-prove',
        method: 'guardianPipeline',
        argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      jest.fn()
    );
    await flush();
    expect(mockProveTransport.prove).toHaveBeenCalledTimes(1);
    const dispatch = miden.__lastRunning();

    miden.__evictHolder();
    const abandoned = await dispatch?.catch((caught: unknown) => caught);

    expect(abandoned).toHaveProperty('name', 'WasmClientPoisonedError');
    expect(G.__off.guardianSubmitProven).not.toHaveBeenCalled();
  });

  it('guardianPipeline (delegated): stops before SUBMIT when the hold is evicted during the delegated prove (#777, #945)', async () => {
    // The delegated leg never touches the prove worker, so the helper's own
    // post-prove check cannot cover it: the pipeline's own
    // `assertWasmHoldCurrent(hold, 'in the guardian pipeline before submit')` is
    // the ONLY guard standing between an eviction during this leg's longest
    // await and an irreversible broadcast.
    await loadModule();
    const miden = jest.requireMock<typeof import('lib/miden/sdk/miden-client') & { __evictHolder: () => void }>(
      'lib/miden/sdk/miden-client'
    );
    let releaseProve!: () => void;
    const parkedProve = new Promise<void>(resolve => {
      releaseProve = resolve;
    });
    // The prove lives inside the executeRequest handle, so it is parked by
    // substituting the handle rather than by a top-level spy.
    G.__off.guardianExecuteRequest = jest.fn(async () => ({
      result: {
        serialize: () => new Uint8Array([55, 66, 77]),
        executedTransaction: () => ({ inputNotes: () => ({ notes: () => [] }), userOutputNotes: () => [] })
      },
      id: { toHex: () => 'guardian-exec-hash' },
      prove: jest.fn(async () => {
        await parkedProve;
        return {
          submit: jest.fn(async () => {
            G.__off.guardianSubmitted = true;
            return { apply: jest.fn(async () => void (G.__off.guardianApplied = true)) };
          })
        };
      })
    }));

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-g-evicted-prove-delegated',
        method: 'guardianPipeline',
        argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([1])), encodeArg(true)]
      }),
      {},
      sendResponse
    );
    await flush();

    miden.__evictHolder();
    releaseProve();
    await flush();

    expect(G.__off.guardianSubmitted).toBe(false);
    expect(G.__off.guardianApplied).toBe(false);
    expect(sendResponse.mock.calls[0][0].ok).toBe(false);
  });
});
