import { useEffect, useMemo } from 'react';

import { onStorageChanged, useStorage } from 'lib/miden/front/storage';
import { onStorageCleared } from 'lib/storage-cleared';

import { hasUnreadBadges, markBadgesViewed } from './progress';
import { BADGE_SEEN_STORAGE_KEY, BADGE_STORAGE_KEY, readEarnedBadges, type BadgeId } from './types';

const EMPTY_BADGES: readonly BadgeId[] = [];

/** Wallet-wide, device-local progress, cleared by the existing wallet reset. No cloud/backup promise. */
export function useWalletBadges() {
  const [stored] = useStorage<unknown>(BADGE_STORAGE_KEY, EMPTY_BADGES);
  return useMemo(() => readEarnedBadges(stored), [stored]);
}

export function useHasUnreadBadges(): boolean {
  const earned = useWalletBadges();
  const [seen] = useStorage<unknown>(BADGE_SEEN_STORAGE_KEY, null);
  return hasUnreadBadges(earned, seen);
}

/** Only the collection calls this: opening Profile alone must leave the notification intact. */
export function useMarkWalletBadgesViewed(earned: readonly BadgeId[]): void {
  useEffect(() => {
    let current = true;
    const stopReset = onStorageCleared(() => {
      current = false;
    });
    // Extension resets arrive from the service worker before React leaves Ready.
    // Observe presence only, and attach before reading awards so a wipe cannot be missed.
    const stopVaultRemoval = onStorageChanged<unknown>('vault_check', value => {
      if (value == null) current = false;
    });
    void Promise.resolve(stopVaultRemoval.attached)
      .then(() => markBadgesViewed(earned, () => current))
      .catch(error => console.warn('[badges] could not mark badges viewed', error));
    return () => {
      current = false;
      stopReset();
      stopVaultRemoval();
    };
  }, [earned]);
}
