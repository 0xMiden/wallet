import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => console.error('Fixture page error:', error.message));
  page.on('console', message => {
    if (message.type() === 'error') console.error('Fixture console error:', message.text());
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === 'http://127.0.0.1:5197' && response.status() >= 400) {
      console.error('Fixture response:', response.status(), url.pathname);
    }
  });
});

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
    await expect(page.getByTestId('bridge-route-confirm')).toBeVisible();
    const badge = await page.getByText('Simulated quotes', { exact: true }).boundingBox();
    const heading = await page.getByText('Choose a route', { exact: true }).boundingBox();
    expect(badge && heading && badge.y + badge.height <= heading.y).toBe(true);
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

for (const surface of ['receive', 'circle'] as const) {
  test(`captures simulated ${surface} quote retry`, async ({ page }, testInfo) => {
    await page.route('**/*', route =>
      new URL(route.request().url()).origin === 'http://127.0.0.1:5197' ? route.continue() : route.abort()
    );
    const dark = testInfo.project.name.endsWith('dark');
    await page.goto(`/?surface=${surface}&retry${dark ? '&dark' : ''}`);
    const action = page.getByTestId('bridge-route-confirm');
    await expect(action).toHaveAccessibleName('Retry');
    await expect(action).toBeEnabled();
    await expect(page.getByTestId('bridge-route-fast')).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: testInfo.outputPath(`${surface}-retry.png`), animations: 'disabled' });

    await action.click();
    await expect(action).toBeDisabled();
    await expect(page.getByTestId('bridge-route-fast')).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: testInfo.outputPath(`${surface}-retry-pending.png`), animations: 'disabled' });
  });
}

test('captures Best Price and Fastest with an incomparable Slow payout', async ({ page }, testInfo) => {
  await page.route('**/*', route =>
    new URL(route.request().url()).origin === 'http://127.0.0.1:5197' ? route.continue() : route.abort()
  );
  const dark = testInfo.project.name.endsWith('dark');
  await page.goto(`/?surface=send&mixed${dark ? '&dark' : ''}`);
  const cards = page.getByTestId(/^bridge-route-(near-intents|fast|slow)$/);
  const expectOrder = async (order: string[]) => {
    for (const [index, id] of order.entries()) {
      await expect(cards.nth(index)).toHaveAttribute('data-testid', `bridge-route-${id}`);
    }
    await expect(page.getByTestId('bridge-route-fast')).toHaveAttribute('aria-pressed', 'true');
  };
  await expectOrder(['near-intents', 'slow', 'fast']);
  await cards.last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('mixed-best-price.png'), animations: 'disabled' });
  await page.getByRole('radio', { name: 'Fastest' }).click();
  await expectOrder(['near-intents', 'fast', 'slow']);
  await page.screenshot({ path: testInfo.outputPath('mixed-fastest.png'), animations: 'disabled' });
});
