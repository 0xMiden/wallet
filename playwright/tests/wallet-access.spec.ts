import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { setEligibilityFixtureState, type EligibilityFixtureState } from '../e2e/helpers/feature-eligibility';
import { expect, test } from '../fixtures/extension';

test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  await setEligibilityFixtureState('allowed');
});

for (const state of ['loading', 'restricted', 'unavailable', 'allowed'] satisfies EligibilityFixtureState[]) {
  test(`root wallet access: ${state}`, async ({ extensionContext, extensionId }, info) => {
    await setEligibilityFixtureState(state);
    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
    const gate = page.getByTestId('wallet-access-gate');
    if (state === 'allowed') {
      await expect(page.getByTestId('onboarding-welcome')).toBeVisible({ timeout: 30_000 });
      await expect(gate).toHaveCount(0);
    } else {
      await expect(gate).toHaveAttribute('data-access-state', state);
      await expect(page.getByTestId('onboarding-welcome')).toHaveCount(0);
      await expect(page.getByTestId('import-seed-phrase')).toHaveCount(0);
      if (state !== 'loading') await expect(page.getByTestId('wallet-access-retry')).toBeVisible();
    }
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
