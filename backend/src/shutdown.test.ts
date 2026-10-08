import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createShutdown } from './shutdown.js';
import { captureLogs } from './test/support.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('shutdown', () => {
  it('holds storage until HTTP and worker operations finish and runs only once', async () => {
    captureLogs();
    const calls: string[] = [];
    let closeHttp: (error?: Error) => void = () => {};
    const workerDone = deferred<void>();
    const shutdown = createShutdown({
      server: {
        close: callback => {
          closeHttp = callback;
          calls.push('http');
        }
      },
      worker: {
        stop: () => {
          calls.push('worker');
          return workerDone.promise;
        }
      },
      feed: {
        close: () => {
          calls.push('feed');
        }
      },
      database: {
        close: () => {
          calls.push('database');
        }
      },
      lock: {
        close: () => {
          calls.push('lock');
        }
      },
      exit: code => {
        calls.push(`exit:${code}`);
      },
      timeoutMs: 1000
    });
    const pending = shutdown();
    assert.equal(shutdown(), pending);
    assert.deepEqual(calls, ['http', 'worker', 'feed']);
    workerDone.resolve();
    await workerDone.promise;
    assert.deepEqual(calls, ['http', 'worker', 'feed']);
    closeHttp();
    await pending;
    assert.deepEqual(calls, ['http', 'worker', 'feed', 'database', 'lock', 'exit:0']);
  });

  it('exits with failure without releasing the lock when the deadline passes', async () => {
    captureLogs();
    const workerDone = deferred<void>();
    const exited = deferred<number>();
    let storageClosed = false;
    const shutdown = createShutdown({
      server: { close: callback => callback() },
      worker: { stop: () => workerDone.promise },
      feed: { close: () => {} },
      database: {
        close: () => {
          storageClosed = true;
        }
      },
      lock: {
        close: () => {
          storageClosed = true;
        }
      },
      exit: exited.resolve,
      timeoutMs: 10
    });
    const pending = shutdown();
    assert.equal(await exited.promise, 1);
    assert.equal(storageClosed, false);
    workerDone.resolve();
    await pending;
  });

  it('keeps the lock until process exit if database close fails', async () => {
    captureLogs();
    let lockClosed = false;
    let exitCode = -1;
    const shutdown = createShutdown({
      server: { close: callback => callback() },
      worker: { stop: async () => {} },
      feed: { close: () => {} },
      database: {
        close: () => {
          throw new Error('close failed');
        }
      },
      lock: {
        close: () => {
          lockClosed = true;
        }
      },
      exit: code => {
        exitCode = code;
      },
      timeoutMs: 1000
    });
    await shutdown();
    assert.equal(exitCode, 1);
    assert.equal(lockClosed, false);
  });
});
