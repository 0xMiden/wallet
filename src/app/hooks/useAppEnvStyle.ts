import { useAppEnv } from '../env';

export const useAppEnvStyle = () => {
  const { compact } = useAppEnv();

  return { dropdownWidth: compact ? 328 : 382 };
};
