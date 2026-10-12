import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { loadTokenLogos, peekTokenLogos } from './runtime';
import { useLoadedList } from './useLoadedList';

const sameLogos = (a: Map<string, string> | null, b: Map<string, string> | null): boolean =>
  a === b || (a !== null && b !== null && a.size === b.size && Array.from(a).every(([id, uri]) => b.get(id) === uri));

/**
 * The logo the verified list gives `faucetId` on the wallet's network, or `undefined` while the list
 * loads, on a network with no list, and for an id the list does not name. Its own module, because
 * component suites mock `useTokenVerification`'s module whole.
 */
export function useTokenLogoUri(faucetId?: string): string | undefined {
  const network = getEffectiveNetworkName();
  const logos = useLoadedList(network, faucetId === undefined ? null : loadTokenLogos, peekTokenLogos, sameLogos);
  if (!logos || faucetId === undefined) return undefined;
  const id = normalizedFaucetId(faucetId);
  for (const [listed, uri] of logos) if (normalizedFaucetId(listed) === id) return uri;
  return undefined;
}
