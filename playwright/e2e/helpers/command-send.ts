import { expect, type Locator, type Page } from '@playwright/test';

/** FullPage extension tests expect Command, never whichever Send form happens to appear first. */
export async function commandSendForm(page: Page, timeoutMs = 30_000): Promise<Locator> {
  await expect(page.getByTestId('command-shell')).toBeVisible({ timeout: timeoutMs });
  const form = page.getByTestId('send-flow');
  await expect(form.getByTestId('command-send-composer')).toBeVisible({ timeout: timeoutMs });
  await expect(form.getByTestId('send-recipient-input')).toBeVisible({ timeout: timeoutMs });
  await expect(form.getByTestId('send-amount-input')).toBeVisible({ timeout: timeoutMs });
  await expect(form.getByTestId('send-recipient-confirm')).toHaveCount(0);
  return form;
}

export async function openCommandSendDetails(page: Page, timeoutMs = 30_000): Promise<Locator> {
  const details = page.getByTestId('command-details');
  await expect(details).toBeVisible({ timeout: timeoutMs });
  await details.locator('summary').click({ timeout: timeoutMs });
  await expect(details).toHaveAttribute('open', '', { timeout: timeoutMs });
  return details;
}

export async function confirmCommandSendReview(page: Page, timeoutMs = 30_000): Promise<void> {
  const review = page.getByTestId('command-footer').getByTestId('command-send-review');
  await expect(review).toBeEnabled({ timeout: timeoutMs });
  await review.click({ timeout: timeoutMs });
  await page.waitForURL(/#\/send\/review\?/, { timeout: timeoutMs });
}
