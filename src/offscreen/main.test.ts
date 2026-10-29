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

describe('offscreen/main — startup / init()', () => {
  it('boots the rayon pool and signals OFFSCREEN_READY (COI on, MT build, hwc known)', async () => {
    await loadModule({ coi: true, hwc: 8 });

    expect(G.__off.getWasmOrThrow).toHaveBeenCalledTimes(1);
    expect(G.__off.initThreadPool).toHaveBeenCalledWith(6);
    // COI on → no SharedArrayBuffer warning.
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('crossOriginIsolated=false'));
    // Timing + loaded log fired, plus the ready signal to the SW.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('initThreadPool(6) took'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('loaded'));
    expect(G.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_READY' });
    // Message listener registered.
    expect(typeof capturedListener).toBe('function');
  });

  it('installs the prove worker as the local prove transport without starting it (#945)', async () => {
    await loadModule();
    const { getLocalProveTransport } = await import('lib/miden/sdk/local-prove-transport');
    const transport = getLocalProveTransport();
    expect(transport).not.toBeNull();
    expect(mockProveTransport.prewarm).not.toHaveBeenCalled();
    expect(mockProveTransport.prove).not.toHaveBeenCalled();

    // Not just "an object with a function named prove" - any stub would pass that.
    // Calling it must reach the mocked ProveWorkerClient instance main.ts actually
    // constructed and installed, not a look-alike.
    const request = { txResult: new Uint8Array([7]) };
    await transport?.prove(request);
    expect(mockProveTransport.prove).toHaveBeenCalledWith(request, undefined);
  });

  // This realm has no extension storage: the network arrives with each call (#1482).
  it('boots without a storage read', async () => {
    await loadModule();
    expect(G.__off.getWasmOrThrow).toHaveBeenCalledTimes(1);
    expect(G.__off.storageCalls).toBe(0);
  });

  it('warns when crossOriginIsolated is false (SAB unavailable)', async () => {
    await loadModule({ coi: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('crossOriginIsolated=false'));
    // Still brings up the pool and signals ready.
    expect(G.__off.initThreadPool).toHaveBeenCalledWith(6);
    expect(G.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_READY' });
  });

  // Scaling saturates at the performance-core count and goes negative beyond it:
  // on a 4P+6E machine, 6 threads was 5386-5524ms while 8 was 5742-5860ms and 10
  // was 6424ms. See the table in main.ts for the full sweep.
  it.each([
    [8, 6],
    [10, 6],
    [16, 6]
  ])('caps the pool at 6 when hardwareConcurrency is %i', async (hwc, expected) => {
    resetControl();
    await loadModule({ hwc });
    expect(G.__off.initThreadPool).toHaveBeenCalledWith(expected);
  });

  it.each([
    [2, 2],
    [4, 4],
    [6, 6]
  ])('leaves a %i-core machine uncapped', async (hwc, expected) => {
    resetControl();
    await loadModule({ hwc });
    expect(G.__off.initThreadPool).toHaveBeenCalledWith(expected);
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
    expect(G.chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'OFFSCREEN_READY' });
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

describe('offscreen/main — telemetry forwarding', () => {
  it('installs a transport, because nothing else in this realm would', async () => {
    // The failure this catches, which the whole suite used to miss: the reporter
    // sends directly when it is the worker and uses an installed transport when
    // it is a page. This document is neither — it HAS a `window`, so it takes the
    // page branch, and it never loads the React app, so nothing installs one.
    // Left alone it silently drops every event, and proving happens HERE on the
    // extension's default build.
    await loadModule();
    const { reportOperation } = await import('lib/telemetry/report-operation');
    G.chrome.runtime.sendMessage.mockClear();

    reportOperation({ operation: 'prove', result: 'completed', durationMs: 5, step: 'prove_fallback' });
    await flush();

    expect(G.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'sw',
      type: 'OFFSCREEN_TELEMETRY_EVENT',
      event: expect.objectContaining({ phase: 'settled', operation: 'prove', step: 'prove_fallback' })
    });
  });

  it('does not let a forwarding failure escape into a prove', async () => {
    // The transport is awaited inside the reporter, which swallows — but this is
    // the realm where a stray rejection would take a transaction down with it,
    // so the property is worth pinning at the boundary rather than inferred from
    // a unit test two modules away.
    await loadModule();
    const { reportOperation } = await import('lib/telemetry/report-operation');
    G.chrome.runtime.sendMessage.mockRejectedValue(new Error('the worker is gone'));

    expect(() => reportOperation({ operation: 'prove', result: 'completed', durationMs: 5 })).not.toThrow();
    await flush();
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

  it.each([
    ['a null', null],
    ["a 'local'", 'local'],
    ['a non-string', 42]
  ])(
    'forwards the decoded bytes to the prove worker as a local prove for %s descriptor (#945)',
    async (_label, proverDescriptor) => {
      await loadModule();
      const sendResponse = jest.fn();
      const ret = capturedListener!(provReq({ proverDescriptor }), {}, sendResponse);
      expect(ret).toBe(true);
      await flush();

      expect(mockProveTransport.prove).toHaveBeenCalledTimes(1);
      expect(mockProveTransport.prove.mock.calls[0]?.[0]).toEqual({ txResult: new Uint8Array([9, 8, 7]) });
      // No WASM call in this realm at all: nothing deserialized, no prover, no client.
      expect(G.__off.deserializeTxResult).not.toHaveBeenCalled();
      expect(G.__off.newLocalProver).not.toHaveBeenCalled();
      expect(G.__off.webClientCtorCount).toBe(0);

      expect(sendResponse).toHaveBeenCalledTimes(1);
      const resp = sendResponse.mock.calls[0][0];
      expect(resp.ok).toBe(true);
      expect(resp.durationMs).toBe(42);
      expect(Array.from(Buffer.from(resp.provenB64, 'base64'))).toEqual([1, 2, 3]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('prove duration_ms='));
    }
  );

  it('answers ok:false for a string descriptor other than local without reaching the prove worker (#945)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    capturedListener!(provReq({ proverDescriptor: 'remote|http://x|5000' }), {}, sendResponse);
    await flush();

    expect(mockProveTransport.prove).not.toHaveBeenCalled();
    expect(G.__off.deserializeProver).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'unsupported prover descriptor' });
  });

  it('proves successive requests through the one worker client, constructing no WebClient here', async () => {
    await loadModule();
    const r1 = jest.fn();
    capturedListener!(provReq({ proverDescriptor: null }), {}, r1);
    await flush();
    const r2 = jest.fn();
    capturedListener!(provReq({ proverDescriptor: null }), {}, r2);
    await flush();

    expect(r1.mock.calls[0][0].ok).toBe(true);
    expect(r2.mock.calls[0][0].ok).toBe(true);
    expect(mockProveTransport.prove).toHaveBeenCalledTimes(2);
    // The one worker client: both proves went through the same construction, not one each.
    expect(mockProveTransport.ctorCount).toBe(1);
    expect(G.__off.webClientCtorCount).toBe(0);
  });

  it('responds ok:false with the Error message when the worker prove fails', async () => {
    await loadModule();
    mockProveTransport.prove.mockRejectedValueOnce(new Error('WASM exploded'));
    const sendResponse = jest.fn();
    capturedListener!(provReq({ proverDescriptor: null }), {}, sendResponse);
    await flush();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('prove failed'), expect.any(Error));
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'WASM exploded' });
  });

  it('responds ok:false with String(err) when the thrown value has no message', async () => {
    await loadModule();
    mockProveTransport.prove.mockRejectedValueOnce('raw failure string');
    const sendResponse = jest.fn();
    capturedListener!(provReq({ proverDescriptor: null }), {}, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'raw failure string' });
  });

  it('chunk-encodes proven output larger than 0x8000 bytes', async () => {
    await loadModule();
    const big = new Uint8Array(0x9000).fill(0x42);
    mockProveTransport.prove.mockResolvedValueOnce({ proven: big, durationMs: 1 });
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


// --- The network this realm runs on comes from the service worker (#1482) ---
//
// An offscreen document has no chrome.storage, so it cannot load the endpoint override
// the way the SW and the page do. The SW sends its endpoint state with every call and
// with OFFSCREEN_RELOAD_ENDPOINTS; these run on the REAL effective-endpoints module, with
// every storage call rejecting as it does in the real document.
describe('offscreen/main - the network comes from the service worker (#1482)', () => {
  // The realm's own effective-endpoints, which everything here but the client reads too
  // (bech32 prefixes, the native-asset scope). Required lazily: loading it pulls the SDK mock,
  // which reads the per-test control object.
  const realm = () => jest.requireActual('lib/miden-chain/effective-endpoints');
  const mainnet = () => ({ override: realm().buildNetworkChoiceOverride('mainnet'), feeFaucetId: '0xmainfee' });
  const custom = () => ({
    override: { ...realm().buildDefaultOverrideFor('devnet'), rpcUrl: 'https://custom.example/rpc' },
    feeFaucetId: '0xcustomfee'
  });
  const MAINNET_BUILD = {
    network: 'mainnet',
    rpcUrl: 'https://rpc.cedar.miden.io',
    proverUrl: 'https://tx-prover.cedar.miden.io',
    noteTransportUrl: 'https://transport.cedar.miden.io',
    feeFaucetId: '0xmainfee'
  };

  const callReq = (endpoints: unknown, op_id = 'op-network') => ({
    target: 'offscreen',
    type: 'OFFSCREEN_CALL',
    op_id,
    method: 'getAccount',
    deadline_ms: 1000,
    argsB64: [encodeArg('acc')],
    endpoints
  });
  const call = async (endpoints: unknown, op_id?: string) => {
    const reply = jest.fn();
    capturedListener!(callReq(endpoints, op_id), {}, reply);
    await flush();
    return reply.mock.calls[0]?.[0];
  };
  const reload = async (endpoints?: unknown) => {
    const ack = jest.fn();
    const ret = capturedListener!(
      { target: 'offscreen', type: 'OFFSCREEN_RELOAD_ENDPOINTS', ...(endpoints ? { endpoints } : {}) },
      {},
      ack
    );
    expect(ret).toBe(true);
    await flush();
    return ack.mock.calls[0]?.[0];
  };

  it('builds the client on the network the call carries, though this realm cannot read storage', async () => {
    await loadModule();
    expect((await call(mainnet())).ok).toBe(true);

    expect(G.__off.createEndpoints).toEqual([MAINNET_BUILD]);
    expect(realm().getEffectiveNetworkName()).toBe('mainnet');
    expect(G.__off.storageCalls).toBe(0);
  });

  it('refuses a call that carries no network state, and builds no client', async () => {
    await loadModule();
    const { endpoints: _none, ...bare } = callReq(undefined);
    const reply = jest.fn();
    capturedListener!(bare, {}, reply);
    await flush();

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toMatchObject({ ok: false, op_id: 'op-network', errorBeforeSubmit: true });
    expect(reply.mock.calls[0][0].error).toContain("call 'getAccount' carries no network state");
    expect(G.__off.createOptions).toHaveLength(0);
    expect(G.__off.clientGetAccount).not.toHaveBeenCalled();
  });

  it('rebuilds the client when a call carries another state, and reuses it for the same one', async () => {
    await loadModule();
    expect((await call(mainnet(), 'op-1')).ok).toBe(true);
    // An equal state in a fresh object, as every message delivers it.
    expect((await call(mainnet(), 'op-2')).ok).toBe(true);
    expect(G.__off.createEndpoints).toEqual([MAINNET_BUILD]);

    expect((await call(custom(), 'op-3')).ok).toBe(true);
    expect(G.__off.createEndpoints).toHaveLength(2);
    expect(G.__off.createEndpoints[1]).toMatchObject({
      network: 'devnet',
      rpcUrl: 'https://custom.example/rpc',
      feeFaucetId: '0xcustomfee'
    });
  });

  // Adopted on receipt, so the service worker's latest message wins in send order even on a cold document.
  it('a reload sent after a call wins when the call arrived while init was still pending', async () => {
    let finishInit!: () => void;
    G.__off.getWasmOrThrow = jest.fn(
      () =>
        new Promise<void>(resolve => {
          finishInit = resolve;
        })
    );
    await loadModule();
    const reply = jest.fn();
    capturedListener!(callReq(mainnet()), {}, reply);
    await flush();
    expect(await reload(custom())).toEqual({ ok: true });

    finishInit();
    await flush();
    expect(reply.mock.calls[0]?.[0]?.ok).toBe(true);
    expect(G.__off.createEndpoints).toEqual([
      expect.objectContaining({ rpcUrl: 'https://custom.example/rpc', feeFaucetId: '0xcustomfee' })
    ]);
  });

  it('a reload with state adopts it and drops the client', async () => {
    await loadModule();
    expect((await call(mainnet())).ok).toBe(true);

    expect(await reload(custom())).toEqual({ ok: true });
    expect(realm().getEffectiveRpcUrl()).toBe('https://custom.example/rpc');
    expect(realm().getEffectiveFeeFaucetId()).toBe('0xcustomfee');
    expect(G.__off.createEndpoints).toHaveLength(1);
    expect((await call(custom())).ok).toBe(true);
    expect(G.__off.createEndpoints).toHaveLength(2);
    expect(G.__off.createEndpoints[1].rpcUrl).toBe('https://custom.example/rpc');

    // The same state again still drops the client it was just rebuilt on: seed removal discards it this way.
    expect(await reload(custom())).toEqual({ ok: true });
    expect((await call(custom())).ok).toBe(true);
    expect(G.__off.createEndpoints).toHaveLength(3);
    expect(G.__off.createEndpoints[2].rpcUrl).toBe('https://custom.example/rpc');
  });

  it('refuses a reload without state, keeping the adopted state and the client', async () => {
    await loadModule();
    expect((await call(custom())).ok).toBe(true);

    const ack = await reload();
    expect(ack).toMatchObject({ ok: false });
    expect(ack.error).toContain('carries no network state');
    expect(realm().getEffectiveRpcUrl()).toBe('https://custom.example/rpc');
    expect((await call(custom())).ok).toBe(true);
    expect(G.__off.createEndpoints).toHaveLength(1);
  });

  it('a reload is answered ok:false, never dropped, when adopting its state throws', async () => {
    await loadModule();
    expect((await call(custom())).ok).toBe(true);
    const unreadable = {
      override: Object.defineProperty({ ...custom().override }, 'rpcUrl', {
        enumerable: true,
        get() {
          throw new Error('unreadable state');
        }
      }),
      feeFaucetId: '0xcustomfee'
    };

    expect(await reload(unreadable)).toEqual({ ok: false, error: 'unreadable state' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('endpoint reload failed'), expect.any(Error));
  });
});

// The SW sends OFFSCREEN_RELOAD_ENDPOINTS, carrying its endpoint state, when the saved override
// changes and when seed removal discards the client: its own resetMidenClient() reaches only the
// SW realm, while flag-on it is the client HERE that talks to the node.
describe('offscreen/main - OFFSCREEN_RELOAD_ENDPOINTS (endpoint overrides)', () => {
  const callReq = (extra: Record<string, unknown>) => ({
    target: 'offscreen',
    type: 'OFFSCREEN_CALL',
    op_id: 'op-endpoints',
    deadline_ms: 1000,
    argsB64: [],
    endpoints: SW_ENDPOINTS,
    ...extra
  });
  const reloadReq = { target: 'offscreen', type: 'OFFSCREEN_RELOAD_ENDPOINTS', endpoints: SW_ENDPOINTS };

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
    endpoints: SW_ENDPOINTS,
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

  it('leaves the prove worker alone: an OFFSCREEN_PROVE after a poisoning still proves through it (#945)', async () => {
    await loadModule();
    const request = { target: 'offscreen', type: 'OFFSCREEN_PROVE', txResultB64: Buffer.from([9]).toString('base64') };
    const p1 = jest.fn();
    capturedListener!(request, {}, p1);
    await flush();
    expect(p1.mock.calls[0][0].ok).toBe(true);

    firePoisoned();
    await flush();

    const p2 = jest.fn();
    capturedListener!(request, {}, p2);
    await flush();
    expect(p2.mock.calls[0][0].ok).toBe(true);
    // The worker's WASM instance is separate, so a trap here does not abort it and
    // this realm builds no prover of its own.
    expect(mockProveTransport.prove).toHaveBeenCalledTimes(2);
    expect(mockProveTransport.prove.mock.calls.map(call => call[0])).toEqual([
      { txResult: new Uint8Array([9]) },
      { txResult: new Uint8Array([9]) }
    ]);
    expect(G.__off.webClientCtorCount).toBe(0);
  });

  it('a decode that retires its trapped client replies with the data error and the next call rebuilds', async () => {
    await loadModule();
    const r1 = jest.fn();
    capturedListener!(callReq({}), {}, r1);
    await flush();
    expect(G.__off.createOptions).toHaveLength(1);

    let passedHold: unknown;
    let liveHold: unknown;
    G.__off.clientDecodeGuardianHistory = jest.fn(async (_encoded: string, hold: unknown) => {
      passedHold = hold;
      liveHold = jest.requireMock('lib/miden/sdk/miden-client').getCurrentWasmLockHold();
      firePoisoned();
      throw new GuardianHistoryDataError('Guardian summary does not deserialize', {
        cause: new WebAssembly.RuntimeError('unreachable')
      });
    });
    const r2 = jest.fn();
    capturedListener!(
      callReq({ op_id: 'op-2', method: 'decodeGuardianHistory', argsB64: [encodeArg('summary')] }),
      {},
      r2
    );
    await flush();
    expect(r2.mock.calls[0][0]).toMatchObject({
      ok: false,
      errorName: 'GuardianHistoryDataError',
      error: 'Guardian summary does not deserialize'
    });
    expect(liveHold).toBeDefined();
    expect(passedHold).toBe(liveHold);
    expect(G.__off.clientMarkPoisoned).toHaveBeenCalledTimes(1);

    const r3 = jest.fn();
    capturedListener!(callReq({ op_id: 'op-3' }), {}, r3);
    await flush();
    expect(r3.mock.calls[0][0].ok).toBe(true);
    expect(G.__off.createOptions).toHaveLength(2);
    expect(G.__off.createOptions[1].useWorker).toBe(false);
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
      return m?.type === OFFSCREEN_SUBMIT_GATE ? { ok: true } : undefined;
    });
    return posted;
  }

  const callReq = (extra: Record<string, unknown>) => ({
    target: 'offscreen',
    type: 'OFFSCREEN_CALL',
    op_id: 'op-markers',
    deadline_ms: 1000,
    argsB64: [],
    endpoints: SW_ENDPOINTS,
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

  it('names tip preparation as the last pipeline marker when the chain sync fails', async () => {
    await withE2EFlag('true', async () => {
      await loadModule();
      G.__off.clientSyncChain.mockRejectedValueOnce(new Error('tip sync failed'));
      const posted = capturePosts();
      capturedListener!(
        callReq({
          method: 'guardianPipeline',
          argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([9])), encodeArg(false), encodeArg('BwcH')]
        }),
        {},
        jest.fn()
      );
      await flush();

      const pipelineLines = markerLines(posted).filter(l => l.includes('] guardianPipeline '));
      expect(pipelineLines[pipelineLines.length - 1]).toContain('guardianPipeline preparing current tip');
      expect(pipelineLines.some(l => l.includes('guardianPipeline calling executeRequest'))).toBe(false);
    });
  });

  it('records tip execution after preparing the current tip', async () => {
    await withE2EFlag('true', async () => {
      await loadModule();
      const posted = capturePosts();
      capturedListener!(
        callReq({
          method: 'guardianPipeline',
          argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([9])), encodeArg(false), encodeArg('BwcH')]
        }),
        {},
        jest.fn()
      );
      await flush();

      expect(G.__off.clientSyncChain.mock.invocationCallOrder[0]).toBeLessThan(
        G.__off.guardianExecuteRequest.mock.invocationCallOrder[0]
      );
      expect(markerLines(posted).some(l => l.includes('guardianPipeline calling executeRequest at current tip'))).toBe(
        true
      );
    });
  });

  it('records nothing at all when the E2E flag is off (production builds)', async () => {
    await withE2EFlag(undefined, async () => {
      await loadModule();
      const posted = capturePosts();
      capturedListener!(
        callReq({
          method: 'guardianPipeline',
          // Four slots, the shape the SW packer always sends; the leaf reads
          // nothing from the 4th.
          argsB64: [encodeArg('acc'), encodeArg(new Uint8Array([9])), encodeArg(false), encodeArg('BwcH')]
        }),
        {},
        jest.fn()
      );
      await flush();

      expect(markerLines(posted)).toEqual([]);
    });
  });

  // #945: `ProveWorkerError.detail` carries the prover's real failure text, which
  // this realm's own `.message` never does (it is closed wallet text - see the
  // class doc). Without it on the FAILED marker too, a worker crash during a
  // guardian write leaves this trail saying only "crashed", the one thing a
  // developer already knew.
  it('carries a ProveWorkerError’s detail on the FAILED marker (#945)', async () => {
    await withE2EFlag('true', async () => {
      await loadModule();
      const { ProveWorkerError } = await import('lib/miden/sdk/local-prove-transport');
      mockProveTransport.prove.mockRejectedValueOnce(new ProveWorkerError('crashed', 'RuntimeError: unreachable'));
      const posted = capturePosts();
      capturedListener!(
        callReq({
          method: 'guardianPipeline',
          argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1])), encodeArg(false)]
        }),
        {},
        jest.fn()
      );
      await flush();

      const lines = markerLines(posted);
      expect(lines.some(l => /call 'guardianPipeline' FAILED .*detail=RuntimeError: unreachable$/.test(l))).toBe(true);
    });
  });

  // #1233: a failed apply after submit crosses back as `ApplyAfterSubmitError`, whose text
  // replaces the store's on the FAILED marker while its cause stays in this realm, so the
  // pipeline's own marker is the only record the harness can read of why the local write failed.
  it('names the store error when an apply fails after submit (#1233)', async () => {
    await withE2EFlag('true', async () => {
      await loadModule();
      G.__off.guardianSubmitProven = jest.fn(async () => ({
        apply: jest.fn(async () => {
          throw new Error('IndexedDB transaction aborted: QuotaExceededError');
        })
      }));
      const posted = capturePosts();
      capturedListener!(
        callReq({
          method: 'guardianPipeline',
          argsB64: [encodeArg('mtst1qguardian'), encodeArg(new Uint8Array([1])), encodeArg(false)]
        }),
        {},
        jest.fn()
      );
      await flush();

      const pipelineLines = markerLines(posted).filter(l => l.includes('] guardianPipeline '));
      expect(
        pipelineLines.some(l =>
          l.endsWith(
            'guardianPipeline apply FAILED after submit (Error: IndexedDB transaction aborted: QuotaExceededError)'
          )
        )
      ).toBe(true);
    });
  });
});

describe('offscreen fee identity transport', () => {
  it('bounds a parked identity IPC at 15 seconds and lets the next successful sync publish', async () => {
    await loadModule();
    jest.useFakeTimers();
    try {
      let messages = 0;
      G.chrome.runtime.sendMessage.mockImplementation((message: { type?: string }) => {
        if (message.type !== 'OFFSCREEN_NATIVE_ASSET_EVENT') return Promise.resolve(undefined);
        messages++;
        return messages === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true });
      });
      const first = jest.fn();
      const request = (op_id: string) => ({
        target: 'offscreen',
        type: 'OFFSCREEN_CALL',
        op_id,
        method: 'getSyncHeight',
        argsB64: [encodeArg(true)],
        deadlineMs: null,
        endpoints: SW_ENDPOINTS
      });
      capturedListener!(request('parked-fee-ipc'), {}, first);
      await jest.advanceTimersByTimeAsync(14_999);
      expect(first).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(first).toHaveBeenCalledTimes(1);
      expect(first.mock.calls[0]?.[0]).toMatchObject({ ok: true });
      expect(JSON.parse(atob(first.mock.calls[0]?.[0].resultB64))).toBe(5000);
      expect(messages).toBe(1);
      const second = jest.fn();
      capturedListener!(request('recovered-fee-ipc'), {}, second);
      await jest.advanceTimersByTimeAsync(0);
      expect(second.mock.calls[0]?.[0]).toMatchObject({ ok: true });
      expect(JSON.parse(atob(second.mock.calls[0]?.[0].resultB64))).toBe(5000);
      expect(messages).toBe(2);
      expect(G.__off.clientSyncState).toHaveBeenCalledTimes(2);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it.each(['syncState', 'waitForTransactionCommit', 'getSyncHeight'])(
    'publishes a scoped plain ID through runtime after %s without storage',
    async method => {
      await loadModule();
      G.chrome.runtime.sendMessage.mockImplementation(async (message: { type?: string }) =>
        message.type === 'OFFSCREEN_NATIVE_ASSET_EVENT' ? { ok: true } : undefined
      );
      const argsB64 =
        method === 'waitForTransactionCommit'
          ? [encodeArg('0xtxid')]
          : method === 'getSyncHeight'
            ? [encodeArg(true)]
            : [];
      const reply = jest.fn();
      capturedListener!(
        {
          target: 'offscreen',
          type: 'OFFSCREEN_CALL',
          op_id: 'fee-identity-transport',
          method,
          argsB64,
          deadlineMs: null,
          endpoints: SW_ENDPOINTS
        },
        {},
        reply
      );
      await flush();
      expect(G.chrome.runtime.sendMessage).toHaveBeenCalledWith({
        target: 'sw',
        type: 'OFFSCREEN_NATIVE_ASSET_EVENT',
        id: '0x817edea77acc5d71616e493afecea3',
        scope: 'offscreen-rpc|devnet'
      });
      expect(reply.mock.calls[0]?.[0]).toMatchObject({ ok: true });
    }
  );
});

describe('actual execution producer through offscreen encoder, proxy, cancellation and wire', () => {
  it.each(['ordinary_new_transaction', 'guardian_signed_request'])(
    'carries %s through every actual diagnostic boundary without sending private material',
    async route => {
      const previousDsn = process.env.SENTRY_DSN;
      const previousClient = process.env.MIDEN_USE_OFFSCREEN_CLIENT;
      const previousProving = process.env.MIDEN_USE_OFFSCREEN_PROVING;
      const previousRealm = G.__MIDEN_IN_OFFSCREEN_DOC__;
      const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
      process.env.SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      process.env.MIDEN_USE_OFFSCREEN_PROVING = 'false';
      const bodies: string[] = [];
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: async (_url: unknown, init?: { body?: unknown }) => {
          const body = init?.body;
          bodies.push(typeof body === 'string' ? body : ArrayBuffer.isView(body) ? new TextDecoder().decode(body) : '');
          return { status: 200, headers: new Headers() };
        }
      });
      let stopCrashReporting = () => {};
      try {
        await loadModule();
        const receiveOffscreen = capturedListener;
        if (!receiveOffscreen) throw new Error('offscreen dispatcher not installed');
        // The two realms share one Jest registry; only the SW-side route selector reads this marker here.
        G.__MIDEN_IN_OFFSCREEN_DOC__ = false;
        G.chrome.offscreen = { hasDocument: async () => true, createDocument: jest.fn(), closeDocument: jest.fn() };
        G.chrome.runtime.onMessage.removeListener = jest.fn();
        const endpoints = await import('lib/miden-chain/effective-endpoints');
        await endpoints.loadEndpointOverrides();
        const proxy = await import('lib/miden/back/miden-client-proxy');
        const Repo = await import('lib/miden/repo');
        const { cancelTransaction } = await import('lib/miden/transaction/cancel');
        const { ITransactionStatus } = await import('lib/miden/db/types');
        const { initCrashReporting, stopCrashReporting: stopReporting } = await import('lib/telemetry/crash');
        stopCrashReporting = stopReporting;
        const original = new Error(
          'assertion failed with error code: 15404814807981965102 private 0xabcdef amount 987654321 https://private.example/path'
        );
        G.__off.guardianExecuteRequest.mockRejectedValueOnce(original);
        const request = Object.freeze({ authArg: () => undefined });
        G.__off.deserializeTxRequest.mockReturnValueOnce(request);
        if (route === 'ordinary_new_transaction') {
          const { MidenClientInterface } = jest.requireActual<typeof import('lib/miden/sdk/miden-client-interface')>(
            'lib/miden/sdk/miden-client-interface'
          );
          const client: import('lib/miden/sdk/miden-client-interface').MidenClientInterface = Reflect.construct(
            MidenClientInterface,
            [
              {
                transactions: { executeRequest: G.__off.guardianExecuteRequest },
                accounts: { get: G.__off.clientAccountsGet }
              },
              'testnet'
            ]
          );
          G.__off.clientNewTransaction.mockImplementation(
            (
              account: string,
              bytes: Uint8Array,
              delegated: boolean | undefined,
              stage: Parameters<typeof client.newTransaction>[3]
            ) => client.newTransaction(account, bytes, delegated, stage)
          );
        }
        let encoded: unknown;
        G.chrome.runtime.sendMessage.mockImplementation(
          (message: { target?: string; type?: string; op_id?: string }) => {
            if (message.target === 'offscreen')
              return new Promise(resolve => {
                receiveOffscreen(message, {}, response => {
                  encoded = response;
                  resolve(response);
                });
              });
            if (message.type === 'OFFSCREEN_OP_STARTED' && message.op_id) proxy.markOpStarted(message.op_id);
            return Promise.resolve(undefined);
          }
        );
        initCrashReporting({ listenToGlobals: false });
        const bytes = new Uint8Array([11, 12, 13]);
        const running =
          route === 'ordinary_new_transaction'
            ? proxy.midenClientProxy.newTransaction('private-account', bytes, false, async () => new Uint8Array())
            : proxy.dispatchGuardianPipeline('private-account', bytes, false, async () => new Uint8Array());
        const reconstructed: unknown = await running.catch(error => error);
        expect(reconstructed).not.toBe(original);
        const { snapshotCrashDiagnostics } = await import('lib/telemetry/crash-diagnostics');
        expect(snapshotCrashDiagnostics(original)).toMatchObject({
          executionRoute: route,
          authObservation: 'observed'
        });
        expect(G.__off.guardianExecuteRequest).toHaveBeenCalledTimes(1);
        expect(G.__off.guardianExecuteRequest).toHaveBeenCalledWith('private-account', request);
        expect(G.__off.deserializeTxRequest).toHaveBeenCalledTimes(1);
        expect(G.__off.deserializeTxRequest).toHaveBeenCalledWith(bytes);
        expect(bytes).toEqual(new Uint8Array([11, 12, 13]));
        expect(G.__off.clientAccountsGet).not.toHaveBeenCalled();
        expect(G.__off.guardianSubmitted).toBe(false);
        const row: import('lib/miden/db/types').ITransaction = {
          id: 'private-execution-row',
          type: 'execute',
          accountId: 'private-account',
          status: ITransactionStatus.GeneratingTransaction,
          stage: 'sending',
          initiatedAt: Math.floor(Date.now() / 1000),
          displayIcon: 'SEND'
        };
        await Repo.transactions.put(row);
        await cancelTransaction(row, reconstructed);
        for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 5));
        const envelope = bodies.find(body => body.includes('WalletTransactionFailure'));
        expect(envelope).toBeDefined();
        expect(envelope).toContain('"executionRoute":"' + route + '"');
        expect(envelope).toContain('"executionObservation":"observed"');
        expect(envelope).toContain('"executionArguments":"absent"');
        expect(envelope).toContain('ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH');
        for (const sentinel of ['0xabcdef', '987654321', 'private.example', 'private-account', 'private-execution-row'])
          expect(envelope).not.toContain(sentinel);
        expect((await Repo.transactions.get(row.id))?.status).toBe(ITransactionStatus.Failed);
        expect(encoded).toMatchObject({
          ok: false,
          errorTransactionExecution: {
            executionRoute: route,
            authObservation: 'observed',
            authArgPresence: 'absent',
            authLayout: 'absent',
            commitmentMatch: 'unavailable',
            accountAuthCode: 'unavailable'
          }
        });
      } finally {
        stopCrashReporting();
        if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
        else Reflect.deleteProperty(globalThis, 'fetch');
        if (previousDsn === undefined) delete process.env.SENTRY_DSN;
        else process.env.SENTRY_DSN = previousDsn;
        if (previousClient === undefined) delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
        else process.env.MIDEN_USE_OFFSCREEN_CLIENT = previousClient;
        if (previousProving === undefined) delete process.env.MIDEN_USE_OFFSCREEN_PROVING;
        else process.env.MIDEN_USE_OFFSCREEN_PROVING = previousProving;
        G.__MIDEN_IN_OFFSCREEN_DOC__ = previousRealm;
      }
    }
  );
});

describe('Task4C3F offscreen acquired-file acknowledgement', () => {
  async function fixture() {
    await loadModule();
    const { MidenClientInterface } = jest.requireActual<typeof import('lib/miden/sdk/miden-client-interface')>(
      'lib/miden/sdk/miden-client-interface'
    );
    const endpoints = await import('lib/miden-chain/effective-endpoints');
    const health = await import('lib/miden/storage-health');
    const bytes = new Uint8Array([19, 48, 62]);
    const noteId = 'ab'.repeat(32);
    const body = {
      metadata: () => ({ noteType: () => 0, free: () => undefined }),
      recipient: () => ({ digest: () => ({ toFelts: () => [1, 2, 3, 4] }) }),
      assets: () => ({ assets: () => [] }),
      free: () => undefined
    };
    const file = {
      note: () => body,
      noteDetails: () => undefined,
      noteId: () => ({ toString: () => noteId, free: () => undefined }),
      serialize: () => bytes.slice()
    };
    G.__off.deserializeAcquiredNoteFile = jest.fn(() => file);
    const imported = jest.fn(async () => noteId);
    const client: import('lib/miden/sdk/miden-client-interface').MidenClientInterface = Reflect.construct(
      MidenClientInterface,
      [{ notes: { import: imported } }, endpoints.getEffectiveNetworkName()]
    );
    G.__off.clientImportNoteBytes.mockImplementation(
      (input: Uint8Array, hold: import('lib/miden/sdk/miden-client').WasmLockHold) =>
        client.importNoteBytes(input, hold)
    );
    let acknowledge: (reply: unknown) => void = () => undefined;
    const acquisitionMessages: unknown[] = [];
    G.chrome.runtime.sendMessage.mockImplementation((message: { type?: string }) => {
      if (message.type === 'OFFSCREEN_NOTE_ACQUISITION') {
        acquisitionMessages.push(message);
        return new Promise(resolve => {
          acknowledge = resolve;
        });
      }
      return Promise.resolve(message.type === OFFSCREEN_STORAGE_HEALTH ? { status: 'healthy', epoch: 0 } : undefined);
    });
    const reply = jest.fn();
    const request = {
      target: 'offscreen',
      type: 'OFFSCREEN_CALL',
      op_id: 'acquisition-operation',
      method: 'importNoteBytes',
      argsB64: [encodeArg(bytes)],
      deadline_ms: 1000,
      storageHealth: { status: 'healthy', epoch: 0 },
      endpoints: { override: null, feeFaucetId: undefined }
    };
    expect(capturedListener?.(request, {}, reply)).toBe(true);
    await flush();
    return {
      bytes,
      noteId,
      imported,
      health,
      reply,
      request,
      acquisitionMessages,
      acknowledge: (response: unknown) => acknowledge(response)
    };
  }

  it('retains the exact generated file through its operation before SDK import and success reply', async () => {
    const f = await fixture();
    try {
      expect(f.acquisitionMessages).toEqual([
        expect.objectContaining({
          target: 'sw',
          type: 'OFFSCREEN_NOTE_ACQUISITION',
          op_id: f.request.op_id,
          epoch: 0,
          notes: [
            {
              kind: 'note',
              id: f.noteId,
              detailsId: 'cd'.repeat(32),
              noteFile: Array.from(f.bytes),
              provenance: 'input',
              format: 'full'
            }
          ]
        })
      ]);
      expect(f.imported).not.toHaveBeenCalled();
      expect(f.reply).not.toHaveBeenCalled();
      f.acknowledge({ ok: true, op_id: f.request.op_id });
      await flush();
      expect(f.imported).toHaveBeenCalledTimes(1);
      expect(G.__off.deserializeAcquiredNoteFile).toHaveBeenCalledWith(f.bytes);
      expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true, op_id: f.request.op_id }));
    } finally {
      f.acknowledge({ ok: false, op_id: f.request.op_id });
      await flush();
    }
  });

  it.each(['refused', 'missing', 'wrong operation'])(
    'refuses a %s retention response before SDK import',
    async response => {
      const f = await fixture();
      try {
        expect(f.acquisitionMessages).toHaveLength(1);
        f.acknowledge(
          response === 'missing'
            ? undefined
            : {
                ok: response !== 'refused',
                op_id: response === 'wrong operation' ? 'other-operation' : f.request.op_id
              }
        );
        await flush();
        expect(f.imported).not.toHaveBeenCalled();
        expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, op_id: f.request.op_id }));
        expect(f.health.getStorageHealth().status).toBe('healthy');
      } finally {
        f.acknowledge({ ok: false, op_id: f.request.op_id });
        await flush();
      }
    }
  );

  it('rejects a late retention ACK after its WASM hold was evicted', async () => {
    const f = await fixture();
    try {
      expect(f.acquisitionMessages).toHaveLength(1);
      const mutex = jest.requireMock('lib/miden/sdk/miden-client');
      mutex.__evictHolder();
      await flush();
      f.acknowledge({ ok: true, op_id: f.request.op_id });
      await flush();
      expect(f.imported).not.toHaveBeenCalled();
      expect(f.reply).toHaveBeenCalledTimes(1);
      expect(f.reply).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, op_id: f.request.op_id, errorName: 'WasmClientPoisonedError' })
      );
      expect(f.health.getStorageHealth().status).toBe('healthy');
    } finally {
      f.acknowledge({ ok: false, op_id: f.request.op_id });
      await flush();
    }
  });
});

describe('Task4C3G5 offscreen canonical recovery option', () => {
  async function fixture() {
    await loadModule();
    G.chrome.runtime.id = 'wallet-extension';
    const health = await import('lib/miden/storage-health');
    await health.initializeStorageHealth();
    expect(health.getStorageHealth().status).toBe('healthy');
    const { toSerializable } = await import('lib/miden/recovery/serialization');
    const family: import('lib/miden/recovery/types').RecoveryNoteEntry = {
      kind: 'note',
      id: '34'.repeat(32),
      detailsId: '34'.repeat(32),
      noteFile: new Uint8Array([19, 48, 80]),
      provenance: 'input',
      format: 'details',
      candidates: [{ id: '12'.repeat(32), noteFile: new Uint8Array([19, 48, 81]), provenance: 'input', format: 'full' }]
    };
    const snapshot = {
      generation: 'sdk-route',
      accounts: [{ accountId: 'retained', nonce: '4', commitment: 'state-4' }],
      notes: [],
      canonicalNotes: [
        {
          familyId: family.id,
          id: '12'.repeat(32),
          detailsId: family.detailsId,
          noteFile: new Uint8Array([19, 48, 81])
        }
      ]
    };
    const read = jest.fn(async (_accounts: string[], _include: boolean, assertLive: () => void) => {
      assertLive();
      return snapshot;
    });
    const { MidenClientInterface } = jest.requireMock('lib/miden/sdk/miden-client-interface');
    MidenClientInterface.createForRecovery = jest.fn(
      async (capability: import('lib/miden/storage-health').StorageRecoveryCapability) => {
        health.assertStorageRecoveryAllowed(capability);
        return { readStorageContinuity: read };
      }
    );
    const request = (families: unknown) => ({
      target: 'offscreen',
      type: 'OFFSCREEN_CALL',
      op_id: 'canonical-route-operation',
      deadline_ms: 1000,
      method: 'readStorageContinuity',
      argsB64: [encodeArg(['retained']), encodeArg(false), encodeArg([]), encodeArg(toSerializable(families))],
      endpoints: SW_ENDPOINTS,
      recoveryAccess: { epoch: health.getStorageHealth().epoch, expiresAt: Date.now() + 1000 }
    });
    return { family, snapshot, read, request, health, toSerializable };
  }

  it('forwards the bounded canonical families under the actual recovery capability and hold', async () => {
    const { family, snapshot, read, request, toSerializable } = await fixture();
    const reply = jest.fn();
    capturedListener!(request([family]), { id: 'wallet-extension' }, reply);
    await flush();
    expect(read).toHaveBeenCalledWith(['retained'], false, expect.any(Function), [], [family]);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    const response: unknown = reply.mock.calls[0]?.[0];
    if (typeof response !== 'object' || response === null) throw new Error('Missing canonical response');
    const encoded: unknown = Reflect.get(response, 'resultB64');
    if (typeof encoded !== 'string') throw new Error('Missing canonical response bytes');
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString())).toEqual(toSerializable(snapshot));
  });

  it.each(['families', 'candidate bytes'])(
    'refuses malformed canonical %s before invoking the SDK reader',
    async invalid => {
      const { family, read, request, health } = await fixture();
      const families = invalid === 'families' ? Array.from({ length: 5 }, () => family) : [family];
      const message = request(families);
      if (invalid === 'candidate bytes') {
        const raw = {
          ...family,
          noteFile: [19, 48, 80],
          candidates: [{ id: '12'.repeat(32), provenance: 'input', noteFile: [999] }]
        };
        message.argsB64[3] = encodeArg([raw]);
      }
      const reply = jest.fn();
      capturedListener!(message, { id: 'wallet-extension' }, reply);
      await flush();
      expect(read).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
      expect(health.getStorageHealth().status).toBe('healthy');
    }
  );

  it('keeps the existing foreign sender refusal for canonical recovery reads', async () => {
    const { family, read, request, health } = await fixture();
    const reply = jest.fn();
    capturedListener!(request([family]), { id: 'foreign-extension' }, reply);
    await flush();
    expect(read).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'Unauthorized recovery read' }));
    expect(health.getStorageHealth().status).toBe('healthy');
  });
});

describe('Task4C3N2 offscreen retained primary acknowledgement', () => {
  async function fixture({ contextChange = '', expired = false } = {}) {
    await loadModule();
    G.chrome.runtime.id = 'wallet-extension';
    const health = await import('lib/miden/storage-health');
    const endpoints = await import('lib/miden-chain/effective-endpoints');
    const { nativeNoteAcquisition } = await import('lib/miden/sdk/native-note-acquisition');
    const actual = jest.requireActual<typeof import('lib/miden/sdk/miden-client-interface')>(
      'lib/miden/sdk/miden-client-interface'
    );
    const mocked = jest.requireMock<typeof import('lib/miden/sdk/miden-client-interface')>(
      'lib/miden/sdk/miden-client-interface'
    );
    await health.initializeStorageHealth();
    expect(health.getStorageHealth().status).toBe('healthy');
    const bytes = new Uint8Array([19, 48, 121]);
    const canonicalBytes = new Uint8Array([19, 48, 122]);
    const noteId = 'ab'.repeat(32);
    const detailsId = 'cd'.repeat(32);
    const sender = '0x' + '11'.repeat(15);
    const body = {
      metadata: () => ({
        sender: () => ({ toString: () => sender, free: () => {} }),
        noteType: () => 0,
        tag: () => ({ asU32: () => 7, free: () => {} }),
        free: () => {}
      }),
      recipient: () => ({ digest: () => ({ toFelts: () => [1, 2, 3, 4] }) }),
      assets: () => ({ assets: () => [] }),
      free: () => {}
    };
    const file = {
      note: () => body,
      noteDetails: () => undefined,
      inclusionProof: () => undefined,
      noteId: () => ({ toString: () => '0x' + noteId, free: () => {} }),
      nullifier: () => '0x' + 'ef'.repeat(32),
      noteTag: () => undefined,
      afterBlockNum: () => undefined,
      serialize: () => canonicalBytes.slice(),
      free: () => {}
    };
    G.__off.deserializeAcquiredNoteFile = jest.fn(() => file);
    let adopted = false;
    let generation = Array.from(new TextEncoder().encode('retained-sdk'));
    let gate: import('@miden-sdk/miden-sdk/lazy').NoteAcquisitionOptions['beforeNoteAcquisition'];
    const candidate: import('@miden-sdk/miden-sdk/lazy').NoteAcquisitionCandidate = {
      operationId: 'offscreen-native-import',
      noteFileBytes: canonicalBytes,
      variant: 'committed',
      source: 'import',
      batchIndex: 0,
      batchCount: 1,
      noteId: '0x' + noteId,
      detailsCommitment: '0x' + detailsId,
      nullifier: '0x' + 'ef'.repeat(32),
      metadata: { sender, noteType: 0, tag: 7, attachmentsCommitment: '0x' + '77'.repeat(32) },
      tag: 7
    };
    const imported = jest.fn(async () => {
      if (!gate) throw new Error('Missing protected import callback fixture');
      await gate(candidate);
      adopted = true;
      return '0x' + noteId;
    });
    const list = jest.fn(async () =>
      adopted ? [{ details: () => body, state: () => 2, isAuthenticated: () => true, free: () => {} }] : []
    );
    const settings = {
      get: jest.fn(async () => generation),
      set: jest.fn(async (_key: string, value: number[]) => {
        generation = value;
      })
    };
    const sdkClient = {
      notes: { import: imported, list },
      settings,
      accounts: {
        get: jest.fn(async () => ({
          nonce: () => ({ asInt: () => 4n }),
          to_commitment: () => ({ toHex: () => 'state-4', free: () => {} })
        }))
      },
      terminate: jest.fn()
    };
    const client: import('lib/miden/sdk/miden-client-interface').MidenClientInterface = Reflect.apply(
      actual.MidenClientInterface.fromClient,
      actual.MidenClientInterface,
      [sdkClient, endpoints.getEffectiveNetworkName()]
    );
    gate = nativeNoteAcquisition(
      endpoints.getEffectiveNetworkName(),
      () => !client.isDisposed,
      () => sdkClient
    ).beforeNoteAcquisition;
    mocked.MidenClientInterface.createForRecovery = jest.fn(async capability => {
      health.assertStorageRecoveryAllowed(capability);
      return client;
    });
    let acknowledge: (value: unknown) => void = () => {};
    const messages: unknown[] = [];
    G.chrome.runtime.sendMessage.mockImplementation((message: { type?: string }) => {
      if (message.type === 'OFFSCREEN_NOTE_ACQUISITION') {
        messages.push(message);
        return new Promise(resolve => {
          acknowledge = resolve;
        });
      }
      return Promise.resolve(message.type === OFFSCREEN_STORAGE_HEALTH ? health.getStorageHealth() : undefined);
    });
    health.markStorageUnavailable('continuity', { backend: 'sdk', operation: 'validate' });
    const incident = health.getStorageHealth();
    const command = {
      kind: 'note',
      note: { kind: 'note', id: noteId, detailsId, noteFile: Array.from(bytes), provenance: 'input', format: 'full' },
      accountId: 'retained-account'
    };
    const context = {
      scope: {
        network: `${endpoints.getEffectiveNetworkName()}:${endpoints.getEffectiveRpcUrl()}`,
        walletGeneration: 'retained-wallet',
        sdkGeneration: contextChange === 'wrong SDK generation' ? 'foreign-sdk' : 'retained-sdk'
      },
      sequence: 7,
      accountId: 'retained-account',
      primaryId: contextChange === 'foreign primary' ? 'aa'.repeat(32) : noteId,
      detailsId,
      ...(contextChange === 'untrusted permission field' ? { trusted: true } : {})
    };
    if (contextChange === 'wrong network') context.scope.network = 'foreign:rpc';
    const request = {
      target: 'offscreen',
      type: 'OFFSCREEN_CALL',
      deadline_ms: 1000,
      endpoints: SW_ENDPOINTS,
      op_id: 'retained-recovery-operation',
      method: 'restoreStorageRecovery',
      argsB64: [encodeArg(command), encodeArg(context)],
      recoveryAccess: { epoch: incident.epoch, expiresAt: Date.now() + (expired ? -1 : 4000) },
      storageHealth: incident
    };
    const reply = jest.fn();
    expect(capturedListener?.(request, { id: 'wallet-extension' }, reply)).toBe(true);
    await flush();
    return {
      client,
      bytes,
      canonicalBytes,
      imported,
      list,
      settings,
      messages,
      request,
      reply,
      health,
      incident,
      adopted: () => adopted,
      acknowledge: (value: unknown) => acknowledge(value),
      restore: async () => {
        acknowledge({ ok: false, op_id: request.op_id });
        await flush();
        client.free();
      }
    };
  }

  it('waits for the live backend receipt ACK before SDK adoption or a success reply', async () => {
    const f = await fixture();
    try {
      expect(f.messages).toEqual([
        expect.objectContaining({
          type: 'OFFSCREEN_NOTE_ACQUISITION',
          op_id: f.request.op_id,
          epoch: f.incident.epoch,
          notes: [expect.objectContaining({ noteFile: Array.from(f.canonicalBytes) })]
        })
      ]);
      expect(f.canonicalBytes).not.toEqual(f.bytes);
      expect(f.adopted()).toBe(false);
      expect(f.reply).not.toHaveBeenCalled();
      f.acknowledge({ ok: true, op_id: f.request.op_id });
      await flush();
      expect(f.adopted()).toBe(true);
      expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true, op_id: f.request.op_id }));
      expect(f.settings.set).not.toHaveBeenCalled();
      expect(f.health.getStorageHealth()).toEqual(f.incident);
    } finally {
      await f.restore();
    }
  });

  it.each(['refused', 'missing', 'wrong operation'])(
    'refuses a %s backend receipt response before adoption',
    async response => {
      const f = await fixture();
      try {
        expect(f.messages).toHaveLength(1);
        f.acknowledge(
          response === 'missing'
            ? undefined
            : {
                ok: response !== 'refused',
                op_id: response === 'wrong operation' ? 'foreign-operation' : f.request.op_id
              }
        );
        await flush();
        expect(f.adopted()).toBe(false);
        expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, op_id: f.request.op_id }));
        expect(f.settings.set).not.toHaveBeenCalled();
        expect(f.health.getStorageHealth()).toEqual(f.incident);
      } finally {
        await f.restore();
      }
    }
  );

  it('refuses a late positive receipt ACK after the actual client retires', async () => {
    const f = await fixture();
    try {
      expect(f.messages).toHaveLength(1);
      f.client.markPoisoned();
      f.acknowledge({ ok: true, op_id: f.request.op_id });
      await flush();
      expect(f.adopted()).toBe(false);
      expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, op_id: f.request.op_id }));
      expect(f.settings.set).not.toHaveBeenCalled();
      expect(f.health.getStorageHealth()).toEqual(f.incident);
    } finally {
      await f.restore();
    }
  });

  it.each(['untrusted permission field', 'wrong SDK generation', 'wrong network', 'foreign primary'])(
    'refuses %s before entering SDK import',
    async contextChange => {
      const f = await fixture({ contextChange });
      try {
        expect(f.imported).not.toHaveBeenCalled();
        expect(f.messages).toHaveLength(0);
        expect(f.adopted()).toBe(false);
        expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(f.settings.set).not.toHaveBeenCalled();
        expect(f.health.getStorageHealth()).toEqual(f.incident);
      } finally {
        await f.restore();
      }
    }
  );

  it('refuses an expired recovery capability before SDK import or a receipt request', async () => {
    const f = await fixture({ expired: true });
    try {
      expect(f.imported).not.toHaveBeenCalled();
      expect(f.messages).toHaveLength(0);
      expect(f.adopted()).toBe(false);
      expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
      expect(f.settings.set).not.toHaveBeenCalled();
      expect(f.health.getStorageHealth()).toEqual(f.incident);
    } finally {
      await f.restore();
    }
  });
});
