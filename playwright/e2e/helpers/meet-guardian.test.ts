import { MEET_GUARDIAN_CHECK_TEST_IDS, openGuardianPickerFromMeetGuardian } from './meet-guardian';
import type { NoticePage } from './network-notice';

/** A fake page whose checkboxes flip on click, recording every call in order. */
const fakePage = (initiallyChecked: readonly string[] = []) => {
  const checked = new Set(initiallyChecked);
  const calls: string[] = [];
  const page: NoticePage = {
    getByTestId: (testId: string) => ({
      waitFor: async ({ timeout }) => {
        calls.push(`wait:${testId}:${timeout}`);
      },
      click: async () => {
        calls.push(`click:${testId}`);
        if (checked.has(testId)) checked.delete(testId);
        else checked.add(testId);
      },
      getAttribute: async (name: string) => (name === 'aria-checked' ? String(checked.has(testId)) : null)
    })
  };
  return { page, calls, checked };
};

// Written out rather than read from the helper: an emptied or shortened list must fail here, not pass.
const EXPECTED_CHECK_IDS = [
  'onboarding-meet-guardian-check-local-state',
  'onboarding-meet-guardian-check-seed-phrase',
  'onboarding-meet-guardian-check-guardian'
];

describe('openGuardianPickerFromMeetGuardian', () => {
  it('ticks exactly the three facts the step shows', () => {
    expect([...MEET_GUARDIAN_CHECK_TEST_IDS]).toEqual(EXPECTED_CHECK_IDS);
  });

  it('waits for the step, ticks all three facts, then opens the picker', async () => {
    const { page, calls, checked } = fakePage();
    await openGuardianPickerFromMeetGuardian(page, 60_000);
    expect(calls).toEqual([
      'wait:onboarding-meet-guardian:60000',
      ...EXPECTED_CHECK_IDS.map(id => `click:${id}`),
      'click:meet-guardian-choose-different'
    ]);
    EXPECTED_CHECK_IDS.forEach(id => expect(checked.has(id)).toBe(true));
  });

  it('leaves a box already ticked alone, so a retry never unticks it', async () => {
    const { page, calls, checked } = fakePage([EXPECTED_CHECK_IDS[2]!]);
    await openGuardianPickerFromMeetGuardian(page);
    expect(calls).not.toContain(`click:${EXPECTED_CHECK_IDS[2]}`);
    expect(calls[0]).toBe('wait:onboarding-meet-guardian:30000');
    EXPECTED_CHECK_IDS.forEach(id => expect(checked.has(id)).toBe(true));
  });
});
