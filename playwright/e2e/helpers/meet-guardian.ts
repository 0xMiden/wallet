import type { NoticePage } from './network-notice';

/** The three facts the Meet your Guardian step asks the user to tick (`MEET_GUARDIAN_POINTS`). */
export const MEET_GUARDIAN_CHECK_TEST_IDS = [
  'onboarding-meet-guardian-check-local-state',
  'onboarding-meet-guardian-check-seed-phrase',
  'onboarding-meet-guardian-check-guardian'
] as const;

/**
 * Get past onboarding's Meet your Guardian step into the full operator picker: tick each of the
 * three facts, then open the picker with the card's Change action (the card and Change show from the
 * first probe round). The ticks come before the Change click because the onboarding picker goes on
 * only once all three facts are ticked; until then its Continue returns to Meet your Guardian. Its
 * Continue also waits for the picked operator to answer online, as Meet's does. A box already ticked
 * is left alone, so a retry never unticks one. Specs pick an operator by endpoint on the picker,
 * which is the only screen that lists them.
 */
export async function openGuardianPickerFromMeetGuardian(page: NoticePage, timeout = 30_000): Promise<void> {
  await page.getByTestId('onboarding-meet-guardian').waitFor({ timeout });
  for (const testId of MEET_GUARDIAN_CHECK_TEST_IDS) {
    const box = page.getByTestId(testId);
    if ((await box.getAttribute('aria-checked')) !== 'true') await box.click();
  }
  await page.getByTestId('meet-guardian-choose-different').click({ timeout });
}
