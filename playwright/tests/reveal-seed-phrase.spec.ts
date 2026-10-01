import type { Page } from '@playwright/test';

import { completeSeedImportOnboarding } from '../e2e/helpers/dapp-confirm';
import { expect, test } from '../fixtures/extension';

/**
 * The recovery-phrase reveal, driven through the real Settings UI in a Chromium MV3
 * extension: bottom-nav Settings -> Recovery Phrase -> "Reveal recovery phrase" -> View
 * -> password -> Continue -> the word grid -> Hide -> Reveal again, once in light mode
 * and once in dark.
 *
 * Pins #1122: `revealMnemonic()` runs a real PBKDF2 decrypt client-side, taking several
 * seconds, and `RevealSeedPhrase.tsx` used to render nothing at all for that whole window.
 * The Hide -> Reveal-again step is a smoke check that the page opens again on its warning;
 * it cannot tell a fresh page from a reused one, because leave() resets to the warning.
 *
 * Runs on the mock build (`MIDEN_USE_MOCK_CLIENT`): the vault decrypt this spec times is
 * real crypto, not a network call, so no chain is needed.
 *
 * NOT COVERED HERE - the hardware-protector (biometric) branch. Seed-import onboarding
 * always creates a password-only vault, so `hasHardwareProtector` resolves `false` and
 * `handleView` goes straight to the password drawer; #1122 was specific to that path.
 */
test.describe('reveal recovery phrase', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'MV3 extension only runs in Chromium');

  /**
   * Types the onboarding password, clicks Continue, then asserts the auth page
   * (`reveal-seed-auth`) AND the Continue button's `aria-busy` are both still on screen -
   * the exact window #1122's fix covers. `aria-busy` is unscoped: DrawerContent is a vaul
   * portal out to <body>, not a descendant of `reveal-seed-auth`.
   */
  async function submitPasswordAndAssertNotBlank(page: Page): Promise<void> {
    const authPage = page.getByTestId('reveal-seed-auth');
    await authPage.waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('#reveal-seed-password').fill('Password123!', { timeout: 10_000 });
    const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
    await continueButton.click({ timeout: 10_000 });
    await expect(authPage).toBeVisible({ timeout: 5_000 });
    await expect(continueButton).toHaveAttribute('aria-busy', 'true', { timeout: 5_000 });
  }

  // Itemised so a stuck step reports its own diagnostic instead of a bare "Test timeout"
  // (dapp-provider.spec.ts does the same): onboarding 420s, goto 30s, Settings tab 30s,
  // Recovery Phrase row+page 20s, Reveal+warning 20s, View+auth page 30s, password+Continue
  // +pending 30s, word grid 20s, Hide 10s, Reveal again 15s, warning View <=10s, View+auth
  // page (dark) 30s, password+Continue+pending (dark) 30s = 695s.
  test('through the real UI, twice, and once in dark mode', async ({ extensionContext, extensionId }, testInfo) => {
    test.setTimeout(750_000);

    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const walletPage = await extensionContext.newPage();
    await completeSeedImportOnboarding(walletPage, fullpageUrl);

    // Onboarding stops at the side-panel handoff screen (deliberately not clicked - see
    // completeSeedImportOnboarding), so this is the first load of the root route; the
    // account is already Ready, so it renders Home.
    await walletPage.goto(`${fullpageUrl}#/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    const settingsTab = walletPage.getByRole('button', { name: 'Settings', exact: true });
    await settingsTab.waitFor({ state: 'visible', timeout: 20_000 });
    await settingsTab.click({ timeout: 10_000 });

    await walletPage.getByTestId('Settings/RecoveryPhraseButton').click({ timeout: 10_000 });
    await walletPage.getByTestId('recovery-phrase-settings').waitFor({ state: 'visible', timeout: 10_000 });

    await walletPage.getByTestId('recovery-phrase-reveal').click({ timeout: 10_000 });
    const warningPage = walletPage.getByTestId('reveal-seed-warning');
    await warningPage.waitFor({ state: 'visible', timeout: 10_000 });

    const viewButton = warningPage.getByRole('button', { name: 'View', exact: true });
    await viewButton.click({ timeout: 15_000 });

    // The page must not go blank while the PBKDF2 unlock runs (#1122).
    await submitPasswordAndAssertNotBlank(walletPage);

    const reviewPage = walletPage.getByTestId('reveal-seed-review');
    await reviewPage.getByTestId('seed-word-0').waitFor({ state: 'visible', timeout: 20_000 });
    await walletPage.screenshot({ path: testInfo.outputPath('reveal-seed-phrase-light.png') });

    // Hide, then reveal again: the page opens on its warning.
    await reviewPage.getByRole('button', { name: 'Hide Recovery Phrase', exact: true }).click({ timeout: 10_000 });

    await walletPage.getByTestId('recovery-phrase-reveal').click({ timeout: 15_000 });
    await expect(viewButton).toBeVisible({ timeout: 10_000 });

    // The same pending-page assertion, repeated once in dark mode.
    await walletPage.evaluate(() => document.documentElement.classList.add('dark'));
    await viewButton.click({ timeout: 15_000 });
    await submitPasswordAndAssertNotBlank(walletPage);
    await walletPage.screenshot({ path: testInfo.outputPath('reveal-seed-phrase-dark.png') });
  });
});
