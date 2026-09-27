/**
 * The prove worker entry (#945), loaded fresh per test with the SDK mocked and the
 * worker globals (`postMessage`, the `message` listener, `crossOriginIsolated`,
 * `navigator.hardwareConcurrency`) stubbed on jsdom's window.
 */
import type { ProveWorkerMessage } from './prove-worker-protocol';

const mockSdk = {
  getWasmOrThrow: jest.fn(async (): Promise<unknown> => ({})),
  initThreadPool: jest.fn(async (_threads: number): Promise<unknown> => undefined),
  hasInitThreadPool: true,
  rayonThreadCount: jest.fn(() => 6),
  webClients: 0,
  webClientCtorShouldThrow: false,
  proveTransaction: jest.fn(async (_result: unknown, _prover: unknown) => mockProven),
  deserialize: jest.fn((_bytes: Uint8Array) => mockResult),
  newLocalProver: jest.fn(() => ({ local: true }))
};
const mockResult = { free: jest.fn() };
const mockProven = { serialize: jest.fn(() => new Uint8Array([4, 5, 6])), free: jest.fn() };

jest.mock('@miden-sdk/miden-sdk/mt/lazy', () => ({
  getWasmOrThrow: () => mockSdk.getWasmOrThrow(),
  get initThreadPool() {
    return mockSdk.hasInitThreadPool ? (threads: number) => mockSdk.initThreadPool(threads) : undefined;
  },
  rayonThreadCount: () => mockSdk.rayonThreadCount(),
  WebClient: class {
    constructor() {
      if (mockSdk.webClientCtorShouldThrow) throw new Error('WebClient ctor failed');
      mockSdk.webClients++;
    }
    proveTransaction(result: unknown, prover: unknown) {
      return mockSdk.proveTransaction(result, prover);
    }
  },
  TransactionResult: { deserialize: (bytes: Uint8Array) => mockSdk.deserialize(bytes) },
  TransactionProver: { newLocalProver: () => mockSdk.newLocalProver() }
}));

type Posted = { message: ProveWorkerMessage; transfer: Transferable[] };

let posted: Posted[];
let onMessage: ((event: MessageEvent) => void) | undefined;

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

async function loadWorker(opts: { coi?: boolean; cores?: number } = {}): Promise<void> {
  Object.defineProperty(globalThis, 'crossOriginIsolated', { value: opts.coi ?? true, configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: opts.cores ?? 8, configurable: true });
  jest.spyOn(globalThis, 'postMessage').mockImplementation((message: ProveWorkerMessage, options) => {
    const transfer = options && typeof options === 'object' && 'transfer' in options ? options.transfer : undefined;
    posted.push({ message, transfer: transfer ?? [] });
  });
  jest.spyOn(globalThis, 'addEventListener').mockImplementation((type: string, listener) => {
    if (type === 'message' && typeof listener === 'function') onMessage = listener;
  });
  await import('./prove-worker');
  await flush();
}

function send(data: unknown): void {
  if (!onMessage) throw new Error('the worker registered no message listener');
  onMessage(new MessageEvent('message', { data }));
}

const proveRequest = (id: number, proverDescriptor = 'local') => ({
  type: 'prove',
  id,
  txResult: new Uint8Array([1, 2, 3]),
  proverDescriptor
});

beforeEach(() => {
  jest.resetModules();
  posted = [];
  onMessage = undefined;
  mockSdk.hasInitThreadPool = true;
  mockSdk.webClients = 0;
  mockSdk.webClientCtorShouldThrow = false;
  mockSdk.getWasmOrThrow.mockImplementation(async () => ({}));
  mockSdk.initThreadPool.mockImplementation(async () => undefined);
  mockSdk.rayonThreadCount.mockImplementation(() => 6);
  mockSdk.proveTransaction.mockImplementation(async () => mockProven);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('prove worker boot', () => {
  it('reports not-cross-origin-isolated and never loads WASM or a pool when isolation is off', async () => {
    await loadWorker({ coi: false });
    expect(posted.map(p => p.message)).toEqual([
      { type: 'init-failed', reason: 'not-cross-origin-isolated', message: expect.any(String) }
    ]);
    expect(mockSdk.getWasmOrThrow).not.toHaveBeenCalled();
    expect(mockSdk.initThreadPool).not.toHaveBeenCalled();
  });

  it.each([
    [4, 4],
    [6, 6],
    [10, 6]
  ])('starts a pool of min(%i cores, 6) = %i threads, exactly once', async (cores, threads) => {
    await loadWorker({ cores });
    expect(mockSdk.initThreadPool).toHaveBeenCalledTimes(1);
    expect(mockSdk.initThreadPool).toHaveBeenCalledWith(threads);
  });

  it('posts ready with the thread count rayon reports', async () => {
    mockSdk.rayonThreadCount.mockReturnValue(5);
    await loadWorker();
    expect(posted.map(p => p.message)).toEqual([{ type: 'ready', threads: 5, crossOriginIsolated: true }]);
    expect(mockSdk.webClients).toBe(1);
  });

  it('reports wasm-load when the SDK binary fails to load', async () => {
    mockSdk.getWasmOrThrow.mockRejectedValue(new Error('fetch failed'));
    await loadWorker();
    expect(posted.map(p => p.message)).toEqual([{ type: 'init-failed', reason: 'wasm-load', message: 'fetch failed' }]);
  });

  it('reports thread-pool when the SDK build has no initThreadPool', async () => {
    mockSdk.hasInitThreadPool = false;
    await loadWorker();
    expect(posted.map(p => p.message)).toEqual([
      { type: 'init-failed', reason: 'thread-pool', message: 'initThreadPool is not exported by this SDK build' }
    ]);
  });

  it('reports thread-pool when the pool fails to start', async () => {
    mockSdk.initThreadPool.mockRejectedValue('no workers');
    await loadWorker();
    expect(posted.map(p => p.message)).toEqual([{ type: 'init-failed', reason: 'thread-pool', message: 'no workers' }]);
  });

  it('reports thread-pool when the WebClient constructor throws, and never posts ready', async () => {
    mockSdk.webClientCtorShouldThrow = true;
    await loadWorker();
    expect(posted.map(p => p.message)).toEqual([
      { type: 'init-failed', reason: 'thread-pool', message: 'WebClient ctor failed' }
    ]);
    expect(mockSdk.webClients).toBe(0);
  });

  it('reports thread-pool when rayonThreadCount throws after the pool starts', async () => {
    mockSdk.rayonThreadCount.mockImplementationOnce(() => {
      throw new Error('rayon query failed');
    });
    await loadWorker();
    expect(posted.map(p => p.message)).toEqual([
      { type: 'init-failed', reason: 'thread-pool', message: 'rayon query failed' }
    ]);
    expect(mockSdk.initThreadPool).toHaveBeenCalledTimes(1);
    expect(mockSdk.webClients).toBe(1);
  });
});

describe('prove worker proving', () => {
  it('proves the exact bytes with a local prover, transfers the proof and frees both handles', async () => {
    const provenBytes = new Uint8Array([4, 5, 6]);
    mockProven.serialize.mockReturnValueOnce(provenBytes);
    await loadWorker();
    posted = [];
    const request = proveRequest(7);
    send(request);
    await flush();

    expect(mockSdk.deserialize).toHaveBeenCalledWith(request.txResult);
    expect(mockSdk.newLocalProver).toHaveBeenCalledTimes(1);
    expect(mockSdk.proveTransaction).toHaveBeenCalledWith(mockResult, { local: true });
    expect(posted.map(p => p.message)).toEqual([
      { type: 'result', id: 7, ok: true, proven: provenBytes, durationMs: expect.any(Number) }
    ]);
    expect(posted[0]?.transfer).toHaveLength(1);
    expect(posted[0]?.transfer[0]).toBe(provenBytes.buffer);
    expect(mockResult.free).toHaveBeenCalledTimes(1);
    expect(mockProven.free).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-local prover descriptor without proving', async () => {
    await loadWorker();
    posted = [];
    send(proveRequest(8, 'remote|https://prover.example'));
    await flush();

    expect(posted.map(p => p.message)).toEqual([
      { type: 'result', id: 8, ok: false, message: 'unsupported prover descriptor' }
    ]);
    expect(mockSdk.proveTransaction).not.toHaveBeenCalled();
  });

  it('answers ok:false when proveTransaction rejects, and still frees the result', async () => {
    mockSdk.proveTransaction.mockRejectedValue(new Error('prover trapped'));
    await loadWorker();
    posted = [];
    send(proveRequest(9));
    await flush();

    expect(posted.map(p => p.message)).toEqual([{ type: 'result', id: 9, ok: false, message: 'prover trapped' }]);
    expect(mockResult.free).toHaveBeenCalledTimes(1);
    expect(mockProven.free).not.toHaveBeenCalled();
  });

  it('surfaces a free() failure asynchronously instead of stalling the queue, and the next prove still runs', async () => {
    const freeError = new Error('free failed');
    await loadWorker();
    posted = [];

    const realSetTimeout = globalThis.setTimeout;
    const capturedTimeouts: Array<() => void> = [];
    Object.defineProperty(globalThis, 'setTimeout', {
      value: (cb: () => void) => {
        capturedTimeouts.push(cb);
        return 0;
      },
      configurable: true,
      writable: true
    });

    const flushMicrotasks = async () => {
      for (let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    };

    try {
      mockResult.free.mockImplementationOnce(() => {
        throw freeError;
      });
      send(proveRequest(20));
      await flushMicrotasks();

      // the successful result already posted before free() threw in the `finally`
      expect(posted.map(p => p.message)).toEqual([
        { type: 'result', id: 20, ok: true, proven: expect.any(Uint8Array), durationMs: expect.any(Number) }
      ]);
      // the rejection is rescheduled onto a fresh macrotask, not swallowed and not
      // left to reject `queue` forever
      expect(capturedTimeouts).toHaveLength(1);
      expect(() => capturedTimeouts[0]?.()).toThrow(freeError);
    } finally {
      Object.defineProperty(globalThis, 'setTimeout', {
        value: realSetTimeout,
        configurable: true,
        writable: true
      });
    }

    posted = [];
    send(proveRequest(21));
    await flush();
    expect(posted.map(p => p.message)).toEqual([
      { type: 'result', id: 21, ok: true, proven: expect.any(Uint8Array), durationMs: expect.any(Number) }
    ]);
  });

  it('answers ok:false for a prove that arrives after a failed boot', async () => {
    await loadWorker({ coi: false });
    posted = [];
    send(proveRequest(10));
    await flush();

    expect(posted.map(p => p.message)).toEqual([
      { type: 'result', id: 10, ok: false, message: 'the prove worker did not start' }
    ]);
  });

  it('runs two proves posted together one after the other', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    mockSdk.proveTransaction
      .mockImplementationOnce(async () => {
        order.push('first started');
        await new Promise<void>(resolve => {
          releaseFirst = resolve;
        });
        order.push('first finished');
        return mockProven;
      })
      .mockImplementationOnce(async () => {
        order.push('second started');
        return mockProven;
      });
    await loadWorker();
    send(proveRequest(1));
    send(proveRequest(2));
    await flush();
    expect(order).toEqual(['first started']);

    releaseFirst();
    await flush();
    expect(order).toEqual(['first started', 'first finished', 'second started']);
  });

  it('ignores a message that is not a prove request', async () => {
    await loadWorker();
    posted = [];
    send({ type: 'prove', id: 'not-a-number' });
    await flush();
    expect(posted).toEqual([]);
    expect(mockSdk.proveTransaction).not.toHaveBeenCalled();
  });
});
