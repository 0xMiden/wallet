import { openGuardianPickerFromMeetGuardian } from './meet-guardian';
import type { NoticePage } from './network-notice';

/** A fake page recording every call in order. */
const fakePage = () => {
  const calls: string[] = [];
  const page: NoticePage = {
    getByTestId: (testId: string) => ({
      waitFor: async ({ timeout }) => {
        calls.push(`wait:${testId}:${timeout}`);
      },
      click: async (options?: { timeout?: number }) => {
        calls.push(`click:${testId}:${options?.timeout}`);
      },
      getAttribute: async () => null
    })
  };
  return { page, calls };
};

describe('openGuardianPickerFromMeetGuardian', () => {
  it('goes through the intro, then opens the provider sheet from the operator screen', async () => {
    const { page, calls } = fakePage();
    await openGuardianPickerFromMeetGuardian(page, 60_000);
    expect(calls).toEqual([
      'wait:onboarding-guardian-intro:60000',
      'click:guardian-intro-continue:60000',
      'wait:onboarding-meet-guardian:60000',
      'click:meet-guardian-choose-different:60000'
    ]);
  });

  it('defaults to a 30s wait', async () => {
    const { page, calls } = fakePage();
    await openGuardianPickerFromMeetGuardian(page);
    expect(calls[0]).toBe('wait:onboarding-guardian-intro:30000');
  });
});
