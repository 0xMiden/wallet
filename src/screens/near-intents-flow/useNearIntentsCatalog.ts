import { useEffect, useState } from 'react';

import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { fetchNearIntentsCatalog } from 'lib/one-click/catalog';
import { createMidenAssetMetadataResolver } from 'lib/one-click/client';
import type { NearIntentsCatalog, NearIntentsConfig } from 'lib/one-click/types';
import { readMidenFaucetMetadata } from 'lib/remote-config/derive';

import { catalogHasRoute } from './chains';

export type NearIntentsCatalogState =
  | { status: 'loading' }
  | { status: 'ready'; catalog: NearIntentsCatalog }
  | { status: 'unavailable' };

/**
 * One load for each config object. The Receive tab can mount and unmount many times; the catalog
 * reads the 1Click token list and the Miden faucets, so it must not read them again each time.
 * A failed load is removed, so that the next mount tries again.
 */
const loads = new WeakMap<NearIntentsConfig, Promise<NearIntentsCatalog>>();

function loadCatalog(config: NearIntentsConfig): Promise<NearIntentsCatalog> {
  const cached = loads.get(config);
  if (cached) return cached;
  const rpcUrl = getEffectiveRpcUrl();
  const resolver = createMidenAssetMetadataResolver(faucetId => readMidenFaucetMetadata(faucetId, rpcUrl));
  const load = fetchNearIntentsCatalog(config, resolver);
  loads.set(config, load);
  load.catch(() => {
    if (loads.get(config) === load) loads.delete(config);
  });
  return load;
}

/** The NEAR Intents catalog for `config`. A catalog with no complete route is `unavailable`. */
export function useNearIntentsCatalog(config: NearIntentsConfig): NearIntentsCatalogState {
  const [state, setState] = useState<NearIntentsCatalogState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    loadCatalog(config).then(
      catalog => {
        if (active) setState(catalogHasRoute(catalog) ? { status: 'ready', catalog } : { status: 'unavailable' });
      },
      () => {
        if (active) setState({ status: 'unavailable' });
      }
    );
    return () => {
      active = false;
    };
  }, [config]);

  return state;
}
