import type { Page } from '@playwright/test';

import { acknowledgeNetworkNotice } from './network-notice';

/** Reach recovery through the displayed Welcome variant without creating an invited account. */
export async function openImportTypeScreen(page: Page, timeout = 30_000, actionTimeout = timeout): Promise<void> {
  await page.getByTestId('onboarding-welcome').waitFor({ timeout });
  const recover = page.locator('#import-link');
  // Before 1.17.10 (#2051) a mainnet Welcome showed only the code options, with recovery in the no-code sheet. The
  // upgrade E2E drives those releases with this helper.
  const noCode = page.getByTestId('onboarding-no-code');
  await recover.or(noCode).first().waitFor({ state: 'visible', timeout });
  const shown = await recover.waitFor({ state: 'visible', timeout: 3_000 }).then(
    () => true,
    () => false
  );
  if (shown) {
    await recover.click({ timeout: actionTimeout });
  } else {
    await noCode.click({ timeout: actionTimeout });
    await page.getByTestId('no-code-sheet-recover').click({ timeout: actionTimeout });
  }
  const notice = page.getByTestId('onboarding-network-notice-acknowledge');
  const importType = page.getByTestId('import-select-type');
  await notice.or(importType).first().waitFor({ state: 'visible', timeout: actionTimeout });
  if (await notice.isVisible()) await acknowledgeNetworkNotice(page, actionTimeout);
  await importType.waitFor({ timeout });
}
