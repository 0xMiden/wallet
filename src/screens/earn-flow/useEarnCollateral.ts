import { useEffect, useSyncExternalStore } from 'react';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { usePageActive } from 'app/layouts/page-active';
import { selectEarnCollateral } from 'lib/epoch/earn-collateral';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetMetadata, getNativeAssetMetadataSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';
import { getE2eOverrides, subscribeE2eOverrides } from 'lib/remote-config/e2e-overrides';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

/** No guessed scale or legacy collateral while native discovery is in flight. */
export function useEarnCollateral() {
  const snapshot = useBridgeConfigSnapshot();
  const active = usePageActive();
  const nativeId = useNativeFeeFaucetId();
  const rpc = getEffectiveRpcUrl();
  const overrides = useSyncExternalStore(subscribeE2eOverrides, getE2eOverrides);
  // The module emits whenever it adopts metadata, so the consumer re-renders only when the metadata changes.
  const metadata = useSyncExternalStore(onNativeAssetChanged, getNativeAssetMetadataSync);
  useEffect(() => {
    if (!active || snapshot.network !== 'testnet' || !nativeId || overrides.earnCollateralFaucet || metadata) return;
    // Asked again only while missing: a failed read adopts nothing, so nothing would emit.
    const load = () => void getNativeAssetMetadata().catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [active, snapshot.network, nativeId, rpc, overrides.earnCollateralFaucet, metadata]);
  return selectEarnCollateral(snapshot);
}
