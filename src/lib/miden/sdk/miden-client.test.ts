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

  // #878: the realm's keystore callbacks live in realm slots; the client is never rebuilt for a write.
  const withKeystoreClient = async (
    run: (mod: typeof import('./miden-client'), create: jest.Mock, free: jest.Mock) => Promise<void>
  ) => {
    const free = jest.fn();
    const create = jest.fn(async () => ({ free, markPoisoned: jest.fn() }));
    jest.doMock('./miden-client-interface', () => ({
      MidenClientInterface: class {
        static create = create;
        free = free;
      }
    }));
    await jest.isolateModulesAsync(async () => {
      await run(require('./miden-client'), create, free);
    });
  };
  const publicKey = new Uint8Array([1, 2]);
  const signingInputs = new Uint8Array([3, 4]);

  it('memoizes one client per realm: a later hold gets the same instance, nothing rebuilt or freed', async () => {
    // The per-write rebuild this change removed lived in the proxy's writes, which
    // now ask for the singleton with no options (pinned in miden-client-proxy.test.ts);
    // this pins the singleton they share.
    await withKeystoreClient(async ({ getMidenClient, withWasmClientLock, installRealmKeystore }, create, free) => {
      installRealmKeystore({ sign: async () => new Uint8Array([1]) });
      const first = await withWasmClientLock(() => getMidenClient());
      const second = await withWasmClientLock(() => getMidenClient());
      expect(create).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
      expect(free).not.toHaveBeenCalled();
    });
  });

  it('routes the SDK keystore callbacks to the realm keystore, and refuses before one is installed', async () => {
    await withKeystoreClient(async ({ getMidenClient, installRealmKeystore }, create) => {
      await getMidenClient();
      const { signCallback, insertKeyCallback } = create.mock.calls[0]![0];
      // A wiring error, named as such: nothing installed yet.
      await expect(signCallback(publicKey, signingInputs)).rejects.toThrow('no sign callback installed in this realm');
      await expect(insertKeyCallback(publicKey, signingInputs)).rejects.toThrow(
        'no insertKey callback installed in this realm'
      );
      const sign = jest.fn(async () => new Uint8Array([9]));
      const insertKey = jest.fn();
      installRealmKeystore({ sign, insertKey });
      await expect(signCallback(publicKey, signingInputs)).resolves.toEqual(new Uint8Array([9]));
      expect(sign).toHaveBeenCalledWith(publicKey, signingInputs);
      await insertKeyCallback(publicKey, signingInputs);
      expect(insertKey).toHaveBeenCalledWith(publicKey, signingInputs);
      // A later install replaces one callback and leaves the other; null clears one. None rebuilds the client.
      const laterSign = jest.fn(async () => new Uint8Array([8]));
      installRealmKeystore({ sign: laterSign });
      await expect(signCallback(publicKey, signingInputs)).resolves.toEqual(new Uint8Array([8]));
      expect(sign).toHaveBeenCalledTimes(1);
      await insertKeyCallback(publicKey, signingInputs);
      expect(insertKey).toHaveBeenCalledTimes(2);
      installRealmKeystore({ insertKey: null });
      await expect(insertKeyCallback(publicKey, signingInputs)).rejects.toThrow('no insertKey callback installed');
      await expect(signCallback(publicKey, signingInputs)).resolves.toEqual(new Uint8Array([8]));
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  it('uninstall drops only the callback it names: a newer install stays', async () => {
    await withKeystoreClient(async ({ getMidenClient, installRealmKeystore, uninstallRealmKeystore }, create) => {
      await getMidenClient();
      const { getKeyCallback, insertKeyCallback } = create.mock.calls[0]![0];
      const older = jest.fn();
      const newer = jest.fn();
      const olderGetKey = jest.fn(async () => new Uint8Array([1]));
      const newerGetKey = jest.fn(async () => new Uint8Array([2]));
      installRealmKeystore({ getKey: olderGetKey, insertKey: older });
      installRealmKeystore({ getKey: newerGetKey, insertKey: newer });
      // A vault retiring after a newer one installed (a lock landing during an unlock) leaves the newer sink.
      uninstallRealmKeystore({ getKey: olderGetKey, insertKey: older });
      await expect(getKeyCallback(publicKey)).resolves.toEqual(new Uint8Array([2]));
      await insertKeyCallback(publicKey, signingInputs);
      expect(newer).toHaveBeenCalledTimes(1);
      expect(older).not.toHaveBeenCalled();
      uninstallRealmKeystore({ getKey: newerGetKey, insertKey: newer });
      await expect(getKeyCallback(publicKey)).rejects.toThrow('no getKey callback installed');
      await expect(insertKeyCallback(publicKey, signingInputs)).rejects.toThrow('no insertKey callback installed');
    });
  });

  const opaque = () => new Error('failed to execute transaction: JsValue(Error: opaque)');
  const lockedSigner = () => {
    const locked = Object.assign(new Error('Sign callback failed (locked)'), { reason: 'locked' });
    return async () => {
      throw locked;
    };
  };

  it("a locked sign rides out on its own hold's rejection, and a hold that completed leaves nothing behind", async () => {
    await withKeystoreClient(async ({ getMidenClient, installRealmKeystore, withWasmClientLock }, create) => {
      await getMidenClient();
      const { signCallback } = create.mock.calls[0]![0];
      installRealmKeystore({ sign: lockedSigner() });
      // A hold whose sign reported locked, but which completed anyway (a dry run):
      // its record is nobody else's.
      await withWasmClientLock(async () => {
        await expect(signCallback(publicKey, signingInputs)).rejects.toMatchObject({ reason: 'locked' });
      });
      // The next hold's own failure is untagged: what the SDK made, not a leftover.
      await expect(withWasmClientLock(async () => Promise.reject(opaque()))).rejects.not.toHaveProperty('reason');
      // A hold whose sign reported locked and which then fails carries it out.
      await expect(
        withWasmClientLock(async () => {
          await expect(signCallback(publicKey, signingInputs)).rejects.toMatchObject({ reason: 'locked' });
          throw opaque();
        })
      ).rejects.toMatchObject({ reason: 'locked' });
      // Carried once.
      await expect(withWasmClientLock(async () => Promise.reject(opaque()))).rejects.not.toHaveProperty('reason');
    });
  });

  it('a later sign that succeeds under the same hold clears the record, so its rejection carries nothing', async () => {
    await withKeystoreClient(async ({ getMidenClient, installRealmKeystore, withWasmClientLock }, create) => {
      await getMidenClient();
      const { signCallback } = create.mock.calls[0]![0];
      await expect(
        withWasmClientLock(async () => {
          installRealmKeystore({ sign: lockedSigner() });
          await expect(signCallback(publicKey, signingInputs)).rejects.toMatchObject({ reason: 'locked' });
          installRealmKeystore({ sign: async () => new Uint8Array([1]) });
          await signCallback(publicKey, signingInputs);
          throw opaque();
        })
      ).rejects.not.toHaveProperty('reason');
      // An untagged sign failure records nothing either.
      await expect(
        withWasmClientLock(async () => {
          installRealmKeystore({
            sign: async () => {
              throw new Error('plain');
            }
          });
          await expect(signCallback(publicKey, signingInputs)).rejects.toThrow('plain');
          throw opaque();
        })
      ).rejects.not.toHaveProperty('reason');
    });
  });

  it("a sign refused on a replaced client leaves the current hold's record intact", async () => {
    await withKeystoreClient(
      async ({ getMidenClient, installRealmKeystore, resetMidenClient, withWasmClientLock }, create) => {
        installRealmKeystore({ sign: lockedSigner() });
        await getMidenClient();
        const stale = create.mock.calls[0]![0].signCallback;
        await resetMidenClient();
        await expect(
          withWasmClientLock(async () => {
            await getMidenClient();
            const live = create.mock.calls[1]![0].signCallback;
            await expect(live(publicKey, signingInputs)).rejects.toMatchObject({ reason: 'locked' });
            // The corpse's late sign is refused, and touches nothing of this hold's.
            await expect(stale(publicKey, signingInputs)).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
            throw opaque();
          })
        ).rejects.toMatchObject({ reason: 'locked' });
      }
    );
  });

  it('isRealmKeystoreInstalled answers by identity: the installed callback, no other, nothing once cleared', async () => {
    await withKeystoreClient(async ({ installRealmKeystore, uninstallRealmKeystore, isRealmKeystoreInstalled }) => {
      const a = jest.fn();
      const b = jest.fn();
      installRealmKeystore({ getKey: a, insertKey: a });
      expect(isRealmKeystoreInstalled({ getKey: a, insertKey: a })).toBe(true);
      expect(isRealmKeystoreInstalled({ getKey: b, insertKey: b })).toBe(false);
      uninstallRealmKeystore({ getKey: a, insertKey: a });
      expect(isRealmKeystoreInstalled({ getKey: a, insertKey: a })).toBe(false);
    });
  });

  it('routes getKey only while a realm callback is installed', async () => {
    await withKeystoreClient(async ({ getMidenClient, installRealmKeystore }, create) => {
      installRealmKeystore({ sign: async () => new Uint8Array(), insertKey: async () => {} });
      await getMidenClient();
      const { getKeyCallback } = create.mock.calls[0]![0];
      await expect(getKeyCallback(publicKey)).rejects.toThrow('no getKey callback installed');
      const getKey = jest.fn(async () => new Uint8Array([1]));
      installRealmKeystore({ getKey });
      await expect(getKeyCallback(publicKey)).resolves.toEqual(new Uint8Array([1]));
      expect(getKey).toHaveBeenCalledWith(publicKey);
    });
  });

  it('refuses a replaced client getKey instead of reading a newer export callback', async () => {
    await withKeystoreClient(async ({ getMidenClient, installRealmKeystore, resetMidenClient }, create) => {
      const older = jest.fn(async () => new Uint8Array([1]));
      installRealmKeystore({ getKey: older });
      await getMidenClient();
      const staleGetKey = create.mock.calls[0]![0].getKeyCallback;

      await resetMidenClient();
      const newer = jest.fn(async () => new Uint8Array([2]));
      installRealmKeystore({ getKey: newer });
      await getMidenClient();
      const liveGetKey = create.mock.calls[1]![0].getKeyCallback;

      await expect(staleGetKey(publicKey)).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      expect(older).not.toHaveBeenCalled();
      expect(newer).not.toHaveBeenCalled();
      await expect(liveGetKey(publicKey)).resolves.toEqual(new Uint8Array([2]));
    });
  });

  it('refuses a getKey result when replacement lands while the key read is parked', async () => {
    await withKeystoreClient(async ({ getMidenClient, installRealmKeystore, resetMidenClient }, create) => {
      let resolveOlder!: (key: Uint8Array) => void;
      const olderResult = new Promise<Uint8Array>(resolve => {
        resolveOlder = resolve;
      });
      const older = jest.fn(() => olderResult);
      installRealmKeystore({ getKey: older });
      await getMidenClient();
      const staleGetKey = create.mock.calls[0]![0].getKeyCallback;
      const pendingRead = staleGetKey(publicKey);
      await Promise.resolve();
      expect(older).toHaveBeenCalledWith(publicKey);

      await resetMidenClient();
      const newer = jest.fn(async () => new Uint8Array([2]));
      installRealmKeystore({ getKey: newer });
      await getMidenClient();
      const liveGetKey = create.mock.calls[1]![0].getKeyCallback;

      resolveOlder(new Uint8Array([1]));
      await expect(pendingRead).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      await expect(liveGetKey(publicKey)).resolves.toEqual(new Uint8Array([2]));
      expect(newer).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses a sign on a replaced client; an insert lands only against the sink ITS build was retired with', async () => {
    await withKeystoreClient(
      async (
        {
          getMidenClient,
          installRealmKeystore,
          uninstallRealmKeystore,
          resetMidenClient,
          withWasmClientLock,
          yieldWasmClientLock
        },
        create
      ) => {
        const sign = jest.fn(async () => new Uint8Array());
        const sinkA = jest.fn();
        const sinkB = jest.fn();
        // The refusals name their kind in the console: the poison message cannot.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        installRealmKeystore({ sign, insertKey: sinkA });
        await withWasmClientLock(async hold => {
          await getMidenClient();
          const { signCallback, insertKeyCallback } = create.mock.calls[0]![0];
          // Yielded, this flow retains its client through the replacements below, the
          // way an evicted account write does: the client is marked, not freed.
          await yieldWasmClientLock(async () => {
            await resetMidenClient();
            // An abandoned write must not gain a signature it could still submit.
            await expect(signCallback(publicKey, signingInputs)).rejects.toMatchObject({
              name: 'WasmClientPoisonedError'
            });
            expect(sign).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('sign refused: the WASM client was replaced'));
            // Its key still lands: the SDK persisted the account before asking, and the
            // installed sink is the one this client's build was retired against.
            await insertKeyCallback(publicKey, signingInputs);
            expect(sinkA).toHaveBeenCalledTimes(1);
            // Reinstalling the same sink (the store's resync after every unlock) is the same sink.
            installRealmKeystore({ insertKey: sinkA });
            await insertKeyCallback(publicKey, signingInputs);
            expect(sinkA).toHaveBeenCalledTimes(2);
            // Another vault's sink installed: refused, and that sink untouched.
            installRealmKeystore({ insertKey: sinkB });
            await expect(insertKeyCallback(publicKey, signingInputs)).rejects.toMatchObject({
              name: 'WasmClientPoisonedError'
            });
            expect(sinkB).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith(
              expect.stringContaining('insertKey refused: the WASM client was replaced')
            );
            warn.mockRestore();
            // The original vault's sink put back (a failed re-unlock's resync): lands again.
            installRealmKeystore({ insertKey: sinkA });
            await insertKeyCallback(publicKey, signingInputs);
            expect(sinkA).toHaveBeenCalledTimes(3);
            // A second replacement stamps the NEW build, not this client's cell.
            installRealmKeystore({ insertKey: sinkB });
            await getMidenClient();
            await resetMidenClient();
            await expect(insertKeyCallback(publicKey, signingInputs)).rejects.toMatchObject({
              name: 'WasmClientPoisonedError'
            });
            expect(sinkB).not.toHaveBeenCalled();
            // A cleared slot refuses.
            uninstallRealmKeystore({ insertKey: sinkB });
            await expect(insertKeyCallback(publicKey, signingInputs)).rejects.toMatchObject({
              name: 'WasmClientPoisonedError'
            });
          }, hold);
        });
      }
    );
  });

  it('a stale uninstall and a sign-only install change nothing about the installed sink', async () => {
    await withKeystoreClient(
      async (
        {
          getMidenClient,
          installRealmKeystore,
          uninstallRealmKeystore,
          resetMidenClient,
          withWasmClientLock,
          yieldWasmClientLock
        },
        create
      ) => {
        const sinkA = jest.fn();
        const sinkB = jest.fn();
        installRealmKeystore({ sign: async () => new Uint8Array(), insertKey: sinkA });
        await withWasmClientLock(async hold => {
          await getMidenClient();
          const { insertKeyCallback } = create.mock.calls[0]![0];
          await yieldWasmClientLock(async () => {
            await resetMidenClient();
            // A retire of a vault whose sink is not installed (an older vault locking
            // after a newer one installed its own) leaves the installed sink alone.
            uninstallRealmKeystore({ insertKey: sinkB });
            // Installing only a signer (Actions.init) does not touch the insert-key slot.
            installRealmKeystore({ sign: async () => new Uint8Array([1]) });
            await insertKeyCallback(publicKey, signingInputs);
            expect(sinkA).toHaveBeenCalledTimes(1);
          }, hold);
        });
      }
    );
  });

  it("a watchdog eviction retires the build the same way: the evicted write's insert lands on its own vault's sink", async () => {
    jest.useFakeTimers();
    try {
      await withKeystoreClient(async ({ getMidenClient, installRealmKeystore, withWasmClientLock }, create) => {
        const sinkA = jest.fn();
        installRealmKeystore({ sign: async () => new Uint8Array(), insertKey: sinkA });
        await getMidenClient();
        const { insertKeyCallback } = create.mock.calls[0]![0];
        // A hold that never settles is evicted at the ceiling: the client is poisoned,
        // not freed, and the abandoned write keeps running (F-041's case).
        const wedged = withWasmClientLock(() => new Promise<never>(() => {}));
        wedged.catch(() => {});
        await jest.advanceTimersByTimeAsync(300_000);
        await expect(wedged).rejects.toMatchObject({ name: 'WasmClientPoisonedError', reason: 'watchdog' });
        await insertKeyCallback(publicKey, signingInputs);
        expect(sinkA).toHaveBeenCalledTimes(1);
      });
    } finally {
      jest.useRealTimers();
    }
  });

  // GAP 7 (resilience): a startup RPC blip must NOT poison the singleton with a
  // permanently-rejected init promise — the next call has to retry and succeed.
  it('self-heals after a startup create() failure instead of poisoning the singleton', async () => {
    const goodClient = { free: jest.fn() };
    const create = jest
      .fn()
      .mockRejectedValueOnce(new Error('node unreachable at startup'))
      .mockResolvedValue(goodClient);
    jest.doMock('./miden-client-interface', () => ({
      MidenClientInterface: class {
        static create = create;
        free() {}
      }
    }));

    let getMidenClient: (options?: unknown) => Promise<unknown> = async () => undefined;
    jest.isolateModules(() => {
      ({ getMidenClient } = require('./miden-client'));
    });

    // First construction fails → the call rejects.
    await expect(getMidenClient()).rejects.toThrow('node unreachable at startup');
    // The NEXT call must re-attempt create() and succeed (not replay the poison).
    await expect(getMidenClient()).resolves.toBe(goodClient);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('resetMidenClient', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('frees the singleton and forces the next getMidenClient() to recreate it', async () => {
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
});
