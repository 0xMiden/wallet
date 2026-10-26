import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { acquireInstanceLock } from './instance-lock.js';

const moduleUrl = new URL('./instance-lock.ts', import.meta.url).href;
const acquireScript = `
  import { acquireInstanceLock } from ${JSON.stringify(moduleUrl)};
  const lock = acquireInstanceLock(process.env.TEST_DB_PATH);
  if (process.env.TEST_HOLD_LOCK) {
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  } else {
    lock.close();
  }
`;
const args = ['--import', 'tsx', '--input-type=module', '-e', acquireScript];

describe('instance lock', () => {
  it('blocks another process and permits restart after close', () => {
    const directory = mkdtempSync(join(tmpdir(), 'backend-lock-'));
    const path = join(directory, 'orders.sqlite');
    const env = { ...process.env, TEST_DB_PATH: path };
    try {
      const lock = acquireInstanceLock(path);
      try {
        const second = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 5000 });
        assert.equal(second.status, 1);
        assert.match(second.stderr, /Cannot lock the backend database/);
      } finally {
        lock.close();
      }
      const restarted = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(restarted.status, 0, restarted.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('releases the lock after a process is killed', { timeout: 10000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'backend-lock-'));
    const path = join(directory, 'orders.sqlite');
    const child = spawn(process.execPath, args, {
      env: { ...process.env, TEST_DB_PATH: path, TEST_HOLD_LOCK: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      assert.throws(() => acquireInstanceLock(path), /Cannot lock/);
      child.kill('SIGKILL');
      await exited;
      acquireInstanceLock(path).close();
    } finally {
      child.kill('SIGKILL');
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an in-memory server database', () => {
    assert.throws(() => acquireInstanceLock(':memory:'), /persistent DB_PATH/);
  });
});
