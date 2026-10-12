/**
 * The end of a test network. The remote wallet config sets `onboarding.inviteOnly` when Bread moves
 * to the invite-only mainnet. A wallet that was set up on a test network before that stays usable
 * for nothing: its test tokens never carry over. The wallet then shows one screen that explains this
 * and offers the reset, which clears every storage and brings the user back to onboarding.
 *
 * A wallet set up WHILE the config is invite-only is not gated: the invite-only Welcome creates it
 * on purpose. The marker below records that setup, written when onboarding starts to finish under
 * the invite-only config. A reset clears the marker with everything else, and the next onboarding
 * writes it again.
 */
export const INVITE_ONBOARDING_SETUP_STORAGE_KEY = 'invite_onboarding_setup_v1';

export interface TestnetEndedInputs {
  /** The config's `onboarding.inviteOnly`: null while no document sets it. */
  inviteOnly: boolean | null;
  /** The wallet is on a test network (testnet, devnet or localnet). */
  onTestNetwork: boolean;
  /** A wallet exists, locked or ready. */
  walletExists: boolean;
  /** An onboarding holder has registered a wallet and has not navigated on yet. */
  finishingOnboarding: boolean;
  /** The marker: this wallet was set up under the invite-only config. */
  setUpUnderInvite: boolean;
}

/** True when the wallet must show the "test network has ended" screen and offer the reset. */
export function isTestnetEnded(inputs: TestnetEndedInputs): boolean {
  if (inputs.inviteOnly !== true) return false;
  if (!inputs.onTestNetwork) return false;
  if (!inputs.walletExists) return false;
  if (inputs.finishingOnboarding) return false;
  return !inputs.setUpUnderInvite;
}
