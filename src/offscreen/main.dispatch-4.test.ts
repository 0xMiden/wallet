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

  it('guardianPipeline: a worker failure fails the write before submit, as ProveWorkerError (#945)', async () => {
    await loadModule();
    const { ProveWorkerError } = await import('lib/miden/sdk/local-prove-transport');
    mockProveTransport.prove.mockRejectedValueOnce(new ProveWorkerError('crashed', 'RuntimeError: unreachable'));

    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'guardianPipeline',
        argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await flush();

    expect(G.__off.guardianProveCalls).toEqual([]);
    expect(G.__off.guardianSubmitProven).not.toHaveBeenCalled();
    expect(sendResponse.mock.calls[0][0]).toMatchObject({
      ok: false,
      errorName: 'ProveWorkerError',
      error: 'Local prove failed in the prove worker (crashed)'
    });
  });

  const boundTipRequest = (blockNumbers = [42]) => ({
    authArg: () => ({ toHex: () => '0xauth' }),
    adviceMap: () => ({ get: () => Array.from({ length: 12 }, (_, i) => ({ asInt: () => (i === 0 ? 42n : 0n) })) }),
    blockNumbers: () => blockNumbers
  });

  const callTipPipeline = () => {
    const response = jest.fn();
    capturedListener!(
      callReq({
        method: 'guardianPipeline',
        argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([9])), encodeArg(false), encodeArg('BwcH')]
      }),
      {},
      response
    );
    return response;
  };

  it('guardianPipeline: syncs the tip and executes without the historical crossed anchor', async () => {
    await loadModule();
    const request = boundTipRequest();
    G.__off.deserializeTxRequest.mockReturnValue(request);
    const response = callTipPipeline();
    await flush();

    expect(response.mock.calls[0][0].ok).toBe(true);
    expect(G.__off.guardianExecuteRequest).toHaveBeenCalledWith('acc', request);
    const syncOrder = G.__off.clientSyncChain.mock.invocationCallOrder[0];
    const heightOrder = G.__off.clientGetSyncHeight.mock.invocationCallOrder[0];
    const executeOrder = G.__off.guardianExecuteRequest.mock.invocationCallOrder[0];
    expect(syncOrder).toBeLessThan(heightOrder);
    expect(heightOrder).toBeLessThan(executeOrder);
  });

  it('guardianPipeline: refuses an undeclared bound block before syncing or executing', async () => {
    await loadModule();
    G.__off.deserializeTxRequest.mockReturnValue(boundTipRequest([]));
    const response = callTipPipeline();
    await flush();

    expect(response.mock.calls[0][0]).toMatchObject({ ok: false, errorName: 'BoundBlockNotDeclaredError' });
    expect(G.__off.clientSyncChain).not.toHaveBeenCalled();
    expect(G.__off.guardianExecuteRequest).not.toHaveBeenCalled();
  });

  it('guardianPipeline: refuses execution when the synced node is below the bound block', async () => {
    await loadModule();
    G.__off.deserializeTxRequest.mockReturnValue(boundTipRequest());
    G.__off.clientGetSyncHeight.mockResolvedValue(41);
    const response = callTipPipeline();
    await flush();

    expect(response.mock.calls[0][0]).toMatchObject({ ok: false, errorName: 'ChainBehindBoundBlockError' });
    expect(G.__off.clientSyncChain).toHaveBeenCalledTimes(1);
    expect(G.__off.guardianExecuteRequest).not.toHaveBeenCalled();
    expect(G.__off.guardianSubmitted).toBe(false);
  });

  it.each([
    { parkedMethod: 'clientSyncChain', expectedHeightReads: 0 },
    { parkedMethod: 'clientGetSyncHeight', expectedHeightReads: 1 }
  ])(
    'guardianPipeline: eviction during $parkedMethod blocks the next WASM call',
    async ({ parkedMethod, expectedHeightReads }) => {
      await loadModule();
      G.__off.deserializeTxRequest.mockReturnValue(boundTipRequest());
      const miden: any = await import('lib/miden/sdk/miden-client');
      let resume!: (value: number) => void;
      G.__off[parkedMethod].mockImplementationOnce(
        () =>
          new Promise<number>(resolve => {
            resume = resolve;
          })
      );
      const response = callTipPipeline();
      await flush();
      expect(G.__off[parkedMethod]).toHaveBeenCalledTimes(1);

      miden.__evictHolder();
      resume(100);
      await flush();

      expect(response.mock.calls[0][0].ok).toBe(false);
      expect(G.__off.clientGetSyncHeight).toHaveBeenCalledTimes(expectedHeightReads);
      expect(G.__off.guardianExecuteRequest).not.toHaveBeenCalled();
      expect(G.__off.guardianSubmitted).toBe(false);
    }
  );

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
    // A delegated write neither starts nor uses the prove worker (#945).
    expect(mockProveTransport.prewarm).not.toHaveBeenCalled();
    expect(mockProveTransport.prove).not.toHaveBeenCalled();
    expect(G.__off.guardianSubmitProven).not.toHaveBeenCalled();
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

  it('guardianPipeline (delegated): a remote prove failure re-proves the same result in the prove worker', async () => {
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

    // First attempt: the explicit remote prover threw. Second: the worker, on the
    // same executed result, submitted through submitProven (#945).
    expect(G.__off.guardianProveCalls).toEqual([{ prover: { __remote: true } }]);
    expect(G.__off.newLocalProver).not.toHaveBeenCalled();
    expect(mockProveTransport.prove).toHaveBeenCalledTimes(1);
    expect(mockProveTransport.prove.mock.calls[0]?.[0]).toEqual({ txResult: new Uint8Array([55, 66, 77]) });
    const executed = await G.__off.guardianExecuteRequest.mock.results[0].value;
    expect(G.__off.guardianSubmitProven).toHaveBeenCalledWith({ __proofFromBytes: [1, 2, 3] }, executed.result);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('delegated guardian prove failed'), expect.any(Error));
    expect(G.__off.guardianApplied).toBe(true);
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('guardianPipeline (delegated): a trap from the delegated prove fails the write without a local re-prove', async () => {
    await loadModule();
    G.__off.guardianProveShouldFailOnce = true;
    G.__off.guardianProveError = new WebAssembly.RuntimeError('unreachable');
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

    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, error: 'unreachable' });
    expect(mockProveTransport.prove).not.toHaveBeenCalled();
    expect(G.__off.guardianSubmitProven).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('delegated guardian prove failed'),
      expect.anything()
    );
  });

  it('guardianPipeline (delegated): a worker failure on the fallback leg fails the write before submit (#945)', async () => {
    await loadModule();
    G.__off.guardianProveShouldFailOnce = true;
    mockProveTransport.prove.mockRejectedValueOnce(new Error('worker gone'));
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

    expect(mockProveTransport.prove).toHaveBeenCalledTimes(1);
    expect(G.__off.guardianSubmitProven).not.toHaveBeenCalled();
    expect(G.__off.guardianSubmitted).toBe(false);
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, error: 'worker gone' });
  });

  it('guardianPipeline (delegated): a transport-shaped prove failure reports a prover outage from THIS realm', async () => {
    // The realm bug this closes, which is the third of its kind. The worker's
    // guardian catch gates `markConnectivityIssue('prover')` on the row's stage
    // being `proving`, and only the INLINE leaf ever stamps that. This leaf
    // reports no stages back at all, so on the default build — where every
    // guardian type routes here — the row is still frozen at `sending`, that
    // gate can never fire, and a prover failing only on guardian operations
    // produced no `service_prover` event from anywhere.
    //
    // Asserted through the forward rather than through module state, because the
    // forward is the only part the worker can see.
    await loadModule();
    G.__off.guardianProveShouldFailOnce = true;
    G.__off.guardianProveFailureMessage = 'transport error: connection refused';
    G.chrome.runtime.sendMessage.mockClear();
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

    const forwarded = G.chrome.runtime.sendMessage.mock.calls
      .map(([message]: [{ event?: { operation?: string } }]) => message.event?.operation)
      .filter((operation: string | undefined) => operation !== undefined);

    // The outage AND the fallback: the transaction still succeeded on the local
    // prover, so a reader needs both to tell "the prover is down" from "the
    // prover is down and transactions are failing".
    expect(forwarded).toContain('service_prover');
    expect(forwarded).toContain('prove');
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('guardianPipeline (delegated): a semantic prove failure reports no outage', async () => {
    // The gate has to be the error's shape, not merely that a prove failed.
    // Marking an outage on "invalid transaction request" would attribute a
    // malformed request to the prover being down, and since a mark no-ops while
    // one is already active it would then swallow the next real outage entirely.
    await loadModule();
    G.__off.guardianProveShouldFailOnce = true;
    G.__off.guardianProveFailureMessage = 'invalid transaction request';
    G.chrome.runtime.sendMessage.mockClear();
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

    const forwarded = G.chrome.runtime.sendMessage.mock.calls.map(
      ([message]: [{ event?: { operation?: string } }]) => message.event?.operation
    );

    expect(forwarded).not.toContain('service_prover');
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

  // #1233: a failed apply waits in real time before its retry reads the account, so every reply
  // after one comes later than a flush.
  const waitForReply = async (sendResponse: jest.Mock) => {
    for (let i = 0; i < 60 && sendResponse.mock.calls.length === 0; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };

  it('guardianPipeline: an apply failure after submit replies with the apply-after-submit code (#1233)', async () => {
    await loadModule();
    const { isApplyAfterSubmitError } = await import('lib/miden/sdk/sdk-error-code');
    G.__off.guardianSubmitProven = jest.fn(async () => {
      G.__off.guardianSubmitted = true;
      return {
        apply: jest.fn(async () => {
          throw new Error('IndexedDB transaction aborted while applying the transaction update: QuotaExceededError');
        })
      };
    });
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'guardianPipeline',
        argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await waitForReply(sendResponse);

    expect(G.__off.guardianSubmitted).toBe(true);
    const resp = sendResponse.mock.calls[0][0];
    expect(resp).toMatchObject({
      ok: false,
      errorCode: 'ApplyTransactionAfterSubmitFailed',
      errorName: 'ApplyAfterSubmitError'
    });
    expect(resp.errorReason).toBeUndefined();
    // The `cause` never crosses the realm. The service worker rebuilds
    // `Offscreen call '<method>' failed: <error>` with the code re-attached
    // (miden-client-proxy finishOp), and each signal alone classifies as landed.
    expect(isApplyAfterSubmitError({ errorCode: resp.errorCode })).toBe(true);
    expect(isApplyAfterSubmitError(new Error(`Offscreen call 'guardianPipeline' failed: ${resp.error}`))).toBe(true);
  });

  it('guardianPipeline: a rejected submit replies without the apply-after-submit code (#1233)', async () => {
    await loadModule();
    G.__off.guardianSubmitProven = jest.fn(async () => {
      throw new Error('node refused the proven transaction');
    });
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'guardianPipeline',
        argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await flush();

    const resp = sendResponse.mock.calls[0][0];
    expect(resp).toMatchObject({ ok: false, error: 'node refused the proven transaction' });
    expect(resp.errorCode).toBeUndefined();
    expect(resp.errorName).toBeUndefined();
    expect(resp.errorBeforeSubmit).toBeUndefined();
  });

  it('guardianPipeline: an apply error that cannot be stringified still replies with the apply-after-submit code (#1233)', async () => {
    await loadModule();
    // `String()` throws on a null-prototype object. The apply-failure breadcrumb stringifies the
    // error even with markers off, so an unguarded one would replace the landed verdict.
    G.__off.guardianSubmitProven = jest.fn(async () => ({
      apply: jest.fn(async () => {
        throw Object.create(null);
      })
    }));
    const sendResponse = jest.fn();
    capturedListener!(
      callReq({
        method: 'guardianPipeline',
        argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      sendResponse
    );
    await waitForReply(sendResponse);

    expect(sendResponse.mock.calls[0][0]).toMatchObject({
      ok: false,
      errorCode: 'ApplyTransactionAfterSubmitFailed',
      errorName: 'ApplyAfterSubmitError'
    });
  });

  // #1233: the apply retry runs in this realm's own hold, off the executed result's initial account
  // commitment.
  const retryableResult = () => ({
    serialize: () => new Uint8Array([55, 66, 77]),
    executedTransaction: () => ({
      id: () => ({ toHex: () => '0xlanded' }),
      inputNotes: () => ({ notes: () => [] }),
      userOutputNotes: () => [],
      accountId: () => 'sdk-guardian',
      initialAccountHeader: () => ({ to_commitment: () => ({ toHex: () => '0xinitial' }) })
    })
  });
  const callGuardianPipeline = (sendResponse: jest.Mock) =>
    capturedListener!(
      callReq({
        method: 'guardianPipeline',
        argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1])), encodeArg(false)]
      }),
      {},
      sendResponse
    );

  it('guardianPipeline: a failure before the submit call replies tagged (#1081)', async () => {
    await loadModule();
    G.__off.guardianExecuteRequest = jest.fn(async () => {
      throw new Error('transaction execution failed: transaction is unauthorized');
    });
    const sendResponse = jest.fn();
    callGuardianPipeline(sendResponse);
    await waitForReply(sendResponse);
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, errorBeforeSubmit: true });
  });

  it('guardianPipeline: the submit gate carries the evidence read before submit (#1081, #1644)', async () => {
    await loadModule();
    const posted: any[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      posted.push(m);
      return m?.type === OFFSCREEN_SUBMIT_GATE ? { ok: true } : undefined;
    });
    G.__off.guardianExecuteRequest = jest.fn(async () => ({
      result: retryableResult(),
      id: { toHex: () => '0xlanded' },
      prove: jest.fn()
    }));
    G.__off.guardianSubmitProven = jest.fn(async () => ({ apply: jest.fn(async () => {}) }));
    const sendResponse = jest.fn();
    callGuardianPipeline(sendResponse);
    await waitForReply(sendResponse);
    const gate = posted.find(m => m?.type === OFFSCREEN_SUBMIT_GATE);
    expect(gate.evidence).toMatchObject({ transactionId: '0xlanded', initialCommitment: '0xinitial' });
  });

  // #1644: the gate is the only way to the submit call, so an attempt the service worker never let through cannot
  // have reached the node, and the reply says so.
  it.each([
    ['refuses it', { ok: false, error: 'op is not awaiting a submit' }],
    ['never answers', undefined]
  ])(
    'guardianPipeline: a submit gate the service worker %s fails the write before its submit (#1644)',
    async (_label, answer) => {
      await loadModule();
      G.chrome.runtime.sendMessage = jest.fn(async (m: any) =>
        m?.type === OFFSCREEN_SUBMIT_GATE ? answer : undefined
      );
      G.__off.guardianExecuteRequest = jest.fn(async () => ({
        result: retryableResult(),
        id: { toHex: () => '0xlanded' },
        prove: jest.fn()
      }));
      G.__off.guardianSubmitProven = jest.fn(async () => ({ apply: jest.fn(async () => {}) }));
      const sendResponse = jest.fn();
      callGuardianPipeline(sendResponse);
      await waitForReply(sendResponse);
      expect(G.__off.guardianSubmitProven).not.toHaveBeenCalled();
      expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, errorBeforeSubmit: true });
    }
  );

  it('guardianPipeline: an apply that fails once and then lands replies ok (#1233)', async () => {
    await loadModule();
    G.__off.guardianExecuteRequest = jest.fn(async () => ({
      result: retryableResult(),
      id: { toHex: () => '0xlanded' },
      prove: jest.fn()
    }));
    const apply = jest.fn(async () => {}).mockRejectedValueOnce(new Error('IndexedDB transaction aborted'));
    G.__off.guardianSubmitProven = jest.fn(async () => ({ apply }));
    G.__off.clientAccountsGet = jest.fn(async () => ({ to_commitment: () => ({ toHex: () => '0xinitial' }) }));
    const sendResponse = jest.fn();

    callGuardianPipeline(sendResponse);
    await waitForReply(sendResponse);

    expect(apply).toHaveBeenCalledTimes(2);
    expect(G.__off.clientAccountsGet).toHaveBeenCalledWith('sdk-guardian');
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: true });
  });

  it('guardianPipeline: an apply whose account write landed is not applied again (#1233)', async () => {
    await loadModule();
    G.__off.guardianExecuteRequest = jest.fn(async () => ({
      result: retryableResult(),
      id: { toHex: () => '0xlanded' },
      prove: jest.fn()
    }));
    const apply = jest.fn(async () => {
      throw new Error('note update failed');
    });
    G.__off.guardianSubmitProven = jest.fn(async () => ({ apply }));
    // The store's account already moved to the post-transaction state.
    G.__off.clientAccountsGet = jest.fn(async () => ({ to_commitment: () => ({ toHex: () => '0xfinal' }) }));
    const sendResponse = jest.fn();

    callGuardianPipeline(sendResponse);
    await waitForReply(sendResponse);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0][0]).toMatchObject({
      ok: false,
      errorCode: 'ApplyTransactionAfterSubmitFailed'
    });
  });

  it('guardianPipeline: an apply whose hold is evicted after the first failure is not applied again (#1233)', async () => {
    // The eviction settles the reply with the waiter's poison first, so only the abandoned dispatch
    // shows the wrap. The store still holds the initial account: only the hold check stops a retry.
    await loadModule();
    const { isApplyAfterSubmitError } = await import('lib/miden/sdk/sdk-error-code');
    const miden = jest.requireMock<
      typeof import('lib/miden/sdk/miden-client') & {
        __evictHolder: () => void;
        __lastRunning: () => Promise<unknown> | null;
      }
    >('lib/miden/sdk/miden-client');
    G.__off.guardianExecuteRequest = jest.fn(async () => ({
      result: retryableResult(),
      id: { toHex: () => '0xlanded' },
      prove: jest.fn()
    }));
    let dispatch: Promise<unknown> | null = null;
    const apply = jest
      .fn(async () => {})
      .mockImplementationOnce(async () => {
        dispatch = miden.__lastRunning();
        miden.__evictHolder();
        throw new Error('IndexedDB transaction aborted');
      });
    G.__off.guardianSubmitProven = jest.fn(async () => ({ apply }));
    G.__off.clientAccountsGet = jest.fn(async () => ({ to_commitment: () => ({ toHex: () => '0xinitial' }) }));
    const sendResponse = jest.fn();

    callGuardianPipeline(sendResponse);
    await waitForReply(sendResponse);
    const abandoned = await Promise.resolve(dispatch).catch((caught: unknown) => caught);

    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, errorName: 'WasmClientPoisonedError' });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(G.__off.clientAccountsGet).not.toHaveBeenCalled();
    expect(isApplyAfterSubmitError(abandoned)).toBe(true);
  });

  it('guardianPipeline: an apply that keeps failing replies with the landed transaction id beside its code (#1233)', async () => {
    await loadModule();
    G.__off.guardianExecuteRequest = jest.fn(async () => ({
      result: retryableResult(),
      id: { toHex: () => '0xlanded' },
      prove: jest.fn()
    }));
    G.__off.guardianSubmitProven = jest.fn(async () => ({
      apply: jest.fn(async () => {
        throw new Error('QuotaExceededError');
      })
    }));
    const sendResponse = jest.fn();

    callGuardianPipeline(sendResponse);
    await waitForReply(sendResponse);

    const reply = sendResponse.mock.calls[0][0];
    expect(reply).toMatchObject({
      ok: false,
      errorCode: 'ApplyTransactionAfterSubmitFailed',
      errorLanded: { transactionId: '0xlanded' }
    });
    expect(reply).not.toHaveProperty('errorTransactionId');
    expect(reply).not.toHaveProperty('errorPrivateOutputNotes');
  });

  it('guardianPipeline: a landed failure replies with its private output note count (#1233)', async () => {
    await loadModule();
    const { ApplyAfterSubmitError } = await import('lib/miden/sdk/sdk-error-code');
    G.__off.guardianExecuteRequest = jest.fn(async () => {
      throw new ApplyAfterSubmitError(new Error('QuotaExceededError'), {
        transactionId: '0xlanded',
        privateOutputNotes: 2
      });
    });
    const sendResponse = jest.fn();

    callGuardianPipeline(sendResponse);
    await waitForReply(sendResponse);

    const reply = sendResponse.mock.calls[0][0];
    expect(reply).toMatchObject({
      ok: false,
      errorCode: 'ApplyTransactionAfterSubmitFailed',
      errorLanded: { transactionId: '0xlanded', privateOutputNotes: 2 }
    });
    expect(reply).not.toHaveProperty('errorTransactionId');
    expect(reply).not.toHaveProperty('errorPrivateOutputNotes');
  });

  it('guardianPipeline: the executeRequest keystore sign reverses to the SW via OFFSCREEN_SIGN_REQUEST tagged with the op_id', async () => {
    await loadModule();
    let signatureSeen: Uint8Array | null = null;
    G.__off.guardianExecuteRequest = jest.fn(async () => {
      const signCb = G.__off.createOptions[0].signCallback;
      signatureSeen = await signCb(new Uint8Array([1, 2]), new Uint8Array([3, 4]));
      return {
        result: {
          serialize: () => new Uint8Array([55, 66, 77]),
          executedTransaction: () => ({ inputNotes: () => ({ notes: () => [] }), userOutputNotes: () => [] })
        },
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
      return m?.type === OFFSCREEN_SUBMIT_GATE ? { ok: true } : undefined;
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
  it('guardianPipeline marks the same three boundaries the inline pipeline stamps, the submit through its gate', async () => {
    await loadModule();
    const timeline: string[] = [];
    G.chrome.runtime.sendMessage = jest.fn(async (m: any) => {
      if (m?.type === 'OFFSCREEN_STAGE_EVENT') timeline.push(`stage:${m.stage}|${m.target}|${m.op_id}`);
      if (m?.type === OFFSCREEN_SUBMIT_GATE) {
        timeline.push(`gate|${m.target}|${m.op_id}`);
        return { ok: true };
      }
      return undefined;
    });
    G.__off.guardianExecuteRequest = jest.fn(async () => {
      timeline.push('executeRequest');
      return {
        result: {
          serialize: () => new Uint8Array([55, 66, 77]),
          executedTransaction: () => ({ inputNotes: () => ({ notes: () => [] }), userOutputNotes: () => [] })
        },
        id: { toHex: () => 'h' }
      };
    });
    mockProveTransport.prove.mockImplementationOnce(async () => {
      timeline.push('worker prove');
      return { proven: new Uint8Array([1]), durationMs: 1 };
    });
    G.__off.guardianSubmitProven = jest.fn(async () => {
      timeline.push('submitProven');
      return { apply: async () => timeline.push('apply') };
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
      'worker prove',
      'gate|sw|op-gstage',
      'submitProven',
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
  it('a still-running evicted dispatch cannot submit or stamp for its successor', async () => {
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
    let capturedOnStage: ((s: string) => Promise<void>) | undefined;
    let releaseFirst!: () => void;
    const firstParked = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    G.__off.clientSendTransaction = jest.fn(async (_tx: unknown, onStage?: (s: string) => Promise<void>) => {
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

    await expect(capturedOnStage!('submitting')).rejects.toThrow(/submit gate/);
    await flush();

    // The rejected old gate cannot record a crossing for either row.
    expect(posted).toEqual([]);

    releaseFirst();
    finishSuccessor({ serialize: () => new Uint8Array([2]) });
    await flush();
    expect(secondResponse.mock.calls[0][0].ok).toBe(true);
  });

});
