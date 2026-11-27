import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import {
  _resetDisplayFeedForTest,
  DISPLAY_QUOTE_MAX_AGE_MS,
  feedFoundNoQuote,
  readDisplayFeed,
  writeDisplayFeed
} from './display-feed';

jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn(async () => undefined)
}));

const NOW = 1_700_000_000_000;
const market = { price: 3000, change24h: 1, percentageChange24h: 1, kind: 'market' as const };
const basket = { price: 1.5, change24h: 0, percentageChange24h: 0, kind: 'basket' as const };

beforeEach(() => {
  _resetDisplayFeedForTest();
  jest.mocked(fetchFromStorage).mockReset().mockResolvedValue(undefined);
  jest.mocked(putToStorage).mockClear();
});

it('remembers a run: basket values to show, and what no market quotes, but never an asset it priced', async () => {
  await writeDisplayFeed('mainnet', { ETH: market, BLUEDW: basket }, ['GC', 'ETH'], 'list-a', NOW);
  expect(putToStorage).toHaveBeenCalledWith('display_feed_v1:mainnet', {
    fetchedAt: NOW,
    baskets: { BLUEDW: 1.5 },
    unquoted: ['GC'],
    listKey: 'list-a'
  });
  expect(feedFoundNoQuote('mainnet', 'GC', NOW)).toBe(true);
  expect(feedFoundNoQuote('mainnet', 'ETH', NOW)).toBe(false);
  expect(feedFoundNoQuote('testnet', 'GC', NOW)).toBe(false);
});

it('reads a stored run into the realm and forgets it after the display window', async () => {
  jest
    .mocked(fetchFromStorage)
    .mockResolvedValue({ fetchedAt: NOW, baskets: { BLUEDW: 1.5, BAD: -1 }, unquoted: ['GC', 7], listKey: 'list-a' });
  expect(feedFoundNoQuote('mainnet', 'GC', NOW)).toBe(false);
  await expect(readDisplayFeed('mainnet', NOW + 1, 'list-a')).resolves.toEqual({
    BLUEDW: { price: 1.5, observedAt: NOW, kind: 'basket', change24h: NaN, percentageChange24h: NaN }
  });
  expect(feedFoundNoQuote('mainnet', 'GC', NOW + 1)).toBe(true);
  const late = NOW + DISPLAY_QUOTE_MAX_AGE_MS + 1;
  expect(feedFoundNoQuote('mainnet', 'GC', late)).toBe(false);
  await expect(readDisplayFeed('mainnet', late, 'list-a')).resolves.toEqual({});
});

it('ignores a malformed record and never lets an older stored run replace a newer one', async () => {
  jest.mocked(fetchFromStorage).mockResolvedValue({ fetchedAt: 'soon', baskets: {}, unquoted: ['GC'] });
  await readDisplayFeed('mainnet', NOW, 'list-a');
  expect(feedFoundNoQuote('mainnet', 'GC', NOW)).toBe(false);

  await writeDisplayFeed('mainnet', {}, ['POL'], 'list-a', NOW);
  jest.mocked(fetchFromStorage).mockResolvedValue({ fetchedAt: NOW - 1, baskets: {}, unquoted: ['GC'] });
  await readDisplayFeed('mainnet', NOW, 'list-a');
  expect(feedFoundNoQuote('mainnet', 'POL', NOW)).toBe(true);
  expect(feedFoundNoQuote('mainnet', 'GC', NOW)).toBe(false);
});

it('withholds basket values computed for another list revision and still reports unquoted', async () => {
  jest
    .mocked(fetchFromStorage)
    .mockResolvedValue({ fetchedAt: NOW, baskets: { BLUEDW: 1.5 }, unquoted: ['GC'], listKey: 'list-a' });
  await expect(readDisplayFeed('mainnet', NOW, 'list-b')).resolves.toEqual({});
  expect(feedFoundNoQuote('mainnet', 'GC', NOW)).toBe(true);
  await expect(readDisplayFeed('mainnet', NOW, 'list-a')).resolves.toEqual({
    BLUEDW: { price: 1.5, observedAt: NOW, kind: 'basket', change24h: NaN, percentageChange24h: NaN }
  });
  // A record from before revisions were stored proves no revision, so it shows no basket.
  _resetDisplayFeedForTest();
  jest.mocked(fetchFromStorage).mockResolvedValue({ fetchedAt: NOW, baskets: { BLUEDW: 1.5 }, unquoted: [] });
  await expect(readDisplayFeed('mainnet', NOW, '')).resolves.toEqual({});
});
