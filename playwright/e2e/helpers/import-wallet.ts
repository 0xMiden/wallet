import { expect, type BrowserContext } from '@playwright/test';

import { openImportTypeScreen } from './onboarding-entry';
import { passImportConfirmation } from './onboarding-confirmation';
import { dismissTelemetryConsent } from './telemetry-consent';

export const IMPORTED_WALLET_PASSWORD = 'Password123!';
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');

/**
 * Import a public wallet through fullpage onboarding and close the page once the wallet is Ready.
 * Budget: welcome 30s + notice 30s + select-type 15s + seed-phrase 15s + create-password 10s +
 * recovery-method 15s + confirmation 30s + telemetry-consent 40s + open-wallet 30s = 215s.
 */
export async function importWallet(extensionContext: BrowserContext, extensionId: string): Promise<void> {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
  await openImportTypeScreen(page, 30_000, 15_000);
  await page.getByTestId('import-type-seed-phrase').click();
  await page.getByTestId('import-seed-phrase').waitFor({ timeout: 15_000 });
  for (let i = 0; i < SEED.length; i++) {
    await page.locator(`#seed-phrase-input-${i}`).fill(SEED[i]!);
  }
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page).toHaveURL(/create-password/);
  await page.locator('input[placeholder="Enter password"]').first().fill(IMPORTED_WALLET_PASSWORD);
  await page.locator('input[placeholder="Enter password again"]').first().fill(IMPORTED_WALLET_PASSWORD);
  await page.getByRole('button', { name: /continue/i }).click();
  await page.getByTestId('import-recovery-method').waitFor({ timeout: 15_000 });
  await page.getByText(/import public account/i).click();
  // A public import creates an account when none exists, so it waits for the reused-phrase acknowledgement.
  await page.getByTestId('reused-phrase-acknowledge').click();
  await page.getByRole('button', { name: /continue/i }).click();
  await passImportConfirmation(page, 30_000);
  // Onboarding gained a consent screen between the confirmation and the handoff, so this
  // driver has to clear it before waiting for a post-onboarding surface.
  await dismissTelemetryConsent(page, { timeoutMs: 30_000 });
  // The wallet is Ready once the side-panel handoff offers to open it; callers open their own page.
  await expect(page.getByRole('button', { name: /open wallet/i })).toBeVisible({ timeout: 30_000 });
  await page.close();
}
