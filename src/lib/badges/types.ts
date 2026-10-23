export const BADGE_IDS = [
  'first-deposit',
  'first-receive',
  'first-send',
  'first-swap',
  'recovery-checked',
  'miniapp-explorer'
] as const;

export type BadgeId = (typeof BADGE_IDS)[number];
export const BADGE_STORAGE_KEY = 'wallet_badges:v1:mainnet';
export const BADGE_SEEN_STORAGE_KEY = 'wallet_badges_seen:v1:mainnet';

/** Only identifiers, never financial payloads, addresses, secrets or transaction references. */
export function readEarnedBadges(value: unknown): BadgeId[] {
  if (!Array.isArray(value)) return [];
  return BADGE_IDS.filter(id => value.includes(id));
}
