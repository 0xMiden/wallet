import { useEffect, useState, useSyncExternalStore } from 'react';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { usePageActive } from 'app/layouts/page-active';
import { selectEarnCollateral } from 'lib/epoch/earn-collateral';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetMetadata } from 'lib/miden-chain/native-asset';
import { getE2eOverrides, subscribeE2eOverrides } from 'lib/remote-config/e2e-overrides';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

/** No guessed scale or legacy collateral while native discovery is in flight. */
export function useEarnCollateral() {
  const snapshot = useBridgeConfigSnapshot();
  const active = usePageActive();
  const nativeId = useNativeFeeFaucetId();
  const rpc = getEffectiveRpcUrl();
  const overrides = useSyncExternalStore(subscribeE2eOverrides, getE2eOverrides);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!active || snapshot.network !== 'testnet' || !nativeId || overrides.earnCollateralFaucet) return;
    let cancelled = false;
    const load = () => {
      void getNativeAssetMetadata().then(
        () => {
          if (!cancelled) refresh(value => value + 1);
        },
        () => {}
      );
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, snapshot.network, nativeId, rpc, overrides.earnCollateralFaucet]);
  return selectEarnCollateral(snapshot);
}
