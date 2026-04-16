import { runWhenClientIdle, withWasmClientLock } from './miden-client';

// `withWasmClientLock` is an active wallet-side mutex layered over the
// SDK's per-instance `_serializeWasmCall` chain. The SDK serializes
// mutating methods only; the wallet mutex covers everything as
// belt-and-suspenders. Validated by every passing stress run since
// 2026-04-16. A follow-up PR may attempt to drop this wrapper, gated on
// a dedicated stress run that proves SDK coverage is sufficient on its
// own — pass-through has been theorized to work but is untested at scale.
describe('withWasmClientLock', () => {
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

  it('serializes concurrent callers', async () => {
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
    expect(maxConcurrent).toBe(1);
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

  it('reuses the same singleton instance across calls', async () => {
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
});
