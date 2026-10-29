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
import { GuardianHistoryDataError } from 'lib/miden/guardian/history-errors';

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

  it('permits only the same-extension named recovery read while ordinary dispatch remains blocked', async () => {
    await loadModule();
    G.chrome.runtime.id = 'wallet-extension';
    const health = await import('lib/miden/storage-health');
    const { MidenClientInterface } = jest.requireMock('lib/miden/sdk/miden-client-interface');
    const snapshot = {
      generation: 'sdk-1',
      accounts: [{ accountId: 'account-1', nonce: '1', commitment: 'state-1' }],
      notes: []
    };
    const read = jest.fn(async () => snapshot);
    MidenClientInterface.createForRecovery = jest.fn(
      async (capability: import('lib/miden/storage-health').StorageRecoveryCapability) => {
        health.assertStorageRecoveryAllowed(capability);
        return { readStorageContinuity: read };
      }
    );
    health.markStorageUnavailable('continuity', { backend: 'sdk', operation: 'validate' });
    const request = () =>
      callReq({
        method: 'readStorageContinuity',
        argsB64: [encodeArg(['account-1']), encodeArg(false)],
        recoveryAccess: { epoch: health.getStorageHealth().epoch, expiresAt: Date.now() + 1000 }
      });
    const refused = jest.fn();
    capturedListener!(request(), { id: 'another-extension' }, refused);
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'Unauthorized recovery read' }));
    for (let i = 0; i < 2; i++) {
      const response = jest.fn();
      capturedListener!(request(), { id: 'wallet-extension' }, response);
      await flush();
      expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    }
    expect(MidenClientInterface.createForRecovery).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(health.getStorageHealth().status).toBe('unavailable');
    const ordinary = jest.fn();
    capturedListener!(callReq({ method: 'getAccount', argsB64: [encodeArg('account-1')] }), {}, ordinary);
    await flush();
    expect(ordinary).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(G.__off.clientGetAccount).not.toHaveBeenCalled();
  });

  it('rejects a recovery permission attached to a mutating dispatch', async () => {
    await loadModule();
    G.chrome.runtime.id = 'wallet-extension';
    const response = jest.fn();
    capturedListener!(
      callReq({ method: 'syncState', recoveryAccess: { epoch: 0, expiresAt: Date.now() + 1000 } }),
      { id: 'wallet-extension' },
      response
    );
    await flush();
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(G.__off.clientSyncState).not.toHaveBeenCalled();
  });

  it('passes only a validated recovery command with a live capability and hold to the client', async () => {
    await loadModule();
    G.chrome.runtime.id = 'wallet-extension';
    const health = await import('lib/miden/storage-health');
    const { MidenClientInterface } = jest.requireMock('lib/miden/sdk/miden-client-interface');
    const restored: unknown[] = [];
    MidenClientInterface.createForRecovery = jest.fn(async () => ({
      restoreStorageRecovery: async (
        command: unknown,
        capability: import('lib/miden/storage-health').StorageRecoveryCapability,
        assertLive: () => void
      ) => {
        health.assertStorageRecoveryAllowed(capability);
        assertLive();
        restored.push(command);
      }
    }));
    health.markStorageUnavailable('continuity', { backend: 'sdk', operation: 'validate' });
    const command = { kind: 'generation', generation: 'retained-sdk' };
    const request = (expiresAt: number, value: unknown) =>
      callReq({
        method: 'restoreStorageRecovery',
        argsB64: [encodeArg(value)],
        recoveryAccess: { epoch: health.getStorageHealth().epoch, expiresAt }
      });
    const response = jest.fn();
    capturedListener!(request(Date.now() + 1000, command), { id: 'wallet-extension' }, response);
    await flush();
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(restored).toEqual([command]);
    const expired = jest.fn();
    capturedListener!(request(Date.now() - 1, command), { id: 'wallet-extension' }, expired);
    await flush();
    expect(expired).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    const malformed = jest.fn();
    capturedListener!(
      request(Date.now() + 1000, { kind: 'generation', generation: 'x'.repeat(129) }),
      { id: 'wallet-extension' },
      malformed
    );
    await flush();
    expect(malformed).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(restored).toEqual([command]);
    expect(health.getStorageHealth().status).toBe('unavailable');
  });

  it.each<import('lib/miden/recovery/sdk-restore').SdkRecoveryCommand>([
    { kind: 'generation', generation: 'retained-sdk' },
    {
      kind: 'account',
      material: {
        floor: { accountId: 'retained-account', nonce: '4', commitment: 'state-4' },
        accountBytes: new Uint8Array([1, 2, 3]),
        guardianCommitment: 'guardian-commitment',
        signerCommitments: ['signer-commitment'],
        chainCommitment: 'state-4'
      }
    }
  ])('Task4C3N3 restores $kind through the encoded absent receipt slot', async command => {
    await loadModule();
    G.chrome.runtime.id = 'wallet-extension';
    const health = await import('lib/miden/storage-health');
    const { toSerializable } = await import('lib/miden/recovery/serialization');
    const { MidenClientInterface } = jest.requireMock('lib/miden/sdk/miden-client-interface');
    const restored: unknown[] = [];
    MidenClientInterface.createForRecovery = jest.fn(async () => ({
      restoreStorageRecovery: async (
        value: unknown,
        capability: import('lib/miden/storage-health').StorageRecoveryCapability,
        assertLive: () => void
      ) => {
        health.assertStorageRecoveryAllowed(capability);
        assertLive();
        restored.push(value);
      }
    }));
    health.markStorageUnavailable('continuity', { backend: 'sdk', operation: 'validate' });
    const incident = health.getStorageHealth();
    const response = jest.fn();
    capturedListener!(
      callReq({
        method: 'restoreStorageRecovery',
        argsB64: [encodeArg(toSerializable(command)), encodeArg(undefined)],
        recoveryAccess: { epoch: incident.epoch, expiresAt: Date.now() + 1000 }
      }),
      { id: 'wallet-extension' },
      response
    );
    await flush();
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(restored).toEqual([command]);
    expect(G.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OFFSCREEN_NOTE_ACQUISITION' })
    );
    expect(health.getStorageHealth()).toEqual(incident);
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

  it('abandons a call evicted while its client was still building, before touching the ambient id (#777)', async () => {
    // The build is a parking await INSIDE the hold, and its eager genesis fetch goes
    // to the very node a `syncState` dispatch is now bounded against — so an eviction
    // here is reachable, not theoretical. What resumes is worse than an unmutexed WASM
    // call: `currentOpId` and `reassertCurrentOpId` are AMBIENT, so a corpse would
    // overwrite the successor's, routing the successor's mid-execute sign to the
    // corpse's callbacks and deadline, and then null the id on its own way out.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      posted.push(m);
      return undefined;
    });

    const buildClient = G.__off.getMidenClient;
    let releaseBuild!: () => void;
    const parkedBuild = new Promise<void>(resolve => {
      releaseBuild = resolve;
    });
    G.__off.getMidenClient = jest.fn(async (...args: unknown[]) => {
      await parkedBuild;
      return buildClient(...args);
    });

    const sendResponse = jest.fn();
    capturedListener!(callReq({ op_id: 'op-evicted-in-build', method: 'syncState', argsB64: [] }), {}, sendResponse);
    await flush();
    // Parked in the build, holding the lock, having touched nothing yet.
    expect(posted.find(m => m?.type === 'OFFSCREEN_OP_STARTED')).toBeUndefined();

    miden.__evictHolder();
    releaseBuild();
    await flush();

    // The response comes from the EVICTION itself — the lock's rejection wins the
    // race, so this call is answered before the parked build even resolves. Asserted
    // to pin the classification the SW's kill rails read; the guard's own contribution
    // is the two assertions below it.
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.errorName).toBe('WasmClientPoisonedError');
    expect(posted.find(m => m?.type === 'OFFSCREEN_OP_STARTED')).toBeUndefined();
    expect(G.__off.clientSyncState).not.toHaveBeenCalled();
  });

  it('getAccount: refuses to serialize the account read before an eviction (#788)', async () => {
    // The Account the read returns is a borrow of the shared client's RefCell, not
    // a snapshot — so when an eviction during the read hands the mutex to a
    // successor, the abandoned dispatch's `serialize()` would be a second borrow
    // alongside whatever the successor is doing. The guard must stop this
    // read-only dispatch at its first post-await WASM touch.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    const serializeSpy = jest.fn(() => new Uint8Array([10, 20, 30]));
    let releaseRead!: () => void;
    const parkedRead = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    G.__off.clientGetAccount = jest.fn(async () => {
      await parkedRead;
      return { serialize: serializeSpy };
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ op_id: 'op-acc-evicted', method: 'getAccount', argsB64: [encodeArg('mtst1qqaccount')] }),
      {},
      sendResponse
    );
    await flush();

    miden.__evictHolder();
    releaseRead();
    await flush();

    // The corpse never touched the account it was handed; the SW-side answer is the
    // eviction's own poison classification.
    expect(serializeSpy).not.toHaveBeenCalled();
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.errorName).toBe('WasmClientPoisonedError');
  });

  // The same guard for the reads whose reach-through happens one frame
  // deeper, INSIDE `MidenClientInterface`, where the dispatch cannot place a
  // check either side of it: `exportNote` serializes the live export result,
  // `getInputNoteDetails` and `getDetailsCommitmentMatches` reduce live records, and `getConsumableNoteDtos`
  // makes a second shared-client call (`getSyncHeight`) after the listing's
  // await. Each is handed a liveness callback, and these dispatches used to be
  // marked `_context` — the reach-through was simply unguarded.
  //
  // The assertion is on the CALLBACK, not just its presence: a dispatch that
  // passes a function which never throws satisfies `expect.any(Function)` and
  // guards nothing.
  it.each([
    ['exportNote', 'clientExportNote', ['note-x', 'Details'], undefined, 'in offscreen'],
    ['getInputNoteDetails', 'clientGetInputNoteDetails', [{ ids: ['0xabc'] }], undefined, 'in offscreen'],
    [
      'getDetailsCommitmentMatches',
      'clientGetDetailsCommitmentMatches',
      [['0xcommitment'], ['0xreal']],
      undefined,
      'in offscreen'
    ],
    // The consumability read names each of its checks; the dispatch forwards that step into its own label.
    [
      'getConsumableNotes',
      'clientGetConsumableNoteDtos',
      ['mtst1qqaccount'],
      'after the reader build',
      'in offscreen getConsumableNotes, after the reader build'
    ]
  ] as const)(
    '%s: hands the interface a liveness check that refuses after an eviction (#788)',
    async (method, clientFn, args, step, expected) => {
      await loadModule();
      const miden: any = await import('lib/miden/sdk/miden-client');
      let assertLive!: (step?: string) => void;
      let releaseRead!: () => void;
      const parkedRead = new Promise<void>(resolve => {
        releaseRead = resolve;
      });
      G.__off[clientFn] = jest.fn(async (...called: unknown[]) => {
        assertLive = called[called.length - 1] as (step?: string) => void;
        await parkedRead;
        return [];
      });

      const sendResponse = jest.fn();
      capturedListener!(
        callReq({ op_id: `op-${method}-evicted`, method, argsB64: args.map(encodeArg) }),
        {},
        sendResponse
      );
      await flush();

      expect(G.__off[clientFn]).toHaveBeenCalledWith(...args, expect.any(Function));

      // While the hold is still ours the check is silent — the falsifier for the
      // throw below, which would otherwise pass against a callback that always
      // throws and guards nothing either.
      expect(() => assertLive()).not.toThrow();

      miden.__evictHolder();
      let thrown: unknown;
      try {
        assertLive(step);
      } catch (e) {
        thrown = e;
      }
      // The poison class, so the SW's kill classifiers read it as an abandonment
      // rather than an ordinary failure; the site names itself on the `cause`.
      expect((thrown as Error)?.name).toBe('WasmClientPoisonedError');
      expect(((thrown as Error).cause as Error).message).toContain(expected);

      releaseRead();
      await flush();
      expect(sendResponse.mock.calls[0][0].ok).toBe(false);
    }
  );

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

  it('imports a recovered P2IDE output under the offscreen WASM lock', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'importGuardianHistoryP2ideNotes',
        argsB64: ['summary', 'account', 'note'].map(encodeArg)
      }),
      {},
      sendResponse
    );
    await flush();
    expect(G.__off.clientImportGuardianHistoryP2ideNotes).toHaveBeenCalledWith(
      'summary',
      'account',
      'note',
      expect.anything()
    );
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: true, resultB64: null });
  });

  it('names a history data error on the ok:false reply, so the SW rebuilds its class', async () => {
    await loadModule();
    let liveHold: unknown;
    G.__off.clientDecodeGuardianHistory = jest.fn(async () => {
      liveHold = jest.requireMock('lib/miden/sdk/miden-client').getCurrentWasmLockHold();
      throw new GuardianHistoryDataError('Guardian summary is too large');
    });
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'decodeGuardianHistory', argsB64: [encodeArg('summary')] }), {}, sendResponse);
    await flush();

    expect(liveHold).toBeDefined();
    expect(G.__off.clientDecodeGuardianHistory).toHaveBeenCalledWith('summary', liveHold);
    expect(sendResponse.mock.calls[0][0]).toMatchObject({
      ok: false,
      op_id: 'op-abc',
      errorName: 'GuardianHistoryDataError',
      error: 'Guardian summary is too large'
    });
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

  it('a try-lock account read answers busy while the offscreen mutex is held, and the account when it is free', async () => {
    await loadModule();
    const miden = await import('lib/miden/sdk/miden-client');
    let releaseHolder!: () => void;
    const held = miden.withWasmClientLock(
      () =>
        new Promise<void>(resolve => {
          releaseHolder = resolve;
        })
    );
    await flush();
    const busyResponse = jest.fn();
    capturedListener!(
      callReq({ op_id: 'fee-busy', method: 'tryGetAccount', argsB64: [encodeArg('fee-account')] }),
      {},
      busyResponse
    );
    await flush();
    const repliesWhileHeld = busyResponse.mock.calls.map(([reply]) => reply);
    const wasHeld = miden.isWasmClientBusy();
    const accountReadsWhileHeld = G.__off.clientGetAccount.mock.calls.length;
    const clientBuildsWhileHeld = G.__off.getMidenClient.mock.calls.length;
    releaseHolder();
    await held;
    await flush();

    expect(repliesWhileHeld).toEqual([
      expect.objectContaining({
        ok: true,
        op_id: 'fee-busy',
        resultB64: Buffer.from(JSON.stringify({ ran: false })).toString('base64')
      })
    ]);
    expect(wasHeld).toBe(true);
    expect(accountReadsWhileHeld).toBe(0);
    expect(clientBuildsWhileHeld).toBe(0);

    const freeResponse = jest.fn();
    capturedListener!(
      callReq({ op_id: 'fee-free', method: 'tryGetAccount', argsB64: [encodeArg('fee-account')] }),
      {},
      freeResponse
    );
    await flush();

    expect(freeResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        op_id: 'fee-free',
        resultB64: Buffer.from(
          JSON.stringify({ ran: true, accountB64: Buffer.from([10, 20, 30]).toString('base64') })
        ).toString('base64')
      })
    );
    expect(G.__off.clientGetAccount).toHaveBeenCalledWith('fee-account');
    expect(miden.isWasmClientBusy()).toBe(false);
  });

  it('bounds a syncState dispatch at the sync ceiling, and leaves the writes on the default (#777)', async () => {
    // The service worker's 30s `withTimeout` bounds its OWN promise, not this hold.
    // A node that accepts SyncChainMmr and never answers held this realm's mutex — the
    // one every send and claim queues behind — until the five-minute last resort, with
    // the SW having discarded the answer four and a half minutes earlier.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    const before = miden.lockOptionsSeen.length;

    capturedListener!(callReq({ op_id: 'sync-op', method: 'syncState', argsB64: [] }), {}, jest.fn());
    await flush();
    capturedListener!(
      callReq({ op_id: 'export-op', method: 'exportNote', argsB64: [encodeArg('n'), encodeArg('Details')] }),
      {},
      jest.fn()
    );
    await flush();

    const [syncOptions, exportOptions] = miden.lockOptionsSeen.slice(before);
    expect(syncOptions).toEqual({ watchdogMs: 120_000, label: 'offscreen-sync' });
    // A write is legitimately long — it signs and proves, and carries its own
    // deadline — so it stays on the default ceiling.
    expect(exportOptions).toBeUndefined();
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

  it.each(['RuntimeError', 'WasmClientPoisonedError'])(
    'commit-wait stops before listing transactions after a direct syncChain %s',
    async errorName => {
      await loadModule();
      const { WasmClientPoisonedError } = jest.requireActual('lib/miden/sdk/wasm-client-poison');
      const error =
        errorName === 'RuntimeError'
          ? new WebAssembly.RuntimeError('sync trapped')
          : new WasmClientPoisonedError('watchdog');
      G.__off.clientSyncChain.mockRejectedValueOnce(error);
      const reply = jest.fn();
      capturedListener!(callReq({ method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }), {}, reply);
      await flush();
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply.mock.calls[0]?.[0]).toMatchObject({ ok: false, errorName });
      expect(G.__off.clientSyncChain).toHaveBeenCalledTimes(1);
      expect(G.__off.clientTransactionsList).not.toHaveBeenCalled();
    }
  );

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

      // Advance through the 1 s inter-poll sleeps until the commit is observed.
      for (let i = 0; i < 6 && sendResponse.mock.calls.length === 0; i++) {
        // eslint-disable-next-line no-await-in-loop
        await jest.advanceTimersByTimeAsync(1_000);
      }

      expect(G.__off.clientTransactionsList).toHaveBeenCalledTimes(3);
      const resp = sendResponse.mock.calls[0][0];
      expect(resp.ok).toBe(true);
      expect(resp.resultB64).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  // The first check runs straight after submit, before any block, so a 5 s sleep ended nearly every wait on its
  // second check, about 5 s in, however soon the block came (#1492).
  it('commit-wait checks again one second after a pending check (#1492)', async () => {
    await loadModule();
    jest.useFakeTimers();
    try {
      G.__off.clientTransactionsList = jest
        .fn()
        .mockResolvedValueOnce([G.__off.pendingStatus])
        .mockResolvedValue([G.__off.committedStatus]);

      const sendResponse = jest.fn();
      capturedListener!(
        callReq({ method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        sendResponse
      );
      for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(0);
      expect(G.__off.clientTransactionsList).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(999);
      expect(G.__off.clientTransactionsList).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(0);
      expect(G.__off.clientTransactionsList).toHaveBeenCalledTimes(2);
      expect(sendResponse).toHaveBeenCalledTimes(1);
      expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: true, resultB64: null });
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

      // 60 s / 1 s = 60 sleeps before the timeout check throws.
      for (let i = 0; i < 65 && sendResponse.mock.calls.length === 0; i++) {
        // eslint-disable-next-line no-await-in-loop
        await jest.advanceTimersByTimeAsync(1_000);
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
      await jest.advanceTimersByTimeAsync(1_000);
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
      await jest.advanceTimersByTimeAsync(1_000);
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
    // loop - the corpse keeps polling every second for up to a minute. Re-asserting
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

  it('an EVICTED commit-wait stops making WASM calls entirely, not just re-stamping its id (#775)', async () => {
    // Once the hold is stale the yield no longer touches the mutex, so every
    // remaining lap ran `syncChain` + `transactions.list` with NO mutex held, right
    // alongside the successor that legitimately holds it — the concurrent-access
    // crash the mutex exists to prevent, for up to a minute after nobody is left
    // awaiting the result.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    jest.useFakeTimers();
    try {
      let releasePoll!: () => void;
      const firstPoll = new Promise<void>(resolve => {
        releasePoll = resolve;
      });
      let polls = 0;
      G.__off.clientTransactionsList = jest.fn(async () => {
        if (++polls === 1) await firstPoll;
        return [G.__off.pendingStatus];
      });

      const r1 = jest.fn();
      capturedListener!(
        callReq({ op_id: 'op1-evicted', method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        r1
      );
      await jest.advanceTimersByTimeAsync(0);

      miden.__evictHolder();
      for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(0);
      expect(r1.mock.calls[0][0].ok).toBe(false);

      // A successor takes the freed lock and holds it across the whole window.
      let releaseSuccessor!: (v: unknown) => void;
      G.__off.clientConsumeNoteId = jest.fn(
        () =>
          new Promise(resolve => {
            releaseSuccessor = resolve;
          })
      );
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

      const syncsBefore = G.__off.clientSyncChain.mock.calls.length;
      releasePoll();
      await jest.advanceTimersByTimeAsync(30_000);

      // The corpse ran its parked poll to completion and then stopped: no further
      // laps, at a second apiece across 30 s.
      expect(polls).toBe(1);
      expect(G.__off.clientSyncChain.mock.calls.length).toBe(syncsBefore);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('abandoning a confirmation poll'));

      releaseSuccessor({ serialize: () => new Uint8Array([9]) });
      await jest.advanceTimersByTimeAsync(0);
      expect(r2.mock.calls[0][0].ok).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a LIVE commit-wait whose client is replaced under it rebuilds and keeps polling (#775)', async () => {
    // The other half of the same guard, and the half that is observable — but NOT the
    // same situation. The hold is still ours, so nobody else is in the client; what
    // happened is that an interloper op which took the mutex during one of our sleeps
    // was evicted, replacing the singleton. Abandoning here threw away a structural
    // guardian confirmation — whose rotation may already be on chain — over somebody
    // else's eviction. Answering `null` would be worse still: that is the committed
    // path, and a guardian leaf reads it as licence to run its structural completion
    // (rotating the local hot-key pointer against a change that never landed). So the
    // poll does neither: it rebuilds and keeps looking.
    await loadModule();
    jest.useFakeTimers();
    try {
      let releasePoll!: () => void;
      const firstPoll = new Promise<void>(resolve => {
        releasePoll = resolve;
      });
      G.__off.clientTransactionsList = jest
        .fn()
        .mockImplementationOnce(async () => {
          await firstPoll;
          return [G.__off.pendingStatus];
        })
        .mockImplementation(async () => [G.__off.committedStatus]);

      const r1 = jest.fn();
      capturedListener!(
        callReq({ op_id: 'op1-live', method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        r1
      );
      await jest.advanceTimersByTimeAsync(0);

      // No eviction: this dispatch still owns its hold and is still awaited. Only the
      // client goes bad under it.
      G.__off.clientIsDisposed = true;
      releasePoll();
      await jest.advanceTimersByTimeAsync(10_000);

      // Re-resolved rather than abandoned, and the answer comes from a poll that
      // actually saw the commit.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rebuilding and continuing'));
      expect(r1).toHaveBeenCalledTimes(1);
      expect(r1.mock.calls[0][0].ok).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });


});
