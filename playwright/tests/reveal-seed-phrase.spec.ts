import type { Page } from '@playwright/test';

import { completeSeedImportOnboarding } from '../e2e/helpers/dapp-confirm';
import { expect, test } from '../fixtures/extension';

/**
 * The recovery-phrase reveal, driven through the real Settings UI in a Chromium
 * MV3 extension: bottom-nav Settings -> Recovery Phrase -> "Reveal recovery
 * phrase" -> View -> password -> Continue -> the word grid -> Hide -> Reveal
 * again, once in light mode and once in dark.
 *
 * Pins #1122. `revealMnemonic()` runs a real PBKDF2 decrypt client-side, taking
 * several seconds, and `RevealSeedPhrase.tsx` used to render nothing at all for
 * that whole window - it returned `null` while `isSubmitting` was true, dropping
 * the password drawer and its loading Continue button off screen. Hiding and
 * revealing again then landed on that same empty branch: the routed page can be
 * a REUSED component instance (a layer `MobilePageLayers` keeps mounted) rather
 * than a fresh mount, and nothing reset its step back to the warning on the way
 * out.
 *
 * Runs on the mock build (`MIDEN_USE_MOCK_CLIENT`): the vault decrypt this spec
 * times is real crypto, not a network call, so no chain is needed to reproduce
 * either half of the bug.
 *
 * NOT COVERED HERE - the hardware-protector (biometric) branch. Seed-import
 * onboarding always creates a password-only vault, so `hasHardwareProtector`
 * resolves `false` and `handleView` goes straight to the password drawer; #1122
 * was specific to that path in the first place.
 */
test.describe('reveal recovery phrase', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'MV3 extension only runs in Chromium');

  /**
   * Types the onboarding password and clicks Continue, then IMMEDIATELY asserts
   * the auth page (`reveal-seed-auth`: the drawer plus its loading Continue)
   * is still on screen - the exact moment #1122's fix covers. With the
   * null-return bug reverted, the page renders nothing for the whole PBKDF2
   * wait and, once it resolves, moves straight to the word grid without ever
   * rendering this branch again - so any bounded timeout here fails either way.
   */
  async function submitPasswordAndAssertNotBlank(page: Page): Promise<void> {
    const authPage = page.getByTestId('reveal-seed-auth');
    await authPage.waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('#reveal-seed-password').fill('Password123!', { timeout: 10_000 });
    // The drawer's own content is a `vaul` PORTAL out to <body>, not a descendant of
    // `authPage` in the DOM - the Continue button has to be found unscoped, the same
    // way `completeSeedImportOnboarding` finds every other flow's Continue.
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 10_000 });
    await expect(authPage).toBeVisible({ timeout: 5_000 });
  }

  /**
   * Budget, itemised - must exceed the sum of every bounded wait below, so a
   * stuck step reports its own diagnostic instead of a bare "Test timeout"
   * (same rule as `dapp-provider.spec.ts`):
   *
   *   onboarding                          420s
   *   goto fullpage (land on Home)         30s
   *   Settings tab (wait + click)          20s
   *   Recovery Phrase row + page           20s
   *   Reveal recovery phrase + warning     20s
   *   View + auth page                     25s
   *   password + Continue + pending        25s
   *   word grid                            20s
   *   Hide click                           10s
   *   Reveal recovery phrase again         15s
   *   warning View button (<=10s)          10s
   *   View + auth page (dark)              25s
   *   password + Continue + pending        25s
   *                                      -----
   *                                       665s
   */
  test('through the real UI, twice, and once in dark mode', async ({ extensionContext, extensionId }, testInfo) => {
    test.setTimeout(750_000);

    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const walletPage = await extensionContext.newPage();
    await completeSeedImportOnboarding(walletPage, fullpageUrl);

    // ── navigate by UI: Home -> Settings -> Recovery Phrase -> Reveal ────────
    // Onboarding stops at the side-panel handoff screen (deliberately not
    // clicked - see `completeSeedImportOnboarding`), so this is the first load
    // of the root route; the account is already Ready, so it renders Home.
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

    // ── password unlock: the page must not go blank while it runs (#1122) ────
    await submitPasswordAndAssertNotBlank(walletPage);

    const reviewPage = walletPage.getByTestId('reveal-seed-review');
    await reviewPage.getByTestId('seed-word-0').waitFor({ state: 'visible', timeout: 20_000 });
    await walletPage.screenshot({ path: testInfo.outputPath('reveal-seed-phrase-light.png') });

    // ── Hide, then reveal again: must land back on the warning, not a reused
    // blank auth branch (the second half of #1122) ──────────────────────────
    await reviewPage.getByRole('button', { name: 'Hide Recovery Phrase', exact: true }).click({ timeout: 10_000 });

    await walletPage.getByTestId('recovery-phrase-reveal').click({ timeout: 15_000 });
    await expect(viewButton).toBeVisible({ timeout: 10_000 });

    // ── the same pending-page assertion, repeated once in dark mode ──────────
    await walletPage.evaluate(() => document.documentElement.classList.add('dark'));
    await viewButton.click({ timeout: 15_000 });
    await submitPasswordAndAssertNotBlank(walletPage);
    await walletPage.screenshot({ path: testInfo.outputPath('reveal-seed-phrase-dark.png') });
  });
});
