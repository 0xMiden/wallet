/** The three facts the test-network notice asks the user to tick (`NETWORK_NOTICE_ROWS`). */
export const NETWORK_NOTICE_CHECK_TEST_IDS = [
  'onboarding-network-notice-check-no-value',
  'onboarding-network-notice-check-no-real-funds',
  'onboarding-network-notice-check-reset'
] as const;

/** The slice of a Playwright `Page` the helper drives, so a unit test can hand it a fake. */
interface NoticeLocator {
  waitFor(options: { timeout: number }): Promise<unknown>;
  click(options?: { timeout?: number }): Promise<unknown>;
  getAttribute(name: string): Promise<string | null>;
}

export interface NoticePage {
  getByTestId(testId: string): NoticeLocator;
}

/**
 * Get past onboarding's test-network notice: tick each of its three checkboxes ("I understand"
 * stays disabled until all three are ticked), then acknowledge. A box already ticked is left alone,
 * so a retry never unticks one.
 */
export async function acknowledgeNetworkNotice(page: NoticePage, timeout = 15_000): Promise<void> {
  const acknowledge = page.getByTestId('onboarding-network-notice-acknowledge');
  await acknowledge.waitFor({ timeout });
  for (const testId of NETWORK_NOTICE_CHECK_TEST_IDS) {
    const box = page.getByTestId(testId);
    if ((await box.getAttribute('aria-checked')) !== 'true') await box.click();
  }
  await acknowledge.click({ timeout });
}
