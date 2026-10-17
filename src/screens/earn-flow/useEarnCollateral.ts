import { useEffect, useState, useSyncExternalStore } from 'react';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { usePageActive } from 'app/layouts/page-active';
import { selectEarnCollateral } from 'lib/epoch/earn-collateral';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetMetadata, getNativeAssetMetadataSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';
import { getE2eOverrides, type MidenUsdc, subscribeE2eOverrides } from 'lib/remote-config/e2e-overrides';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

/** The collateral new Earn deposits spend, or, until there is one, whether it is still being read or cannot be had. */
export type EarnCollateralState =
  | { state: 'resolved'; collateral: MidenUsdc }
  | { state: 'loading' | 'unavailable'; collateral: null };

/** No guessed scale or legacy collateral while native discovery is in flight. */
export function useEarnCollateralState(): EarnCollateralState {
  const snapshot = useBridgeConfigSnapshot();
  const active = usePageActive();
  const nativeId = useNativeFeeFaucetId();
  const rpc = getEffectiveRpcUrl();
  const overrides = useSyncExternalStore(subscribeE2eOverrides, getE2eOverrides);
  // The module emits whenever it adopts metadata, so the consumer re-renders only when the metadata changes.
  const metadata = useSyncExternalStore(onNativeAssetChanged, getNativeAssetMetadataSync);
  // A failed read counts only for the endpoint and asset it was made against.
  const scope = `${rpc} ${nativeId}`;
  const [failedScope, setFailedScope] = useState<string | null>(null);
  useEffect(() => {
    if (!active || snapshot.network !== 'testnet' || !nativeId || overrides.earnCollateralFaucet || metadata) return;
    let live = true;
    const failed = () => {
      if (live) setFailedScope(scope);
    };
    // Asked again only while missing: a failed read adopts nothing, so nothing would emit.
    const load = () =>
      void getNativeAssetMetadata().then(read => {
        if (!read) failed();
      }, failed);
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, snapshot.network, nativeId, rpc, overrides.earnCollateralFaucet, metadata, scope]);
  const collateral = selectEarnCollateral(snapshot);
  if (collateral) return { state: 'resolved', collateral };
  if (snapshot.network !== 'testnet') {
    const deriving = snapshot.status === 'loading' || (!!snapshot.config && !snapshot.derived);
    return { state: deriving ? 'loading' : 'unavailable', collateral: null };
  }
  // Metadata that is not USDCx at a known scale will not become it on a retry; a retry after a failure keeps saying so.
  const settled = !!nativeId && (!!metadata || failedScope === scope);
  return { state: settled ? 'unavailable' : 'loading', collateral: null };
}
