import { useSyncExternalStore } from 'react';

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
let current: { mark: OnboardingFinishMark } | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach(listener => listener());

/**
 * Held from before registration until the holder has navigated to its post-creation route: Welcome's tap-to-confirm
 * handler, Welcome's Chrome side-panel auto-create, and ForgotPassword's recover confirmation. While held and the
 * wallet is ready, the root shows the loading view instead of Home.
 */
export function markOnboardingFinishing(): OnboardingFinishMark {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const entry = {} as { mark: OnboardingFinishMark };
  const release = () => {
    clearTimeout(timer);
    if (current !== entry) return;
    current = null;
    notify();
  };
  // Lifecycle telemetry leaves the hold out, so this warning is the only trace a stalled holder leaves.
  const expire = () => {
    if (current !== entry) return;
    console.warn(
      `[onboarding-finish] released by the ${ONBOARDING_FINISH_BUDGET_MS} ms safety budget; the holder never navigated on`
    );
    release();
  };
  entry.mark = {
    arm: () => {
      if (timer !== undefined) return;
      timer = setTimeout(expire, ONBOARDING_FINISH_BUDGET_MS);
    },
    release
  };
  current = entry;
  notify();
  return entry.mark;
}

/** Arms whichever mark is held, if any. PageRouter calls it once the hold is on screen. */
export function armHeldOnboardingMark(): void {
  current?.mark.arm();
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
