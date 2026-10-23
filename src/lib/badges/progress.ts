import { isStored } from 'lib/miden/back/safe-storage';
import { fetchFromStorage, inStorageTurn, putToStorage } from 'lib/miden/front/storage';

import { ISSUABLE_BADGES } from './evidence';
import { BADGE_SEEN_STORAGE_KEY, BADGE_STORAGE_KEY, readEarnedBadges, type BadgeId } from './types';

/** The same wallet-wide Mainnet scope as awards; an absent baseline means legacy progress, not unread. */
export function hasUnreadBadges(awards: unknown, seen: unknown): boolean {
  if (!Array.isArray(seen)) return false;
  const viewed = readEarnedBadges(seen);
  return readEarnedBadges(awards).some(id => ISSUABLE_BADGES.includes(id) && !viewed.includes(id));
}

// An extension reset wipes storage in the service worker under this same turn and the page hears of it only
// later, so a writer granted the turn after a wipe must see the wallet gone here. 'vault_check' is the vault's
// presence entry; isStored applies the vault's own key hashing.
const walletStillStored = () => isStored('vault_check');

/** Share the award lock with acknowledgements so another page cannot overwrite a newer seen set. */
export async function mergeBadgeAwards(additions: readonly BadgeId[], current: () => boolean): Promise<void> {
  await inStorageTurn(BADGE_STORAGE_KEY, async () => {
    const stored = readEarnedBadges(await fetchFromStorage(BADGE_STORAGE_KEY));
    if (!current()) return;
    const merged = readEarnedBadges([...stored, ...additions]);
    if (merged.length === stored.length) return;
    const seen = await fetchFromStorage(BADGE_SEEN_STORAGE_KEY);
    if (!(await walletStillStored()) || !current()) return;
    // Seed only the pre-existing awards: this first new award, and later ones, remain unread.
    if (!Array.isArray(seen)) await putToStorage(BADGE_SEEN_STORAGE_KEY, stored);
    if (current()) await putToStorage(BADGE_STORAGE_KEY, merged);
  });
}

/** Acknowledge the rendered snapshot only; an award arriving while this queues must still be viewed. */
export async function markBadgesViewed(
  visible: readonly BadgeId[],
  current: () => boolean = () => true
): Promise<void> {
  await inStorageTurn(BADGE_STORAGE_KEY, async () => {
    const stored = readEarnedBadges(await fetchFromStorage(BADGE_STORAGE_KEY));
    const rawSeen = await fetchFromStorage(BADGE_SEEN_STORAGE_KEY);
    if (!current()) return;
    const seen = readEarnedBadges(rawSeen);
    const additions = visible.filter(id => ISSUABLE_BADGES.includes(id) && stored.includes(id));
    const merged = readEarnedBadges([...seen, ...additions]);
    if (Array.isArray(rawSeen) && merged.length === seen.length) return;
    if (!(await walletStillStored()) || !current()) return;
    await putToStorage(BADGE_SEEN_STORAGE_KEY, merged);
  });
}
