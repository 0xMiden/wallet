import { isTestnetEnded, TestnetEndedInputs } from './testnet-ended';

// A wallet set up on a test network before the config went invite-only.
const ENDED: TestnetEndedInputs = {
  inviteOnly: true,
  onTestNetwork: true,
  walletExists: true,
  finishingOnboarding: false,
  setUpUnderInvite: false
};

describe('isTestnetEnded', () => {
  it('ends the test network for a wallet set up before the invite-only config', () => {
    expect(isTestnetEnded(ENDED)).toBe(true);
  });

  it.each([
    ['the config is not invite-only', { inviteOnly: false }],
    ['no document sets the variant', { inviteOnly: null }],
    ['the wallet is on mainnet', { onTestNetwork: false }],
    ['no wallet exists', { walletExists: false }],
    ['onboarding is finishing', { finishingOnboarding: true }],
    ['the wallet was set up under the invite-only config', { setUpUnderInvite: true }]
  ] as const)('does not end it while %s', (_name, override) => {
    expect(isTestnetEnded({ ...ENDED, ...override })).toBe(false);
  });
});
