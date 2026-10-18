import { useStorage } from 'lib/miden/front/storage';

import { BADGE_STORAGE_KEY, readEarnedBadges } from './types';

/** Wallet-wide, device-local progress, cleared by the existing wallet reset. No cloud/backup promise. */
export function useWalletBadges() {
  const [stored] = useStorage<unknown>(BADGE_STORAGE_KEY, []);
  return readEarnedBadges(stored);
}
