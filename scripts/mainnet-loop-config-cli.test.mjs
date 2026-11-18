import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const [label, changed, message] of [
  ['non-mainnet environment', { E2E_NETWORK: 'testnet' }, 'requires mainnet'],
  ['missing workflow output', { GITHUB_ENV: '' }, 'requires a workflow environment file'],
  ['invalid workflow identity', { GITHUB_RUN_ID: 'local' }, 'requires a numeric workflow identity']
]) {
  test(`refuses ${label} before fetching or writing a snapshot`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'mainnet-config-cli-'));
    const output = join(directory, 'environment');
    try {
      const result = spawnSync(process.execPath, ['scripts/mainnet-loop-config-server.mjs'], {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, E2E_NETWORK: 'mainnet', GITHUB_RUN_ID: '123', GITHUB_ENV: output, ...changed }
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(message), result.stderr);
      assert.equal(existsSync(output), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
