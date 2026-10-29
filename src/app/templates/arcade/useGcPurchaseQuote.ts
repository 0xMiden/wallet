import useSWR from 'swr';

import { usePageActive } from 'app/layouts/page-active';
import {
  DEFAULT_GC_PURCHASE_AMOUNT,
  findGcSales,
  getGcSaleConfig,
  pickGcSale,
  type GcSale
} from 'lib/miden/arcade/gc-sale';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import type { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

import type { GcPurchaseEntryState } from '../ArcadeCoinsCard';

// The live note changes with every buy, so the sale is re-read often enough that a tap rarely meets a spent note.
const SALE_REFRESH_MS = 30_000;

/**
 * The live GC sale of `network`: read on RPC clients of its own, no WASM lock, only while the page is on screen.
 * `state` is what the Buy more GC entry shows; a network with no sale never reads at all. The sale's seller comes
 * from the accepted config document (`getGcSaleConfig`), so the read is keyed on it and follows a document change.
 */
export function useGcPurchaseQuote(
  network: MIDEN_NETWORK_NAME,
  buyer: string
): {
  sales: GcSale[];
  sale: GcSale | null;
  state: GcPurchaseEntryState;
  refresh: () => Promise<GcSale | null | undefined>;
} {
  const pageActive = usePageActive();
  // Subscribed for its changes only: the config module's snapshot is what `getGcSaleConfig` reads.
  useBridgeConfigSnapshot({ load: false });
  const seller = getGcSaleConfig(network)?.sellerAccountId;
  const payFaucetId = getNativeAssetIdSync();
  const configured = seller !== undefined && payFaucetId !== null;
  const { data, error, isLoading, mutate } = useSWR(
    configured && pageActive ? ['arcade-gc-sale', network, seller, payFaucetId, buyer] : null,
    () => findGcSales(network),
    { refreshInterval: SALE_REFRESH_MS, dedupingInterval: 5_000, revalidateOnFocus: false }
  );
  const sales = (data ?? []).filter(candidate => !sameWalletAccountId(candidate.sellerAccountId, buyer));
  const sale = pickGcSale(sales, DEFAULT_GC_PURCHASE_AMOUNT, buyer) ?? sales[0] ?? null;
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
  return {
    sale,
    sales,
    state,
    refresh: async () => pickGcSale((await mutate()) ?? [], DEFAULT_GC_PURCHASE_AMOUNT, buyer)
  };
}
