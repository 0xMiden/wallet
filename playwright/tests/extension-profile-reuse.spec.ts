import { chromium, expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { reloadUnpackedExtension } from '../e2e/harness/reload-unpacked-extension';

async function writeExtension(directory: string, build: string): Promise<void> {
  await Promise.all([
    writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify({
        name: 'Wallet profile reuse fixture',
        version: '1.0.0',
        manifest_version: 3,
        permissions: ['storage'],
        background: { service_worker: 'background.js' }
      })
    ),
    writeFile(path.join(directory, 'background.js'), `globalThis.fixtureBuild = ${JSON.stringify(build)};`),
    writeFile(path.join(directory, 'fullpage.html'), `<body data-build="${build}"></body>`)
  ]);
}

// The real fixture reopens profiles containing both Chrome storage and wallet IndexedDB state.
async function indexedDbMarker(value: string | undefined): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('profile-reuse-fixture', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('state', value === undefined ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('state');
      const request = value === undefined ? store.get('marker') : store.put(value, 'marker');
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

test.setTimeout(60_000);

test('reusing an unpacked extension profile loads the new worker and preserves storage', async ({}, testInfo) => {
  const extensionPath = testInfo.outputPath('extension');
  const profile = testInfo.outputPath('profile');
  await mkdir(extensionPath, { recursive: true });
  await writeExtension(extensionPath, 'previous');
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: testInfo.project.use.headless,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      ignoreDefaultArgs: ['--disable-extensions']
    });
  const firstContext = await launch();
  let extensionId: string;
  try {
    const worker = firstContext.serviceWorkers()[0] ?? (await firstContext.waitForEvent('serviceworker'));
    extensionId = new URL(worker.url()).host;
    expect(await worker.evaluate(() => Reflect.get(globalThis, 'fixtureBuild'))).toBe('previous');
    await worker.evaluate(() => chrome.storage.local.set({ reusedProfile: true }));
    await worker.evaluate(indexedDbMarker, 'preserved');
  } finally {
    await firstContext.close();
  }

  await writeExtension(extensionPath, 'current');
  const reusedContext = await launch();
  try {
    const previous = reusedContext.serviceWorkers()[0] ?? (await reusedContext.waitForEvent('serviceworker'));
    const worker = await reloadUnpackedExtension(reusedContext, previous, extensionPath);
    expect(reusedContext.pages().filter(p => p.url().startsWith('chrome-extension://'))).toHaveLength(0);
    expect(new URL(worker.url()).host).toBe(extensionId);
    expect(await worker.evaluate(() => Reflect.get(globalThis, 'fixtureBuild'))).toBe('current');
    expect(await worker.evaluate(() => chrome.storage.local.get('reusedProfile'))).toEqual({ reusedProfile: true });
    expect(await worker.evaluate(indexedDbMarker, undefined)).toBe('preserved');
    const page = await reusedContext.newPage();
    await page.goto(new URL('fullpage.html', worker.url()).href, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-build', 'current');
  } finally {
    await reusedContext.close();
  }
});
