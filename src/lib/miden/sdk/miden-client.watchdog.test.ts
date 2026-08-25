/**
 * Issue #775: a WASM trap aborts a wasm-bindgen future WITHOUT settling its JS
 * promise, so `withWasmClientLock`'s `finally` never runs and the mutex wedges
 * forever. These suites cover the two recovery mechanisms (lock-hold watchdog,
 * realm 'error' fast path) and the poisoned-client dispose/recreate that must
 * follow. Fake timers throughout — the watchdog ceiling is 5 minutes.
 */
import { isLockedError } from 'lib/miden/transaction/helper';

import {
  isWasmClientBusy,
  tryWithWasmClientLock,
  WasmClientPoisonedError,
  withWasmClientLock,
  withWasmLockWatchdogPaused,
  yieldWasmClientLock
} from './miden-client';

/** Advanced by every test's beforeEach — see the setSystemTime call there. */
let fakeDayOffset = 0;

/**
 * Attach a rejection expectation NOW — so the eviction's rejection always has
 * a handler — while letting the test drive timers before awaiting the outcome.
 */
function expectRejection(promise: Promise<unknown>, match: Record<string, unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject(match);
}

/** Dispatch a realm ErrorEvent shaped like a genuine main-realm WASM trap. */
function dispatchTrapEvent(): void {
  window.dispatchEvent(
    new ErrorEvent('error', {
      error: new WebAssembly.RuntimeError('unreachable'),
      message: 'Uncaught RuntimeError: unreachable'
    })
  );
}

describe('wasm lock watchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Start each test a full day later than the previous one, so a prior
    // test's recovery stamp can never hold this test inside the realm-error
    // cooldown window.
    jest.setSystemTime(new Date(Date.now() + ++fakeDayOffset * 86_400_000));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('evicts a never-settling holder at the ceiling so the next acquirer runs, rejecting it with a named error', async () => {
    const first = withWasmClientLock(() => new Promise<never>(() => {}));
    const firstRejects = expectRejection(first, {
      name: 'WasmClientPoisonedError',
      reason: 'watchdog'
    });

    let ran = false;
    const second = withWasmClientLock(async () => {
      ran = true;
    });

    await jest.advanceTimersByTimeAsync(300_000);

    expect(ran).toBe(true);
    await firstRejects;
    await second;
  });

  it('never double-releases: a waiter woken by recovery is not overlapped by a later acquirer', async () => {
    const wedged = withWasmClientLock(() => new Promise<never>(() => {}));
    const wedgedRejects = expectRejection(wedged, { name: 'WasmClientPoisonedError' });

    let releaseA!: () => void;
    const aGate = new Promise<void>(resolve => {
      releaseA = resolve;
    });
    let aRunning = false;
    let overlapped = false;
    const a = withWasmClientLock(async () => {
      aRunning = true;
      await aGate;
      aRunning = false;
    });

    await jest.advanceTimersByTimeAsync(300_000);
    await wedgedRejects;
    expect(aRunning).toBe(true);

    // If the evicted holder's finally released a second time, C would start
    // while A still holds the lock.
    const c = withWasmClientLock(async () => {
      if (aRunning) overlapped = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(aRunning).toBe(true);
    expect(overlapped).toBe(false);

    releaseA();
    await a;
    await c;
    expect(overlapped).toBe(false);
  });

  it('produces an error that the transaction loop will Fail, not requeue as a locked-vault defer', () => {
    expect(isLockedError(new WasmClientPoisonedError('watchdog'))).toBe(false);
    expect(isLockedError(new WasmClientPoisonedError('realm-error', new WebAssembly.RuntimeError('unreachable')))).toBe(
      false
    );
  });
});

describe('realm error fast path', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Start each test a full day later than the previous one, so a prior
    // test's recovery stamp can never hold this test inside the realm-error
    // cooldown window.
    jest.setSystemTime(new Date(Date.now() + ++fakeDayOffset * 86_400_000));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('an unrelated (non-trap) realm error leaves the holder alone', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    const first = withWasmClientLock(() => gate);
    await jest.advanceTimersByTimeAsync(0);

    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new TypeError('Cannot read properties of undefined'),
        message: "Uncaught TypeError: Cannot read properties of undefined (reading 'foo')"
      })
    );
    await jest.advanceTimersByTimeAsync(0);

    releaseGate();
    await expect(first).resolves.toBeUndefined();
  });

  it('an uncaught WASM-trap-shaped realm error evicts the holder immediately, without waiting for the watchdog', async () => {
    const first = withWasmClientLock(() => new Promise<never>(() => {}));
    const firstRejects = expectRejection(first, {
      name: 'WasmClientPoisonedError',
      reason: 'realm-error'
    });

    let ran = false;
    const second = withWasmClientLock(async () => {
      ran = true;
    });

    // Let `first` actually take the lock (acquire resolves on a microtask) —
    // a real trap fires while the holder's operation is running.
    await jest.advanceTimersByTimeAsync(0);

    dispatchTrapEvent();
    // Flush microtasks only — zero timer time passes, proving detection does
    // not depend on the watchdog ceiling.
    await jest.advanceTimersByTimeAsync(0);

    expect(ran).toBe(true);
    await firstRejects;
    await second;
  });

  it('detects a worker-propagated trap that arrives with only a message, no error object', async () => {
    const first = withWasmClientLock(() => new Promise<never>(() => {}));
    const firstRejects = expectRejection(first, {
      name: 'WasmClientPoisonedError',
      reason: 'realm-error'
    });
    await jest.advanceTimersByTimeAsync(0);

    // A trap inside the SDK's method worker loses the error object crossing the
    // worker boundary — only the message survives.
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught RuntimeError: unreachable' }));
    await jest.advanceTimersByTimeAsync(0);

    expect(isWasmClientBusy()).toBe(false);
    await firstRejects;
  });

  it('detects a trap reported only by its .wasm filename', async () => {
    const first = withWasmClientLock(() => new Promise<never>(() => {}));
    const firstRejects = expectRejection(first, {
      name: 'WasmClientPoisonedError',
      reason: 'realm-error'
    });
    await jest.advanceTimersByTimeAsync(0);

    window.dispatchEvent(
      new ErrorEvent('error', { message: 'Script error.', filename: 'https://wallet/miden_client_web.wasm' })
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(isWasmClientBusy()).toBe(false);
    await firstRejects;
  });

  it('ignores a benign error that merely mentions wasm in its message', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    const first = withWasmClientLock(() => gate);
    await jest.advanceTimersByTimeAsync(0);

    // On mobile the whole React app shares the realm — an unrelated error that
    // happens to say "wasm" must not evict a healthy holder.
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new Error('failed to load wasm module bundle'),
        message: 'Uncaught Error: failed to load wasm module bundle'
      })
    );
    await jest.advanceTimersByTimeAsync(0);

    releaseGate();
    await expect(first).resolves.toBeUndefined();
  });

  it('evicts a holder even while its watchdog is paused — the incident shape: a trap milliseconds into a local prove', async () => {
    const first = withWasmClientLock(async () => {
      await withWasmLockWatchdogPaused(() => new Promise<never>(() => {}));
    });
    const firstRejects = expectRejection(first, {
      name: 'WasmClientPoisonedError',
      reason: 'realm-error'
    });
    await jest.advanceTimersByTimeAsync(0);

    dispatchTrapEvent();
    await jest.advanceTimersByTimeAsync(0);

    expect(isWasmClientBusy()).toBe(false);
    await firstRejects;
  });

  it('suppresses realm-error evictions for a cooldown after a recovery, so a corpse trap cannot cascade', async () => {
    const first = withWasmClientLock(() => new Promise<never>(() => {}));
    const firstRejects = expectRejection(first, { name: 'WasmClientPoisonedError' });
    await jest.advanceTimersByTimeAsync(0);
    dispatchTrapEvent();
    await jest.advanceTimersByTimeAsync(0);
    await firstRejects;

    // The next (innocent) holder acquires; the evicted corpse's deferred trap
    // fires moments later and must NOT take it down too.
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    const second = withWasmClientLock(() => gate);
    await jest.advanceTimersByTimeAsync(1_000);
    dispatchTrapEvent();
    await jest.advanceTimersByTimeAsync(0);
    expect(isWasmClientBusy()).toBe(true);

    // Past the cooldown a fresh trap is trusted again.
    await jest.advanceTimersByTimeAsync(10_000);
    const secondRejects = expectRejection(second, { name: 'WasmClientPoisonedError' });
    dispatchTrapEvent();
    await jest.advanceTimersByTimeAsync(0);
    expect(isWasmClientBusy()).toBe(false);
    await secondRejects;
    releaseGate();
  });
});

describe('watchdog pause and yield', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Start each test a full day later than the previous one, so a prior
    // test's recovery stamp can never hold this test inside the realm-error
    // cooldown window.
    jest.setSystemTime(new Date(Date.now() + ++fakeDayOffset * 86_400_000));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('withWasmLockWatchdogPaused stops the clock, and resume re-arms the full ceiling from scratch', async () => {
    let releasePause!: () => void;
    const pauseGate = new Promise<void>(resolve => {
      releasePause = resolve;
    });

    const op = withWasmClientLock(async () => {
      await withWasmLockWatchdogPaused(() => pauseGate);
      await new Promise<never>(() => {});
    });
    const opRejects = expectRejection(op, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    await jest.advanceTimersByTimeAsync(0);
    // Paused: far past the ceiling, the holder survives (a sign round-trip or
    // local prove may take arbitrarily long).
    await jest.advanceTimersByTimeAsync(600_000);
    expect(isWasmClientBusy()).toBe(true);

    releasePause();
    await jest.advanceTimersByTimeAsync(0);
    // Re-armed from scratch: a full fresh budget, not "remaining time".
    await jest.advanceTimersByTimeAsync(299_999);
    expect(isWasmClientBusy()).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    expect(isWasmClientBusy()).toBe(false);
    await opRejects;
  });

  it('runs the operation without touching the mutex when no lock is held (an evicted flow must not corrupt it)', async () => {
    let sawBusyInside: boolean | null = null;
    const value = await yieldWasmClientLock(async () => {
      sawBusyInside = isWasmClientBusy();
      return 'through';
    });
    expect(value).toBe('through');
    expect(sawBusyInside).toBe(false);
    expect(isWasmClientBusy()).toBe(false);
    await expect(withWasmClientLock(async () => 'ok')).resolves.toBe('ok');
  });

  it('nested pauses only re-arm when the outermost bracket closes', async () => {
    let releaseOuter!: () => void;
    const outerGate = new Promise<void>(resolve => {
      releaseOuter = resolve;
    });

    const op = withWasmClientLock(async () => {
      await withWasmLockWatchdogPaused(async () => {
        await withWasmLockWatchdogPaused(async () => {});
        // Inner bracket closed, outer still open — the watchdog must stay off.
        await outerGate;
      });
      await new Promise<never>(() => {});
    });
    const opRejects = expectRejection(op, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(600_000);
    expect(isWasmClientBusy()).toBe(true);

    releaseOuter();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(isWasmClientBusy()).toBe(false);
    await opRejects;
  });

  it('a holder that yielded the lock is not watched, and the watchdog re-arms on reacquire', async () => {
    let releaseYield!: () => void;
    const yieldGate = new Promise<void>(resolve => {
      releaseYield = resolve;
    });

    const op = withWasmClientLock(async () => {
      await yieldWasmClientLock(() => yieldGate);
      await new Promise<never>(() => {});
    });
    const opRejects = expectRejection(op, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    await jest.advanceTimersByTimeAsync(0);
    // While yielded the mutex is genuinely free and the holder must survive
    // far past the ceiling (this is the offscreen-prove wait).
    expect(isWasmClientBusy()).toBe(false);
    await jest.advanceTimersByTimeAsync(600_000);
    expect(isWasmClientBusy()).toBe(false);

    releaseYield();
    await jest.advanceTimersByTimeAsync(0);
    expect(isWasmClientBusy()).toBe(true);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(isWasmClientBusy()).toBe(false);
    await opRejects;
  });

  it('a tryWithWasmClientLock holder is recoverable, and the mutex stays sane after the abandoned op settles late', async () => {
    let settleLate!: () => void;
    const late = new Promise<void>(resolve => {
      settleLate = resolve;
    });

    const wedged = tryWithWasmClientLock(() => late.then(() => 'late-value'));
    const wedgedRejects = expectRejection(wedged, {
      name: 'WasmClientPoisonedError',
      reason: 'watchdog'
    });
    await jest.advanceTimersByTimeAsync(300_000);
    expect(isWasmClientBusy()).toBe(false);
    await wedgedRejects;

    // The abandoned operation finally settles — must not double-release or
    // otherwise corrupt the mutex.
    settleLate();
    await jest.advanceTimersByTimeAsync(0);

    await expect(withWasmClientLock(async () => 'a')).resolves.toBe('a');
    await expect(tryWithWasmClientLock(async () => 'b')).resolves.toEqual({ ran: true, value: 'b' });
    expect(isWasmClientBusy()).toBe(false);
  });
});

describe('poisoned client recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Start each test a full day later than the previous one, so a prior
    // test's recovery stamp can never hold this test inside the realm-error
    // cooldown window.
    jest.setSystemTime(new Date(Date.now() + ++fakeDayOffset * 86_400_000));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    jest.resetModules();
  });

  interface IsolatedLockModule {
    withWasmClientLock: typeof withWasmClientLock;
    yieldWasmClientLock: typeof yieldWasmClientLock;
    getMidenClient: (options?: unknown) => Promise<unknown>;
    resetMidenClient: () => Promise<void>;
  }

  const loadIsolated = async (freeImpl?: () => void) => {
    const free = jest.fn(freeImpl);
    const create = jest.fn(async () => ({ free }));
    jest.doMock('./miden-client-interface', () => ({
      MidenClientInterface: class {
        static create = create;
        free = free;
      }
    }));
    let mod!: IsolatedLockModule;
    await jest.isolateModulesAsync(async () => {
      mod = require('./miden-client');
    });
    return { mod, free, create };
  };

  it('after watchdog recovery the next acquirer gets a freshly constructed client, not the disposed one', async () => {
    const { mod, free, create } = await loadIsolated();
    const clientBefore = await mod.getMidenClient();

    const wedged = mod.withWasmClientLock(() => new Promise<never>(() => {}));
    const wedgedRejects = expectRejection(wedged, { name: 'WasmClientPoisonedError' });
    await jest.advanceTimersByTimeAsync(300_000);
    await wedgedRejects;

    expect(free).toHaveBeenCalledTimes(1);
    const clientAfter = await mod.getMidenClient();
    expect(create).toHaveBeenCalledTimes(2);
    expect(clientAfter).not.toBe(clientBefore);
  });

  it('a trap while the lock is free still disposes the poisoned singletons', async () => {
    const { mod, free, create } = await loadIsolated();
    const clientBefore = await mod.getMidenClient();

    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new WebAssembly.RuntimeError('unreachable'),
        message: 'Uncaught RuntimeError: unreachable'
      })
    );

    expect(free).toHaveBeenCalledTimes(1);
    const clientAfter = await mod.getMidenClient();
    expect(create).toHaveBeenCalledTimes(2);
    expect(clientAfter).not.toBe(clientBefore);
  });

  it('a realm-error eviction also hands the next acquirer a fresh client', async () => {
    const { mod, free, create } = await loadIsolated();
    const clientBefore = await mod.getMidenClient();

    const wedged = mod.withWasmClientLock(() => new Promise<never>(() => {}));
    const wedgedRejects = expectRejection(wedged, {
      name: 'WasmClientPoisonedError',
      reason: 'realm-error'
    });
    await jest.advanceTimersByTimeAsync(0);
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new WebAssembly.RuntimeError('unreachable'),
        message: 'Uncaught RuntimeError: unreachable'
      })
    );
    await jest.advanceTimersByTimeAsync(0);
    await wedgedRejects;

    expect(free).toHaveBeenCalledTimes(1);
    const clientAfter = await mod.getMidenClient();
    expect(create).toHaveBeenCalledTimes(2);
    expect(clientAfter).not.toBe(clientBefore);
  });

  it('does not dispose on a trap while a holder is suspended mid-yield', async () => {
    const { mod, free } = await loadIsolated();
    await mod.getMidenClient();

    let releaseYield!: () => void;
    const yieldGate = new Promise<void>(resolve => {
      releaseYield = resolve;
    });
    const op = mod.withWasmClientLock(() => mod.yieldWasmClientLock(() => yieldGate));
    await jest.advanceTimersByTimeAsync(0);

    // The trap fires while the holder has yielded the lock (offscreen-prove
    // window) — disposing here would pull the client out from under the
    // suspended flow past its point of no return.
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new WebAssembly.RuntimeError('unreachable'),
        message: 'Uncaught RuntimeError: unreachable'
      })
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(free).not.toHaveBeenCalled();

    releaseYield();
    await op;
  });

  it('recovers even when disposing the trapped client itself throws', async () => {
    const { mod, create } = await loadIsolated(() => {
      throw new Error('free() called on a trapped module');
    });
    const clientBefore = await mod.getMidenClient();

    const wedged = mod.withWasmClientLock(() => new Promise<never>(() => {}));
    const wedgedRejects = expectRejection(wedged, { name: 'WasmClientPoisonedError' });
    await jest.advanceTimersByTimeAsync(300_000);
    await wedgedRejects;

    const clientAfter = await mod.getMidenClient();
    expect(create).toHaveBeenCalledTimes(2);
    expect(clientAfter).not.toBe(clientBefore);
  });

  it('resetMidenClient() still resolves after a recovery (no deadlock against its own lock)', async () => {
    const { mod } = await loadIsolated();
    await mod.getMidenClient();

    const wedged = mod.withWasmClientLock(() => new Promise<never>(() => {}));
    const wedgedRejects = expectRejection(wedged, { name: 'WasmClientPoisonedError' });
    await jest.advanceTimersByTimeAsync(300_000);
    await wedgedRejects;

    await expect(mod.resetMidenClient()).resolves.toBeUndefined();
  });
});
