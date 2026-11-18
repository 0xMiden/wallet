import type { CDPSession, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { setEligibilityFixtureState } from '../e2e/helpers/feature-eligibility';
import { IMPORTED_WALLET_PASSWORD, importWallet } from '../e2e/helpers/import-wallet';
import { expect, test } from '../fixtures/extension';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

async function syncWallet(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'INTERCOM' });
        const timer = setTimeout(() => {
          port.disconnect();
          reject(new Error('Disposable wallet sync request timed out'));
        }, 30_000);
        port.onMessage.addListener((message: unknown) => {
          if (!message || typeof message !== 'object' || Reflect.get(message, 'reqId') !== 1) return;
          const type: unknown = Reflect.get(message, 'type');
          if (type !== 'INTERCOM_RESPONSE' && type !== 'INTERCOM_ERROR') return;
          clearTimeout(timer);
          port.disconnect();
          const data: unknown = Reflect.get(message, 'data');
          if (
            type === 'INTERCOM_RESPONSE' &&
            data &&
            typeof data === 'object' &&
            Reflect.get(data, 'type') === 'SYNC_RESPONSE'
          )
            resolve();
          else reject(new Error('Disposable wallet sync request failed'));
        });
        port.postMessage({ type: 'INTERCOM_REQUEST', reqId: 1, data: { type: 'SYNC_REQUEST', force: true } });
      })
  );
}

async function rowCount(protocol: CDPSession, securityOrigin: string, databaseName: string, objectStoreName: string) {
  const { databaseNames } = await protocol.send('IndexedDB.requestDatabaseNames', { securityOrigin });
  if (!databaseNames.includes(databaseName)) return 0;
  const { entriesCount } = await protocol.send('IndexedDB.getMetadata', {
    securityOrigin,
    databaseName,
    objectStoreName
  });
  return entriesCount;
}

function recoveryDataPresent(page: Page) {
  return page.evaluate(async () => {
    const keys = ['vault_key_password', 'miden_recovery_v1_testnet_slot0', 'miden_recovery_v1_testnet_slot1'];
    const data = await chrome.storage.local.get(keys);
    return (
      typeof data.vault_key_password === 'string' &&
      Boolean(data.miden_recovery_v1_testnet_slot0 || data.miden_recovery_v1_testnet_slot1)
    );
  });
}

test('blocks balances and send review after the disposable wallet loses IndexedDB', async ({
  extensionContext,
  extensionId
}, info) => {
  // Full-page seed import plus two bounded sync requests and the recovery screen.
  test.setTimeout(330_000);
  await setEligibilityFixtureState('allowed');
  await importWallet(extensionContext, extensionId);

  const origin = `chrome-extension://${extensionId}`;
  const fullPage = `${origin}/fullpage.html`;
  const page = await extensionContext.newPage();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(fullPage, { waitUntil: 'domcontentloaded' });

  const balance = page.getByTestId('balance-card-label');
  const unlock = page.getByTestId('unlock-password');
  await balance.or(unlock).first().waitFor({ timeout: 30_000 });
  if (await unlock.isVisible()) {
    const password = unlock.locator('#unlock-password');
    await password.fill(IMPORTED_WALLET_PASSWORD);
    await password.press('Enter');
  }
  await expect(balance).toBeVisible({ timeout: 30_000 });

  const protocol = await extensionContext.newCDPSession(page);
  try {
    await syncWallet(page);
    await expect.poll(() => rowCount(protocol, origin, 'mock_client_db', 'latestAccountHeaders')).toBeGreaterThan(0);
    await expect.poll(() => rowCount(protocol, origin, 'TridentMain', 'recovery')).toBe(1);
    await expect.poll(() => recoveryDataPresent(page)).toBe(true);

    // Clear only IndexedDB for the disposable extension origin. The independent
    // chrome.storage.local vault and retained recovery data stay in place.
    await protocol.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' });
    await expect.poll(() => rowCount(protocol, origin, 'mock_client_db', 'latestAccountHeaders')).toBe(0);
    await expect.poll(() => rowCount(protocol, origin, 'TridentMain', 'recovery')).toBe(0);
    await expect.poll(() => recoveryDataPresent(page)).toBe(true);
    await syncWallet(page);

    const recovery = page.getByRole('heading', { name: 'Wallet storage unavailable' });
    const rebuild = page.getByRole('button', { name: 'Rebuild from recovery data' });
    await expect(recovery).toBeVisible({ timeout: 30_000 });
    await expect(rebuild).toBeEnabled();
    await expect(balance).toHaveCount(0);

    await page.goto(`${fullPage}#/send/review`);
    await expect(recovery).toBeVisible();
    await expect(rebuild).toBeEnabled();
    await expect(balance).toHaveCount(0);
    await expect(page.getByTestId('send-review-submit')).toHaveCount(0);
    await expect.poll(() => rowCount(protocol, origin, 'mock_client_db', 'latestAccountHeaders')).toBe(0);

    const file = info.outputPath('wallet-access-storage-recovery.png');
    const screenshot = await page.screenshot({ scale: 'css', animations: 'disabled' });
    await writeFile(
      file,
      await sharp(screenshot)
        .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer()
    );
    await info.attach('Wallet storage recovery', { path: file, contentType: 'image/png' });
  } finally {
    await protocol.detach();
  }
});
