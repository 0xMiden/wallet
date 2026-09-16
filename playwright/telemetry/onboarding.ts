import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** The seed this suite imports. Known, so it doubles as a leak sentinel. */
export const SEED_WORDS =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');

export const PASSWORD = 'Password123!';

/** `HelpImproveWallet.tsx`'s container. */
export const CONSENT_SELECTOR = '[data-testid="onboarding-help-improve-wallet"]';

/** `OpenSidePanel.tsx`'s root -- where Chrome onboarding lands. */
export const HANDOFF_SELECTOR = '[data-testid="finish-side-panel"]';

/**
 * Import a wallet, stopping at the consent prompt without answering it.
 *
 * The import path rather than create: create is Guardian-mandatory and needs a
 * live backend, which this suite deliberately does not stand up. Import reaches
 * the same post-onboarding state, and it has the property this test wants —
 * the seed is one WE chose, so it is a known sentinel rather than something
 * that has to be scraped off a screen.
 */
export async function importWalletToConsentPrompt(page: Page): Promise<void> {
  await page.getByTestId('onboarding-welcome').waitFor({ timeout: 30_000 });
  await page.locator('#import-link').click();

  await page.getByTestId('import-seed-phrase').waitFor({ timeout: 15_000 });
  for (let i = 0; i < SEED_WORDS.length; i++) {
    await page.locator(`#seed-phrase-input-${i}`).fill(SEED_WORDS[i]!);
  }
  await page.getByRole('button', { name: /continue/i }).click();

  await expect(page).toHaveURL(/create-password/);
  await page.locator('input[placeholder="Enter password"]').first().fill(PASSWORD);
  await page.locator('input[placeholder="Enter password again"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /continue/i }).click();

  await page.getByTestId('import-recovery-method').waitFor({ timeout: 15_000 });
  await page.getByText(/import public account/i).click();
  await page.getByRole('button', { name: /continue/i }).click();

  await expect(page.getByTestId('onboarding-confirmation')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('onboarding-confirmation-submit').click();

  await page.locator(CONSENT_SELECTOR).waitFor({ state: 'visible', timeout: 30_000 });
}
