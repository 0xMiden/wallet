import { useSyncExternalStore } from 'react';

/**
 * How long an armed mark may stay held. Armed immediately before Welcome's Ready wait (5 s), so this covers that
 * wait and the navigation after it with room to spare; it only matters if a handler never releases its mark.
 */
export const ONBOARDING_FINISH_BUDGET_MS = 15_000;

export interface OnboardingFinishMark {
  /** Starts the safety timeout. Called when the Ready wait begins, not before a registration of unbounded length. */
  arm(): void;
  /** Idempotent, and only ever clears this mark, never a later one. */
  release(): void;
}

// The mark lives outside every component: ConditionalProviders remounts the app subtree when the wallet turns Ready,
// which is exactly the moment the mark has to survive.
let current: object | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach(listener => listener());

/**
 * Held by the tap-to-confirm handler from before registration until it has navigated to the post-creation route.
 * While held and the wallet is ready, the root shows the loading view instead of Home.
 */
export function markOnboardingFinishing(): OnboardingFinishMark {
  const token = {};
  current = token;
  notify();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(timer);
    if (current !== token) return;
    current = null;
    notify();
  };
  return {
    arm: () => {
      clearTimeout(timer);
      timer = setTimeout(release, ONBOARDING_FINISH_BUDGET_MS);
    },
    release
  };
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
