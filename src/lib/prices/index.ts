import { useEffect, useMemo, useRef } from 'react';

import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

import { fetchKlineData, fetchTokenPrices, Timeframe } from './binance';
import { writeUsdPriceCache } from './usd';

export { fetchKlineData, getTokenPrice, listedFiat, listedPrice } from './binance';
export type { KlinePoint, Timeframe, TokenPriceInfo, TokenPrices } from './binance';

/**
 * useTokenSparkline — close prices over the given timeframe for a single symbol.
 * Backed by SWR, deduped across rows showing the same symbol. Returns an empty
 * array while loading or when the symbol is unknown to Binance.
 */
export function useTokenSparkline(symbol: string, timeframe: Timeframe = '1D'): number[] {
  const { data } = useRetryableSWR(
    symbol ? ['kline', symbol, timeframe] : null,
    () => fetchKlineData(symbol, timeframe),
    { refreshInterval: 5 * 60_000, dedupingInterval: 60_000 }
  );

  return useMemo(() => (data ?? []).map(p => p.value), [data]);
}

/**
 * PriceProvider - Fetches token prices from Binance and syncs to Zustand store.
 * Mount alongside FiatCurrencyProvider in the app tree.
 */
export function PriceProvider() {
  const setTokenPrices = useWalletStore(s => s.setTokenPrices);
  const syncDone = useRef(false);

  const { data: prices } = useRetryableSWR('token-prices', fetchTokenPrices, {
    refreshInterval: 5 * 60_000,
    dedupingInterval: 30_000
  });

  useEffect(() => {
    if (prices && Object.keys(prices).length > 0) {
      syncDone.current = true;
      setTokenPrices(prices);
      // The enforcement path runs in the backend realm and cannot see this store. Writing through
      // is what keeps the cache warm enough that the backend rarely fetches on the send path.
      void writeUsdPriceCache(prices);
    }
  }, [prices, setTokenPrices]);

  return null;
}
