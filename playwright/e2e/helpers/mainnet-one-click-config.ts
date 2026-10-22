import { createMidenAssetMetadataResolver, fetchOneClickAssets } from '../../../src/lib/one-click/client';
import type { OneClickAsset, OneClickConfig } from '../../../src/lib/one-click/types';
import { readMidenFaucetMetadata } from '../../../src/lib/remote-config/derive';
import { parseBridgeConfig } from '../../../src/lib/remote-config/schema';

import { getEnvironmentConfig } from '../config/environments';
import { createMainnetOneClickOriginFetcher } from './mainnet-one-click-origin';

export const MAINNET_WALLET_CONFIG_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main/mainnet.json';

export interface MainnetOneClickSetup {
  config: OneClickConfig;
  assets: OneClickAsset[];
}

export function mainnetOneClickConfig(document: unknown): OneClickConfig | undefined {
  const parsed = parseBridgeConfig(document, 'mainnet');
  return parsed?.features.nearIntents === true ? parsed.swap?.oneClick : undefined;
}

export async function loadMainnetOneClickSetup(
  fetcher: typeof fetch = fetch,
  providerFetcher: typeof fetch = fetch,
  extensionId?: string
): Promise<MainnetOneClickSetup | undefined> {
  const response = await fetcher(MAINNET_WALLET_CONFIG_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Mainnet wallet config request failed (${response.status})`);
  const document: unknown = await response.json();
  const config = mainnetOneClickConfig(document);
  if (!config || config.midenAssets.length === 0) return undefined;
  const rpcUrl = getEnvironmentConfig().rpcUrl;
  const resolver = createMidenAssetMetadataResolver(faucetId => readMidenFaucetMetadata(faucetId, rpcUrl));
  const scopedFetcher = extensionId
    ? createMainnetOneClickOriginFetcher(config.serviceUrl, extensionId, providerFetcher)
    : providerFetcher;
  const assets = await fetchOneClickAssets(config, resolver, scopedFetcher);
  if (!assets.some(asset => asset.blockchain === 'miden')) return undefined;
  return { config, assets };
}
