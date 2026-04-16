import { runWhenClientIdle, withWasmClientLock } from './miden-client';

// Historical context: `withWasmClientLock` used to serialize every WASM call
// through a wallet-side global mutex. That responsibility moved into
// `@miden-sdk/miden-sdk` itself (WebClient's `_serializeWasmCall` chain),
// so this wrapper is now a pass-through. Call sites still use the name
// while we migrate; new code should call the SDK directly or use
// `midenClient.waitForIdle()` for coordination.
describe('withWasmClientLock (pass-through)', () => {
  it('executes the operation and returns its result', async () => {
    const result = await withWasmClientLock(async () => 'test-result');
    expect(result).toBe('test-result');
  });

  it('propagates errors from the operation', async () => {
    await expect(
      withWasmClientLock(async () => {
        throw new Error('test error');
      })
    ).rejects.toThrow('test error');
  });

  it('does not block concurrent callers (serialization now handled by SDK)', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const ops = Array.from({ length: 5 }, (_, i) =>
      withWasmClientLock(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise(resolve => setTimeout(resolve, 20));
        concurrentCount--;
        return i;
      })
    );

    await Promise.all(ops);

    // The wrapper no longer serializes — the SDK handles that internally.
    // At least two ops should have overlapped, proving the wrapper is a
    // pure pass-through rather than a mutex.
    expect(maxConcurrent).toBeGreaterThan(1);
  });
});

describe('runWhenClientIdle', () => {
  it('runs idle tasks asynchronously', async () => {
    let executed = false;

    runWhenClientIdle(async () => {
      executed = true;
    });

    // Wait for the idle task to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(executed).toBe(true);
  });

  it('handles errors in idle tasks without breaking the queue', async () => {
    const order: string[] = [];
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    runWhenClientIdle(async () => {
      order.push('idle1');
      throw new Error('idle task error');
    });

    runWhenClientIdle(async () => {
      order.push('idle2');
    });

    // Wait for both to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(order).toEqual(['idle1', 'idle2']);
    expect(consoleSpy).toHaveBeenCalledWith('Idle task failed:', expect.any(Error));

    consoleSpy.mockRestore();
  });

  it('processes idle tasks in FIFO order', async () => {
    const order: string[] = [];

    runWhenClientIdle(async () => {
      order.push('first');
    });
    runWhenClientIdle(async () => {
      order.push('second');
    });
    runWhenClientIdle(async () => {
      order.push('third');
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(order).toEqual(['first', 'second', 'third']);
  });
});

describe('getMidenClient singleton', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('reuses the same instance without options', async () => {
    const create = jest.fn(async () => ({ free: jest.fn() }));
    jest.doMock('./miden-client-interface', () => ({
      MidenClientInterface: class {
        static create = create;
        free() {}
      }
    }));

    jest.isolateModules(() => {
      const { getMidenClient } = require('./miden-client');
      return Promise.all([getMidenClient(), getMidenClient()]).then(([first, second]: any[]) => {
        expect(create).toHaveBeenCalledTimes(1);
        expect(first).toBe(second);
      });
    });
  });

  it('disposes and recreates when called with options', async () => {
    const free = jest.fn();
    const create = jest.fn().mockResolvedValueOnce({ free }).mockResolvedValueOnce({ free });

    jest.doMock('./miden-client-interface', () => ({
      MidenClientInterface: class {
        static create = create;
        free = free;
      }
    }));

    jest.isolateModules(() => {
      const { getMidenClient } = require('./miden-client');
      return Promise.resolve()
        .then(() => getMidenClient({ seed: new Uint8Array([1]) }))
        .then(() => getMidenClient({ seed: new Uint8Array([2]) }))
        .then(() => {
          expect(create).toHaveBeenCalledTimes(2);
          expect(free).toHaveBeenCalledTimes(1);
        });
    });
  });
});
