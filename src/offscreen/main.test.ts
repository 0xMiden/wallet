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

type Listener = (msg: any, sender: any, sendResponse: (r?: any) => void) => boolean | undefined;

const G = globalThis as any;

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
    newLocalProver: jest.fn(() => ({ __local: true }))
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
