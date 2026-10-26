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
 * Get past onboarding's test-network notice: wait for "I understand" and tap it. The notice lists
 * its three facts as plain rows; nothing has to be ticked first.
 */
export async function acknowledgeNetworkNotice(page: NoticePage, timeout = 15_000): Promise<void> {
  const acknowledge = page.getByTestId('onboarding-network-notice-acknowledge');
  await acknowledge.waitFor({ timeout });
  await acknowledge.click({ timeout });
}
