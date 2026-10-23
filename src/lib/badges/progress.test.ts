import { hasUnreadBadges, markBadgesViewed, mergeBadgeAwards } from './progress';
import { BADGE_SEEN_STORAGE_KEY, BADGE_STORAGE_KEY } from './types';

const mockValues = new Map<string, unknown>();
const mockWrites = jest.fn();
let mockTurn = Promise.resolve();
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: async (key: string) => mockValues.get(key),
  putToStorage: async (key: string, value: unknown) => {
    mockWrites(key, value);
    mockValues.set(key, value);
  },
  inStorageTurn: (_key: string, operation: () => Promise<void>) => {
    const next = mockTurn.then(operation);
    mockTurn = next.catch(() => {});
    return next;
  }
}));
beforeEach(() => {
  mockValues.clear();
  mockWrites.mockReset();
  mockTurn = Promise.resolve();
});

it('does not flag legacy awards until there is an initialized seen baseline, and ignores unavailable badges', () => {
  expect(hasUnreadBadges(['first-send'], undefined)).toBe(false);
  expect(hasUnreadBadges(['first-send'], [])).toBe(true);
  expect(hasUnreadBadges(['first-send'], ['first-send'])).toBe(false);
  expect(hasUnreadBadges(['first-receive', 'recovery-checked', 'miniapp-explorer'], [])).toBe(false);
});

it('migrates existing awards as seen before writing a newly issued award', async () => {
  mockValues.set(BADGE_STORAGE_KEY, ['first-send']);
  await mergeBadgeAwards(['first-deposit'], () => true);
  expect(mockValues.get(BADGE_SEEN_STORAGE_KEY)).toEqual(['first-send']);
  expect(mockValues.get(BADGE_STORAGE_KEY)).toEqual(['first-deposit', 'first-send']);
  expect(hasUnreadBadges(mockValues.get(BADGE_STORAGE_KEY), mockValues.get(BADGE_SEEN_STORAGE_KEY))).toBe(true);
  expect(mockWrites.mock.calls.map(call => call[0])).toEqual([BADGE_SEEN_STORAGE_KEY, BADGE_STORAGE_KEY]);
});

it('retains seen state through duplicate issuance and subsequent reads', async () => {
  mockValues.set(BADGE_STORAGE_KEY, []);
  await mergeBadgeAwards(['first-send'], () => true);
  await markBadgesViewed(['first-send']);
  mockWrites.mockClear();
  await mergeBadgeAwards(['first-send', 'first-send'], () => true);
  expect(mockWrites).not.toHaveBeenCalled();
  expect(hasUnreadBadges(mockValues.get(BADGE_STORAGE_KEY), mockValues.get(BADGE_SEEN_STORAGE_KEY))).toBe(false);
});

it('acknowledges only the rendered snapshot so a concurrent new award stays unread', async () => {
  mockValues.set(BADGE_STORAGE_KEY, ['first-send', 'first-deposit']);
  mockValues.set(BADGE_SEEN_STORAGE_KEY, []);
  await markBadgesViewed(['first-send']);
  expect(mockValues.get(BADGE_SEEN_STORAGE_KEY)).toEqual(['first-send']);
  expect(hasUnreadBadges(mockValues.get(BADGE_STORAGE_KEY), mockValues.get(BADGE_SEEN_STORAGE_KEY))).toBe(true);
  await markBadgesViewed(['first-send', 'first-deposit']);
  expect(hasUnreadBadges(mockValues.get(BADGE_STORAGE_KEY), mockValues.get(BADGE_SEEN_STORAGE_KEY))).toBe(false);
});

it('merges simultaneous views instead of losing either acknowledgement', async () => {
  mockValues.set(BADGE_STORAGE_KEY, ['first-send', 'first-swap']);
  mockValues.set(BADGE_SEEN_STORAGE_KEY, []);
  await Promise.all([markBadgesViewed(['first-send']), markBadgesViewed(['first-swap'])]);
  expect(mockValues.get(BADGE_SEEN_STORAGE_KEY)).toEqual(['first-send', 'first-swap']);
});

it('abandons stale award and view writes while waiting on the storage turn', async () => {
  let release: () => void = () => {};
  mockTurn = new Promise(resolve => {
    release = resolve;
  });
  let current = true;
  const award = mergeBadgeAwards(['first-send'], () => current);
  const view = markBadgesViewed(['first-send'], () => current);
  current = false;
  release();
  await Promise.all([award, view]);
  expect(mockWrites).not.toHaveBeenCalled();
});

it('never acknowledges an unearned or unavailable identifier', async () => {
  mockValues.set(BADGE_STORAGE_KEY, ['first-receive']);
  await markBadgesViewed(['first-send', 'first-receive']);
  expect(mockValues.get(BADGE_SEEN_STORAGE_KEY)).toEqual([]);
  expect(mockValues.get(BADGE_STORAGE_KEY)).toEqual(['first-receive']);
});
