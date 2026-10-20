import * as binance from './binance';
import { fetchKlineData, fetchTokenPrices } from './feed';
import * as kraken from './kraken';

jest.mock('./binance');
jest.mock('./kraken');

const primary = jest.mocked(binance);
const fallback = jest.mocked(kraken);
const dollars = { price: 1, change24h: 0, percentageChange24h: 0 };

beforeEach(() => {
  jest.resetAllMocks();
  primary.fetchTokenPrices.mockResolvedValue({ USDT: dollars, USDC: dollars });
  primary.fetchKlineData.mockResolvedValue([]);
  primary.isListedSymbol.mockReturnValue(true);
  fallback.findKrakenUsdMarket.mockResolvedValue(null);
  fallback.fetchKrakenPrices.mockResolvedValue({});
  fallback.fetchKrakenKlineData.mockResolvedValue([]);
});

it('keeps Binance bulk requests and does not query Kraken for supported assets', async () => {
  primary.fetchTokenPrices.mockResolvedValueOnce({ SOL: dollars });
  expect(await fetchTokenPrices(['SOL'])).toEqual({ SOL: dollars });
  expect(primary.fetchTokenPrices).toHaveBeenCalledWith(['SOL']);
  expect(fallback.findKrakenUsdMarket).not.toHaveBeenCalled();
  expect(fallback.fetchKrakenPrices).not.toHaveBeenCalled();
});

it('batches Kraken USD markets after Binance confirms they are absent', async () => {
  primary.isListedSymbol.mockImplementation(symbol => symbol === 'SOL');
  fallback.findKrakenUsdMarket.mockImplementation(async symbol => `${symbol}USD`);
  fallback.fetchKrakenPrices.mockResolvedValue({ PYUSD: dollars, FALLBACK: dollars });
  expect(await fetchTokenPrices(['PYUSD', 'FALLBACK', 'PYUSD', 'SOL'])).toEqual({
    USDT: dollars,
    USDC: dollars,
    PYUSD: dollars,
    FALLBACK: dollars
  });
  expect(fallback.findKrakenUsdMarket).toHaveBeenCalledTimes(2);
  expect(fallback.fetchKrakenPrices).toHaveBeenCalledWith(
    new Map([
      ['PYUSD', 'PYUSDUSD'],
      ['FALLBACK', 'FALLBACKUSD']
    ])
  );
  await fetchTokenPrices(['PYUSD']);
  expect(fallback.findKrakenUsdMarket).toHaveBeenCalledTimes(2);
});

it('does not use Kraken after a transient Binance failure', async () => {
  primary.fetchTokenPrices.mockResolvedValueOnce({});
  primary.isListedSymbol.mockReturnValue(true);
  expect(await fetchTokenPrices(['PRIMARYRETRY'])).toEqual({});
  expect(fallback.findKrakenUsdMarket).not.toHaveBeenCalled();
});

it('caches an unsupported market but retries a failed Kraken lookup', async () => {
  primary.isListedSymbol.mockReturnValue(false);
  fallback.findKrakenUsdMarket.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));
  await fetchTokenPrices(['ABSENT', 'RETRY']);
  fallback.findKrakenUsdMarket.mockResolvedValueOnce('RETRYUSD');
  fallback.fetchKrakenPrices.mockResolvedValueOnce({ RETRY: dollars });
  expect((await fetchTokenPrices(['ABSENT', 'RETRY'])).RETRY).toEqual(dollars);
  expect(fallback.findKrakenUsdMarket.mock.calls.map(([symbol]) => symbol)).toEqual(['ABSENT', 'RETRY', 'RETRY']);
});

it('keeps Binance quotes when Kraken fails', async () => {
  primary.isListedSymbol.mockReturnValue(false);
  fallback.findKrakenUsdMarket.mockResolvedValueOnce('FAILUREUSD');
  fallback.fetchKrakenPrices.mockRejectedValueOnce(new Error('offline'));
  expect(await fetchTokenPrices(['FAILURE'])).toEqual({ USDT: dollars, USDC: dollars });
});

it('ignores invalid price symbols', async () => {
  primary.isListedSymbol.mockReturnValue(false);
  await fetchTokenPrices(['', 'constructor', 'BAD/PAIR']);
  expect(fallback.findKrakenUsdMarket).not.toHaveBeenCalled();
});

it('uses Kraken direct USD history when Binance has no market', async () => {
  primary.isListedSymbol.mockReturnValue(false);
  fallback.findKrakenUsdMarket.mockResolvedValueOnce('HISTORYUSD');
  fallback.fetchKrakenKlineData.mockResolvedValueOnce([{ time: 1, value: 0.9999 }]);
  expect(await fetchKlineData('HISTORY', '1D')).toEqual([{ time: 1, value: 0.9999 }]);
  expect(fallback.fetchKrakenKlineData).toHaveBeenCalledWith('HISTORYUSD', '1D');
});

it('keeps Binance history and does not mask a failed Binance history request with another provider', async () => {
  primary.fetchKlineData.mockResolvedValueOnce([{ time: 1, value: 2 }]);
  expect(await fetchKlineData('SOL', '1H')).toEqual([{ time: 1, value: 2 }]);
  expect(await fetchKlineData('SOL', '1H')).toEqual([]);
  expect(fallback.findKrakenUsdMarket).not.toHaveBeenCalled();
});

it('returns no history for an absent market or failed Kraken lookup', async () => {
  primary.isListedSymbol.mockReturnValue(false);
  expect(await fetchKlineData('NOHISTORY', '1D')).toEqual([]);
  fallback.findKrakenUsdMarket.mockRejectedValueOnce(new Error('rate limit'));
  expect(await fetchKlineData('HISTORYRETRY', '1D')).toEqual([]);
});
