import { putToStorage, useLocalStorage } from '../../lib/miden/front';
import { MidenSharedStorageKey } from '../../lib/miden/types';

/**
 * Marks onboarding complete without reading the persisted flag. Reading it goes through a suspending storage hook,
 * so a caller rendered above a page's Suspense boundary (the PageLayout toolbar) would blank the screen on a cold key.
 */
export const useSetOnboardingCompleted = () => {
  const [, setOnboarding] = useLocalStorage('onboarding', false);
  return (value: boolean) => {
    setOnboarding(value);
    void putToStorage(MidenSharedStorageKey.OnboardingCompleted, value);
  };
};
