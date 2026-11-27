import { THEME_STORAGE_KEY } from '../../src/lib/settings/constants';
import { importWallet } from '../e2e/helpers/import-wallet';
import { expect, test } from '../fixtures/extension';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('captures Wallet privacy settings copy in both themes', async ({ extensionId, extensionContext }, info) => {
  test.setTimeout(300_000);
  await extensionContext.route(/^https?:\/\//, route =>
    new URL(route.request().url()).origin === 'http://127.0.0.1:8551' ? route.continue() : route.abort()
  );
  await importWallet(extensionContext, extensionId);

  const sidebar = `chrome-extension://${extensionId}/sidepanel.html`;
  for (const theme of ['light', 'dark'] as const) {
    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 380, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_STORAGE_KEY,
      value: theme
    });
    await page.goto(`${sidebar}#/settings/general-settings`, { waitUntil: 'domcontentloaded' });
    const settings = page.getByTestId('general-settings');
    const proof = settings.getByText(
      'On by default. When on, the wallet sends transaction details to a remote service to generate proofs. When off, the wallet proves transactions locally on your device, except bridge withdrawals and Earn deposits, which still try that remote service. If the service is unavailable, local proving is available.',
      { exact: true }
    );
    await expect(settings).toBeVisible({ timeout: 30_000 });
    const toggle = settings.getByTestId('General Settings/DelegateToggle');
    await expect(toggle).toBeChecked();
    await proof.scrollIntoViewIfNeeded();
    await expect(proof).toBeInViewport({ ratio: 1 });
    await expect(toggle).toBeInViewport({ ratio: 1 });
    const layout = await proof.evaluate(async node => {
      await document.fonts.ready;
      const bounds = node.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(node);
      const lines = Array.from(range.getClientRects()).filter(line => line.width > 0);
      return {
        wraps: new Set(lines.map(line => line.top)).size > 1,
        fits: lines.every(line => line.left >= bounds.left - 1 && line.right <= bounds.right + 1)
      };
    });
    expect(layout).toEqual({ wraps: true, fits: true });
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await page.screenshot({ path: info.outputPath(`proving-${theme}.png`), animations: 'disabled', scale: 'css' });

    await page.goto(`${sidebar}#/rotate-guardian`, { waitUntil: 'domcontentloaded' });
    await page
      .getByTestId('onboarding-choose-guardian')
      .getByRole('button', { name: 'Learn more about the Guardian' })
      .click();
    const drawer = page.getByRole('dialog', { name: 'What is a Guardian?' });
    const details = drawer.getByText('Your Guardian can see your account and payment details.', { exact: false });
    const limit = drawer.getByText('Move your funds on its own.', { exact: true });
    await expect(details).toBeInViewport({ ratio: 1 });
    await expect(limit).toBeInViewport({ ratio: 1 });
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await page.screenshot({ path: info.outputPath(`guardian-${theme}.png`), animations: 'disabled', scale: 'css' });
    await page.close();
  }
});
