import { welcomeOnboarding } from './invite-onboarding';

describe('welcomeOnboarding', () => {
  it('shows the general Welcome when the config sets no variant, and the taps unlock the invite-only one', () => {
    expect(welcomeOnboarding(null, false)).toEqual({ inviteOnly: false, tapsUnlockInviteOnly: true });
  });

  it('shows the invite-only Welcome after the unlock, and the taps then open Developer Settings', () => {
    expect(welcomeOnboarding(null, true)).toEqual({ inviteOnly: true, tapsUnlockInviteOnly: false });
  });

  it.each([
    [true, false],
    [true, true],
    [false, false],
    [false, true]
  ])('shows the variant the config sets (inviteOnly %s), whatever the unlock (%s)', (configured, unlocked) => {
    expect(welcomeOnboarding(configured, unlocked)).toEqual({ inviteOnly: configured, tapsUnlockInviteOnly: false });
  });
});
