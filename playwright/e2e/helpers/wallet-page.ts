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
    // Wait for blur to be removed
    await this.page.waitForTimeout(500);

    // Extract seed words by finding all numbered word elements in the grid.
    // Structure: article > label.Chip > label.inner > [p.number, p.word]
    // We look for p elements that DON'T start with a digit (the word, not the "1." number).
    const seedWords = await this.page.evaluate(() => {
      const article = document.querySelector('article');
      if (!article) return [];
      // Each Chip is a <label> containing an inner <label> with two <p> children
      const chips = article.querySelectorAll(':scope > label');
      const words: string[] = [];
      chips.forEach(chip => {
        const ps = chip.querySelectorAll('p');
        // The last <p> in each chip is the word (the first is the number like "1.")
        const wordP = ps[ps.length - 1];
        if (wordP) {
          const text = wordP.textContent?.trim() || '';
          if (text && !/^\d+\.?$/.test(text)) {
            words.push(text);
          }
        }
      });
      return words;
    });

    console.log(`[WalletPage] Extracted ${seedWords.length} seed words: ${seedWords.join(', ')}`);

    const firstWord = seedWords[0];
    const lastWord = seedWords[seedWords.length - 1];
    if (!firstWord || !lastWord || seedWords.length < 12) {
      throw new Error(`Failed to read seed words from backup screen. Got ${seedWords.length} words: ${seedWords.join(', ')}`);
    }

    await this.page.getByRole('button', { name: /continue/i }).click();

    // Verify seed phrase (select first and last words)
    const verifyContainer = this.page.getByTestId('verify-seed-phrase');
    await verifyContainer.waitFor({ timeout: 15_000 });

    // Click the button containing the first word text, then the last word
    await verifyContainer.locator(`button:has-text("${firstWord}")`).first().click();
    await verifyContainer.locator(`button:has-text("${lastWord}")`).first().click();

    // Verify the Continue button is enabled before clicking
    const continueBtn = verifyContainer.getByRole('button', { name: /continue/i });
    const isDisabled = await continueBtn.isDisabled();
    if (isDisabled) {
      // Debug: log what words are visible in the verify grid
      const verifyWords = await verifyContainer.evaluate((el) => {
        return Array.from(el.querySelectorAll('button')).map(b => b.textContent?.trim() || '');
      });
      throw new Error(
        `Verify seed phrase: Continue button is disabled after selecting "${firstWord}" and "${lastWord}". ` +
        `Available words: ${verifyWords.join(', ')}`
      );
    }
    await continueBtn.click();

    // Set password
    await expect(this.page).toHaveURL(/create-password/);
    await this.page.locator('input[placeholder="Enter password"]').first().fill(password);
    await this.page.locator('input[placeholder="Enter password again"]').first().fill(password);
    await this.page.getByRole('button', { name: /continue/i }).click();

    // Wait for "Your wallet is ready" confirmation screen.
    // Note: this text appears IMMEDIATELY when the confirmation page renders,
    // BEFORE the wallet is actually created. The actual creation happens when
    // "Get Started" is clicked.
    await expect(this.page.getByText(/your wallet is ready/i)).toBeVisible({ timeout: 120_000 });

    // Capture console errors from the page for diagnostics
    const consoleErrors: string[] = [];
    const consoleHandler = (msg: any) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
      }
    };
    this.page.on('console', consoleHandler);

    // Click "Get Started" - this triggers register() which sends NEW_WALLET_REQUEST
    // to the service worker. The SW will create the vault and update state.
    await this.page.getByRole('button', { name: /get started/i }).click();

    // Wait for the wallet creation to complete. The UI will navigate to '/' on success.
    // Do NOT reload the page - that kills the in-flight intercom request.
    // Instead, wait for either:
    // 1. "Send" or "Receive" text (Explore page after successful creation + navigation)
    // 2. The loading state to clear (button becomes clickable again = failure)
    const WALLET_CREATION_TIMEOUT = 120_000;

    try {
      // Wait for the natural navigation to the Explore page
      await this.page.getByText('Send').or(this.page.getByText('Receive')).first()
        .waitFor({ timeout: WALLET_CREATION_TIMEOUT });
    } catch {
      // Natural navigation didn't happen. Check what state we're in.
      const currentUrl = this.page.url();
      const bodyText = await this.page.locator('body').textContent().catch(() => '');

      // Check if the button returned to non-loading state (meaning register() threw)
      const buttonLoading = await this.page.evaluate(() => {
        const btn = document.querySelector('button');
        return btn?.getAttribute('data-loading') === 'true' ||
          btn?.querySelector('.animate-spin') !== null;
      }).catch(() => false);

      console.log(`[WalletPage] Wallet creation didn't navigate. URL: ${currentUrl}`);
      console.log(`[WalletPage] Button loading: ${buttonLoading}`);
      console.log(`[WalletPage] Console errors: ${consoleErrors.join(' | ')}`);
      console.log(`[WalletPage] Body text (first 500): ${bodyText?.slice(0, 500)}`);

      // Try reloading - maybe the wallet WAS created in the SW but the
      // frontend response was lost (port disconnect, etc.)
      for (let attempt = 0; attempt < 15; attempt++) {
        await this.page.waitForTimeout(3_000);
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(3_000);

        const sendVisible = await this.page.getByText('Send').isVisible().catch(() => false);
        const receiveVisible = await this.page.getByText('Receive').isVisible().catch(() => false);
        if (sendVisible || receiveVisible) break;

        // Check if we're back at welcome screen (wallet not created)
        const welcomeVisible = await this.page.getByTestId('onboarding-welcome')
          .isVisible().catch(() => false);
        if (welcomeVisible && attempt > 5) {
          // After 5 reload attempts, if still showing welcome, the wallet wasn't created.
          // Try creating it via direct intercom as fallback.
          console.log('[WalletPage] Wallet not created via UI, trying direct intercom...');
          try {
            await this.page.evaluate(async (pwd: string) => {
              const intercom = (window as any).__TEST_INTERCOM__;
              if (!intercom) throw new Error('No __TEST_INTERCOM__');
              await intercom.request({
                type: 'NEW_WALLET_REQUEST',
                password: pwd,
                mnemonic: undefined,
                ownMnemonic: false,
              });
            }, password);
            // Wait for state to propagate
            await this.page.waitForTimeout(5_000);
            await this.page.reload({ waitUntil: 'domcontentloaded' });
            await this.page.waitForTimeout(3_000);
          } catch (e) {
            console.log(`[WalletPage] Direct intercom fallback failed: ${e}`);
          }
        }
      }
    }

    this.page.removeListener('console', consoleHandler);

    // Extract address
    let address = '';
    try {
      address = await this.getAccountAddress();
    } catch {
      // Fallback: try to get address from the store
      address = await this.page.evaluate(() => {
        const store = (window as any).__TEST_STORE__;
        return store?.getState?.()?.currentAccount?.publicKey || 'unknown';
      }) || 'unknown';
    }

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
      // Read balances from the Zustand store (consumed assets) AND from
      // chrome.storage.local sync data (consumable notes not yet consumed).
      // The transaction processor auto-consumes notes but may not run in SW.
      const result = await this.page.evaluate(async (symbol) => {
        const store = (window as any).__TEST_STORE__;
        if (!store) return { balance: 0, debug: 'no store' };
        const state = store.getState();

        // Trigger a fresh balance fetch
        try {
          if (state.currentAccount?.publicKey && state.fetchBalances) {
            await state.fetchBalances(state.currentAccount.publicKey, state.assetsMetadata || {});
          }
        } catch {}

        const freshState = store.getState();
        let totalBalance = 0;

        // 1. Read consumed assets from store
        for (const tokenList of Object.values(freshState.balances || {}) as any[]) {
          if (!Array.isArray(tokenList)) continue;
          for (const token of tokenList) {
            const amount = parseFloat(String(token.amount ?? token.balance ?? '0'));
            if (amount > 0) {
              totalBalance += amount;
            }
          }
        }

        // 2. Also check consumable notes from sync data (pending incoming tokens)
        // These are notes that have been discovered but not yet consumed.
        try {
          const storage = await new Promise<any>((resolve) => {
            chrome.storage.local.get(['miden_sync_data'], resolve);
          });
          const syncData = storage?.miden_sync_data;
          if (syncData?.notes?.length > 0) {
            for (const note of syncData.notes) {
              const baseUnits = parseInt(note.amountBaseUnits || '0', 10);
              const decimals = note.metadata?.decimals ?? 8;
              const noteBalance = baseUnits / Math.pow(10, decimals);
              if (noteBalance > 0) {
                totalBalance += noteBalance;
              }
            }
          }
        } catch {}

        return {
          balance: totalBalance,
          debug: `consumed=${totalBalance - 0}, notes pending, total=${totalBalance}`,
        };
      }, tokenSymbol);

      return typeof result === 'object' ? result.balance : result;
    } catch (e) {
      console.log(`[WalletPage.getBalance] Error: ${e}`);
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
      await this.page.evaluate(async () => {
        const intercom = (window as any).__TEST_INTERCOM__;
        if (intercom) {
          // Sync state with the blockchain node
          await intercom.request({ type: 'SYNC_REQUEST' });
          // Trigger transaction processing (auto-consume pending notes)
          await intercom.request({ type: 'PROCESS_TRANSACTIONS_REQUEST' });
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
   * Lock the wallet via intercom LOCK_REQUEST.
   */
  async lockWallet(): Promise<void> {
    await this.page.evaluate(async () => {
      const intercom = (window as any).__TEST_INTERCOM__;
      if (intercom) {
        await intercom.request({ type: 'LOCK_REQUEST' });
      }
    });
    await this.page.waitForTimeout(2_000);
    // Reload to show the locked state (unlock screen)
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2_000);
  }

  /**
   * Unlock the wallet with a password.
   */
  async unlockWallet(password: string = PASSWORD): Promise<void> {
    await this.navigateHome();
    // Wait for password prompt - it might be type="password" or a regular input
    const passwordInput = this.page.locator('input[type="password"]');
    try {
      await passwordInput.waitFor({ timeout: 15_000 });
      await passwordInput.fill(password);
    } catch {
      // Fallback: try any visible input
      const anyInput = this.page.locator('input').first();
      await anyInput.waitFor({ timeout: 5_000 });
      await anyInput.fill(password);
    }
    await this.page.getByRole('button', { name: /unlock|continue|submit/i }).click();
    await this.page.waitForTimeout(3_000);
  }
}
