import { useEffect, useRef } from 'react';

import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

import { fetchTokenPrices } from './binance';

export { fetchKlineData, getTokenPrice } from './binance';
export type { KlinePoint, Timeframe, TokenPriceInfo, TokenPrices } from './binance';

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
    }
  }, [prices, setTokenPrices]);

  return null;
}
