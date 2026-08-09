import { isWasmClientBusy, runWhenClientIdle, tryWithWasmClientLock, withWasmClientLock } from './miden-client';

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
    runWhenClientIdle(async () => {
      // Normal task — no-op
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    // No crash — the queue processed cleanly
    expect(true).toBe(true);
  });
});

describe('isWasmClientBusy', () => {
  it('is false when the mutex is idle', () => {
    expect(isWasmClientBusy()).toBe(false);
  });

  it('is true while a withWasmClientLock operation holds the lock, false after', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    // Lock is acquired synchronously when idle, so it reports busy immediately.
    const op = withWasmClientLock(async () => {
      await gate;
    });
    expect(isWasmClientBusy()).toBe(true);

    release!();
    await op;
    expect(isWasmClientBusy()).toBe(false);
  });

  it('stays busy for a queued operation until the whole chain drains', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    const first = withWasmClientLock(async () => {
      await gate;
    });
    // Second op queues behind the first; the mutex stays held throughout.
    const second = withWasmClientLock(async () => {});
    expect(isWasmClientBusy()).toBe(true);

    release!();
    await Promise.all([first, second]);
    expect(isWasmClientBusy()).toBe(false);
  });
});

describe('tryWithWasmClientLock', () => {
  it('runs the operation and returns { ran: true, value } when the lock is free', async () => {
    const op = jest.fn(async () => 42);
    const res = await tryWithWasmClientLock(op);
    expect(res).toEqual({ ran: true, value: 42 });
    expect(op).toHaveBeenCalledTimes(1);
    expect(isWasmClientBusy()).toBe(false); // released
  });

  it('skips (ran: false) and does not run the operation while the lock is held', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const holder = withWasmClientLock(async () => {
      await gate;
    });
    expect(isWasmClientBusy()).toBe(true);

    const op = jest.fn(async () => 'value');
    const res = await tryWithWasmClientLock(op);
    expect(res).toEqual({ ran: false });
    expect(op).not.toHaveBeenCalled();

    release!();
    await holder;
    expect(isWasmClientBusy()).toBe(false);
  });

  it('releases the lock even if the operation throws', async () => {
    await expect(
      tryWithWasmClientLock(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(isWasmClientBusy()).toBe(false);
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

describe('resetMidenClient', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('frees the no-options singleton and forces the next getMidenClient() to recreate it', async () => {
    const free = jest.fn();
    const create = jest.fn(async () => ({ free }));
    jest.doMock('./miden-client-interface', () => ({
      MidenClientInterface: class {
        static create = create;
        free = free;
      }
    }));

    await jest.isolateModulesAsync(async () => {
      const { getMidenClient, resetMidenClient } = require('./miden-client');
      const first = await getMidenClient();
      expect(create).toHaveBeenCalledTimes(1);

      await resetMidenClient();
      expect(free).toHaveBeenCalledTimes(1);

      const second = await getMidenClient();
      expect(create).toHaveBeenCalledTimes(2);
      expect(second).not.toBe(first);
    });
  });

  it('is a no-op when no singleton has been created yet', async () => {
    const create = jest.fn();
    jest.doMock('./miden-client-interface', () => ({
      MidenClientInterface: class {
        static create = create;
        free() {}
      }
    }));

    await jest.isolateModulesAsync(async () => {
      const { resetMidenClient } = require('./miden-client');
      await expect(resetMidenClient()).resolves.toBeUndefined();
      expect(create).not.toHaveBeenCalled();
    });
  });

  it('clears an in-flight no-options creation so it cannot repopulate a stale client after the reset', async () => {
    // Regression for: `disposeAllInstances()` used to only clear `initializingPromise`
    // inside the `if (this.instance)` guard, so a reset that lands *while* a no-options
    // `getInstance()` creation is still pending (instance still null) left that pending
    // promise in place. When it later resolved, it unconditionally set `this.instance`
    // to a client built against the pre-reset override, silently undoing the reset.
    const free = jest.fn();
    let resolveCreate: (client: { free: () => void }) => void = () => {};
    const pending = new Promise<{ free: () => void }>(resolve => {
      resolveCreate = resolve;
    });
    const create = jest.fn(() => pending);
    jest.doMock('./miden-client-interface', () => ({
      MidenClientInterface: class {
        static create = create;
        free = free;
      }
    }));

    await jest.isolateModulesAsync(async () => {
      const { getMidenClient, resetMidenClient } = require('./miden-client');

      // Kick off a no-options creation but don't await it — it's left in flight.
      const firstCall = getMidenClient();
      expect(create).toHaveBeenCalledTimes(1);

      // Reset while that creation is still pending: `this.instance` is still null, so
      // the old `if (this.instance)`-guarded clear alone would have left the stale
      // in-flight promise in place.
      await resetMidenClient();

      // A getInstance() call issued after the reset (but before the stale creation
      // settles) must NOT rejoin the stale in-flight promise — it should start its own
      // fresh creation instead.
      const secondCall = getMidenClient();
      expect(create).toHaveBeenCalledTimes(2);

      resolveCreate({ free });
      await Promise.all([firstCall, secondCall]);
    });
  });

  it('also frees an instanceWithOptions singleton, if one exists', async () => {
    const free = jest.fn();
    const create = jest.fn(async () => ({ free }));
    jest.doMock('./miden-client-interface', () => ({
      MidenClientInterface: class {
        static create = create;
        free = free;
      }
    }));

    await jest.isolateModulesAsync(async () => {
      const { getMidenClient, resetMidenClient } = require('./miden-client');
      await getMidenClient({ seed: new Uint8Array([1]) });
      expect(create).toHaveBeenCalledTimes(1);

      await resetMidenClient();
      expect(free).toHaveBeenCalledTimes(1);

      await getMidenClient({ seed: new Uint8Array([2]) });
      expect(create).toHaveBeenCalledTimes(2);
    });
  });
});
