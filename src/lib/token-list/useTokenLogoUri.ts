import { useEffect, useState } from 'react';

import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { loadTokenLogos, onTokenListUpdated } from './runtime';

type LoadedLogos = { network: string; logos: Map<string, string> | null };

/**
 * The logo the verified list gives `faucetId` on the wallet's network, or `undefined` while the list
 * loads, on a network with no list, and for an id the list does not name. Its own module, because
 * component suites mock `useTokenVerification`'s module whole.
 */
export function useTokenLogoUri(faucetId?: string): string | undefined {
  const network = getEffectiveNetworkName();
  const [loaded, setLoaded] = useState<LoadedLogos | null>(null);
  const wanted = faucetId !== undefined;

  useEffect(() => {
    if (!wanted) return undefined;
    let current = true;
    const load = () =>
      loadTokenLogos(network).then(logos => {
        if (current) setLoaded({ network, logos });
      });
    void load();
    const unsubscribe = onTokenListUpdated(updated => {
      if (updated === network) void load();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [network, wanted]);

  // A list loaded for another network says nothing about this one.
  const logos = faucetId !== undefined && loaded?.network === network ? loaded.logos : null;
  if (!logos || faucetId === undefined) return undefined;
  const id = normalizedFaucetId(faucetId);
  for (const [listed, uri] of logos) if (normalizedFaucetId(listed) === id) return uri;
  return undefined;
}
