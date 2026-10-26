import useSWR from 'swr';

import { usePageActive } from 'app/layouts/page-active';
import { findLiveGcSale, getGcSaleConfig, type GcSale } from 'lib/miden/arcade/gc-sale';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import type { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import type { GcPurchaseEntryState } from '../ArcadeCoinsCard';

// The live note changes with every buy, so the sale is re-read often enough that a tap rarely meets a spent note.
const SALE_REFRESH_MS = 30_000;

/**
 * The live GC sale of `network`: read on RPC clients of its own, no WASM lock, only while the page is on screen.
 * `state` is what the Buy more GC entry shows; a network with no sale never reads at all.
 */
export function useGcPurchaseQuote(network: MIDEN_NETWORK_NAME): {
  sale: GcSale | null;
  state: GcPurchaseEntryState;
  refresh: () => Promise<GcSale | null | undefined>;
} {
  const pageActive = usePageActive();
  const payFaucetId = getNativeAssetIdSync();
  const configured = getGcSaleConfig(network) !== undefined && payFaucetId !== null;
  const { data, error, isLoading, mutate } = useSWR(
    configured && pageActive ? ['arcade-gc-sale', network, payFaucetId] : null,
    () => findLiveGcSale(network),
    { refreshInterval: SALE_REFRESH_MS, dedupingInterval: 5_000, revalidateOnFocus: false }
  );
  const sale = data ?? null;
  const state: GcPurchaseEntryState = (() => {
    switch (true) {
      case !configured:
      case error !== undefined:
        return 'unavailable';
      case isLoading && data === undefined:
        return 'checking';
      case sale !== null:
        return 'ready';
      default:
        return 'unavailable';
    }
  })();
  return { sale, state, refresh: () => mutate() };
}
