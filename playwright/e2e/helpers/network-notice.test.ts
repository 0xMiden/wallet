import { acknowledgeNetworkNotice, NoticePage } from './network-notice';

/** A fake page recording every call in order. */
const fakePage = () => {
  const calls: string[] = [];
  const page: NoticePage = {
    getByTestId: (testId: string) => ({
      waitFor: async ({ timeout }) => {
        calls.push(`wait:${testId}:${timeout}`);
      },
      click: async () => {
        calls.push(`click:${testId}`);
      },
      getAttribute: async () => null
    })
  };
  return { page, calls };
};

describe('acknowledgeNetworkNotice', () => {
  it('waits for I understand and taps it, with the given timeout', async () => {
    const { page, calls } = fakePage();
    await acknowledgeNetworkNotice(page, 30_000);
    expect(calls).toEqual([
      'wait:onboarding-network-notice-acknowledge:30000',
      'click:onboarding-network-notice-acknowledge'
    ]);
  });

  it('defaults the timeout to 15 s', async () => {
    const { page, calls } = fakePage();
    await acknowledgeNetworkNotice(page);
    expect(calls[0]).toBe('wait:onboarding-network-notice-acknowledge:15000');
  });
});
