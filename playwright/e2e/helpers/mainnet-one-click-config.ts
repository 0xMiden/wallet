import { createMidenAssetMetadataResolver } from '../../../src/lib/one-click/client';
import { fetchNearIntentsCatalog } from '../../../src/lib/one-click/catalog';
import type { NearIntentsCatalog, NearIntentsConfig, OneClickAsset } from '../../../src/lib/one-click/types';
import { parseBridgeConfig } from '../../../src/lib/remote-config/schema';

import { getEnvironmentConfig } from '../config/environments';
import { createMainnetOneClickOriginFetcher } from './mainnet-one-click-origin';
import { readMainnetFaucetMetadata } from './mainnet-miden-read';

export const MAINNET_WALLET_CONFIG_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main/mainnet.json';

export function mainnetConfigSource(): string {
  const override = process.env.MIDEN_REMOTE_CONFIG_URL;
  if (!override) return MAINNET_WALLET_CONFIG_URL;
  const url = new URL(override);
  if (
    process.env.E2E_NETWORK !== 'mainnet' ||
    override.length > 512 ||
    override.trim() !== override ||
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('The mainnet qualification config must be an owned loopback E2E source');
  return `${override.replace(/\/+$/, '')}/mainnet.json`;
}

/** The EVM chains the nightly can fund, by 1Click blockchain name. The catalog carries no chain id. */
export const MAINNET_ONE_CLICK_EVM_CHAIN_IDS: Readonly<Record<string, number>> = { eth: 1, arb: 42161 };

export interface MainnetOneClickSetup {
  config: NearIntentsConfig;
  catalog: NearIntentsCatalog;
  assets: OneClickAsset[];
}

export function mainnetOneClickConfig(document: unknown): NearIntentsConfig | undefined {
  const parsed = parseBridgeConfig(document, 'mainnet');
  return parsed?.features.nearIntents === true ? parsed.nearIntents : undefined;
}

// The catalog's origin and Miden assets as one list: each origin asset gets its chain id, and a Miden asset that
// several origin tokens deliver is listed once.
function flattenCatalog(catalog: NearIntentsCatalog): OneClickAsset[] {
  const assets = new Map<string, OneClickAsset>();
  for (const chain of catalog.chains) {
    const chainId = MAINNET_ONE_CLICK_EVM_CHAIN_IDS[chain.id];
    for (const token of chain.tokens) {
      assets.set(token.asset.assetId, chainId === undefined ? token.asset : { ...token.asset, chainId });
      for (const output of token.outputs) assets.set(output.assetId, output);
    }
  }
  return [...assets.values()];
}

export async function loadMainnetOneClickSetup(
  fetcher: typeof fetch = fetch,
  providerFetcher: typeof fetch = fetch,
  extensionId?: string
): Promise<MainnetOneClickSetup | undefined> {
  const response = await fetcher(mainnetConfigSource(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Mainnet wallet config request failed (${response.status})`);
  const document: unknown = await response.json();
  const config = mainnetOneClickConfig(document);
  if (!config || config.midenAssets.length === 0) return undefined;
  const rpcUrl = getEnvironmentConfig().rpcUrl;
  const resolver = createMidenAssetMetadataResolver(faucetId => readMainnetFaucetMetadata(faucetId, rpcUrl));
  const scopedFetcher = extensionId
    ? createMainnetOneClickOriginFetcher(config.serviceUrl, extensionId, providerFetcher)
    : providerFetcher;
  const catalog = await fetchNearIntentsCatalog(config, resolver, scopedFetcher);
  const assets = flattenCatalog(catalog);
  if (!assets.some(asset => asset.blockchain === 'miden')) return undefined;
  return { config, catalog, assets };
}
