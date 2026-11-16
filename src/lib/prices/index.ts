import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { useMidenContext } from 'lib/miden/front';
import { getPriceAssets } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getBridgeConfigSnapshot, subscribeBridgeConfig } from 'lib/remote-config/runtime';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import {
  loadTokenPriceAssets,
  peekTokenBaskets,
  peekTokenDecimals,
  peekTokenPriceAssets
} from 'lib/token-list/runtime';
import { useLoadedList } from 'lib/token-list/useLoadedList';

import { basketPriceSources, fetchBasketPrices } from './basket-nav';
import type { Timeframe } from './binance';
import { fetchKlineData, fetchTokenPrices, hasNoUsdMarket } from './feed';
import { writeUsdPriceCache } from './usd';

export { listedFiatValue, listedPrice, pricesLoaded, quotedPrice } from './binance';
export { fetchKlineData } from './feed';
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

function entries<T>(map: Map<string, T> | null | undefined): [string, T][] | null | undefined {
  return map ? Array.from(map) : map;
}

/**
 * Everything the price fetch reads from the loaded list (price assets, baskets and decimals), as one string, or
 * undefined before the first load. A refresh that changes any of them changes this key, so the fetch runs again.
 */
function peekPriceListKey(network: string): string | undefined {
  const assets = peekTokenPriceAssets(network);
  if (assets === undefined) return undefined;
  return JSON.stringify([entries(assets), entries(peekTokenBaskets(network)), entries(peekTokenDecimals(network))]);
}

async function loadPriceListKey(network: string): Promise<string | undefined> {
  await loadTokenPriceAssets(network);
  return peekPriceListKey(network);
}

const sameKey = (a: string | undefined, b: string | undefined): boolean => a === b;

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
  const listKey = useLoadedList(network, enabled ? loadPriceListKey : null, peekPriceListKey, sameKey) ?? '';
  const assets = getPriceAssets();
  const symbols = [...new Set(assets.values())].filter(symbol => symbol !== 'USDCX').sort();
  const assetKey = JSON.stringify(Array.from(assets).sort(([a], [b]) => a.localeCompare(b)));
  const {
    data: prices,
    error: priceError,
    isLoading: pricesLoading
  } = useRetryableSWR(
    enabled ? ['token-prices', network, assetKey, listKey] : null,
    async () => {
      const prices = await fetchTokenPrices(symbols);
      // After the feed, which is what rules a market out and prices the constituents: a basket's value never stands
      // in for an exchange's price.
      const sources = basketPriceSources(peekTokenBaskets(network), assets, peekTokenDecimals(network), hasNoUsdMarket);
      const basketPrices = sources.length > 0 ? await fetchBasketPrices(sources, prices) : {};
      return { network, assetKey, listKey, prices, basketPrices };
    },
    { refreshInterval: 5 * 60_000, dedupingInterval: 30_000, keepPreviousData: false }
  );

  useEffect(() => {
    useWalletStore.setState({ tokenPricesStatus: pricesLoading ? 'loading' : priceError ? 'error' : 'ready' });
  }, [pricesLoading, priceError]);

  // A list change that only moves a basket or its decimals clears its old value too, not only a price asset change.
  useEffect(() => {
    setTokenPrices({});
  }, [network, assetKey, listKey, setTokenPrices]);

  useEffect(() => {
    if (enabled && prices?.network === network && prices.assetKey === assetKey && prices.listKey === listKey) {
      setTokenPrices({ ...prices.basketPrices, ...prices.prices });
      // The enforcement path runs in the backend realm and cannot see this store. Writing through
      // is what keeps the cache warm enough that the backend rarely fetches on the send path.
      // Exchange quotes only: a basket's value is for display and never values a spend.
      writeUsdPriceCache(prices.prices).catch(() => undefined);
    }
  }, [enabled, network, assetKey, listKey, prices, setTokenPrices]);

  return null;
}
