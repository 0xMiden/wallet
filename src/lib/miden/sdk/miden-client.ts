import { MidenClientInterface, MidenClientCreateOptions } from './miden-client-interface';

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
 * Execute an operation with the WASM client mutex held.
 * This ensures only one WASM client operation runs at a time across the entire app.
 */
export async function withWasmClientLock<T>(operation: () => Promise<T>): Promise<T> {
  await wasmClientMutex.acquire();
  try {
    return await operation();
  } finally {
    wasmClientMutex.release();
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
  try {
    return { ran: true, value: await operation() };
  } finally {
    wasmClientMutex.release();
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
  wasmClientMutex.release();
  try {
    return await operation();
  } finally {
    await wasmClientMutex.acquire();
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
      const client = await MidenClientInterface.create();
      this.instance = client;
      this.initializingPromise = null;
      return client;
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
      const client = await MidenClientInterface.create(options);
      this.instanceWithOptions = client;
      this.initializingPromiseWithOptions = null;
      return client;
    })();

    return this.initializingPromiseWithOptions;
  }

  disposeInstanceWithOptions(): void {
    if (this.instanceWithOptions) {
      this.instanceWithOptions.free();
      this.instanceWithOptions = null;
      this.initializingPromiseWithOptions = null;
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
      this.instance.free();
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
