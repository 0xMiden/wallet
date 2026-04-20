import { DEFAULT_NETWORK, NETWORK_STORAGE_ID } from 'lib/miden-chain/constants';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { WalletNetwork } from 'lib/shared/types';

import { NETWORKS } from '../networks';

export async function getCurrentMidenNetwork() {
  const storage = getStorageProvider();
  const items = await storage.get([NETWORK_STORAGE_ID, 'custom_networks_snapshot']);
  const networkId = items[NETWORK_STORAGE_ID] as string | undefined;
  const customNetworksSnapshot = items['custom_networks_snapshot'] as WalletNetwork[] | undefined;

  const allNetworks = [...NETWORKS, ...(customNetworksSnapshot ?? [])];
  return allNetworks.find(n => n.id === networkId) ?? allNetworks.find(n => n.id === DEFAULT_NETWORK) ?? NETWORKS[0];
}
