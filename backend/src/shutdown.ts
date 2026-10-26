import { logEvent } from './log.js';

export interface ShutdownOptions {
  server: { close(callback: (error?: Error) => void): void };
  worker: { stop(): Promise<void> };
  feed: { close(): void };
  database: { close(): void };
  lock: { close(): void };
  exit: (code: number) => void;
  timeoutMs: number;
}

/** Stop new work, wait for active work, then release storage. Repeated calls share the same result. */
export function createShutdown(options: ShutdownOptions): () => Promise<void> {
  let pending: Promise<void> | null = null;

  async function shutdown(): Promise<void> {
    const timer = setTimeout(() => {
      logEvent('error', 'shutdown_timeout');
      options.exit(1);
    }, options.timeoutMs);
    logEvent('info', 'shutdown_started');
    try {
      const httpClosed = new Promise<void>((resolve, reject) => {
        options.server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      const workerStopped = options.worker.stop();
      options.feed.close();
      await Promise.all([httpClosed, workerStopped]);
      options.database.close();
      options.lock.close();
      logEvent('info', 'shutdown_complete');
      options.exit(0);
    } catch {
      // Keep the lock until process exit if cleanup fails.
      logEvent('error', 'shutdown_failed');
      options.exit(1);
    } finally {
      clearTimeout(timer);
    }
  }

  return () => {
    pending ??= shutdown();
    return pending;
  };
}
