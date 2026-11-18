import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [executablePath, volume, extension] = process.argv.slice(2);
assert.ok(executablePath && volume && extension);
assert.equal(spawnSync('stat', ['-f', '-c', '%T', volume], { encoding: 'utf8' }).stdout.trim(), 'tmpfs');
const profile = join(volume, 'profile');
const filler = join(volume, 'fill');

await mkdir(extension);
await writeFile(
  join(extension, 'manifest.json'),
  JSON.stringify({
    manifest_version: 3,
    version: '1.0',
    name: 'IndexedDB Disk Probe',
    permissions: ['storage', 'unlimitedStorage'],
    background: { service_worker: 'worker.js' }
  })
);
await writeFile(
  join(extension, 'worker.js'),
  'chrome.runtime.onInstalled.addListener(() => {}); chrome.runtime.onStartup.addListener(() => {});'
);
await writeFile(join(extension, 'index.html'), '<!doctype html><title>IndexedDB Disk Probe</title>');

async function inProfile(action) {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-brave-update',
      '--disable-extensions-except=' + extension,
      '--load-extension=' + extension
    ]
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
    const page = await context.newPage();
    await page.goto(new URL('index.html', worker.url()).href);
    await action(page, context);
  } finally {
    await context.close();
  }
}

function probe({ mode, dbName }) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('records');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('records', mode === 'read' ? 'readonly' : 'readwrite');
      const records = tx.objectStore('records');
      const read = mode === 'read' ? records.get('prior') : undefined;
      tx.oncomplete = () => {
        db.close();
        resolve({ committed: true, prior: read?.result });
      };
      tx.onabort = () => {
        db.close();
        resolve({ committed: false, error: tx.error?.name });
      };
      if (mode === 'seed') records.put('known-good', 'prior');
      if (mode === 'pressure') {
        for (let i = 0; i < 8; i++) records.put(crypto.getRandomValues(new Uint8Array(48 * 1024)), i);
      }
    };
  });
}

const names = ['wallet', 'activity'];
await inProfile(async page => {
  for (const dbName of names) assert.equal((await page.evaluate(probe, { mode: 'seed', dbName })).committed, true);
  await page.evaluate(() => chrome.storage.local.set({ checkpoint: 'known-good' }));
});

await inProfile(async (page, context) => {
  for (const dbName of names) {
    assert.equal((await page.evaluate(probe, { mode: 'read', dbName })).prior, 'known-good');
  }
  const fill = spawnSync('dd', ['if=/dev/zero', 'of=' + filler, 'bs=1M', 'count=96', 'status=none'], { encoding: 'utf8' });
  assert.notEqual(fill.status, 0, 'The bounded volume must actually run out of space');
  assert.match(fill.stderr, /No space left on device/);
  console.log('Operating-system ENOSPC confirmed on the temporary volume');
  try {
    const write = await page.evaluate(probe, { mode: 'pressure', dbName: names[0] });
    console.log('IndexedDB write under disk exhaustion:', JSON.stringify(write));
    assert.equal(write.committed, false, 'The IndexedDB write must encounter the fault');
    const session = await context.newCDPSession(page);
    const { histograms } = await session.send('Browser.getHistograms', { query: 'WebCore.IndexedDB.' });
    console.log(
      'Backing-store failure counters:',
      JSON.stringify(histograms.filter(({ name }) => /WriteError|OpenStatus|OpenErrors|OpenFirstTry/.test(name)))
    );
  } finally {
    await rm(filler, { force: true });
  }
});

await inProfile(async page => {
  assert.equal((await page.evaluate(() => chrome.storage.local.get('checkpoint'))).checkpoint, 'known-good');
  const present = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name));
  const survived = {};
  for (const dbName of names) {
    survived[dbName] =
      present.includes(dbName) && (await page.evaluate(probe, { mode: 'read', dbName })).prior === 'known-good';
  }
  console.log('Records after restoring disk space and reopening the profile:', JSON.stringify(survived));
  console.log('Independent chrome.storage.local checkpoint survived');
});
