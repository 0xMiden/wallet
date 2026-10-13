import { welcomeOnboarding } from './invite-onboarding';

describe('welcomeOnboarding', () => {
  it('shows the general Welcome when the config sets no variant, and the taps unlock the invite-only one', () => {
    expect(welcomeOnboarding(null, false)).toEqual({ inviteOnly: false, tapsUnlockInviteOnly: true });
  });

  it('shows the invite-only Welcome after the unlock, and the taps then open Developer Settings', () => {
    expect(welcomeOnboarding(null, true)).toEqual({ inviteOnly: true, tapsUnlockInviteOnly: false });
  });

  it.each([false, true])(
    'shows the invite-only Welcome directly when the config sets inviteOnly true, whatever the unlock (%s)',
    unlocked => {
      expect(welcomeOnboarding(true, unlocked)).toEqual({ inviteOnly: true, tapsUnlockInviteOnly: false });
    }
  );

  it('keeps the tap unlock when the config sets inviteOnly false', () => {
    expect(welcomeOnboarding(false, false)).toEqual({ inviteOnly: false, tapsUnlockInviteOnly: true });
    expect(welcomeOnboarding(false, true)).toEqual({ inviteOnly: true, tapsUnlockInviteOnly: false });
  });
});
