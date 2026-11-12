import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { useDeadlineNow } from 'lib/ui/deadline-ticker';

import { useBridgeConfigSnapshot } from './use-feature-availability';
import { hasMainnetLaunched, selectMainnetLaunchAt } from './values';

/** The shared sample the countdown and `useMainnetLaunched` render from. */
export const useMainnetLaunchNow = useDeadlineNow;

/**
 * Whether mainnet has launched for the effective network: the document's countdown is on and its moment
 * has passed. Re-renders from the shared sample, so a Welcome or recovery left open across the moment
 * changes mode without a reload, and on every document change that moves the moment.
 */
export function useMainnetLaunched(): boolean {
  const snapshot = useBridgeConfigSnapshot();
  const launchAt = selectMainnetLaunchAt(snapshot);
  const now = useMainnetLaunchNow(launchAt);
  return hasMainnetLaunched(snapshot, now);
}

/**
 * Invite-only onboarding: mainnet has launched, or the effective network is already mainnet. A network
 * picked in Developer Settings (`developerChoice`) exempts the launch, never an actual mainnet. The
 * Welcome's seven-tap unlock stays local to `OnboardingNetwork` and is combined with this result there.
 */
export function isInviteOnlyRequired(
  launched: boolean,
  network: MIDEN_NETWORK_NAME,
  developerChoice: boolean
): boolean {
  return (launched && !developerChoice) || network === MIDEN_NETWORK_NAME.MAINNET;
}
