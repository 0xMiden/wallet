import { MidenClientInterface } from './miden-client-interface';

/**
 * Pass-through — the wallet no longer serializes WASM calls at this layer.
 *
 * The SDK's internal `_serializeWasmCall` chain + the single-instance
 * MidenClient design handles concurrency. This wrapper exists only to
 * keep the 43 call sites compiling during the transition. A follow-up
 * can inline the calls and remove this export entirely.
 */
export async function withWasmClientLock<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}

/**
 * Queue a low-priority operation to run when the WASM client is idle.
 * With the mutex removed, idle tasks run immediately (fire-and-forget).
 */
export function runWhenClientIdle(operation: () => Promise<void>): void {
  operation().catch(err => console.warn('Idle task failed:', err));
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
