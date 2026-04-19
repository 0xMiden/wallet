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
}

const midenClientSingleton = new MidenClientSingleton();

/**
 * Convenience function to get the shared MidenClientInterface instance.
 * Use this in your components and modules instead of calling MidenClientInterface.create().
 */
export async function getMidenClient(options?: MidenClientCreateOptions): Promise<MidenClientInterface> {
  if (options) {
    console.time('Creating MidenClient with options');
    const client = await midenClientSingleton.getInstanceWithOptions(options);
    console.timeEnd('Creating MidenClient with options');
    return client;
  }
  console.time('Getting MidenClient instance');
  const client = await midenClientSingleton.getInstance();
  console.timeEnd('Getting MidenClient instance');
  return client;
}
