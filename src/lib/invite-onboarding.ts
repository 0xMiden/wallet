/**
 * The invite-only onboarding: Welcome offers "I have a code", and a new wallet needs a mainnet
 * access code the node checks before the create flow. The general onboarding offers the create and
 * recover flows behind the test-network notice.
 *
 * The remote wallet config chooses the variant with `onboarding.inviteOnly`. When the document
 * sets it, that value decides, and seven logo taps open Developer Settings. When the document does
 * not set it (an older document), the general variant shows, seven logo taps unlock the invite-only
 * variant, and seven more open Developer Settings. The unlock lives for the page's life and is not
 * stored.
 */
let unlocked = false;

export const isInviteOnboardingUnlocked = (): boolean => unlocked;

export const setInviteOnboardingUnlocked = (enabled: boolean): void => {
  unlocked = enabled;
};

export interface WelcomeOnboarding {
  /** Welcome shows the invite-only way in. */
  inviteOnly: boolean;
  /** Seven logo taps unlock the invite-only variant. When false, they open Developer Settings. */
  tapsUnlockInviteOnly: boolean;
}

/**
 * The Welcome variant from the document's value (`selectInviteOnlyOnboarding`, null when the
 * document sets none) and the unlock taps of this page.
 */
export function welcomeOnboarding(configured: boolean | null, tapUnlocked: boolean): WelcomeOnboarding {
  if (configured !== null) return { inviteOnly: configured, tapsUnlockInviteOnly: false };
  return { inviteOnly: tapUnlocked, tapsUnlockInviteOnly: !tapUnlocked };
}
