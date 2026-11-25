import { expect, test } from '@playwright/test';

for (const surface of ['send', 'receive', 'circle'] as const) {
  test(`captures simulated ${surface} provider comparison`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://127.0.0.1:5197') return route.continue();
      external.push(url.origin);
      return route.abort();
    });

    const params = new URLSearchParams({ surface });
    const dark = testInfo.project.name.endsWith('dark');
    if (dark) params.set('dark', '');
    const provider = surface === 'circle' ? 'usdcx' : 'slow';
    const epoch = page.getByTestId('bridge-route-fast');
    const other = page.getByTestId(`bridge-route-${provider}`);
    const cards = page.locator(`[data-testid="bridge-route-fast"], [data-testid="bridge-route-${provider}"]`);
    const sort = page.getByRole('radiogroup', { name: 'Sort routes' });

    await page.goto(`/?${params}`);
    if (dark) await expect(page.locator('html')).toHaveClass('dark');
    else await expect(page.locator('html')).not.toHaveClass('dark');
    await expect(sort.getByRole('radio', { name: 'Best Price' })).toBeChecked();
    await expect(cards.first()).toHaveAttribute('data-testid', `bridge-route-${provider}`);
    await expect(epoch).toContainText('19.8');
    await expect(other).toContainText('20');
    await expect(page.getByTestId('bridge-route-confirm')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-best-price.png`), animations: 'disabled' });

    await other.click();
    await sort.getByRole('radio', { name: 'Fastest' }).click();
    await expect(cards.first()).toHaveAttribute('data-testid', 'bridge-route-fast');
    await expect(other).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: testInfo.outputPath(`${surface}-fastest.png`), animations: 'disabled' });

    if (surface !== 'circle') {
      params.set('failed', '');
      await page.goto(`/?${params}`);
      await expect(epoch).toBeDisabled();
      await expect(other).toBeEnabled();
      await expect(page.getByTestId('bridge-route-confirm')).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`${surface}-unavailable.png`), animations: 'disabled' });
    }
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });
}
