import { runWhenClientIdle, withWasmClientLock } from './miden-client';

// `withWasmClientLock` is now a pass-through. The SDK's internal
// `_serializeWasmCall` chain + single-instance design handles concurrency.
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

  it('does not serialize (pass-through allows concurrency)', async () => {
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
    expect(maxConcurrent).toBeGreaterThan(1);
  });
});

describe('runWhenClientIdle', () => {
  it('runs idle tasks immediately (fire-and-forget)', async () => {
    let executed = false;

    runWhenClientIdle(async () => {
      executed = true;
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(executed).toBe(true);
  });

  it('handles errors in idle tasks without breaking', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    runWhenClientIdle(async () => {
      throw new Error('idle task error');
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(consoleSpy).toHaveBeenCalledWith('Idle task failed:', expect.any(Error));

    consoleSpy.mockRestore();
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
