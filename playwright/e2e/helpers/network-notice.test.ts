import { acknowledgeNetworkNotice, NETWORK_NOTICE_CHECK_TEST_IDS, NoticePage } from './network-notice';

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

describe('acknowledgeNetworkNotice', () => {
  it('ticks all three facts before acknowledging', async () => {
    const { page, calls, checked } = fakePage();
    await acknowledgeNetworkNotice(page, 30_000);
    expect(calls).toEqual([
      'wait:onboarding-network-notice-acknowledge:30000',
      ...NETWORK_NOTICE_CHECK_TEST_IDS.map(id => `click:${id}`),
      'click:onboarding-network-notice-acknowledge'
    ]);
    NETWORK_NOTICE_CHECK_TEST_IDS.forEach(id => expect(checked.has(id)).toBe(true));
  });

  it('leaves a box already ticked alone, so a retry never unticks it', async () => {
    const { page, calls, checked } = fakePage([NETWORK_NOTICE_CHECK_TEST_IDS[1]]);
    await acknowledgeNetworkNotice(page);
    expect(calls).not.toContain(`click:${NETWORK_NOTICE_CHECK_TEST_IDS[1]}`);
    expect(calls[0]).toBe('wait:onboarding-network-notice-acknowledge:15000');
    NETWORK_NOTICE_CHECK_TEST_IDS.forEach(id => expect(checked.has(id)).toBe(true));
  });
});
