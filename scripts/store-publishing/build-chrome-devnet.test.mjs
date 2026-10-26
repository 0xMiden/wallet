import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const api = await import('./build-chrome-devnet.mjs').catch(() => ({}));

test('standard local build keeps production Chrome and other outputs while appending isolated Devnet archive', async () => {
  assert.equal(typeof api.buildChromeDevnet, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'store-build-test-'));
  const dist = join(dir, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'mobile.txt'), 'original mobile');
  const networks = [];
  try {
    await api.buildChromeDevnet({ dist, run: async network => {
      networks.push(network);
      await mkdir(join(dist, 'chrome_unpacked'), { recursive: true });
      await writeFile(join(dist, 'chrome.zip'), network);
      await writeFile(join(dist, 'chrome_unpacked', 'manifest.json'), JSON.stringify({ name: network }));
      await writeFile(join(dist, 'mobile.txt'), 'overwritten by build');
    } });
    assert.deepEqual(networks, ['testnet', 'devnet']);
    assert.equal(await readFile(join(dist, 'chrome.zip'), 'utf8'), 'testnet');
    assert.equal(await readFile(join(dist, 'chrome-testnet.zip'), 'utf8'), 'testnet');
    assert.equal(await readFile(join(dist, 'chrome-devnet.zip'), 'utf8'), 'devnet');
    assert.equal(await readFile(join(dist, 'mobile.txt'), 'utf8'), 'original mobile');
    assert.deepEqual(JSON.parse(await readFile(join(dist, 'chrome_unpacked/manifest.json'), 'utf8')), { name: 'testnet' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed Devnet build restores previous outputs and reports failure', async () => {
  assert.equal(typeof api.buildChromeDevnet, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'store-build-test-'));
  const dist = join(dir, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'chrome.zip'), 'previous');
  try {
    await assert.rejects(api.buildChromeDevnet({ dist, run: async network => {
      await mkdir(join(dist, 'chrome_unpacked'), { recursive: true });
      await writeFile(join(dist, 'chrome_unpacked/manifest.json'), '{}');
      await writeFile(join(dist, 'chrome.zip'), network);
      if (network === 'devnet') throw new Error('Devnet compiler failed');
    } }), /Devnet compiler failed/);
    assert.equal(await readFile(join(dist, 'chrome.zip'), 'utf8'), 'previous');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
