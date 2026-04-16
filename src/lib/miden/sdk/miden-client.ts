import { MidenClientInterface } from './miden-client-interface';

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

// Wallet-side serialization for WASM client calls.
//
// The SDK serializes mutating methods internally via `_serializeWasmCall`.
// This wallet-level mutex provides additional coverage:
//   1. Validated by every passing stress run since 2026-04-16.
//   2. Cheap (one async hop per call) — overhead is negligible.
//   3. Once unification has stabilized, a follow-up PR can attempt to
//      drop this wrapper, gated on a dedicated stress run that proves
//      the SDK's coverage is sufficient on its own.
//
// Bisect history: a prior attempt to make this a no-op was wrongly blamed
// for stress regressions that turned out to be a CLI version mismatch. So
// pass-through MIGHT be safe — but that's untested under stress, and out
// of scope for the unification PR.
const wasmClientMutex = new AsyncMutex();

export async function withWasmClientLock<T>(operation: () => Promise<T>): Promise<T> {
  await wasmClientMutex.acquire();
  try {
    return await operation();
  } finally {
    wasmClientMutex.release();
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
 * Singleton manager for the long-lived MidenClientInterface instance.
 *
 * Single-instance design: keystore callbacks are wired permanently at
 * MidenClient.create time (via the keystore-bridge module); per-vault and
 * per-tx state is bound late through the bridge's mutable slots, so we
 * never need to dispose-and-recreate the underlying client just to swap
 * options. This eliminates the multi-singleton race that used to require
 * inter-instance JS-level serialization.
 */
class MidenClientSingleton {
  private instance: MidenClientInterface | null = null;
  private initializingPromise: Promise<MidenClientInterface> | null = null;

  async getInstance(): Promise<MidenClientInterface> {
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
}

const midenClientSingleton = new MidenClientSingleton();

/**
 * The shared, long-lived MidenClientInterface for this process.
 * Use this in your components and modules instead of calling
 * MidenClientInterface.create() directly.
 *
 * Tests that need a fresh client with a specific seed call
 * `MidenClientInterface.create({seed})` directly, bypassing the singleton.
 */
export async function getMidenClient(): Promise<MidenClientInterface> {
  return midenClientSingleton.getInstance();
}
