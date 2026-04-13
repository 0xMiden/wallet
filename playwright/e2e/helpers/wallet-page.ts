import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import type { TimelineRecorder } from '../harness/timeline-recorder';

const PASSWORD = 'Password123!';
const SYNC_WAIT_MS = 3_500;

/**
 * Page Object Model for a single wallet extension instance.
 * Encapsulates all UI interactions, reusing selectors from popup-smoke.spec.ts.
 */
export class WalletPage {
  readonly page: Page;
  readonly extensionId: string;
  readonly userDataDir: string;

  constructor(page: Page, extensionId: string, userDataDir: string = '') {
    this.page = page;
    this.extensionId = extensionId;
    this.userDataDir = userDataDir;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  private get fullpageUrl(): string {
    return `chrome-extension://${this.extensionId}/fullpage.html`;
  }

  async navigateTo(hash: string): Promise<void> {
    await this.page.goto(`${this.fullpageUrl}#${hash}`, { waitUntil: 'domcontentloaded' });
  }

  async navigateHome(): Promise<void> {
    const currentUrl = this.page.url();
    // Skip navigation if already on the fullpage (avoid re-triggering WASM init)
    if (currentUrl.startsWith(`chrome-extension://${this.extensionId}/fullpage.html`)) {
      // Navigate to home hash if on a sub-route
      if (currentUrl.includes('#/') && !currentUrl.endsWith('#/')) {
        await this.page.goto(`${this.fullpageUrl}#/`, { waitUntil: 'domcontentloaded' });
      }
      return;
    }
    await this.page.goto(this.fullpageUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('#root > *', { timeout: 60_000 });
  }

  // ── Onboarding ────────────────────────────────────────────────────────────

  /**
   * Complete the "Create a new wallet" onboarding flow.
   * Returns the wallet address and seed phrase.
   */
  async createNewWallet(password: string = PASSWORD): Promise<{ address: string; seedPhrase: string[] }> {
    // The fixture guarantees the welcome screen is visible by the time we get here.
    const welcome = this.page.getByTestId('onboarding-welcome');
    await welcome.waitFor({ timeout: 30_000 });

    // Click "Create a new wallet". The WASM SDK may still be loading (TLA stripped),
    // so the first click might not navigate. Retry until the seed phrase screen appears.
    for (let attempt = 0; attempt < 10; attempt++) {
      await welcome.getByRole('button', { name: /create a new wallet/i }).click();
      try {
        await this.page.getByText(/back up your wallet/i).waitFor({ timeout: 10_000 });
        break;
      } catch {
        if (attempt === 9) throw new Error('Seed phrase screen did not appear after 10 attempts');
        // WASM may not be ready yet -- wait and retry
        await this.page.waitForTimeout(3_000);
      }
    }
    await this.page.getByRole('button', { name: /show/i }).click();

    // Extract seed words
    const seedWords = await this.page.$$eval(
      'article > label > label > p:last-child',
      paragraphs => paragraphs.map(p => p.textContent?.trim() || '')
    );

    const firstWord = seedWords[0];
    const lastWord = seedWords[11];
    if (!firstWord || !lastWord) {
      throw new Error('Failed to read seed words from backup screen');
    }

    await this.page.getByRole('button', { name: /continue/i }).click();

    // Verify seed phrase (select first and last words)
    const verifyContainer = this.page.getByTestId('verify-seed-phrase');
    await verifyContainer.waitFor({ timeout: 15_000 });
    await verifyContainer.locator(`button:has-text("${firstWord}")`).first().click();
    await verifyContainer.locator(`button:has-text("${lastWord}")`).first().click();
    await verifyContainer.getByRole('button', { name: /continue/i }).click();

    // Set password
    await expect(this.page).toHaveURL(/create-password/);
    await this.page.locator('input[placeholder="Enter password"]').first().fill(password);
    await this.page.locator('input[placeholder="Enter password again"]').first().fill(password);
    await this.page.getByRole('button', { name: /continue/i }).click();

    // Wait for "Your wallet is ready" -- this confirms the wallet was created.
    // The confirmation screen appears after registerNewWallet completes.
    await expect(this.page.getByText(/your wallet is ready/i)).toBeVisible({ timeout: 60_000 });
    await this.page.getByRole('button', { name: /get started/i }).click();

    // After onboarding, wait for the Explore page to appear.
    // The backend needs to return status=Ready for the router to show Explore.
    // Reload periodically to force fresh state fetches.
    for (let waitAttempt = 0; waitAttempt < 20; waitAttempt++) {
      const sendVisible = await this.page.getByText('Send').isVisible().catch(() => false);
      const receiveVisible = await this.page.getByText('Receive').isVisible().catch(() => false);
      if (sendVisible || receiveVisible) break;
      if (waitAttempt === 19) {
        // Final attempt -- just navigate directly and hope for the best
        await this.navigateHome();
        await this.page.waitForTimeout(5_000);
        break;
      }
      await this.page.waitForTimeout(2_000);
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(2_000);
    }

    // Extract address
    const address = await this.getAccountAddress();

    return { address, seedPhrase: seedWords };
  }

  /**
   * Complete the "Import with seed phrase" onboarding flow.
   */
  async importWallet(seedPhrase: string[], password: string = PASSWORD): Promise<{ address: string }> {
    await this.navigateHome();

    const welcome = this.page.getByTestId('onboarding-welcome');
    await welcome.waitFor({ timeout: 30_000 });
    await welcome.getByRole('button', { name: /i already have a wallet/i }).click();

    const importType = this.page.getByTestId('import-select-type');
    await importType.waitFor({ timeout: 15_000 });
    await importType.getByText(/import with seed phrase/i).click();

    // Fill seed phrase
    for (let i = 0; i < seedPhrase.length; i++) {
      await this.page.locator(`#seed-phrase-input-${i}`).fill(seedPhrase[i]!);
    }
    await this.page.getByRole('button', { name: /continue/i }).click();

    // Set password
    await expect(this.page).toHaveURL(/create-password/);
    await this.page.locator('input[placeholder="Enter password"]').first().fill(password);
    await this.page.locator('input[placeholder="Enter password again"]').first().fill(password);
    await this.page.getByRole('button', { name: /continue/i }).click();

    // Confirmation
    await expect(this.page.getByText(/your wallet is ready/i)).toBeVisible();
    await this.page.getByRole('button', { name: /get started/i }).click();
    await expect(this.page.getByText('Send')).toBeVisible({ timeout: 30_000 });

    const address = await this.getAccountAddress();
    return { address };
  }

  // ── Address ───────────────────────────────────────────────────────────────

  /**
   * Extract the wallet account address from the Receive page.
   */
  async getAccountAddress(): Promise<string> {
    await this.navigateTo('/receive');
    const receiveContainer = this.page.getByTestId('receive-page');
    await receiveContainer.waitFor({ timeout: 15_000 });

    // The address is displayed as text on the receive page
    const addressEl = this.page.getByText(/your address/i).locator('..').locator('text=mtst');
    let address: string;
    try {
      address = (await addressEl.textContent({ timeout: 10_000 })) ?? '';
    } catch {
      // Fallback: try to find any bech32-like address text
      const allText = await receiveContainer.textContent();
      const match = allText?.match(/mtst\S+/);
      address = match?.[0] ?? '';
    }

    if (!address) {
      throw new Error('Could not extract wallet address from Receive page');
    }

    // Navigate back to home
    await this.navigateHome();

    return address.trim();
  }

  // ── Balance ───────────────────────────────────────────────────────────────

  /**
   * Get the balance for a specific token from the Explore page.
   * If tokenSymbol is not given, returns the balance of the first token row.
   * Returns 0 if no matching token found.
   */
  async getBalance(tokenSymbol?: string): Promise<number> {
    await this.navigateHome();
    await this.page.waitForTimeout(1_000);

    try {
      // Read balances from the Zustand store via __TEST_STORE__ (requires E2E build).
      // This is more reliable than scraping the page body.
      const result = await this.page.evaluate((symbol) => {
        const store = (window as any).__TEST_STORE__;
        if (!store) return 0;
        const state = store.getState();
        if (!state.balances) return 0;

        // Balances are keyed by account address -> array of token objects
        for (const tokenList of Object.values(state.balances) as any[]) {
          if (!Array.isArray(tokenList)) continue;
          for (const token of tokenList) {
            const tokenAmount = parseFloat(String(token.amount ?? token.balance ?? '0'));
            if (symbol) {
              // Match requested token symbol (case-insensitive)
              const tokenSym = String(token.symbol ?? '').toUpperCase();
              if (tokenSym === symbol.toUpperCase() && tokenAmount > 0) {
                return tokenAmount;
              }
            } else {
              // Return first non-zero balance
              if (tokenAmount > 0) return tokenAmount;
            }
          }
        }
        return 0;
      }, tokenSymbol);

      return result;
    } catch {
      return 0;
    }
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /**
   * Trigger a sync via the intercom SyncRequest.
   * Requires MIDEN_E2E_TEST=true build which exposes __TEST_INTERCOM__.
   */
  async triggerSync(): Promise<void> {
    try {
      await this.page.evaluate(() => {
        const intercom = (window as any).__TEST_INTERCOM__;
        if (intercom) {
          intercom.request({ type: 'SYNC_REQUEST' });
        }
      });
    } catch {
      // May fail during navigation, ignore
    }
    await this.page.waitForTimeout(SYNC_WAIT_MS);
  }

  // ── Send Flow ─────────────────────────────────────────────────────────────

  /**
   * Execute the full send flow: SelectToken -> SendDetails -> ReviewTransaction.
   */
  async sendTokens(params: {
    recipientAddress: string;
    amount: string;
    isPrivate: boolean;
  }): Promise<void> {
    // 1. Navigate to send
    await this.navigateTo('/send');
    const sendFlow = this.page.getByTestId('send-flow');
    await sendFlow.waitFor({ timeout: 15_000 });

    // 2. SelectToken: click first available token
    // Token rows are clickable CardItem components
    const tokenItem = sendFlow.locator('article, [role="button"]').first();
    await tokenItem.click({ timeout: 10_000 });

    // 3. SendDetails: fill address, amount, toggle private
    // Wait for SendDetails page to appear
    await this.page.waitForTimeout(500);

    // Fill recipient address (textarea)
    const addressInput = sendFlow.locator('textarea').first();
    await addressInput.fill(params.recipientAddress);

    // Fill amount
    const amountInput = sendFlow.locator('input[type="text"], input[type="number"], input[inputmode="decimal"]').first();
    await amountInput.fill(params.amount);

    // Toggle private payment if needed (default is true/On)
    // The private payment toggle shows "On" and "Off" buttons
    if (!params.isPrivate) {
      // Click "Off" to disable private payment
      try {
        const offButton = sendFlow.getByText('Off', { exact: true }).first();
        await offButton.click({ timeout: 5_000 });
      } catch {
        // Toggle may not be visible or already in correct state
      }
    }

    // Click Continue
    await sendFlow.getByRole('button', { name: /continue/i }).click();

    // 4. ReviewTransaction: click Confirm
    await this.page.waitForTimeout(500);
    await sendFlow.getByRole('button', { name: /confirm/i }).click({ timeout: 10_000 });

    // 5. Wait for transaction processing
    // The GeneratingTransaction screen shows, then TransactionInitiated
    await this.page.waitForTimeout(2_000);

    // Wait for success or return to home
    try {
      // Look for success indicators
      await this.page.waitForSelector(
        'text=/transaction.*initiated|transaction.*success|successfully/i',
        { timeout: 120_000 }
      );
    } catch {
      // May navigate away automatically - check we're not on an error screen
      const bodyText = await this.page.locator('body').textContent();
      if (bodyText?.toLowerCase().includes('error') || bodyText?.toLowerCase().includes('failed')) {
        throw new Error(`Send transaction appears to have failed. Page text: ${bodyText?.slice(0, 500)}`);
      }
    }
  }

  // ── Balance Waiting ───────────────────────────────────────────────────────

  /**
   * Wait for the wallet's balance to exceed a minimum value.
   * Repeatedly triggers sync and checks balance.
   */
  async waitForBalanceAbove(
    minBalance: number,
    timeoutMs: number,
    timeline?: TimelineRecorder,
    tokenSymbol?: string
  ): Promise<number> {
    const intervalMs = 5_000;
    const maxAttempts = Math.ceil(timeoutMs / intervalMs);
    let lastBalance = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.triggerSync();
      lastBalance = await this.getBalance(tokenSymbol);

      if (timeline) {
        timeline.emit({
          category: 'blockchain_state',
          severity: lastBalance > minBalance ? 'info' : 'warn',
          message: `Balance check: ${lastBalance} (need > ${minBalance}) attempt ${attempt}/${maxAttempts}`,
          data: { balance: lastBalance, minBalance, attempt, maxAttempts },
        });
      }

      if (lastBalance > minBalance) return lastBalance;

      if (attempt < maxAttempts) {
        await this.page.waitForTimeout(intervalMs);
      }
    }

    throw new Error(
      `Balance did not exceed ${minBalance} within ${timeoutMs}ms. Last balance: ${lastBalance}`
    );
  }

  // ── Lock/Unlock ───────────────────────────────────────────────────────────

  /**
   * Lock the wallet (navigate to settings and trigger lock).
   */
  async lockWallet(): Promise<void> {
    await this.navigateTo('/settings');
    // Settings page has a "Lock Wallet" option or similar
    // Try to find and click the lock button
    const lockButton = this.page.getByText(/lock wallet/i).first();
    try {
      await lockButton.click({ timeout: 10_000 });
    } catch {
      // Fallback: try the intercom to send a lock request
      await this.page.evaluate(() => {
        const intercom = (window as any).__TEST_INTERCOM__;
        if (intercom) intercom.request({ type: 'LOCK_REQUEST' });
      });
    }
    await this.page.waitForTimeout(1_000);
  }

  /**
   * Unlock the wallet with a password.
   */
  async unlockWallet(password: string = PASSWORD): Promise<void> {
    await this.navigateHome();
    // Wait for password prompt
    const passwordInput = this.page.locator('input[type="password"]');
    await passwordInput.waitFor({ timeout: 10_000 });
    await passwordInput.fill(password);
    await this.page.getByRole('button', { name: /unlock|continue|submit/i }).click();
    await this.page.waitForTimeout(2_000);
  }
}
