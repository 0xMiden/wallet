import { useEffect, useState } from 'react';

import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';

import { loadVerifiedFaucetIds, onTokenListUpdated } from './runtime';

export type TokenVerification = 'verified' | 'unverified' | 'unknown';

type VerifiedList = { network: string; ids: Set<string> | null };

const sameIds = (a: Set<string> | null, b: Set<string> | null): boolean =>
  a === b || (a !== null && b !== null && a.size === b.size && Array.from(a).every(id => b.has(id)));

/**
 * Whether `faucetId` is on the verified list for the wallet's network. `unknown` (no mark) while the
 * list loads and on a network with no list: not knowing is not evidence against a token. The native
 * token is always verified, since it is the chain's own fee faucet.
 */
export function useTokenVerification(faucetId: string): TokenVerification {
  const network = getEffectiveNetworkName();
  const [verified, setVerified] = useState<VerifiedList | null>(null);
  // Only re-renders on a discovery: the verdict reads the cache itself, which a storage hydrate
  // fills without an event.
  const [, setDiscoveredNativeId] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    // What this effect last stored: an unchanged reload stores nothing, so it re-renders no row (a
    // functional update returning the old state would still render each row once).
    let stored: Set<string> | null | undefined;
    const load = () =>
      loadVerifiedFaucetIds(network).then(ids => {
        if (!current || (stored !== undefined && sameIds(stored, ids))) return;
        stored = ids;
        setVerified({ network, ids });
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

  // A list loaded for another network says nothing about this one.
  const ids = verified?.network === network ? verified.ids : null;
  if (!ids) return 'unknown';
  const id = normalizedFaucetId(faucetId);
  const nativeId = getNativeAssetIdSync();
  if (nativeId && id === normalizedFaucetId(nativeId)) return 'verified';
  // The list holds ids as published; both sides take the encoding of the network this render reads.
  return Array.from(ids).some(listed => normalizedFaucetId(listed) === id) ? 'verified' : 'unverified';
}
