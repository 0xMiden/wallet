import type { Page } from '@playwright/test';

import { acknowledgeNetworkNotice } from './network-notice';

/** Reach recovery through the displayed Welcome variant without creating an invited account. */
export async function openImportTypeScreen(page: Page, timeout = 30_000, actionTimeout = timeout): Promise<void> {
  await page.getByTestId('onboarding-welcome').waitFor({ timeout });
  const recover = page.locator('#import-link');
  const noCode = page.getByTestId('onboarding-no-code');
  await noCode.or(recover).first().waitFor({ state: 'visible', timeout });
  if (await noCode.isVisible()) {
    await noCode.click({ timeout: actionTimeout });
    await page.getByTestId('no-code-sheet-recover').click({ timeout: actionTimeout });
  } else {
    await recover.click({ timeout: actionTimeout });
  }
  const notice = page.getByTestId('onboarding-network-notice-acknowledge');
  const importType = page.getByTestId('import-select-type');
  await notice.or(importType).first().waitFor({ state: 'visible', timeout: actionTimeout });
  if (await notice.isVisible()) await acknowledgeNetworkNotice(page, actionTimeout);
  await importType.waitFor({ timeout });
}
