import { useCallback, useEffect, useState } from 'react';

import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';

import { loadVerifiedFaucetIds, onTokenListUpdated } from './runtime';

export type TokenVerification = 'verified' | 'unverified' | 'unknown';

/**
 * Whether a token is on the verified list for the wallet's network. `unknown` (no mark) while the
 * list loads and on a network with no list: not knowing is not evidence against a token. The native
 * token is always verified, since it is the chain's own fee faucet.
 */
export function useTokenVerification(): (faucetId: string) => TokenVerification {
  const network = getEffectiveNetworkName();
  const [verified, setVerified] = useState<{ network: string; ids: Set<string> | null } | null>(null);
  // Only re-renders on a discovery: the callback reads the cache itself, which a storage hydrate
  // fills without an event.
  const [, setDiscoveredNativeId] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const load = () =>
      loadVerifiedFaucetIds(network).then(ids => {
        if (current) setVerified({ network, ids });
      });
    void load();
    const unsubscribe = onTokenListUpdated(updated => {
      if (updated === network) void load();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [network]);

  useEffect(() => onNativeAssetChanged(setDiscoveredNativeId), []);

  return useCallback(
    (faucetId: string) => {
      // A list loaded for another network says nothing about this one.
      const ids = verified?.network === network ? verified.ids : null;
      if (!ids) return 'unknown';
      const id = normalizedFaucetId(faucetId);
      const nativeId = getNativeAssetIdSync();
      if (nativeId && id === normalizedFaucetId(nativeId)) return 'verified';
      return ids.has(id) ? 'verified' : 'unverified';
    },
    [verified, network]
  );
}
