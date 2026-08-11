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
// never touch getMidenClient. `withWasmClientLock` is a real (tiny) mutex so
// W1's serialization of concurrent OFFSCREEN_CALLs is testable; its closure
// state resets per test because loadModule() re-runs this factory after
// jest.resetModules().
jest.mock('lib/miden/sdk/miden-client', () => {
  const g = globalThis as any;
  let locked = false;
  const waiters: Array<() => void> = [];
  const withWasmClientLock = async <T>(op: () => Promise<T>): Promise<T> => {
    if (locked) await new Promise<void>(resolve => waiters.push(resolve));
    else locked = true;
    try {
      return await op();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else locked = false;
    }
  };
  return {
    getMidenClient: (...a: any[]) => g.__off.getMidenClient(...a),
    withWasmClientLock
  };
});

// Slice 5: the offscreen doc creates its client via `MidenClientInterface.create`
// (with the reverse-IPC sign stub + `useWorker:false`) instead of the SW
// singleton `getMidenClient`. Delegate `create` to the SAME `g.__off.getMidenClient`
// control fn so the existing "reuses client" / "S1 retry" assertions keep working;
// the create options are captured on `g.__off.createOptions` for the new assertions.
jest.mock('lib/miden/sdk/miden-client-interface', () => {
  const g = globalThis as any;
  return {
    MidenClientInterface: {
      create: (opts: any) => {
        g.__off.createOptions.push(opts);
        return g.__off.getMidenClient(opts);
      }
    }
  };
});

let capturedListener: Listener | undefined;
let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

function resetControl() {
  G.__off = {
    getWasmOrThrow: jest.fn(async () => {}),
    hasInitThreadPool: true,
    initThreadPool: jest.fn(async () => {}),
    webClientCtorCount: 0,
    proveTransaction: jest.fn(async () => ({ serialize: () => new Uint8Array([1, 2, 3]) })),
    deserializeTxResult: jest.fn(() => ({ __txResult: true })),
    // Slice 6a: TransactionRequest.deserialize(trBytes) → a request handle the
    // guardianPipeline hands to executeRequest. Echo the bytes so the test can
    // assert the co-signed request crossed intact.
    deserializeTxRequest: jest.fn((b: Uint8Array) => ({ __trFromBytes: Array.from(b) })),
    deserializeProver: jest.fn(async (d: string) => ({ __fromDescriptor: d })),
    newLocalProver: jest.fn(() => ({ __local: true })),
    // OFFSCREEN_CALL dispatch: the offscreen-owned client's getAccount returns
    // an Account-like object exposing serialize() (the SDK's real serializer).
    clientGetAccount: jest.fn(async (_id: string) => ({ serialize: () => new Uint8Array([10, 20, 30]) })),
    // Slice-3 read methods on the offscreen-owned client.
    clientSyncState: jest.fn(async () => ({ __syncSummary: true })),
    // Slice-6b structural commit-wait on the offscreen-owned client (void).
    clientWaitForTransactionCommit: jest.fn(async (_id: string) => {}),
    clientExportNote: jest.fn(async (_id: string, _t: string) => new Uint8Array([44, 55, 66])),
    clientGetInputNoteDetails: jest.fn(async (_q: unknown) => [
      { noteId: '0xabc', senderAccountId: 'mtst1qsender', assets: [], noteType: 0, nullifier: '0xn', state: 2 }
    ]),
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
    getMidenClient: jest.fn(async () => ({
      getAccount: (...a: any[]) => (globalThis as any).__off.clientGetAccount(...a),
      syncState: (...a: any[]) => (globalThis as any).__off.clientSyncState(...a),
      waitForTransactionCommit: (...a: any[]) => (globalThis as any).__off.clientWaitForTransactionCommit(...a),
      exportNote: (...a: any[]) => (globalThis as any).__off.clientExportNote(...a),
      getInputNoteDetails: (...a: any[]) => (globalThis as any).__off.clientGetInputNoteDetails(...a),
      getConsumableNoteDtos: (...a: any[]) => (globalThis as any).__off.clientGetConsumableNoteDtos(...a),
      consumeNoteId: (...a: any[]) => (globalThis as any).__off.clientConsumeNoteId(...a),
      sendTransaction: (...a: any[]) => (globalThis as any).__off.clientSendTransaction(...a),
      swapTransaction: (...a: any[]) => (globalThis as any).__off.clientSwapTransaction(...a),
      newTransaction: (...a: any[]) => (globalThis as any).__off.clientNewTransaction(...a),
      // Slice-7a: getInputNote / importNoteBytes are interface methods on the
      // offscreen-owned client; the DISPATCH reduces getInputNote in-realm.
      getInputNote: (...a: any[]) => (globalThis as any).__off.clientGetInputNote(...a),
      importNoteBytes: (...a: any[]) => (globalThis as any).__off.clientImportNoteBytes(...a),
      // The raw client the guardian leaf pipeline + slice-7a sync-height/lineage
      // reads drive directly.
      client: {
        transactions: {
          executeRequest: (...a: any[]) => (globalThis as any).__off.guardianExecuteRequest(...a)
        },
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

  it('dispatches waitForTransactionCommit against the offscreen-owned client and returns resultB64:null (void)', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    const ret = capturedListener!(
      callReq({ method: 'waitForTransactionCommit', argsB64: [encodeArg('0xtxid')] }),
      {},
      sendResponse
    );
    expect(ret).toBe(true);
    await flush();

    // The commit-wait polled the OFFSCREEN-owned client — the realm that applied the
    // tx under the flag — with the id decoded across the wire. This is the fix: the SW
    // client is dormant flag-on and would time out; polling here uses the live state.
    expect(G.__off.clientWaitForTransactionCommit).toHaveBeenCalledWith('0xtxid');
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(true);
    expect(resp.op_id).toBe('op-abc');
    // The wait resolves void — nothing to serialize back to the SW.
    expect(resp.resultB64).toBeNull();
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

  it('getInputNoteDetails maps a JSON-null query arg back to undefined for the SDK', async () => {
    await loadModule();
    const sendResponse = jest.fn();
    // encodeArg(undefined) → 's:null'; decodeArg → null; dispatch does `?? undefined`.
    capturedListener!(callReq({ method: 'getInputNoteDetails', argsB64: [encodeArg(undefined)] }), {}, sendResponse);
    await flush();

    expect(G.__off.clientGetInputNoteDetails).toHaveBeenCalledWith(undefined);
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
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

  it('guardianPipeline (delegated): proves remote via empty prove({}), never a local prover, then submits/applies', async () => {
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

    // Delegated success uses the client's default (remote) prover: prove({}).
    expect(G.__off.guardianProveCalls).toEqual([{}]);
    expect(G.__off.newLocalProver).not.toHaveBeenCalled();
    expect(G.__off.guardianApplied).toBe(true);
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

    // First attempt: remote prove({}) threw. Second: local newLocalProver.
    expect(G.__off.guardianProveCalls[0]).toEqual({});
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
});
