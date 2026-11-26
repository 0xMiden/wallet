import { expect, test } from '@playwright/test';

const baseline = process.env.BRIDGE_STATUS_CAPTURE === 'baseline';

for (const phase of ['ready', 'received'] as const) {
  test(`shows the ${phase} USDCx status in Activity and the receipt`, async ({ page }, info) => {
    const resources: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => {
      errors.push(error.message);
      console.error(error.message);
    });
    page.on('console', message => {
      if (message.type() === 'error') console.error(message.text());
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://127.0.0.1:5193') return route.continue();
      resources.push(url.origin);
      return route.abort();
    });
    const theme = info.project.name;
    const expected = phase === 'received' ? 'Completed' : baseline ? 'Confirmed' : 'Pending';
    await page.goto(`/?${theme === 'dark' ? 'dark&' : ''}${phase === 'received' ? 'received' : ''}`);
    await expect(page.getByTestId('activity-bridge-status')).toHaveText(expected);
    const receipt = page.getByRole('region', { name: 'Deposit receipt' });
    await expect(receipt.getByText('Bridge initiated!', { exact: true })).toBeVisible();
    await expect(receipt.getByText(expected, { exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/);
    await page.screenshot({ path: info.outputPath(`bridge-status-${phase}-${theme}.png`), animations: 'disabled' });
    expect(errors).toEqual([]);
    expect(resources).toEqual([]);
  });
}
