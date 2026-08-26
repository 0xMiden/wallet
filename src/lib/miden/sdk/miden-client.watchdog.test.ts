/**
 * Issue #775: a WASM trap aborts a wasm-bindgen future WITHOUT settling its JS
 * promise, so `withWasmClientLock`'s `finally` never runs and the mutex wedges
 * forever. These suites cover the two recovery mechanisms (lock-hold watchdog,
 * realm 'error' fast path) and the poisoned-client dispose/recreate that must
 * follow. Fake timers throughout — the watchdog ceiling is 5 minutes.
 */
import { isLockedError } from 'lib/miden/transaction/helper';

import {
  __resetRecoveryCooldownForTests,
  isWasmClientBusy,
  tryWithWasmClientLock,
  WasmClientPoisonedError,
  WasmLockHold,
  withWasmClientLock,
  withWasmLockWatchdogPaused,
  yieldWasmClientLock
} from './miden-client';

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
    // Drop any recovery stamp left by an earlier test, so its cooldown cannot
    // suppress this test's trap. Fake timers restart the monotonic clock at 0
    // on every install, which puts a prior stamp in this test's future.
    __resetRecoveryCooldownForTests();
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

  it('a paused hold is relaxed, not unwatched: it survives the normal ceiling and is evicted at the paused one', async () => {
    // Stopping the clock outright made the backstop optional exactly where a
    // trap is most likely, and on the realms whose traps the listener cannot see
    // (the SDK method worker swallows one into a never-settling request) that
    // left the wedge permanent — the pre-#775 failure mode, reached through the
    // fix's own escape hatch.
    const wedged = withWasmClientLock(async () => {
      await withWasmLockWatchdogPaused(() => new Promise<never>(() => {}));
    });
    const wedgedRejects = expectRejection(wedged, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    let successorRan = false;
    const successor = withWasmClientLock(async () => {
      successorRan = true;
    });

    // Well past the normal ceiling: a genuinely slow sign or local prove must
    // still be waiting, untouched.
    await jest.advanceTimersByTimeAsync(600_000);
    expect(successorRan).toBe(false);
    expect(isWasmClientBusy()).toBe(true);

    // Past the paused ceiling: the wedge is bounded after all.
    await jest.advanceTimersByTimeAsync(1_300_000);
    await wedgedRejects;
    await successor;
    expect(successorRan).toBe(true);
  });

  it('closing a pause puts the hold back on the NORMAL ceiling', async () => {
    let releasePause!: () => void;
    const pauseGate = new Promise<void>(resolve => {
      releasePause = resolve;
    });
    const wedged = withWasmClientLock(async () => {
      await withWasmLockWatchdogPaused(() => pauseGate);
      await new Promise<never>(() => {});
    });
    const wedgedRejects = expectRejection(wedged, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    await jest.advanceTimersByTimeAsync(0);
    releasePause();
    await jest.advanceTimersByTimeAsync(0);

    // The post-pause remainder gets the 5-minute ceiling, not the 30-minute one.
    await jest.advanceTimersByTimeAsync(300_000);
    await wedgedRejects;
    expect(isWasmClientBusy()).toBe(false);
  });

  it('a nested pause does not push the paused ceiling out on every open', async () => {
    // Re-arming per bracket would let a flow that opens brackets in a loop keep
    // resetting the bound, restoring the old stop-the-clock behaviour.
    let openInner!: () => void;
    const innerGate = new Promise<void>(resolve => {
      openInner = resolve;
    });
    const wedged = withWasmClientLock(async () => {
      await withWasmLockWatchdogPaused(async () => {
        await innerGate;
        await withWasmLockWatchdogPaused(() => new Promise<never>(() => {}));
      });
    });
    const wedgedRejects = expectRejection(wedged, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    // Spend most of the paused ceiling inside the OUTER bracket, then open the
    // inner one.
    await jest.advanceTimersByTimeAsync(1_200_000);
    openInner();
    await jest.advanceTimersByTimeAsync(0);

    // The inner bracket must not have restarted the 1.8M ceiling.
    await jest.advanceTimersByTimeAsync(600_001);
    await wedgedRejects;
    expect(isWasmClientBusy()).toBe(false);
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

  it.each([
    ["the SDK's own wording", 'Client not initialized'],
    ['a vault-shaped trap text', 'wallet is locked'],
    ['and the third pattern too', 'vault is unavailable']
  ])('keeps a locked-vault phrase in the CAUSE out of its own message — %s', (_why, causeText) => {
    // The realm listener hands the trap through as `cause`, and a trap's text is
    // not ours. `isLockedError` reads the error's own message and means DEFER:
    // leave the row Queued and retry after unlock. That is safe only because a
    // locked vault is strictly pre-submit — the one thing an eviction is not, so
    // a match here would requeue a send whose abandoned pipeline can still pay.
    const poisoned = new WasmClientPoisonedError('realm-error', new WebAssembly.RuntimeError(causeText));

    expect(poisoned.message).not.toContain(causeText);
    expect(isLockedError(poisoned)).toBe(false);
    // The trap is still recoverable for a human, just not through the message.
    expect(poisoned.cause).toBeInstanceOf(WebAssembly.RuntimeError);
    expect((poisoned.cause as Error).message).toBe(causeText);
  });

  it('names the cause class in its message, and refuses an unrecognized name', () => {
    expect(new WasmClientPoisonedError('realm-error', new WebAssembly.RuntimeError('unreachable')).message).toContain(
      'RuntimeError'
    );
    const odd = new Error('boom');
    odd.name = 'wallet is locked';
    expect(new WasmClientPoisonedError('realm-error', odd).message).toContain('unrecognized error name');
    expect(isLockedError(new WasmClientPoisonedError('realm-error', odd))).toBe(false);
  });
});

describe('realm error fast path', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Drop any recovery stamp left by an earlier test, so its cooldown cannot
    // suppress this test's trap. Fake timers restart the monotonic clock at 0
    // on every install, which puts a prior stamp in this test's future.
    __resetRecoveryCooldownForTests();
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

  it.each([
    ['this codebase says "unreachable" for connectivity, not for traps', 'Uncaught Error: node unreachable'],
    ['a guardian outage reads the same way', 'Uncaught Error: guardian unreachable'],
    ['so does the prover banner', 'Uncaught Error: prover unreachable']
  ])('ignores a benign error whose message merely contains "unreachable" — %s', async (_why, message) => {
    // The predicate used to match the bare word `unreachable`, which fires on
    // this app's own connectivity wording — and on mobile the whole React app
    // shares this realm. A false positive is expensive: it evicts a healthy
    // holder and disposes a live client mid-transaction. It also bought nothing,
    // since engines render the real trap as `RuntimeError: unreachable`, which
    // the RuntimeError arm already matches.
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    const first = withWasmClientLock(() => gate);
    await jest.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new ErrorEvent('error', { error: new Error(message), message }));
    await jest.advanceTimersByTimeAsync(0);

    expect(isWasmClientBusy()).toBe(true);
    releaseGate();
    await expect(first).resolves.toBeUndefined();
  });

  it.each([
    ["JavaScriptCore's out-of-bounds wording", 'Out of bounds memory access'],
    ["JavaScriptCore's divide-by-zero wording", 'Division by zero'],
    ["V8's out-of-bounds wording", 'memory access out of bounds'],
    ["V8's divide-by-zero wording", 'divide by zero']
  ])("detects a trap in either engine's phrasing — %s", async (_why, message) => {
    // Trap text is not portable, and iOS (JavaScriptCore) is where the recorded
    // #775 freeze happened — matching only V8's phrasing left that platform with
    // no fast path at all.
    const first = withWasmClientLock(() => new Promise<never>(() => {}));
    const firstRejects = expectRejection(first, { name: 'WasmClientPoisonedError', reason: 'realm-error' });
    await jest.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new ErrorEvent('error', { message: `Uncaught RuntimeError-less: ${message}` }));
    await jest.advanceTimersByTimeAsync(0);

    expect(isWasmClientBusy()).toBe(false);
    await firstRejects;
  });

  it('detects a trap delivered as an unhandled REJECTION, not an error event', async () => {
    // A trap that rejects its call is unhandled whenever the awaiting flow is
    // already gone, and JavaScriptCore favours this shape. The listener used to
    // watch 'error' only, so on those deliveries recovery waited for the
    // watchdog instead of firing in milliseconds.
    const first = withWasmClientLock(() => new Promise<never>(() => {}));
    const firstRejects = expectRejection(first, { name: 'WasmClientPoisonedError', reason: 'realm-error' });
    await jest.advanceTimersByTimeAsync(0);

    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new WebAssembly.RuntimeError('unreachable') })
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(isWasmClientBusy()).toBe(false);
    await firstRejects;
  });

  it('ignores an ordinary unhandled rejection — the realm is shared with the whole app', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    const first = withWasmClientLock(() => gate);
    await jest.advanceTimersByTimeAsync(0);

    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('node unreachable') }));
    await jest.advanceTimersByTimeAsync(0);

    expect(isWasmClientBusy()).toBe(true);
    releaseGate();
    await expect(first).resolves.toBeUndefined();
  });

  it('ignores an ordinary error thrown from a wasm-GLUE file, which is not a .wasm module', async () => {
    // `/\.wasm\b/` matched `foo.wasm.js` and `foo.wasm.map` — the `\b` is
    // satisfied by the following dot — so any TypeError out of generated glue
    // code evicted a holder.
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    const first = withWasmClientLock(() => gate);
    await jest.advanceTimersByTimeAsync(0);

    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Uncaught TypeError: x is not a function',
        filename: 'https://wallet/assets/miden_client_web.wasm.js'
      })
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(isWasmClientBusy()).toBe(true);
    releaseGate();
    await expect(first).resolves.toBeUndefined();
  });

  it('still detects a .wasm module URL carrying a query string or fragment', async () => {
    const first = withWasmClientLock(() => new Promise<never>(() => {}));
    const firstRejects = expectRejection(first, { name: 'WasmClientPoisonedError', reason: 'realm-error' });
    await jest.advanceTimersByTimeAsync(0);

    window.dispatchEvent(
      new ErrorEvent('error', { message: 'Script error.', filename: 'https://wallet/client.wasm?v=3' })
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(isWasmClientBusy()).toBe(false);
    await firstRejects;
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

  // Also pins the cooldown's "never recovered" sentinel: this recovery is stamped
  // at monotonic time 0 (no time has been advanced yet), so a sentinel of 0 —
  // rather than null — would read as "no recovery" and let the corpse trap
  // through, which is the cascade this suppression exists to stop.
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
    // Drop any recovery stamp left by an earlier test, so its cooldown cannot
    // suppress this test's trap. Fake timers restart the monotonic clock at 0
    // on every install, which puts a prior stamp in this test's future.
    __resetRecoveryCooldownForTests();
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

  it('an evicted flow yielding with its own hold does NOT release the lock the next holder now owns', async () => {
    // The wedge this closes: eviction abandons an operation rather than
    // cancelling it, so the evicted flow keeps running and reaches its next
    // `yieldWasmClientLock`. Inferring ownership from "somebody holds the mutex"
    // cannot tell that flow from the real owner, so it released the INNOCENT
    // holder's lock — popping a waiter into a concurrent WASM call beside a live
    // holder, then leaving the mutex owned by nobody once it reacquired. The
    // real instance of this is the offscreen commit-wait loop, which yields on
    // every poll for a full 60s after being evicted.
    let releaseCorpseYield!: () => void;
    const corpseGate = new Promise<void>(resolve => {
      releaseCorpseYield = resolve;
    });
    let corpseHold: WasmLockHold | null = null;
    let corpseYieldReturned = false;

    const evicted = withWasmClientLock(async hold => {
      corpseHold = hold;
      // Wedge past the ceiling so this holder is evicted while still alive.
      await new Promise<never>(() => {});
    });
    const evictedRejects = expectRejection(evicted, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    await jest.advanceTimersByTimeAsync(300_000);
    await evictedRejects;
    expect(isWasmClientBusy()).toBe(false);

    // A healthy holder takes the freed lock.
    let releaseSuccessor!: () => void;
    const successorGate = new Promise<void>(resolve => {
      releaseSuccessor = resolve;
    });
    const successor = withWasmClientLock(() => successorGate);
    await jest.advanceTimersByTimeAsync(0);
    expect(isWasmClientBusy()).toBe(true);

    // Nobody must be able to start while the successor holds the lock.
    let interloperRan = false;
    const interloper = withWasmClientLock(async () => {
      interloperRan = true;
    });

    // Now the corpse yields, passing the hold it captured before it was evicted.
    const corpseYield = yieldWasmClientLock(async () => {
      await corpseGate;
      return 'corpse-done';
    }, corpseHold).then(v => {
      corpseYieldReturned = true;
      return v;
    });

    await jest.advanceTimersByTimeAsync(0);
    // The successor still owns the mutex and the queued op has NOT been let in.
    expect(isWasmClientBusy()).toBe(true);
    expect(interloperRan).toBe(false);

    releaseCorpseYield();
    await expect(corpseYield).resolves.toBe('corpse-done');
    expect(corpseYieldReturned).toBe(true);
    // The corpse's yield never took the mutex, so it must not have queued for it
    // either — the successor is still the owner.
    expect(isWasmClientBusy()).toBe(true);
    expect(interloperRan).toBe(false);

    releaseSuccessor();
    await successor;
    await interloper;
    expect(interloperRan).toBe(true);
    expect(isWasmClientBusy()).toBe(false);
  });

  it('an evicted flow pausing with its own hold does NOT silence the watchdog of the next holder', async () => {
    // Same root cause as the yield case: a corpse reaching a sign callback or a
    // local prove would otherwise clear the watchdog of the holder recovery just
    // promoted — removing the backstop from the one flow still guarding the
    // client, for as long as the corpse's own wait lasts.
    let corpseHold: WasmLockHold | null = null;
    const evicted = withWasmClientLock(async hold => {
      corpseHold = hold;
      await new Promise<never>(() => {});
    });
    const evictedRejects = expectRejection(evicted, { name: 'WasmClientPoisonedError', reason: 'watchdog' });
    await jest.advanceTimersByTimeAsync(300_000);
    await evictedRejects;

    const successor = withWasmClientLock(() => new Promise<never>(() => {}));
    const successorRejects = expectRejection(successor, { name: 'WasmClientPoisonedError', reason: 'watchdog' });
    await jest.advanceTimersByTimeAsync(0);

    // The corpse opens a pause that never closes, quoting its stale hold.
    void yieldWasmClientLock(async () => {}, corpseHold);
    void withWasmLockWatchdogPaused(() => new Promise<never>(() => {}), corpseHold);
    await jest.advanceTimersByTimeAsync(0);

    // The successor's own ceiling still fires.
    await jest.advanceTimersByTimeAsync(300_000);
    expect(isWasmClientBusy()).toBe(false);
    await successorRejects;
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
    // Drop any recovery stamp left by an earlier test, so its cooldown cannot
    // suppress this test's trap. Fake timers restart the monotonic clock at 0
    // on every install, which puts a prior stamp in this test's future.
    __resetRecoveryCooldownForTests();
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
    onWasmClientPoisoned: (listener: () => void) => () => void;
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

  it('notifies realms that keep their own client, which the singleton dispose cannot reach', async () => {
    // The offscreen document builds its client with `MidenClientInterface.create`
    // and caches it in a module-local, so `disposeAllInstances()` reaches nothing
    // there — recovery would release the mutex and then hand the next call the
    // same trapped client. That is the realm where the recorded #775 trap
    // happened, so the hook is what makes recovery mean anything there.
    const { mod } = await loadIsolated();
    await mod.getMidenClient();
    const realmDisposer = jest.fn();
    mod.onWasmClientPoisoned(realmDisposer);

    const wedged = mod.withWasmClientLock(() => new Promise<never>(() => {}));
    const wedgedRejects = expectRejection(wedged, { name: 'WasmClientPoisonedError' });
    await jest.advanceTimersByTimeAsync(300_000);
    await wedgedRejects;

    expect(realmDisposer).toHaveBeenCalledTimes(1);
  });

  it('a throwing realm disposer cannot abort recovery — the mutex is still released', async () => {
    const { mod } = await loadIsolated();
    await mod.getMidenClient();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mod.onWasmClientPoisoned(() => {
      throw new Error('realm disposer blew up');
    });

    const wedged = mod.withWasmClientLock(() => new Promise<never>(() => {}));
    const wedgedRejects = expectRejection(wedged, { name: 'WasmClientPoisonedError' });
    let nextRan = false;
    const next = mod.withWasmClientLock(async () => {
      nextRan = true;
    });

    await jest.advanceTimersByTimeAsync(300_000);
    await wedgedRejects;
    await next;
    expect(nextRan).toBe(true);
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
