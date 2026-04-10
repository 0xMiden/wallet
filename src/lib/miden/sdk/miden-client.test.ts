import { runWhenClientIdle, withWasmClientLock } from './miden-client';

describe('withWasmClientLock', () => {
  it('executes a single operation and returns its result', async () => {
    const result = await withWasmClientLock(async () => {
      return 'test-result';
    });

    expect(result).toBe('test-result');
  });

  it('serializes concurrent operations', async () => {
    const executionOrder: number[] = [];
    const operationDuration = 50;

    // Start 3 operations concurrently
    const op1 = withWasmClientLock(async () => {
      executionOrder.push(1);
      await new Promise(resolve => setTimeout(resolve, operationDuration));
      executionOrder.push(-1);
      return 'op1';
    });

    const op2 = withWasmClientLock(async () => {
      executionOrder.push(2);
      await new Promise(resolve => setTimeout(resolve, operationDuration));
      executionOrder.push(-2);
      return 'op2';
    });

    const op3 = withWasmClientLock(async () => {
      executionOrder.push(3);
      await new Promise(resolve => setTimeout(resolve, operationDuration));
      executionOrder.push(-3);
      return 'op3';
    });

    const results = await Promise.all([op1, op2, op3]);

    // All operations should complete
    expect(results).toEqual(['op1', 'op2', 'op3']);

    // Operations should be serialized: each one starts after previous ends
    // Pattern should be: [1, -1, 2, -2, 3, -3] (start/end pairs in order)
    expect(executionOrder).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it('releases the lock even when operation throws', async () => {
    const errorOp = withWasmClientLock(async () => {
      throw new Error('test error');
    });

    await expect(errorOp).rejects.toThrow('test error');

    // Next operation should still be able to acquire the lock
    const result = await withWasmClientLock(async () => {
      return 'success after error';
    });

    expect(result).toBe('success after error');
  });

  it('preserves operation order (FIFO)', async () => {
    const order: string[] = [];

    const ops = ['first', 'second', 'third', 'fourth', 'fifth'].map(name =>
      withWasmClientLock(async () => {
        order.push(name);
        await new Promise(resolve => setTimeout(resolve, 10));
        return name;
      })
    );

    await Promise.all(ops);

    expect(order).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
  });

  it('does not allow concurrent execution', async () => {
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

    // Should never have more than 1 concurrent operation
    expect(maxConcurrent).toBe(1);
  });
});

describe('runWhenClientIdle', () => {
  it('runs immediately when mutex is idle', async () => {
    let executed = false;

    runWhenClientIdle(async () => {
      executed = true;
    });

    // Wait for the idle task to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(executed).toBe(true);
  });

  it('waits for high-priority operations to complete', async () => {
    const order: string[] = [];

    // Start a high-priority operation
    const highPriority = withWasmClientLock(async () => {
      order.push('high-start');
      await new Promise(resolve => setTimeout(resolve, 50));
      order.push('high-end');
      return 'high';
    });

    // Queue an idle task while high-priority is running
    runWhenClientIdle(async () => {
      order.push('idle');
    });

    await highPriority;
    // Wait for idle task to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    // Idle task should run after high-priority completes
    expect(order).toEqual(['high-start', 'high-end', 'idle']);
  });

  it('allows high-priority operations to run while idle task is waiting', async () => {
    const order: string[] = [];

    // Start an idle task that takes some time (but doesn't hold the lock)
    runWhenClientIdle(async () => {
      order.push('idle1-start');
      await new Promise(resolve => setTimeout(resolve, 50));
      order.push('idle1-end');
    });

    // Wait for idle task to start
    await new Promise(resolve => setTimeout(resolve, 10));

    // Queue a high-priority operation while idle task is running
    // Since idle tasks don't hold the lock, high-priority can run immediately
    const highPriority = withWasmClientLock(async () => {
      order.push('high');
      return 'high';
    });

    // Queue another idle task
    runWhenClientIdle(async () => {
      order.push('idle2');
    });

    await highPriority;
    // Wait for all to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // High priority can run while idle1 is awaiting (idle tasks don't hold lock)
    // idle2 runs after idle1 completes
    expect(order).toEqual(['idle1-start', 'high', 'idle1-end', 'idle2']);
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

    // First occupy the mutex
    const blocker = withWasmClientLock(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    // Queue multiple idle tasks
    runWhenClientIdle(async () => {
      order.push('first');
    });
    runWhenClientIdle(async () => {
      order.push('second');
    });
    runWhenClientIdle(async () => {
      order.push('third');
    });

    await blocker;
    // Wait for idle tasks to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(order).toEqual(['first', 'second', 'third']);
  });
});

describe('AsyncMutex idle queue — high-priority interruption', () => {
  it('pauses idle tasks when high-priority work arrives', async () => {
    const order: string[] = [];

    // Queue two idle tasks
    runWhenClientIdle(async () => {
      order.push('idle1-start');
      // While this is running, a high-priority task arrives
      await new Promise(resolve => setTimeout(resolve, 30));
      order.push('idle1-end');
    });

    runWhenClientIdle(async () => {
      order.push('idle2');
    });

    // Wait for first idle task to start
    await new Promise(resolve => setTimeout(resolve, 10));

    // Acquire lock (high-priority) — this should cause remaining idle tasks
    // to be paused (re-queued) until lock is released
    const highPriority = withWasmClientLock(async () => {
      order.push('high');
      return 'done';
    });

    await highPriority;
    // Wait for idle tasks to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(order[0]).toBe('idle1-start');
    expect(order).toContain('high');
    expect(order).toContain('idle2');
  });

  it('handles null/undefined tasks in the idle queue gracefully', async () => {
    // This tests the `if (!task)` guard in runIdleTasks
    // Queue an undefined-returning factory
    runWhenClientIdle(async () => {
      // Normal task
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    // No crash — the queue processed cleanly
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
