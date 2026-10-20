import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { useMidenContext } from 'lib/miden/front';
import { getPriceAssets } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getBridgeConfigSnapshot, subscribeBridgeConfig } from 'lib/remote-config/runtime';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { loadTokenPriceAssets, peekTokenPriceAssets } from 'lib/token-list/runtime';
import { useLoadedList } from 'lib/token-list/useLoadedList';

import { fetchKlineData, fetchTokenPrices, Timeframe } from './binance';
import { writeUsdPriceCache } from './usd';

export { fetchKlineData, listedFiatValue, listedPrice, pricesLoaded, quotedPrice } from './binance';
export type { KlinePoint, Timeframe, TokenPriceInfo, TokenPrices } from './binance';

/**
 * useTokenSparkline — close prices over the given timeframe for a single symbol.
 * Backed by SWR, deduped across rows showing the same symbol. Returns an empty
 * array while loading or when the symbol is unknown to Binance.
 */
export function useTokenSparkline(symbol: string | undefined, timeframe: Timeframe = '1D'): number[] {
  const { data } = useRetryableSWR(
    symbol ? ['kline', symbol, timeframe] : null,
    () => (symbol ? fetchKlineData(symbol, timeframe) : Promise.resolve([])),
    { refreshInterval: 5 * 60_000, dedupingInterval: 60_000 }
  );

  return useMemo(() => (data ?? []).map(p => p.value), [data]);
}

const sameAssets = (a: Map<string, string> | null, b: Map<string, string> | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.size === b.size && Array.from(a).every(([id, asset]) => b.get(id) === asset));

/**
 * PriceProvider - Fetches token prices from Binance and syncs to Zustand store.
 * Mount it once, outside the wallet-ready gate: prices are public, so the fetch can start before unlock. It reads
 * nothing until a wallet exists, so onboarding makes no price request.
 */
export function PriceProvider() {
  const setTokenPrices = useWalletStore(s => s.setTokenPrices);
  const { locked, ready } = useMidenContext();

  const network = getEffectiveNetworkName();
  const enabled = locked || ready;
  useSyncExternalStore(subscribeBridgeConfig, getBridgeConfigSnapshot);
  useLoadedList(network, enabled ? loadTokenPriceAssets : null, peekTokenPriceAssets, sameAssets);
  const assets = getPriceAssets();
  const symbols = [...new Set(assets.values())].filter(symbol => symbol !== 'USDCX').sort();
  const assetKey = JSON.stringify(Array.from(assets).sort(([a], [b]) => a.localeCompare(b)));
  const { data: prices } = useRetryableSWR(
    enabled ? ['token-prices', network, assetKey] : null,
    async () => ({ network, assetKey, prices: await fetchTokenPrices(symbols) }),
    { refreshInterval: 5 * 60_000, dedupingInterval: 30_000, keepPreviousData: false }
  );

  useEffect(() => {
    setTokenPrices({});
  }, [network, assetKey, setTokenPrices]);

  useEffect(() => {
    if (enabled && prices?.network === network && prices.assetKey === assetKey) {
      setTokenPrices(prices.prices);
      // The enforcement path runs in the backend realm and cannot see this store. Writing through
      // is what keeps the cache warm enough that the backend rarely fetches on the send path.
      writeUsdPriceCache(prices.prices).catch(() => undefined);
    }
  }, [enabled, network, assetKey, prices, setTokenPrices]);

  return null;
}
