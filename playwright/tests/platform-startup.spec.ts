import type { BrowserContext, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '../fixtures/extension';

async function controlPage(context: BrowserContext, extensionId: string, extensionPath: string) {
  // No app port/timer can wake the stopped worker before its protected intent is seeded.
  await writeFile(
    join(extensionPath, 'platform-startup-fixture.html'),
    '<!doctype html><title>Startup fixture</title>'
  );
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/platform-startup-fixture.html`);
  for (const other of context.pages()) {
    if (other !== page && other.url().startsWith(`chrome-extension://${extensionId}/`)) await other.close();
  }
  return page;
}

async function stopWorker(context: BrowserContext, control: Page) {
  const old = context.serviceWorkers()[0];
  if (!old) throw new Error('Extension worker unavailable');
  const scriptUrl = old.url();
  const wakeUrl = new URL('fullpage.html', scriptUrl).href;
  const ordinary = await context.newPage();
  await ordinary.goto('about:blank');
  const protocol = await context.newCDPSession(ordinary);
  let versionId = '';
  let running = '';
  let stopped = false;
  protocol.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions) {
      if (version.scriptURL !== scriptUrl) continue;
      if (!versionId && version.runningStatus === 'running') versionId = version.versionId;
      if (version.versionId === versionId) {
        running = version.runningStatus;
        if (running === 'stopped') stopped = true;
      }
    }
  });
  await protocol.send('ServiceWorker.enable');
  await expect.poll(() => versionId).not.toBe('');
  await old.evaluate(() => Reflect.set(globalThis, '__platformBeforeStop', true));
  await protocol.send('ServiceWorker.stopWorker', { versionId });
  await expect.poll(() => stopped).toBe(true);
  return async () => {
    const wake = await context.newPage();
    await wake.goto(wakeUrl, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => running, { timeout: 30_000 }).toBe('running');
    const worker = context.serviceWorkers().find(item => item.url() === scriptUrl);
    if (!worker) throw new Error('Restarted worker unavailable');
    await expect.poll(() => worker.evaluate(() => Reflect.get(globalThis, '__platformBeforeStop'))).toBeUndefined();
    await protocol.detach();
    await control.close();
    return worker;
  };
}

test('startup completes a protected reset seeded while its worker is stopped', async ({
  extensionContext,
  extensionId,
  extensionPath
}) => {
  test.setTimeout(90_000);
  const page = await controlPage(extensionContext, extensionId, extensionPath);
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      vault_key_password: 'fixture protector',
      vault_key_platform: {
        version: 1,
        credentialId: 'AQIDBA',
        prfSalt: 'A'.repeat(43),
        wrappedKey: 'A'.repeat(80),
        backupEligible: false
      },
      platform_unlock_reset_request: { nonce: 'A'.repeat(43), options: { keepEndpointOverride: false } }
    });
  });
  const wake = await stopWorker(extensionContext, page);
  await page.evaluate(async () => {
    const opened = indexedDB.open('miden-platform-unlock-reset');
    opened.onupgradeneeded = () => opened.result.createObjectStore('authorization', { keyPath: 'id' });
    await new Promise<void>((resolve, reject) => {
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const db = opened.result;
        const tx = db.transaction('authorization', 'readwrite');
        tx.objectStore('authorization').put({
          id: 'reset',
          version: 1,
          phase: 'pending',
          nonce: 'A'.repeat(43),
          options: { keepEndpointOverride: true }
        });
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  });
  const worker = await wake();
  await expect
    .poll(
      () =>
        worker.evaluate(async () =>
          chrome.storage.local.get([
            'vault_key_password',
            'vault_key_platform',
            'platform_unlock_reset_request',
            'platform_credentials_to_signal'
          ])
        ),
      { timeout: 30_000 }
    )
    .toEqual({ platform_credentials_to_signal: { pending: [], toSignal: ['AQIDBA'] } });
});

test('an editable reset marker cannot authorize a cold-start wipe', async ({
  extensionContext,
  extensionId,
  extensionPath
}) => {
  const page = await controlPage(extensionContext, extensionId, extensionPath);
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      vault_key_password: 'fixture protector',
      platform_unlock_reset_request: { nonce: 'A'.repeat(43), options: { keepEndpointOverride: false } }
    });
  });
  const wake = await stopWorker(extensionContext, page);
  const worker = await wake();
  await expect
    .poll(() => worker.evaluate(async () => (await chrome.storage.local.get('vault_key_password')).vault_key_password))
    .toBe('fixture protector');
});
