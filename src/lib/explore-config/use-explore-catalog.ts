import { useEffect, useSyncExternalStore } from 'react';

import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { getExploreCatalogSnapshot, initExploreConfig, subscribeExploreCatalog } from './runtime';
import type { ExploreCatalog } from './schema';

/**
 * The effective network's Explore catalog, re-rendering when a newer copy lands. The network is read on every render,
 * so a Developer Settings switch shows that network's catalog and loads its copy.
 */
export function useExploreCatalog(): ExploreCatalog | null {
  const network = getEffectiveNetworkName();
  const catalog = useSyncExternalStore(subscribeExploreCatalog, getExploreCatalogSnapshot);
  // Never rejects.
  useEffect(() => void initExploreConfig(network), [network]);
  return catalog;
}
