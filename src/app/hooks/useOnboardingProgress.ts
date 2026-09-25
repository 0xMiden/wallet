import { useLocalStorage, useStorage } from '../../lib/miden/front';
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
