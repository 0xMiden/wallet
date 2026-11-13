import type { BrowserContext } from '@playwright/test';

import { expect, test } from '../fixtures/extension';

async function restartWorker(context: BrowserContext) {
  const old = context.serviceWorkers()[0];
  if (!old) throw new Error('Extension worker unavailable');
  const wakeUrl = new URL('fullpage.html', old.url()).href;
  const restarted = context.waitForEvent('serviceworker', {
    predicate: worker => worker.url() === old.url(),
    timeout: 30_000
  });
  await old
    .evaluate(() => chrome.runtime.reload())
    .catch(error => {
      if (!/closed|destroyed|invalidated/i.test(String(error))) throw error;
    });
  const wake = await context.newPage();
  await wake.goto(wakeUrl, { waitUntil: 'domcontentloaded' });
  return restarted;
}

test('startup completes the protected reset before serving a recreated wallet', async ({
  extensionContext,
  extensionId
}) => {
  test.setTimeout(90_000);
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const nonce = 'A'.repeat(43);
    await chrome.storage.local.set({
      vault_key_password: 'fixture protector',
      vault_key_platform: {
        version: 1,
        credentialId: 'AQIDBA',
        prfSalt: 'A'.repeat(43),
        wrappedKey: 'A'.repeat(80),
        backupEligible: false
      },
      platform_unlock_reset_request: { nonce, options: { keepEndpointOverride: false } }
    });
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
          nonce,
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
  const worker = await restartWorker(extensionContext);
  await expect
    .poll(
      () =>
        worker.evaluate(async () => {
          const values = await chrome.storage.local.get([
            'vault_key_password',
            'vault_key_platform',
            'platform_unlock_reset_request',
            'platform_credentials_to_signal'
          ]);
          return values;
        }),
      { timeout: 30_000 }
    )
    .toEqual({ platform_credentials_to_signal: { pending: [], toSignal: ['AQIDBA'] } });
});

test('an editable reset marker cannot authorize a cold-start wipe', async ({ extensionContext, extensionId }) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      vault_key_password: 'fixture protector',
      platform_unlock_reset_request: { nonce: 'A'.repeat(43), options: { keepEndpointOverride: false } }
    });
  });
  const worker = await restartWorker(extensionContext);
  await expect
    .poll(() => worker.evaluate(async () => (await chrome.storage.local.get('vault_key_password')).vault_key_password))
    .toBe('fixture protector');
});
