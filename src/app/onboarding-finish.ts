import { useSyncExternalStore } from 'react';

import { flushSync } from 'react-dom';

import { navigate } from 'lib/woozie';

/**
 * How long an armed mark may stay held. The clock starts when the hold is first on screen (PageRouter arms the held
 * mark the moment it sees the wallet Ready) or when the holder arms it after registration, whichever comes first; it
 * only matters if a holder never releases its mark.
 */
export const ONBOARDING_FINISH_BUDGET_MS = 15_000;

export interface OnboardingFinishMark {
  /**
   * Starts the safety timeout. Called by each holder after registration, and through armHeldOnboardingMark when the
   * hold reaches the screen; a second call is a no-op, so the clock is never restarted. A mark taken before a
   * registration of unbounded length (a biometric prompt) stays unarmed until one of those happens.
   */
  arm(): void;
  /** Idempotent, and only ever clears this mark, never a later one. */
  release(): void;
}

// The mark lives outside every component: ConditionalProviders remounts the app subtree when the wallet turns Ready,
// which is exactly the moment the mark has to survive.
let current: OnboardingFinishMark | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach(listener => listener());

/**
 * Held from before registration until the holder has navigated to its post-creation route through
 * navigateOnFromOnboarding: Welcome's tap-to-confirm handler, Welcome's Chrome side-panel auto-register, and
 * ForgotPassword's recover confirmation. Two readers act on it: while it is held and the wallet is ready, PageRouter
 * shows the loading view at the root instead of Home, and HotKeyRotationGate leaves the onboarding tab ungated when the
 * side panel can take the handoff.
 */
export function markOnboardingFinishing(): OnboardingFinishMark {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(timer);
    if (current !== mark) return;
    current = null;
    notify();
  };
  // Lifecycle telemetry leaves the hold out, so this warning is the only trace a stalled holder leaves.
  const expire = () => {
    if (current !== mark) return;
    console.warn(
      `[onboarding-finish] released by the ${ONBOARDING_FINISH_BUDGET_MS} ms safety budget; the holder never navigated on`
    );
    release();
  };
  const mark: OnboardingFinishMark = {
    arm: () => {
      if (timer !== undefined) return;
      timer = setTimeout(expire, ONBOARDING_FINISH_BUDGET_MS);
    },
    release
  };
  current = mark;
  notify();
  return mark;
}

/** Arms whichever mark is held, if any. PageRouter calls it once the hold is on screen. */
export function armHeldOnboardingMark(): void {
  current?.arm();
}

export const isOnboardingFinishing = () => current !== null;

export function subscribeOnboardingFinishing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const useOnboardingFinishing = () =>
  useSyncExternalStore(subscribeOnboardingFinishing, isOnboardingFinishing, isOnboardingFinishing);

/**
 * How a holder navigates on, called before it releases its mark. The release notifies a useSyncExternalStore
 * subscription, a sync-lane update, while woozie's location update is default-lane, so when both fire in one task React
 * commits the release first: one commit shows neither the mark nor the handoff route, which ungates HotKeyRotationGate
 * and shows PageRouter's root for that commit. flushSync commits the route before the release can. A caller never
 * passes one of Welcome's hash steps: Welcome's in-flight hash guard leaves the attempt's own navigation alone only
 * because every target leaves Welcome's route.
 */
export function navigateOnFromOnboarding(to: string): void {
  flushSync(() => navigate(to));
}
