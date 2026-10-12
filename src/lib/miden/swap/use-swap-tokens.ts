import { useEffect, useState } from 'react';

import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

import { getDefaultSwapPair, getSwapTokens, type SwapToken } from './tokens';

/**
 * The swap registry for a component: `getSwapTokens()`, re-read when the bridge config lands or
 * changes, and once more when the SDK's WASM is ready, since that is when a listed faucet's hex id
 * takes its bech32 form. A new array on every render: key an effect on a token's `faucetId`, never
 * on the list.
 */
export function useSwapTokens(): SwapToken[] {
  useBridgeConfigSnapshot({ load: false });
  const [, setSdkReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    ensureSdkWasmReady().then(
      () => {
        if (mounted) setSdkReady(true);
      },
      () => undefined
    );
    return () => {
      mounted = false;
    };
  }, []);
  return getSwapTokens();
}

/**
 * Whether the swap screen can open: available once the registry has a default pair (two listed
 * tokens), loading while the document has not been read, else unavailable as not configured. The
 * `detail` names the cause for the log; users see the swap screen's own copy.
 */
export function swapAvailability(snapshot: BridgeConfigSnapshot): FeatureAvailability {
  if (getDefaultSwapPair() !== null) return { state: 'available' };
  if (snapshot.status === 'loading') return { state: 'loading' };
  return { state: 'unavailable', reason: 'not-configured', detail: 'swap.tokens names fewer than two tokens' };
}
