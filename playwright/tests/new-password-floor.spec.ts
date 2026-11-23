import { openCreatePasswordForImport } from '../e2e/helpers/import-wallet';
import { expect, test } from '../fixtures/extension';

/**
 * The create-password screen of a seed-phrase import enforces the 12-character floor for a NEW
 * password: 11 characters keep Continue disabled and show the rule, 12 enable it. Runs on the mock
 * build; no chain is touched because the flow stops at the password screen.
 */
test.describe('new-password floor', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'MV3 extension only runs in Chromium');

  // welcome 30s + notice 30s + select-type 15s + seed-phrase 15s + create-password 10s + fills and asserts 30s = 130s.
  test('keeps Continue disabled at 11 characters and enables it at 12', async ({
    extensionContext,
    extensionId
  }, testInfo) => {
    test.setTimeout(180_000);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
    await openCreatePasswordForImport(page);

    const password = page.locator('input[placeholder="Enter password"]').first();
    const verify = page.locator('input[placeholder="Enter password again"]').first();
    const continueButton = page.getByTestId('create-password-submit');

    const eleven = 'Abcdef1234!';
    await password.fill(eleven);
    await verify.fill(eleven);
    await expect(continueButton).toBeDisabled();
    await expect(page.getByText('At least 12 characters', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('posture-password-11.png'), animations: 'disabled' });

    const twelve = 'Abcdef12345!';
    await password.fill(twelve);
    await verify.fill(twelve);
    await expect(continueButton).toBeEnabled();
    // The button fades between its states; capture the settled colour, not the start of the fade.
    await page.screenshot({ path: testInfo.outputPath('posture-password-12.png'), animations: 'disabled' });
  });
});
