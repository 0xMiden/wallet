import { expect, test } from '@playwright/test';

test('shows the failed claim and applies the hold deadline', async ({ page }, info) => {
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

  if (process.env.CLAIM_CARD_CAPTURE === 'baseline') {
    await expect(page.getByRole('button', { name: 'Accepting…' })).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('pending-activity-submission')).toBeVisible();
    await expect(page.getByTestId('guardian-hold-notice')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`claim-card-baseline-${theme}.png`), animations: 'disabled' });
  } else {
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeDisabled();
    await expect(retry).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('guardian-hold-notice')).toContainText(/You can retry after .*\d/);
    await page.screenshot({ path: info.outputPath(`claim-card-held-${theme}.png`), animations: 'disabled' });

    await page.clock.fastForward(91_000);
    await expect(page.getByTestId('guardian-hold-notice')).toHaveCount(0);
    await expect(page.getByTestId('pending-activity-hint')).toContainText('Could not accept');
    await expect(retry).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`claim-card-expired-${theme}.png`), animations: 'disabled' });
  }

  expect(errors).toEqual([]);
  expect(blockedResources).toEqual([]);
});
