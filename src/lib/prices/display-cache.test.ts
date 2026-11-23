import { fetchFromStorage } from 'lib/miden/front/storage';

import { readCachedDisplayQuotes } from './display-cache';

jest.mock('lib/miden/front/storage', () => ({ fetchFromStorage: jest.fn() }));

it('returns only fresh cached market prices without inventing a daily change', async () => {
  jest.mocked(fetchFromStorage).mockResolvedValue({
    ETH: { priceMicro: '2501000000', fetchedAt: 990 },
    SOL: { priceMicro: '190000000', fetchedAt: 399 },
    BTC: { priceMicro: '90000000000', fetchedAt: 1001 },
    BAD: { priceMicro: '-2', fetchedAt: 990 }
  });
  expect(await readCachedDisplayQuotes(1000)).toEqual({
    ETH: { price: 2501, observedAt: 990000, kind: 'market', change24h: NaN, percentageChange24h: NaN }
  });
});
