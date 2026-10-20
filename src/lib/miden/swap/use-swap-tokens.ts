import { useEffect, useState } from 'react';

import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { type FeatureAvailability, geoFeatureGate } from 'lib/remote-config/availability';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

import { getDefaultSwapPair, getSwapPartners, getSwapTokens, type SwapToken } from './tokens';

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
 * The tokens a swap side's picker lists. With `partnersOf` (the faucet on the other side), only the
 * tokens that share a solver pair with it; without, every token that has a partner, so a token the
 * solver swaps with nothing is never offered. Re-read as `useSwapTokens` is.
 */
export function useSwapPickerTokens(partnersOf?: string): SwapToken[] {
  const tokens = useSwapTokens();
  return partnersOf === undefined
    ? tokens.filter(token => getSwapPartners(token.faucetId).length > 0)
    : getSwapPartners(partnersOf);
}

/**
 * Whether the swap screen can open: available once the registry has a default pair (the solver's
 * first pair), loading while the document has not been read, service down when the read of the
 * solver's pairs failed, else unavailable as not configured. The `detail` names the cause for the
 * log; users see the swap screen's own copy.
 */
export function swapAvailability(snapshot: BridgeConfigSnapshot): FeatureAvailability {
  const gated = geoFeatureGate('swap', snapshot.config, snapshot.geo);
  if (gated) return gated;
  if (getDefaultSwapPair() !== null) return { state: 'available' };
  if (snapshot.status === 'loading') return { state: 'loading' };
  const pairs = snapshot.derived?.swap?.pairs;
  if (pairs?.state === 'error') {
    return { state: 'unavailable', reason: 'service-down', detail: `swap pairs: ${pairs.message}` };
  }
  return { state: 'unavailable', reason: 'not-configured', detail: 'the swap solver lists no pair' };
}
