import { expect, test } from '@playwright/test';

test('shows the queued claim until preflight starts', async ({ page }, info) => {
  const errors: string[] = [];
  const blockedResources: string[] = [];
  page.on('pageerror', error => {
    errors.push(error.message);
    console.error(error.message);
  });
  page.on('console', message => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:5196') return route.continue();
    blockedResources.push(url.origin);
    return route.abort();
  });
  await page.clock.install({ time: new Date('2026-11-26T12:00:00Z') });
  const theme = info.project.name;
  await page.goto(theme === 'dark' ? '/?dark' : '/');
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/);

  const accepting = page.getByRole('button', { name: 'Accepting…' });
  const notice = page.getByText('Claim queued. The wallet will retry automatically.', { exact: true });
  if (process.env.CLAIM_CARD_CAPTURE === 'baseline') {
    await expect(accepting).toHaveAttribute('aria-busy', 'true');
    await expect(notice).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`claim-card-baseline-${theme}.png`), animations: 'disabled' });
  } else {
    await expect(notice).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim queued', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`claim-card-queued-${theme}.png`), animations: 'disabled' });

    await page.evaluate(() => window.dispatchEvent(new Event('fixture-pickup')));
    await expect(notice).toHaveCount(0);
    await expect(accepting).toHaveAttribute('aria-busy', 'true');
    await page.screenshot({ path: info.outputPath(`claim-card-active-${theme}.png`), animations: 'disabled' });
  }

  expect(errors).toEqual([]);
  expect(blockedResources).toEqual([]);
});
