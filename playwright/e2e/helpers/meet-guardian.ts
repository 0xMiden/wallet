import type { NoticePage } from './network-notice';

/**
 * Get past onboarding's guardian intro into the provider sheet: Continue on Meet your Guardian (the
 * intro), then Change provider on Choose your Guardian, which opens the sheet listing every operator.
 * Nothing has to be ticked. Specs then pick an operator by endpoint on the sheet (`data-guardian-endpoint`),
 * which closes it, and go on with `meet-guardian-continue`; that Continue waits for the picked operator
 * to answer online.
 */
export async function openGuardianPickerFromMeetGuardian(page: NoticePage, timeout = 30_000): Promise<void> {
  await page.getByTestId('onboarding-guardian-intro').waitFor({ timeout });
  await page.getByTestId('guardian-intro-continue').click({ timeout });
  await page.getByTestId('onboarding-meet-guardian').waitFor({ timeout });
  await page.getByTestId('meet-guardian-choose-different').click({ timeout });
}
