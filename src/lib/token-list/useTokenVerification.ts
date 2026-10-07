import { useEffect, useState } from 'react';

import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';

import { loadVerifiedFaucetIds, peekVerifiedFaucetIds } from './runtime';
import { useLoadedList } from './useLoadedList';

export type TokenVerification = 'verified' | 'unverified' | 'unknown';

const sameIds = (a: Set<string> | null, b: Set<string> | null): boolean =>
  a === b || (a !== null && b !== null && a.size === b.size && Array.from(a).every(id => b.has(id)));

/**
 * Whether `faucetId` is on the verified list for the wallet's network. `unknown` (no mark) while the
 * list loads and on a network with no list: not knowing is not evidence against a token. The native
 * token is always verified, since it is the chain's own fee faucet.
 */
export function useTokenVerification(faucetId: string): TokenVerification {
  const network = getEffectiveNetworkName();
  const ids = useLoadedList(network, loadVerifiedFaucetIds, peekVerifiedFaucetIds, sameIds);
  // Only re-renders on a discovery: the verdict reads the cache itself, which a storage hydrate
  // fills without an event.
  const [, setDiscoveredNativeId] = useState<string | null>(null);

  useEffect(() => onNativeAssetChanged(setDiscoveredNativeId), []);

  if (!ids) return 'unknown';
  const id = normalizedFaucetId(faucetId);
  const nativeId = getNativeAssetIdSync();
  if (nativeId && id === normalizedFaucetId(nativeId)) return 'verified';
  // The list holds ids as published; both sides take the encoding of the network this render reads.
  return Array.from(ids).some(listed => normalizedFaucetId(listed) === id) ? 'verified' : 'unverified';
}
