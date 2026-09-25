import { useEffect, useMemo, useRef } from 'react';

import { preload } from 'swr';

import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

import { fetchKlineData, fetchTokenPrices, Timeframe } from './binance';
import { writeUsdPriceCache } from './usd';

export { fetchKlineData, getTokenPrice, listedFiatValue, listedPrice } from './binance';
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
 * Mount it once, outside the wallet-ready gate: prices are public, so the fetch can start before unlock.
 */
const TOKEN_PRICES_KEY = 'token-prices';

/** Starts the price fetch ahead of PriceProvider, whose first read consumes the in-flight request. */
export function preloadTokenPrices() {
  preload(TOKEN_PRICES_KEY, fetchTokenPrices);
}

export function PriceProvider() {
  const setTokenPrices = useWalletStore(s => s.setTokenPrices);
  const syncDone = useRef(false);

  const { data: prices } = useRetryableSWR(TOKEN_PRICES_KEY, fetchTokenPrices, {
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
