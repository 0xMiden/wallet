import { writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import sharp from 'sharp';

import { setEligibilityFixtureState, type EligibilityFixtureState } from '../e2e/helpers/feature-eligibility';
import { expect, test } from '../fixtures/extension';

test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  await setEligibilityFixtureState('allowed');
});

async function expectBlockedAccess(page: Page, state: Exclude<EligibilityFixtureState, 'allowed'>) {
  await expect(page.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', state);
  await expect(page.getByTestId('onboarding-welcome')).toHaveCount(0);
  await expect(page.getByTestId('import-seed-phrase')).toHaveCount(0);
}

async function expectRetryableAccess(page: Page, state: 'restricted' | 'unavailable') {
  await expectBlockedAccess(page, state);
  await expect(page.getByTestId('wallet-access-retry')).toBeVisible();
}

const accessAssertions: Record<EligibilityFixtureState, (page: Page) => Promise<void>> = {
  allowed: async page => {
    await expect(page.getByTestId('onboarding-welcome')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('wallet-access-gate')).toHaveCount(0);
  },
  loading: page => expectBlockedAccess(page, 'loading'),
  restricted: page => expectRetryableAccess(page, 'restricted'),
  unavailable: page => expectRetryableAccess(page, 'unavailable')
};

for (const state of ['loading', 'restricted', 'unavailable', 'allowed'] satisfies EligibilityFixtureState[]) {
  test(`root wallet access: ${state}`, async ({ extensionContext, extensionId }, info) => {
    await setEligibilityFixtureState(state);
    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
    await accessAssertions[state](page);
    const screenshot = info.outputPath(`wallet-access-${state}.png`);
    await page.screenshot({ path: screenshot });
    await writeFile(
      screenshot,
      await sharp(screenshot).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).toBuffer()
    );
    await info.attach(`wallet-access-${state}`, { path: screenshot, contentType: 'image/png' });
    await page.close();
  });
}
