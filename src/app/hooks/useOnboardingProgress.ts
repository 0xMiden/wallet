import { useCallback } from 'react';

import { putToStorage, useLocalStorage, useStorage } from '../../lib/miden/front';
import { MidenSharedStorageKey } from '../../lib/miden/types';

export const useOnboardingProgress = () => {
  const [onBoarding, setOnboarding] = useLocalStorage('onboarding', false);
  const [onboardingCompleted, setIsOnboardingCompleted] = useStorage(
    MidenSharedStorageKey.OnboardingCompleted,
    onBoarding
  );

  const setOnboardingCompleted = (value: boolean) => {
    setOnboarding(value);
    setIsOnboardingCompleted(value);
  };

  return {
    onboardingCompleted,
    setOnboardingCompleted
  };
};

/**
 * Marks onboarding complete without reading the persisted flag. Reading it goes through a suspending storage hook,
 * so a caller rendered above a page's Suspense boundary (the PageLayout toolbar) would blank the screen on a cold key.
 */
export const useSetOnboardingCompleted = () => {
  const [, setOnboarding] = useLocalStorage('onboarding', false);
  return useCallback(
    (value: boolean) => {
      setOnboarding(value);
      void putToStorage(MidenSharedStorageKey.OnboardingCompleted, value);
    },
    [setOnboarding]
  );
};
