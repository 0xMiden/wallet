// This import must stay ABOVE the `./miden-client-interface` one: that import
// forms a cycle (via `speculation-manager`), and the re-exported poison
// bindings below must already be initialized when the cycle re-enters this
// module — see `wasm-client-poison.ts`.
import { WASM_LOCK_WATCHDOG_MS, WasmClientPoisonedError } from './wasm-client-poison';
// eslint-disable-next-line import/order -- must load AFTER wasm-client-poison (TDZ safety, see above)
import { MidenClientInterface, MidenClientCreateOptions } from './miden-client-interface';

export { WASM_LOCK_WATCHDOG_MS, WasmClientPoisonedError };

/**
 * Simple async mutex to prevent concurrent WASM client operations.
 * The WASM client cannot handle concurrent calls - they cause
 * "recursive use of an object detected which would lead to unsafe aliasing in rust" errors.
 *
 * Supports an idle queue for low-priority background tasks that run only when
 * no high-priority operations are pending.
 */
class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];
  private idleQueue: Array<() => Promise<void>> = [];
  private drainingIdle = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
      // Run idle tasks immediately - deduplication is handled by callers
      this.drainIdleQueue();
    }
  }

  /** True while an operation currently holds the mutex. */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * Non-blocking acquire: takes the lock and returns `true` if it was free,
   * otherwise returns `false` without waiting. The check-and-set is atomic in
   * single-threaded JS (no `await` between the read and the write).
   */
  tryAcquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  /**
   * Queue a low-priority task to run when the mutex is idle.
   * Idle tasks run after all high-priority (withWasmClientLock) operations complete.
   * Idle tasks do NOT hold the lock - they should use withWasmClientLock internally if needed.
   */
  queueIdleTask(task: () => Promise<void>): void {
    this.idleQueue.push(task);
    // Run immediately if idle - deduplication is handled by callers
    if (!this.locked && this.queue.length === 0 && !this.drainingIdle) {
      this.drainIdleQueue();
    }
  }

  private drainIdleQueue(): void {
    // Don't drain if: nothing to drain, already draining, lock held, or high-priority work waiting
    if (this.idleQueue.length === 0 || this.drainingIdle || this.locked || this.queue.length > 0) {
      return;
    }
    const tasks = this.idleQueue.splice(0);
    this.runIdleTasks(tasks);
  }

  private runIdleTasks(tasks: Array<() => Promise<void>>): void {
    this.drainingIdle = true;
    // Run idle tasks sequentially without holding the lock.
    // Each task is responsible for acquiring locks via withWasmClientLock if needed.
    const runNext = (index: number): void => {
      if (index >= tasks.length) {
        this.drainingIdle = false;
        // Check if more idle tasks were queued while we were running
        if (this.idleQueue.length > 0 && !this.locked) {
          this.drainIdleQueue();
        }
        return;
      }
      // Check if high-priority work is waiting - if so, pause idle tasks
      /* c8 ignore next 5 -- requires concurrent lock contention during idle drain */
      if (this.locked || this.queue.length > 0) {
        // Re-queue remaining tasks and stop
        this.idleQueue.unshift(...tasks.slice(index));
        this.drainingIdle = false;
        return;
      }
      const task = tasks[index];
      /* c8 ignore next 4 -- defensive guard for sparse array */
      if (!task) {
        runNext(index + 1);
        return;
      }
      task()
        .catch(err => console.warn('Idle task failed:', err))
        .finally(() => runNext(index + 1));
    };
    runNext(0);
  }
}

// Global mutex for all WASM client operations
const wasmClientMutex = new AsyncMutex();

/**
 * The current `withWasmClientLock` holder. At most one exists at a time (the
 * mutex serializes holds); `null` while the lock is free or while a holder has
 * yielded it via `yieldWasmClientLock`.
 */
interface LockHolder {
  /** Set by recovery: the holder was evicted and the mutex already re-released. */
  killed: boolean;
  /** Depth of `withWasmLockWatchdogPaused` brackets currently open. */
  pauseCount: number;
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  /** Rejects the race in `withWasmClientLock`, unblocking the caller. */
  abort: (err: Error) => void;
  aborted: Promise<never>;
}

let currentHolder: LockHolder | null = null;

/**
 * Does an uncaught realm error look like a WebAssembly trap? The main-realm
 * case carries the actual `WebAssembly.RuntimeError`; an error propagated up
 * from the SDK's method worker loses the error object in transit, so fall back
 * to matching the message/filename. Deliberately narrow — an unrelated app
 * error sharing the realm (mobile runs the whole React app in the client's
 * window) must not evict a healthy holder.
 */
function looksLikeWasmTrap(event: ErrorEvent): boolean {
  if (typeof WebAssembly !== 'undefined' && event.error instanceof WebAssembly.RuntimeError) {
    return true;
  }
  const message = typeof event.message === 'string' ? event.message : '';
  // No bare "wasm" match here: on mobile the whole React app shares the realm,
  // and an unrelated error merely mentioning wasm must not evict a holder.
  if (/\bRuntimeError\b|\bunreachable\b|memory access out of bounds/i.test(message)) {
    return true;
  }
  const filename = typeof event.filename === 'string' ? event.filename : '';
  return /\.wasm\b/i.test(filename);
}

/**
 * Suppress realm-error evictions for a window after any recovery. An evicted
 * holder's operation is abandoned, not cancelled — if it was still alive (a
 * watchdog false positive), its next call against the disposed client can trap,
 * and that corpse trap must not be attributed to the innocent next holder or
 * dispose the freshly built client (a cascade). A genuine second trap inside
 * the window still gets the watchdog. Guarded against clock rewinds (and fake
 * timers): a negative delta counts as expired.
 */
const REALM_ERROR_COOLDOWN_MS = 10_000;
let lastRecoveryAt = 0;

function inRecoveryCooldown(): boolean {
  const sinceRecovery = Date.now() - lastRecoveryAt;
  return lastRecoveryAt !== 0 && sinceRecovery >= 0 && sinceRecovery < REALM_ERROR_COOLDOWN_MS;
}

/** Holders currently suspended inside a `yieldWasmClientLock` window. */
let yieldedHolderCount = 0;

function onRealmError(event: ErrorEvent): void {
  if (!looksLikeWasmTrap(event)) return;
  const cause = event.error ?? new Error(event.message || 'unknown WASM trap');
  if (inRecoveryCooldown()) {
    console.error('[miden-client] WASM trap within recovery cooldown — ignoring (likely an evicted corpse):', cause);
    return;
  }
  if (currentHolder) {
    recoverFromWedgedHolder(currentHolder, 'realm-error', cause);
  } else if (yieldedHolderCount > 0) {
    // A holder is suspended mid-yield (e.g. awaiting an offscreen prove).
    // Disposing now would pull the client out from under it when it reacquires
    // — and past its point-of-no-return that would falsely Fail a healthy
    // transaction. Leave recovery to the suspended flow's own failure path.
    console.error('[miden-client] WASM trap while a holder is mid-yield — not disposing:', cause);
  } else {
    // No holder to evict, but the trap still aborted the module instance —
    // dispose so the next getMidenClient() constructs a fresh client instead
    // of handing out the poisoned one.
    console.error('[miden-client] WASM trap with no lock holder — disposing client singletons:', cause);
    lastRecoveryAt = Date.now();
    midenClientSingleton.disposeAllInstances();
  }
}

/**
 * Register the trap listener on this realm (issue #775). A trap surfaces as an
 * uncaught error on the realm — NOT as an `unhandledrejection`, because the
 * abandoned future's promise never settles. This module is instantiated once
 * per realm, so installing here covers every realm that owns a client (service
 * worker, offscreen document, mobile/desktop main window, extension UI pages)
 * with no per-realm wiring.
 *
 * Caveat: where the client runs inside the SDK's method worker (extension SW),
 * a worker trap reaches this realm listener only if it propagates unhandled
 * through the Worker object; if the SDK swallows it, the watchdog is the
 * backstop. On mobile — where the recorded #775 freeze happened — the client
 * runs on this realm's main thread and the fast path always sees the trap.
 */
let realmErrorListenerInstalled = false;
function ensureRealmErrorListener(): void {
  if (realmErrorListenerInstalled) return;
  if (typeof globalThis.addEventListener !== 'function') return;
  globalThis.addEventListener('error', onRealmError);
  realmErrorListenerInstalled = true;
}

function armWatchdog(holder: LockHolder): void {
  holder.watchdogTimer = setTimeout(() => {
    recoverFromWedgedHolder(holder, 'watchdog');
  }, WASM_LOCK_WATCHDOG_MS);
}

function beginHold(): LockHolder {
  let abort!: (err: Error) => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = reject;
  });
  const holder: LockHolder = { killed: false, pauseCount: 0, watchdogTimer: null, abort, aborted };
  armWatchdog(holder);
  currentHolder = holder;
  return holder;
}

/**
 * Close out a hold on the normal path. Returns whether the caller still owns
 * the mutex and must release it — `false` means recovery already evicted this
 * holder and released the lock, and releasing again would corrupt the queue.
 */
function endHold(holder: LockHolder): boolean {
  if (holder.watchdogTimer) clearTimeout(holder.watchdogTimer);
  holder.watchdogTimer = null;
  if (currentHolder === holder) {
    currentHolder = null;
  }
  return !holder.killed;
}

/**
 * Evict a wedged holder (issue #775): reject its pending race with a named
 * error and release the mutex so the queue drains. The abandoned operation's
 * promise stays pending forever — that is exactly the failure mode this
 * recovers from.
 */
function recoverFromWedgedHolder(holder: LockHolder, reason: 'watchdog' | 'realm-error', cause?: unknown): void {
  // Stale trigger: the holder already finished, was already killed, or is
  // mid-yield (not currently holding the lock).
  if (holder.killed || holder !== currentHolder) return;
  holder.killed = true;
  lastRecoveryAt = Date.now();
  if (holder.watchdogTimer) clearTimeout(holder.watchdogTimer);
  holder.watchdogTimer = null;
  currentHolder = null;
  const error = new WasmClientPoisonedError(reason, cause);
  console.error('[miden-client] evicting wedged WASM lock holder:', error);
  holder.abort(error);
  // A trap aborts the WASM module instance — every later call against it
  // fails, so releasing the mutex alone would hand the next operation a dead
  // client. Dispose first (deliberately NOT via resetMidenClient(), which
  // takes this same lock and would deadlock), then release so the queue
  // drains onto a freshly constructed client.
  midenClientSingleton.disposeAllInstances();
  wasmClientMutex.release();
}

/**
 * Execute an operation with the WASM client mutex held.
 * This ensures only one WASM client operation runs at a time across the entire app.
 */
export async function withWasmClientLock<T>(operation: () => Promise<T>): Promise<T> {
  await wasmClientMutex.acquire();
  const holder = beginHold();
  try {
    return await Promise.race([operation(), holder.aborted]);
  } finally {
    if (endHold(holder)) {
      wasmClientMutex.release();
    }
  }
}

/**
 * True while any `withWasmClientLock` operation is in progress.
 *
 * Background pollers that deliberately bypass `withWasmClientLock` (currently
 * the balance poll, `fetchBalances` → `getAccount`) MUST check this and skip
 * their WASM read while it is true.
 *
 * Rationale: a transaction holds this lock across the SDK's
 * `_withInnerWebClient` window, and during that window the SDK runs any OTHER
 * client call INLINE (skipping its own `_serializeWasmCall` chain), on the
 * documented assumption that the caller holds an external mutex over every
 * other WASM path. An un-locked read fired inside that window therefore runs
 * inline too and double-borrows wasm-bindgen's RefCell — panicking the WASM
 * client (`web-client/src/platform.rs` "RefCell already borrowed"), which on
 * mobile hangs guardian consumes forever. Skipping a poll cycle costs one
 * delayed balance refresh; racing the lock crashes the client.
 */
export function isWasmClientBusy(): boolean {
  return wasmClientMutex.isLocked;
}

/**
 * Run `operation` under the WASM client lock ONLY if the lock can be taken
 * without waiting; otherwise skip it and resolve to `{ ran: false }`.
 *
 * For background reads that intentionally bypass `withWasmClientLock` for
 * responsiveness (the balance poll's `getAccount`) but must still be atomic
 * against transactions: a plain un-locked read fired during a transaction's
 * `_withInnerWebClient` window runs inline and double-borrows the WASM client's
 * RefCell (crash). Acquiring the lock around the read closes that window, and
 * using a NON-blocking try (skip, don't queue) preserves the reason the read
 * bypassed the lock in the first place — it must not stall behind long writes
 * like `syncState`. Callers treat `{ ran: false }` as "skip this refresh, keep
 * prior data, retry next cycle."
 *
 * Unlike a plain `isWasmClientBusy()` check, this is atomic with the borrow:
 * there is no check-then-act gap in which the lock could be taken by a
 * transaction between the guard and the read.
 */
export async function tryWithWasmClientLock<T>(
  operation: () => Promise<T>
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!wasmClientMutex.tryAcquire()) return { ran: false };
  const holder = beginHold();
  try {
    return { ran: true, value: await Promise.race([operation(), holder.aborted]) };
  } finally {
    if (endHold(holder)) {
      wasmClientMutex.release();
    }
  }
}

/**
 * Run `operation` with the current lock holder's watchdog paused (issue #775).
 * Mirrors `pauseDeadline`/`resumeDeadline` in `miden-client-proxy.ts`: pause
 * stops the clock entirely, and the close of the bracket re-arms the FULL
 * ceiling from scratch — no elapsed-time accounting. For the two legitimately
 * unbounded waits inside a hold: a keystore sign round-trip (blocks on user
 * authentication) and a local prove (the fallback when delegated proving is
 * down — capping it would leave nothing to fall back to).
 *
 * Depth-counted so brackets nest, and holder-scoped: the holder is captured at
 * entry so the close can never touch a different holder. No-op when the lock
 * is not held. Pausing only silences the watchdog — a realm trap still evicts
 * a paused holder immediately.
 */
export async function withWasmLockWatchdogPaused<T>(operation: () => Promise<T>): Promise<T> {
  const holder = currentHolder;
  if (holder && !holder.killed) {
    holder.pauseCount++;
    if (holder.watchdogTimer) {
      clearTimeout(holder.watchdogTimer);
      holder.watchdogTimer = null;
    }
  }
  try {
    return await operation();
  } finally {
    if (holder && !holder.killed) {
      holder.pauseCount--;
      if (holder.pauseCount === 0 && holder === currentHolder) {
        armWatchdog(holder);
      }
    }
  }
}

/**
 * Temporarily release the WASM client mutex while running `operation`, then
 * reacquire it before resolving. Caller MUST currently hold the lock.
 *
 * Use this when a lock-holding flow does long, genuinely-non-WASM-client
 * work — for example, awaiting an offscreen-document prover. Without
 * yielding, sync (which contends on this same mutex) gets blocked for the
 * full prove duration and surfaces a "can't reach node" toast on its
 * timeout. With the yield, sync runs while the prove is happening in the
 * other context, which is fine because the offscreen doc has its own WASM
 * instance and isn't touching the SW's client.
 *
 * Safety: the operation must NOT touch the WASM client (any wasm-bindgen
 * call, MidenClient method, etc.). It's only safe to use for I/O-bound
 * waits on workloads that don't share state with the SW's WASM instance.
 */
export async function yieldWasmClientLock<T>(operation: () => Promise<T>): Promise<T> {
  // While yielded this flow does not hold the lock, so it must not be watched
  // (the offscreen prove it waits on is legitimately unbounded) and must not
  // be the realm-error eviction target — another holder may take the lock in
  // the meantime and gets its own watchdog (issue #775).
  const holder = currentHolder;
  if (!holder) {
    // No current holder means this flow does not own the mutex — either a
    // contract violation or, after a recovery, an evicted holder's abandoned
    // operation still running. Releasing here would pop a waiter into a
    // concurrent WASM call, and the reacquire would leak a permanently-held
    // lock (the exact wedge #775 fixes). Run the operation without touching
    // the mutex.
    return operation();
  }
  if (holder.watchdogTimer) {
    clearTimeout(holder.watchdogTimer);
    holder.watchdogTimer = null;
  }
  currentHolder = null;
  yieldedHolderCount++;
  wasmClientMutex.release();
  try {
    return await operation();
  } finally {
    await wasmClientMutex.acquire();
    yieldedHolderCount--;
    /* c8 ignore else -- a suspended holder is never the eviction target today */
    if (!holder.killed) {
      currentHolder = holder;
      if (holder.pauseCount === 0) {
        armWatchdog(holder);
      }
    } else {
      // Defensive: a holder cannot currently be killed while suspended, but if
      // that ever becomes possible this flow must not resume as owner — hand
      // the slot straight back instead of leaking a held lock.
      /* c8 ignore next 2 -- see above */
      wasmClientMutex.release();
    }
  }
}

/**
 * Queue a low-priority operation to run when the WASM client is idle.
 * Use this for background tasks like metadata prefetching that shouldn't
 * block or delay critical operations.
 *
 * Operations are fire-and-forget (errors are logged, not thrown).
 */
export function runWhenClientIdle(operation: () => Promise<void>): void {
  wasmClientMutex.queueIdleTask(operation);
}

/**
 * Singleton manager for MidenClientInterface.
 * Ensures a bounded number of client instances (and underlying web workers) exist at a time.
 */
class MidenClientSingleton {
  private instance: MidenClientInterface | null = null;
  private initializingPromise: Promise<MidenClientInterface> | null = null;

  private instanceWithOptions: MidenClientInterface | null = null;
  private initializingPromiseWithOptions: Promise<MidenClientInterface> | null = null;

  /**
   * Get or create the singleton MidenClientInterface instance.
   * This instance does not specify any options and is never disposed.
   * On mobile, if instanceWithOptions already exists, return that to avoid
   * creating multiple clients (which causes OOM from multiple WASM worker instances).
   */
  async getInstance(): Promise<MidenClientInterface> {
    // On mobile, reuse any existing client to avoid OOM from multiple worker instances
    /* c8 ignore next 3 -- singleton reuse path, requires prior getInstanceWithOptions call */
    if (this.instanceWithOptions) {
      return this.instanceWithOptions;
    }

    /* c8 ignore next 3 -- singleton cache hit, requires WASM client creation */
    if (this.instance) {
      return this.instance;
    }

    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    this.initializingPromise = (async () => {
      try {
        const client = await MidenClientInterface.create();
        this.instance = client;
        return client;
      } finally {
        // Always clear the memoized init promise so a transient startup failure
        // (e.g. the node is unreachable at first client construction) self-heals
        // on the NEXT getInstance() call, instead of poisoning the singleton with
        // a permanently-rejected promise until a full reload / SW restart. Before
        // this, a startup blip left every caller getting the same rejection
        // forever (resilience gap 7).
        this.initializingPromise = null;
      }
    })();

    return this.initializingPromise;
  }

  /**
   * Get or create the singleton MidenClientInterface instance with specified options.
   * If it already exists, this instance will always be disposed and recreated to ensure option correctness.
   */
  async getInstanceWithOptions(options: MidenClientCreateOptions): Promise<MidenClientInterface> {
    if (this.instanceWithOptions) {
      this.disposeInstanceWithOptions();
    }

    /* c8 ignore next 3 -- concurrent init dedup, requires WASM client creation */
    if (this.initializingPromiseWithOptions) {
      return this.initializingPromiseWithOptions;
    }

    this.initializingPromiseWithOptions = (async () => {
      try {
        const client = await MidenClientInterface.create(options);
        this.instanceWithOptions = client;
        return client;
      } finally {
        // Self-heal a transient startup failure instead of poisoning the
        // memoized promise (resilience gap 7 — see getInstance above).
        this.initializingPromiseWithOptions = null;
      }
    })();

    return this.initializingPromiseWithOptions;
  }

  disposeInstanceWithOptions(): void {
    if (this.instanceWithOptions) {
      this.freeGuarded(this.instanceWithOptions);
      this.instanceWithOptions = null;
      this.initializingPromiseWithOptions = null;
    }
  }

  /**
   * `free()` on a trapped WASM module can itself throw (issue #775). The
   * instance is being discarded either way, so a throwing free must never
   * abort a dispose — that would leave the dead client in the slot and hand
   * it to the next `getMidenClient()` caller.
   */
  private freeGuarded(instance: MidenClientInterface): void {
    try {
      instance.free();
    } catch (err) {
      console.warn('[miden-client] free() threw during dispose (continuing):', err);
    }
  }

  /**
   * Free every live singleton (the no-options `instance` and the
   * `instanceWithOptions`), so the next `getInstance()`/`getInstanceWithOptions()`
   * call recreates the WASM client from scratch. Used when the effective
   * endpoints (RPC/prover/note-transport) change underneath a long-lived
   * singleton — see `resetMidenClient`.
   */
  disposeAllInstances(): void {
    if (this.instance) {
      this.freeGuarded(this.instance);
      this.instance = null;
    }
    // Null unconditionally, not just inside the `this.instance` guard above: if a
    // no-options `getInstance()` creation is in flight, `this.instance` is still null
    // here (the guard above never runs) but `initializingPromise` is a pending promise
    // that a subsequent `getInstance()` call would otherwise return as-is — repopulating
    // `this.instance` with a client built against the pre-reload override once that
    // stale creation resolves. Clearing the slot means any `getInstance()` call issued
    // after this reset starts its own fresh creation instead of rejoining the stale one.
    this.initializingPromise = null;
    this.disposeInstanceWithOptions();
  }
}

const midenClientSingleton = new MidenClientSingleton();

// Install the trap listener as soon as any code in this realm touches the
// client module — a trap can fire during an un-locked bypass read (the balance
// poll) before the first `withWasmClientLock` call ever happens.
ensureRealmErrorListener();

/**
 * Convenience function to get the shared MidenClientInterface instance.
 * Use this in your components and modules instead of calling MidenClientInterface.create().
 */
export async function getMidenClient(options?: MidenClientCreateOptions): Promise<MidenClientInterface> {
  if (options) {
    const client = await midenClientSingleton.getInstanceWithOptions(options);
    return client;
  }
  const client = await midenClientSingleton.getInstance();
  return client;
}

/**
 * Dispose every live MidenClientInterface singleton so the next `getMidenClient()`
 * call rebuilds one from scratch against the current effective endpoints
 * (`lib/miden-chain/effective-endpoints`). Use this after the endpoint
 * override changes underneath an already-created client (e.g. the SW's
 * `RELOAD_ENDPOINT_OVERRIDES_REQUEST` handler) — the client bakes in
 * rpcUrl/proverUrl/noteTransportUrl at `MidenClient.create()` time and never
 * re-reads them. Runs inside `withWasmClientLock` so it can't dispose a
 * client mid-operation.
 */
export async function resetMidenClient(): Promise<void> {
  await withWasmClientLock(async () => {
    midenClientSingleton.disposeAllInstances();
  });
}
