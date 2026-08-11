import { expect, test } from '../fixtures/extension';

test.describe.configure({ mode: 'serial' });

/**
 * Console errors that are noise in the extension build and are not wallet
 * regressions:
 *  - The wallet-connect / AppKit dependency chain (pulled in for the bridge
 *    flows) probes for an inline script and for Coinbase's COOP header. Neither
 *    path is reachable from the extension fullpage, and MV3's CSP blocking the
 *    inline script is the intended behaviour, not a failure.
 */
const IGNORED_CONSOLE_ERRORS = [
  /Executing inline script violates the following Content Security Policy directive/i,
  // Emitted as either "Coinbase Wallet SDK" or "Base Account SDK" depending on
  // the resolved SDK version.
  /SDK requires the Cross-Origin-Opener-Policy header/i
];

const isIgnoredConsoleError = (text: string) => IGNORED_CONSOLE_ERRORS.some(pattern => pattern.test(text));

test.describe('Fullpage UI', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension UI only runs in Chromium');

  test('loads UI without console errors', async ({ extensionContext, extensionId }) => {
    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const errors: string[] = [];

    extensionContext.on('page', page => {
      page.on('console', message => {
        if (message.type() === 'error' && !isIgnoredConsoleError(message.text())) {
          errors.push(message.text());
        }
      });
    });

    const page = await extensionContext.newPage();
    await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveTitle('Miden Wallet');
    // Wait for React to render content into #root (not just for #root to exist)
    await page.waitForSelector('#root > *', { timeout: 30000 });

    expect(errors).toHaveLength(0);
  });

  // SKIPPED for the v0 UI: the create flow is now Guardian-mandatory (no "Fully
  // Private" option), so a wallet can't be created in this smoke build without a
  // live guardian backend. The create → "Open wallet" → side-panel handoff path
  // is covered by the blockchain E2E harness (which uses the onboarding bypass).
  test.skip('onboarding create flow completes and hands off to the side panel', async ({
    extensionContext,
    extensionId
  }) => {
    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const page = await extensionContext.newPage();

    await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });

    const welcome = page.getByTestId('onboarding-welcome');
    await welcome.waitFor({ timeout: 30000 });
    if (page.isClosed()) {
      throw new Error('Page closed before onboarding');
    }
    await welcome.getByRole('button', { name: /create a new wallet/i }).click();

    await page.getByText(/back up your wallet/i).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /show/i }).click();

    // Extract the first and last words from the seed phrase display
    // The structure is: article > label (Chip) > label > [p (index), p (word)]
    // We get all the word paragraphs (second p in each inner label)
    const seedWords = await page.$$eval('article > label > label > p:last-child', paragraphs =>
      paragraphs.map(p => p.textContent?.trim() || '')
    );
    const firstWord = seedWords[0];
    const lastWord = seedWords[11];

    if (!firstWord || !lastWord) {
      throw new Error('Failed to read first/last seed words from backup screen');
    }

    await page.getByRole('button', { name: /continue/i }).click();

    await page.getByTestId('verify-seed-phrase').waitFor({ timeout: 15000 });

    // Select the correct words (first and last) and continue
    const verifyContainer = page.getByTestId('verify-seed-phrase');
    // Click the buttons containing the words (the word is inside a Chip/label inside a button)
    await verifyContainer.locator(`button:has-text("${firstWord}")`).first().click();
    await verifyContainer.locator(`button:has-text("${lastWord}")`).first().click();
    await verifyContainer.getByRole('button', { name: /continue/i }).click();

    // Set password
    await expect(page).toHaveURL(/create-password/);
    await page.locator('input[placeholder="Enter password"]').first().fill('Password123!');
    await page.locator('input[placeholder="Enter password again"]').first().fill('Password123!');
    await page.getByRole('button', { name: /continue/i }).click();

    // Recovery method step — pick "Fully Private" to avoid the guardian backend.
    await page.getByRole('heading', { name: /set up account recovery/i }).waitFor({ timeout: 15000 });
    await page
      .getByText(/fully private/i)
      .first()
      .click();
    await page.getByRole('button', { name: /continue/i }).click();

    // New-wallet onboarding hands the wallet off to the Chrome side panel: the
    // wallet is created in the background ("Creating your wallet…"), then once
    // it's ready an "Open wallet" CTA appears. Clicking it opens the side panel
    // (a separate context) and closes this tab, so we assert the ready handoff
    // screen here rather than driving the side panel. The "Open wallet" button
    // is gated on the store reaching Ready, so seeing it confirms the wallet was
    // created and is functional. Recovery/import completes the same way (#428) —
    // see the import flow test below.
    await expect(page.getByText(/your wallet is ready/i)).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: /open wallet/i })).toBeVisible({ timeout: 30000 });
  });

  test('onboarding import flow completes and hands off to the side panel', async ({
    extensionContext,
    extensionId
  }) => {
    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const page = await extensionContext.newPage();

    await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });

    const welcome = page.getByTestId('onboarding-welcome');
    await welcome.waitFor({ timeout: 30000 });
    if (page.isClosed()) {
      throw new Error('Page closed before onboarding');
    }
    await page.locator('#import-link').click();

    // Recovery is seed-phrase only — the old "select import type" screen is gone
    // and the welcome link lands directly on the seed entry form.
    await page.getByTestId('import-seed-phrase').waitFor({ timeout: 15000 });

    const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(
      ' '
    );
    for (let i = 0; i < words.length; i++) {
      await page.locator(`#seed-phrase-input-${i}`).fill(words[i]!);
    }
    await page.getByRole('button', { name: /continue/i }).click();

    await expect(page).toHaveURL(/create-password/);
    await page.locator('input[placeholder="Enter password"]').first().fill('Password123!');
    await page.locator('input[placeholder="Enter password again"]').first().fill('Password123!');
    await page.getByRole('button', { name: /continue/i }).click();

    // Import-recovery-method step — pick "Import public account".
    await page.getByTestId('import-recovery-method').waitFor({ timeout: 15000 });
    await page.getByText(/import public account/i).click();
    await page.getByRole('button', { name: /continue/i }).click();

    // Confirmation: the "Your Wallet is ready" heading is split by <Trans>, so
    // assert the container testid instead of the text.
    await expect(page.getByTestId('onboarding-confirmation')).toBeVisible({ timeout: 30000 });

    // Complete onboarding. Recovery now hands off to the Chrome side panel just
    // like first-run create (#428): the wallet becomes Ready in the background and
    // the "Open wallet" handoff screen appears (rather than the classic in-tab
    // Explore page). The in-tab path still applies to non-extension / E2E builds
    // and is covered by the Welcome/ForgotPassword unit tests.
    await page.getByTestId('onboarding-confirmation-submit').click();
    await expect(page.getByText(/your wallet is ready/i)).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: /open wallet/i })).toBeVisible({ timeout: 30000 });
  });

  test('import seed phrase enforces valid words before continue', async ({ extensionContext, extensionId }) => {
    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const page = await extensionContext.newPage();

    await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });

    const welcome = page.getByTestId('onboarding-welcome');
    await welcome.waitFor({ timeout: 30000 });
    if (page.isClosed()) {
      throw new Error('Page closed before onboarding');
    }
    await page.locator('#import-link').click();

    const seedForm = page.getByTestId('import-seed-phrase');
    await seedForm.waitFor({ timeout: 15000 });

    const continueButton = page.getByRole('button', { name: /continue/i });
    await seedForm.locator('#seed-phrase-input-0').fill('notaword');
    await expect(continueButton).toBeDisabled();

    const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(
      ' '
    );
    for (let i = 0; i < words.length; i++) {
      await seedForm.locator(`#seed-phrase-input-${i}`).fill(words[i]!);
    }

    await expect(continueButton).toBeEnabled();
  });

  test('send flow renders and stays disabled without inputs', async ({ extensionContext, extensionId }) => {
    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const page = await extensionContext.newPage();

    await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#root > *', { timeout: 30000 });

    await page.goto(`${fullpageUrl}#/send`, { waitUntil: 'domcontentloaded' });
    const sendFlow = page.getByTestId('send-flow');
    const sendVisible = await sendFlow.isVisible().catch(() => false);

    if (sendVisible) {
      const continueButtons = await sendFlow.getByRole('button', { name: /continue/i }).all();
      if (continueButtons.length > 0) {
        const disabledStates = await Promise.all(continueButtons.map(btn => btn.isDisabled()));
        expect(disabledStates.some(Boolean)).toBeTruthy();
      }
    } else {
      await expect(page.getByTestId('onboarding-welcome')).toBeVisible({ timeout: 10000 });
    }
  });

  test('receive page shows address and upload affordance', async ({ extensionContext, extensionId }) => {
    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const page = await extensionContext.newPage();

    await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#root > *', { timeout: 30000 });

    await page.goto(`${fullpageUrl}#/receive`, { waitUntil: 'domcontentloaded' });

    const receiveContainer = page.getByTestId('receive-page');
    const receiveVisible = await receiveContainer.isVisible().catch(() => false);

    if (receiveVisible) {
      await expect(page.getByText(/your address/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /upload/i })).toBeVisible();
    } else {
      await expect(page.getByTestId('onboarding-welcome')).toBeVisible({ timeout: 10000 });
    }
  });
});
