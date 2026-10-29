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

  it('polls the REBUILT client, not the poisoned one it was handed (#775)', async () => {
    // The assertion the test above cannot make: that the rebuild actually happened.
    // Keeping the old reference would answer from a client the realm has abandoned —
    // reading a store the poisoned module may never advance again — so the poll must
    // be seen to move onto the new build. Only THIS build is disposed (the shared
    // flag would dispose the replacement too), and the poison hook nulls the realm's
    // memo exactly as production does, so the next resolve constructs build 2.
    await loadModule();
    const disposedBuild = G.__off.clientBuilds;
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
        callReq({ op_id: 'op1-rebuild', method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        r1
      );
      await jest.advanceTimersByTimeAsync(0);
      const pollingBuild = G.__off.listBuilds[0];
      expect(pollingBuild).toBeGreaterThan(disposedBuild - 1);

      // An interloper's eviction poisons the shared client and drops the memo.
      G.__off.disposedBuilds.add(pollingBuild);
      for (const listener of G.__off.poisonedListeners ?? []) listener();
      releasePoll();
      await jest.advanceTimersByTimeAsync(10_000);

      expect(r1.mock.calls[0][0].ok).toBe(true);
      // Every lap after the rebuild came from a LATER build than the poisoned one.
      const buildsAfter = G.__off.listBuilds.slice(1);
      expect(buildsAfter.length).toBeGreaterThan(0);
      expect(buildsAfter.every((build: number) => build > pollingBuild)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the poison classification when the REBUILD itself fails (#775)', async () => {
    // The rebuild reaches the node (the create does an eager genesis fetch), so it can
    // fail on its own. Surfacing that as a plain error writes the row Failed like any
    // ordinary failure — and for a structural guardian op that means skipping a
    // completion step for a rotation that may be on chain. What happened is still an
    // abandonment, so it has to be reported as one: `isWasmClientPoisonedError` is
    // what every kill classifier reads to tell those apart.
    await loadModule();
    const disposedBuild = G.__off.clientBuilds;
    jest.useFakeTimers();
    try {
      let releasePoll!: () => void;
      const firstPoll = new Promise<void>(resolve => {
        releasePoll = resolve;
      });
      G.__off.clientTransactionsList = jest.fn(async () => {
        await firstPoll;
        return [G.__off.pendingStatus];
      });

      const r1 = jest.fn();
      capturedListener!(
        callReq({ op_id: 'op1-rebuild-fails', method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        r1
      );
      await jest.advanceTimersByTimeAsync(0);

      G.__off.disposedBuilds.add(G.__off.listBuilds[0] ?? disposedBuild + 1);
      for (const listener of G.__off.poisonedListeners ?? []) listener();
      G.__off.getMidenClient = jest.fn(async () => {
        throw new Error('genesis fetch failed');
      });
      releasePoll();
      await jest.advanceTimersByTimeAsync(10_000);

      expect(r1).toHaveBeenCalledTimes(1);
      const resp = r1.mock.calls[0][0];
      expect(resp.ok).toBe(false);
      // The classification is the point: unwrapped, this arrives as a plain `Error`
      // carrying "genesis fetch failed", which the SW writes Failed like any other.
      expect(resp.errorName).toBe('WasmClientPoisonedError');
      expect(resp.errorReason).toBe('watchdog');
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops polling when the hold goes stale during the REBUILD (#775)', async () => {
    // The rebuild is itself an await, and a long one — the create does an eager
    // genesis fetch against the same node whose parking caused the eviction that
    // poisoned us. An eviction landing inside it leaves the loop holding a fresh,
    // healthy client and NO mutex, so its next WASM call runs alongside the successor
    // that legitimately holds the lock. The loop-top guard cannot see this: it ran
    // before the rebuild started, and the post-sync one is already a call too late.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    jest.useFakeTimers();
    try {
      G.__off.clientTransactionsList = jest.fn(async () => [G.__off.pendingStatus]);

      const r1 = jest.fn();
      capturedListener!(
        callReq({
          op_id: 'op1-evicted-in-rebuild',
          method: 'waitForTransactionCommit',
          argsB64: [encodeArg('0xtxid')]
        }),
        {},
        r1
      );
      // Let the first lap complete and park in its inter-poll sleep.
      for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(0);
      expect(G.__off.clientSyncChain).toHaveBeenCalledTimes(1);
      const pollingBuild = G.__off.listBuilds[0];

      // An interloper's eviction poisons this build and drops the memo while we sleep,
      // and the replacement's construction then parks.
      G.__off.disposedBuilds.add(pollingBuild);
      for (const listener of G.__off.poisonedListeners ?? []) listener();
      const buildClient = G.__off.getMidenClient;
      let releaseRebuild!: () => void;
      const parkedRebuild = new Promise<void>(resolve => {
        releaseRebuild = resolve;
      });
      G.__off.getMidenClient = jest.fn(async (...args: unknown[]) => {
        await parkedRebuild;
        return buildClient(...args);
      });

      // Second lap: takes the rebuild branch and parks there.
      await jest.advanceTimersByTimeAsync(1_000);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rebuilding and continuing'));

      // Evicted while the rebuild is in flight, then the rebuild succeeds.
      miden.__evictHolder();
      for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(0);
      releaseRebuild();
      await jest.advanceTimersByTimeAsync(30_000);

      expect(r1.mock.calls[0][0].ok).toBe(false);
      // Not one further WASM call on the rebuilt client. `syncChain` is the assertion
      // that bites: it is the FIRST call after the rebuild, so a guard only after the
      // sync would already have let it run unmutexed.
      expect(G.__off.clientSyncChain).toHaveBeenCalledTimes(1);
      expect(G.__off.clientTransactionsList).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops polling when the hold goes stale during the post-sync WASM call (#775)', async () => {
    // The loop-top guard cannot cover the window it opens itself: an eviction landing
    // inside `syncChain()` — whose own failure is swallowed — would otherwise let
    // `transactions.list()` run with NO mutex held, alongside the successor that
    // legitimately holds it. That is the double-borrow the mutex exists to prevent,
    // reached through the one await the guard sits in front of.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    jest.useFakeTimers();
    try {
      let releaseSync!: () => void;
      const parkedSync = new Promise<void>(resolve => {
        releaseSync = resolve;
      });
      let syncs = 0;
      G.__off.clientSyncChain = jest.fn(async () => {
        if (++syncs === 1) await parkedSync;
        return { __syncSummary: true };
      });
      G.__off.clientTransactionsList = jest.fn(async () => [G.__off.pendingStatus]);

      const r1 = jest.fn();
      capturedListener!(
        callReq({ op_id: 'op1-evicted-in-sync', method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        r1
      );
      await jest.advanceTimersByTimeAsync(0);

      // Evicted while parked INSIDE the sync, then the sync answers late.
      miden.__evictHolder();
      for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(0);
      expect(r1.mock.calls[0][0].ok).toBe(false);

      releaseSync();
      await jest.advanceTimersByTimeAsync(30_000);

      // The corpse never reached its WASM read, and never ran another lap.
      expect(G.__off.clientTransactionsList).not.toHaveBeenCalled();
      expect(syncs).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops before the status read when the hold goes stale during the transactions.list await (#788)', async () => {
    // The post-sync guard covers the `transactions.list` CALL, but the list is an
    // await of its own, and the records it returns are borrows of the shared
    // client — a `transactionStatus()` read after an eviction landing inside the
    // list would double-borrow alongside the successor. A read-only poll, so the
    // never-guard-post-submit rule does not apply.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    const statusSpy = jest.fn(() => ({ isCommitted: () => true, isDiscarded: () => false }));
    let releaseList!: () => void;
    const parkedList = new Promise<void>(resolve => {
      releaseList = resolve;
    });
    G.__off.clientTransactionsList = jest.fn(async () => {
      await parkedList;
      return [{ transactionStatus: statusSpy }];
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ op_id: 'op-evicted-in-list', method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
      {},
      sendResponse
    );
    await flush();

    // Evicted while parked INSIDE the list, then the list answers late — with a
    // status that reads COMMITTED, so an unguarded loop would report success.
    miden.__evictHolder();
    releaseList();
    await flush();

    expect(statusSpy).not.toHaveBeenCalled();
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.errorName).toBe('WasmClientPoisonedError');
  });

  it('a LIVE commit-wait whose replacement client is ALSO poisoned still never reports a commit (#775)', async () => {
    // The rebuild is not a licence to answer "committed" without seeing one. If the
    // realm keeps poisoning every client it builds, the poll must run out of time and
    // say so — the one answer it must never invent is the successful one.
    await loadModule();
    jest.useFakeTimers();
    try {
      G.__off.clientTransactionsList = jest.fn(async () => [G.__off.pendingStatus]);
      G.__off.clientIsDisposed = true;

      const r1 = jest.fn();
      capturedListener!(
        callReq({ op_id: 'op1-live-forever', method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
        {},
        r1
      );
      await jest.advanceTimersByTimeAsync(70_000);

      expect(r1).toHaveBeenCalledTimes(1);
      expect(r1.mock.calls[0][0].ok).toBe(false);
      expect(String(r1.mock.calls[0][0].error)).toContain('timed out');
      // It really did take the rebuild branch, on every lap, rather than reaching the
      // deadline some other way: with the branch skipped the poll polls a disposed
      // client and still times out, so the assertions above alone cannot tell the two
      // apart. (Build COUNT is not the signal — the realm memoizes, and nothing here
      // poisons the memo, so every lap gets the same disposed instance back. That is
      // the scenario: a realm that cannot produce a healthy client must run out of
      // time rather than invent a commit.)
      const rebuildWarnings = warnSpy.mock.calls.filter(call => String(call[0]).includes('rebuilding and continuing'));
      expect(rebuildWarnings.length).toBeGreaterThan(1);
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
    // Both args decoded, plus the post-await liveness re-check the interface
    // method runs before the serialize (see the guarded-reach-through test below).
    expect(G.__off.clientExportNote).toHaveBeenCalledWith('note-x', 'Details', expect.any(Function));
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
    expect(G.__off.clientGetInputNoteDetails).toHaveBeenCalledWith({ ids: ['0xabc'] }, expect.any(Function));
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    // resultB64 is the UTF-8 JSON of the DTO array — decode + parse it back and
    // prove the numeric enums (noteType:0, state:2) and strings all survived.
    const decoded = JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'));
    expect(decoded).toEqual([
      { noteId: '0xabc', senderAccountId: 'mtst1qsender', assets: [], noteType: 0, nullifier: '0xn', state: 2 }
    ]);
  });

  it('dispatches a commitment batch and JSON-encodes the ordered DTO entries', async () => {
    await loadModule();
    const dto = [
      { notes: [{ noteId: 'n9' }], uncommitted: 0 },
      { notes: [], uncommitted: 1 }
    ];
    G.__off.clientGetDetailsCommitmentMatches.mockResolvedValueOnce(dto);
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'getDetailsCommitmentMatches',
        argsB64: [encodeArg(['0xcommitment', '0xother']), encodeArg(['n9', 'n10'])]
      }),
      {},
      sendResponse
    );
    await flush();

    expect(G.__off.clientGetDetailsCommitmentMatches).toHaveBeenCalledWith(
      ['0xcommitment', '0xother'],
      ['n9', 'n10'],
      expect.any(Function)
    );
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'))).toEqual(dto);
  });

  it('dispatches getDetailsCommitmentMatches and JSON-encodes its plain DTO (#1389)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ method: 'getDetailsCommitmentMatches', argsB64: [encodeArg(['0xcommitment']), encodeArg(['0xreal'])] }),
      {},
      sendResponse
    );
    await flush();

    expect(G.__off.clientGetDetailsCommitmentMatches).toHaveBeenCalledWith(
      ['0xcommitment'],
      ['0xreal'],
      expect.any(Function)
    );
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'))).toEqual([
      {
        notes: [
          { noteId: '0xreal', senderAccountId: 'mtst1qsender', assets: [], noteType: 0, nullifier: '0xn', state: 2 }
        ],
        uncommitted: 1
      }
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
    expect(G.__off.clientGetConsumableNoteDtos).toHaveBeenCalledWith('mtst1qqaccount', expect.any(Function));
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

  it('dispatches buildPswapCancelRequest and returns the fee-aware request bytes verbatim', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(
      callReq({
        method: 'buildPswapCancelRequest',
        argsB64: [encodeArg('mtst1qqaccount'), encodeArg('0xtip')]
      }),
      {},
      sendResponse
    );
    expect(ret).toBe(true);
    await flush();

    // A request without the flag builds as a live order does, with it false (#1487).
    expect(G.__off.clientBuildPswapCancelRequest).toHaveBeenCalledWith(
      'mtst1qqaccount',
      '0xtip',
      expect.any(Function),
      {
        allowNodeNote: false
      }
    );
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(Buffer.from(resp.resultB64, 'base64')).toEqual(Buffer.from([20, 14, 7, 6]));
  });

  it('dispatches a node-note buildPswapCancelRequest with its option', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'buildPswapCancelRequest',
        argsB64: [encodeArg('mtst1qqaccount'), encodeArg('0xtip'), encodeArg(true)]
      }),
      {},
      sendResponse
    );
    await flush();

    expect(G.__off.clientBuildPswapCancelRequest).toHaveBeenCalledWith(
      'mtst1qqaccount',
      '0xtip',
      expect.any(Function),
      {
        allowNodeNote: true
      }
    );
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
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
    expect(G.__off.clientSyncState).toHaveBeenCalledTimes(1);
    expect(G.__off.clientGetSyncHeight).not.toHaveBeenCalled();
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'))).toBe(5000);
  });

  it('getSyncHeight(fresh): refuses to read blockNum() off the summary after an eviction (#788)', async () => {
    // The fresh branch parks on a network sync, and the SyncSummary it returns is
    // a borrow of the shared client — `.blockNum()` after an eviction is the
    // double borrow the hold re-check exists to refuse.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    const blockNumSpy = jest.fn(() => 5000);
    let releaseSync!: () => void;
    const parkedSync = new Promise<void>(resolve => {
      releaseSync = resolve;
    });
    G.__off.clientSyncState = jest.fn(async () => {
      await parkedSync;
      return { blockNum: blockNumSpy };
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ op_id: 'op-height-evicted', method: 'getSyncHeight', argsB64: [encodeArg(true)] }),
      {},
      sendResponse
    );
    await flush();

    miden.__evictHolder();
    releaseSync();
    await flush();

    expect(blockNumSpy).not.toHaveBeenCalled();
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.errorName).toBe('WasmClientPoisonedError');
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

  it('getPswapLineage: refuses to reduce the live record after an eviction (#788)', async () => {
    // The reduction reaches through the record's live WASM methods, and the record
    // is a borrow of the shared client — an eviction during the lineage read must
    // stop the dispatch before the first touch. One tracking spy behind EVERY
    // record method: the reducer's read order is its own business, so the
    // assertion is that no method was touched at all.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    const recordRead = jest.fn();
    let releaseLineage!: () => void;
    const parkedLineage = new Promise<void>(resolve => {
      releaseLineage = resolve;
    });
    G.__off.clientLineage = jest.fn(async () => {
      await parkedLineage;
      return {
        orderId: () => {
          recordRead();
          return '77';
        },
        currentTipNoteId: () => {
          recordRead();
          return { toString: () => '0xtip' };
        },
        currentDepth: () => {
          recordRead();
          return 2;
        },
        state: () => {
          recordRead();
          return 1;
        },
        remainingOffered: () => {
          recordRead();
          return 10n;
        },
        remainingRequested: () => {
          recordRead();
          return 20n;
        }
      };
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ op_id: 'op-lineage-evicted', method: 'getPswapLineage', argsB64: [encodeArg('77')] }),
      {},
      sendResponse
    );
    await flush();

    miden.__evictHolder();
    releaseLineage();
    await flush();

    expect(recordRead).not.toHaveBeenCalled();
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.errorName).toBe('WasmClientPoisonedError');
  });

  it('dispatches one bulk lineage read and reduces every result in the owning realm', async () => {
    await loadModule();
    G.__off.clientLineages = jest.fn(async () => [
      await G.__off.clientLineage(),
      {
        orderId: () => '88',
        currentTipNoteId: () => ({ toString: () => '0xtip88' }),
        currentDepth: () => 0,
        state: () => 0,
        remainingOffered: () => 9007199254740993n,
        remainingRequested: () => 40n
      }
    ]);
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getPswapLineages', argsB64: [] }), {}, sendResponse);
    await flush();
    expect(G.__off.clientLineages).toHaveBeenCalledTimes(1);
    const response = sendResponse.mock.calls[0][0];
    expect(response.ok).toBe(true);
    expect(JSON.parse(Buffer.from(response.resultB64, 'base64').toString('utf8'))).toEqual([
      {
        orderId: '77',
        currentTipNoteId: '0xtip',
        currentDepth: 2,
        state: 1,
        remainingOffered: '10',
        remainingRequested: '20'
      },
      {
        orderId: '88',
        currentTipNoteId: '0xtip88',
        currentDepth: 0,
        state: 0,
        remainingOffered: '9007199254740993',
        remainingRequested: '40'
      }
    ]);
  });

  it('serializes an empty bulk lineage snapshot as an array', async () => {
    await loadModule();
    G.__off.clientLineages = jest.fn(async () => []);
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getPswapLineages', argsB64: [] }), {}, sendResponse);
    await flush();
    const response = sendResponse.mock.calls[0][0];
    expect(response.ok).toBe(true);
    expect(JSON.parse(Buffer.from(response.resultB64, 'base64').toString('utf8'))).toEqual([]);
  });

  it('does not reduce a bulk lineage snapshot after its offscreen hold is evicted', async () => {
    await loadModule();
    const miden = await import('lib/miden/sdk/miden-client');
    const evict: () => void = Reflect.get(miden, '__evictHolder');
    const recordRead = jest.fn(() => '77');
    let release!: () => void;
    const parked = new Promise<void>(resolve => {
      release = resolve;
    });
    G.__off.clientLineages = jest.fn(async () => {
      await parked;
      return [{ orderId: recordRead }];
    });
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getPswapLineages', argsB64: [] }), {}, sendResponse);
    await flush();
    evict();
    release();
    await flush();
    expect(recordRead).not.toHaveBeenCalled();
    expect(sendResponse.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        ok: false,
        errorName: 'WasmClientPoisonedError'
      })
    );
  });

  it('dispatches getInputNoteSummary → reduces the live record to its noteType (JSON DTO)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(callReq({ method: 'getInputNoteSummary', argsB64: [encodeArg('0xn')] }), {}, sendResponse);
    await flush();

    expect(G.__off.clientGetInputNote).toHaveBeenCalledWith('0xn');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'))).toMatchObject({ noteType: 1 });
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

  it('offscreen summary carries fee assets and rejects stale reduction', async () => {
    await loadModule();
    const nativeId = 'native-faucet';
    const tokenId = 'token-faucet';
    const details = jest.fn(() => ({
      assets: () => ({
        fungibleAssets: () => [
          { faucetId: () => ({ canonical: nativeId }), amount: () => 10000n },
          { faucetId: () => ({ canonical: tokenId }), amount: () => 7n }
        ]
      })
    }));
    G.__off.clientGetInputNote.mockResolvedValue({ metadata: () => ({ noteType: () => 1 }), details });
    const liveResponse = jest.fn();
    capturedListener!(callReq({ method: 'getInputNoteSummary', argsB64: [encodeArg('0xn')] }), {}, liveResponse);
    await flush();

    expect(G.__off.clientGetInputNote).toHaveBeenCalledTimes(1);
    expect(liveResponse.mock.calls[0][0].ok).toBe(true);
    const summary = JSON.parse(Buffer.from(liveResponse.mock.calls[0][0].resultB64, 'base64').toString('utf8'));
    expect(summary).toEqual({
      noteType: 1,
      assets: [
        { faucetId: nativeId, amount: '10000' },
        { faucetId: tokenId, amount: '7' }
      ]
    });
    expect(details).toHaveBeenCalledTimes(1);

    const miden: any = await import('lib/miden/sdk/miden-client');
    const staleRecord = { metadata: jest.fn(() => ({ noteType: () => 1 })), details };
    staleRecord.details.mockClear();
    let releaseNote!: () => void;
    const parkedNote = new Promise<void>(resolve => {
      releaseNote = resolve;
    });
    G.__off.clientGetInputNote = jest.fn(async () => {
      await parkedNote;
      return staleRecord;
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({ op_id: 'op-summary-evicted', method: 'getInputNoteSummary', argsB64: [encodeArg('0xn')] }),
      {},
      sendResponse
    );
    await flush();

    miden.__evictHolder();
    releaseNote();
    await flush();

    expect(staleRecord.metadata).not.toHaveBeenCalled();
    expect(staleRecord.details).not.toHaveBeenCalled();
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.errorName).toBe('WasmClientPoisonedError');
  });

  it('dispatches importNoteBytes → imports into the offscreen store and ships the id back as bytes', async () => {
    await loadModule();
    let liveHold: unknown;
    G.__off.clientImportNoteBytes = jest.fn(async (_bytes: Uint8Array, _hold: unknown) => {
      liveHold = jest.requireMock('lib/miden/sdk/miden-client').getCurrentWasmLockHold();
      return '0ximportedid';
    });
    const sendResponse = jest.fn();
    const noteBytes = new Uint8Array([0xab, 0xcd, 0xef]);
    capturedListener!(callReq({ method: 'importNoteBytes', argsB64: [encodeArg(noteBytes)] }), {}, sendResponse);
    await flush();

    // The raw note bytes crossed intact and were imported into THIS client's store.
    expect(G.__off.clientImportNoteBytes).toHaveBeenCalledTimes(1);
    expect(Array.from(G.__off.clientImportNoteBytes.mock.calls[0][0])).toEqual([0xab, 0xcd, 0xef]);
    expect(liveHold).toEqual(expect.anything());
    expect(G.__off.clientImportNoteBytes.mock.calls[0][1]).toBe(liveHold);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(Buffer.from(resp.resultB64, 'base64').toString('utf8')).toBe('0ximportedid');
  });

  it('dispatches proposal-note import and restores note bytes', async () => {
    await loadModule();
    let liveHold: unknown;
    G.__off.clientImportRecoveryNoteBytes = jest.fn(async (_notes: Uint8Array[], _hold: unknown) => {
      liveHold = jest.requireMock('lib/miden/sdk/miden-client').getCurrentWasmLockHold();
      return { imported: 1, failures: 0 };
    });
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
    expect(liveHold).toEqual(expect.anything());
    expect(G.__off.clientImportRecoveryNoteBytes.mock.calls[0][1]).toBe(liveHold);
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

  it('getSerializedInputNoteDetails: an eviction mid-loop stops the record reduction AND every later fetch (#788)', async () => {
    // The shared loop swallows per-note throws (a not-found note is a skip), so no
    // single up-front check can stop it — the liveness question is PER-ITERATION:
    // the record read after each await and the NEXT iteration's fetch are both
    // WASM borrows. Note 1 resolves before the eviction; the eviction lands during
    // note 2's fetch; note 2's record must never be read and note 3 must never be
    // fetched at all.
    await loadModule();
    const miden: any = await import('lib/miden/sdk/miden-client');
    const secondRecordRead = jest.fn();
    let releaseSecond!: () => void;
    const parkedSecond = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });
    G.__off.clientGetInputNote = jest.fn(async (id: string) => {
      if (id === 'n2') {
        await parkedSecond;
        return {
          details: () => {
            secondRecordRead();
            return { assets: () => ({ fungibleAssets: () => [] }) };
          },
          state: () => {
            secondRecordRead();
            return { toString: () => 'Invalid' };
          },
          nullifier: () => {
            secondRecordRead();
            return { toString: () => '0xn2' };
          }
        };
      }
      return {
        details: () => ({ assets: () => ({ fungibleAssets: () => [] }) }),
        state: () => ({ toString: () => 'Invalid' }),
        nullifier: () => ({ toString: () => `0x${id}` })
      };
    });

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        op_id: 'op-details-evicted',
        method: 'getSerializedInputNoteDetails',
        argsB64: [encodeArg(['n1', 'n2', 'n3'])]
      }),
      {},
      sendResponse
    );
    await flush();

    miden.__evictHolder();
    releaseSecond();
    await flush();

    // Note 2's record was fetched before the eviction but never READ after it, and
    // note 3's fetch — a WASM call in its own right — never happened.
    expect(secondRecordRead).not.toHaveBeenCalled();
    expect(G.__off.clientGetInputNote).toHaveBeenCalledTimes(2);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.errorName).toBe('WasmClientPoisonedError');
  });

  describe('dryRunTransaction (the USDCx burn fee probe)', () => {
    const REQUEST = new Uint8Array([1, 2, 3]);
    const dryRunReq = (op_id = 'op-dry-run') =>
      callReq({ op_id, method: 'dryRunTransaction', argsB64: [encodeArg('0xaccount'), encodeArg(REQUEST)] });
    const decoded = (resp: { resultB64: string }) => JSON.parse(Buffer.from(resp.resultB64, 'base64').toString('utf8'));

    it("executes the request on this document's client with no sync and no note import", async () => {
      await loadModule();
      const { executeForSummaryAtTip } = await import('@openzeppelin/miden-multisig-client');
      const sendResponse = jest.fn();

      capturedListener!(dryRunReq(), {}, sendResponse);
      await flush();

      const resp = sendResponse.mock.calls[0][0];
      expect(resp.ok).toBe(true);
      // The multisig mock's summary serializes to [0xab].
      expect(decoded(resp)).toEqual({ summaryBytes: Buffer.from([0xab]).toString('base64') });
      const client = await G.__off.getMidenClient.mock.results[0].value;
      expect(G.__off.prepareCustomRequestBytes).toHaveBeenCalledWith(
        client.client,
        '0xaccount',
        REQUEST,
        expect.objectContaining({ mock: 'wasm-lock-hold' })
      );
      expect(executeForSummaryAtTip).toHaveBeenCalledWith(client.client, '0xaccount', {
        __trFromBytes: [1, 2, 3],
        authArg: expect.any(Function)
      });
      expect(G.__off.clientSyncState).not.toHaveBeenCalled();
      expect(G.__off.clientSyncChain).not.toHaveBeenCalled();
      expect(G.__off.clientImportNoteBytes).not.toHaveBeenCalled();
    });

    it('executes locally when the account is already fully authorized, still submitting nothing', async () => {
      await loadModule();
      const { executeForSummaryAtTip } = await import('@openzeppelin/miden-multisig-client');
      jest
        .mocked(executeForSummaryAtTip)
        .mockRejectedValueOnce(new Error('TRANSACTION_ALREADY_AUTHORIZED: already fully authorized'));
      const sendResponse = jest.fn();

      capturedListener!(dryRunReq(), {}, sendResponse);
      await flush();

      const resp = sendResponse.mock.calls[0][0];
      expect(resp.ok).toBe(true);
      expect(decoded(resp)).toEqual({ executedBytes: Buffer.from([55, 66, 77]).toString('base64') });
      expect(G.__off.guardianExecuteRequest).toHaveBeenCalledWith('0xaccount', {
        __trFromBytes: [1, 2, 3],
        authArg: expect.any(Function)
      });
      expect(G.__off.guardianSubmitted).toBe(false);
    });

    it.each([
      ['no signer for the account', 'storage error: Failed to get secret key from IndexedDB'],
      ['no fee faucet for the network', 'no fee faucet is known for network `mlcl`']
    ])('executes locally when the summary fails with %s, still submitting nothing', async (_kind, message) => {
      await loadModule();
      const { executeForSummaryAtTip } = await import('@openzeppelin/miden-multisig-client');
      jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(new Error(message));
      const sendResponse = jest.fn();

      capturedListener!(dryRunReq(), {}, sendResponse);
      await flush();

      const resp = sendResponse.mock.calls[0][0];
      expect(resp.ok).toBe(true);
      expect(decoded(resp)).toEqual({ executedBytes: Buffer.from([55, 66, 77]).toString('base64') });
      expect(G.__off.guardianExecuteRequest).toHaveBeenCalledWith('0xaccount', {
        __trFromBytes: [1, 2, 3],
        authArg: expect.any(Function)
      });
      expect(G.__off.guardianSubmitted).toBe(false);
    });

    it.each([
      ['an execution failure', () => new Error('the kernel assertion failed')],
      ['a trap', () => new WebAssembly.RuntimeError('unreachable')]
    ])('reports %s as it stands, with no local retry', async (_kind, failure) => {
      await loadModule();
      const { executeForSummaryAtTip } = await import('@openzeppelin/miden-multisig-client');
      const error = failure();
      jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(error);
      const sendResponse = jest.fn();

      capturedListener!(dryRunReq(), {}, sendResponse);
      await flush();

      const resp = sendResponse.mock.calls[0][0];
      expect(resp.ok).toBe(false);
      expect(resp.error).toBe(error.message);
      expect(G.__off.guardianExecuteRequest).not.toHaveBeenCalled();
    });

    it('refuses to execute once an eviction took its hold during the request preparation', async () => {
      await loadModule();
      const miden: any = await import('lib/miden/sdk/miden-client');
      const { executeForSummaryAtTip } = await import('@openzeppelin/miden-multisig-client');
      let releasePreparation: (() => void) | undefined;
      G.__off.prepareCustomRequestBytes = jest.fn(async (_client: unknown, _account: string, bytes: Uint8Array) => {
        await new Promise<void>(resolve => {
          releasePreparation = resolve;
        });
        return bytes;
      });
      const sendResponse = jest.fn();

      capturedListener!(dryRunReq('op-dry-run-evicted'), {}, sendResponse);
      await flush();
      miden.__evictHolder();
      releasePreparation?.();
      await flush();

      expect(executeForSummaryAtTip).not.toHaveBeenCalled();
      expect(G.__off.deserializeTxRequest).not.toHaveBeenCalled();
      const resp = sendResponse.mock.calls[0][0];
      expect(resp.ok).toBe(false);
      expect(resp.errorName).toBe('WasmClientPoisonedError');
    });
  });


});
