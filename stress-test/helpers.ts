import type { Page } from '@playwright/test';

import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

const FAUCET_API_BASE = 'https://api.midenbrowserwallet.com/mint';

/**
 * Send a message to the extension's background service worker via a persistent
 * INTERCOM port (matching the real IntercomClient protocol).
 */
export async function sendWalletMessage(page: Page, message: any): Promise<any> {
  return await page.evaluate(
    (msg: any) =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'INTERCOM' });
        const reqId = Date.now() + Math.random();

        const listener = (response: any) => {
          if (response?.reqId !== reqId) return;
          port.onMessage.removeListener(listener);
          port.disconnect();
          if (response.type === 'INTERCOM_RESPONSE') {
            resolve(response.data);
          } else if (response.type === 'INTERCOM_ERROR') {
            reject(new Error(JSON.stringify(response.data)));
          }
        };

        port.onMessage.addListener(listener);
        port.postMessage({
          type: 'INTERCOM_REQUEST',
          data: msg,
          reqId
        });
      }),
    message
  );
}

/**
 * Get the current wallet state from the background service worker.
 */
export async function getState(page: Page): Promise<any> {
  const res = await sendWalletMessage(page, { type: WalletMessageType.GetStateRequest });
  return res?.state;
}

/**
 * Ensure the wallet is ready (create or unlock as needed).
 */
export async function ensureWalletReady(page: Page, password: string, mnemonic?: string): Promise<any> {
  for (let i = 0; i < 10; i++) {
    const state = await getState(page);
    const status = state?.status;
    // WalletStatus is a numeric enum: Idle=0, Locked=1, Ready=2
    if (status === WalletStatus.Ready) {
      return state;
    }
    if (status === WalletStatus.Locked) {
      await sendWalletMessage(page, { type: WalletMessageType.UnlockRequest, password });
    } else {
      await sendWalletMessage(page, {
        type: WalletMessageType.NewWalletRequest,
        password,
        mnemonic,
        ownMnemonic: !!mnemonic
      });
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error('Wallet not ready after retries');
}

/**
 * Create a new HD account in the wallet.
 */
export async function createAccount(page: Page, walletType: WalletType, name: string): Promise<void> {
  await sendWalletMessage(page, {
    type: WalletMessageType.CreateAccountRequest,
    walletType,
    name
  });
  // Wait for state to propagate
  await page.waitForTimeout(500);
}

/**
 * Switch the active account in the wallet.
 */
export async function switchAccount(page: Page, publicKey: string): Promise<void> {
  await sendWalletMessage(page, {
    type: WalletMessageType.UpdateCurrentAccountRequest,
    accountPublicKey: publicKey
  });
  await page.waitForTimeout(500);
}

/**
 * Fund an account via the faucet API.
 * Requests 100 MDN (10000000000 base units).
 */
export async function fundAccount(bech32Address: string): Promise<Response> {
  const url = `${FAUCET_API_BASE}/${bech32Address}/10000000000`;
  console.log(`Funding account: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Faucet request failed: ${res.status} ${res.statusText}`);
  }
  return res;
}

/**
 * Wait for the MIDEN token balance to appear on the Explore page.
 */
export async function waitForBalance(page: Page, timeoutMs: number = 120_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(2_000);
    const midenVisible = await page
      .locator('text=MDN')
      .first()
      .isVisible()
      .catch(() => false);
    console.log(`[waitForBalance] Checking for balance visibility: ${midenVisible}`); // Debug log
    if (midenVisible) {
      return;
    }
    await page.waitForTimeout(3_000);
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  throw new Error(`Balance did not appear within ${timeoutMs}ms`);
}
