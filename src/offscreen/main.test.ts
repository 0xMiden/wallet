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

import { encodeArg } from 'lib/miden/back/offscreen-codec';

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
    deserializeProver: jest.fn(async (d: string) => ({ __fromDescriptor: d })),
    newLocalProver: jest.fn(() => ({ __local: true })),
    // OFFSCREEN_CALL dispatch: the offscreen-owned client's getAccount returns
    // an Account-like object exposing serialize() (the SDK's real serializer).
    clientGetAccount: jest.fn(async (_id: string) => ({ serialize: () => new Uint8Array([10, 20, 30]) })),
    // Slice-3 read methods on the offscreen-owned client.
    clientSyncState: jest.fn(async () => ({ __syncSummary: true })),
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
    getMidenClient: jest.fn(async () => ({
      getAccount: (...a: any[]) => (globalThis as any).__off.clientGetAccount(...a),
      syncState: (...a: any[]) => (globalThis as any).__off.clientSyncState(...a),
      exportNote: (...a: any[]) => (globalThis as any).__off.clientExportNote(...a),
      getInputNoteDetails: (...a: any[]) => (globalThis as any).__off.clientGetInputNoteDetails(...a),
      getConsumableNoteDtos: (...a: any[]) => (globalThis as any).__off.clientGetConsumableNoteDtos(...a)
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
});
