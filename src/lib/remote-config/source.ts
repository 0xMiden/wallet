import type { StorageProvider } from 'lib/platform/storage-adapter';
import { versionedDocumentSource } from 'lib/versioned-document';

import { type BridgeConfig, parseBridgeConfig } from './schema';

/** The highest document version each network has accepted, as `{ [network]: number }`. A wallet reset keeps it. */
export const BRIDGE_CONFIG_FLOOR_KEY = 'bridge_config_floor_v1';
const PUBLISHED_BASE_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';

export interface StoredBridgeConfig {
  config: BridgeConfig;
  fetchedAt: number;
}

/** `bridge_config_v1:<network>`, holding `{ fetchedAt, body }` with the body as fetched. */
export function bridgeConfigCacheKey(network: string): string {
  return `bridge_config_v1:${network}`;
}

// Vite folds both reads to literals, and a production build's MIDEN_E2E_TEST is 'false', so a leaked
// MIDEN_REMOTE_CONFIG_URL can never point a shipped wallet at another document.
function e2eBaseUrl(): string | null {
  if (process.env.MIDEN_E2E_TEST !== 'true') return null;
  const base = process.env.MIDEN_REMOTE_CONFIG_URL;
  return base ? base.replace(/\/+$/, '') : null;
}

export function bridgeConfigUrl(network: string): string {
  return `${e2eBaseUrl() ?? PUBLISHED_BASE_URL}/${network}.json`;
}

// Local http only in a document an E2E build serves itself; reading the published repo, it validates as production.
const parseOptions = () => ({ allowLocalHttp: e2eBaseUrl() !== null });

const source = versionedDocumentSource<BridgeConfig>({
  label: 'bridge config',
  logTag: 'remote-config',
  floorKey: BRIDGE_CONFIG_FLOOR_KEY,
  cacheKey: bridgeConfigCacheKey,
  url: bridgeConfigUrl,
  maxBytes: 32 * 1_024,
  timeoutMs: 10_000,
  parse: (body, network) => parseBridgeConfig(body, network, parseOptions())
});

/** Test-only: swap the storage, fetch and clock; with no argument, restore the defaults. */
export function _setBridgeConfigSourceDepsForTest(
  overrides: { storage?: StorageProvider; fetch?: typeof fetch; now?: () => number } = {}
): void {
  source.setDepsForTest(overrides);
}

/** The accepted document stored for `network`, validated again, or null when there is none or it no longer validates. */
export async function readStoredBridgeConfig(network: string): Promise<StoredBridgeConfig | null> {
  const stored = await source.readStored(network);
  return stored && { config: stored.document, fetchedAt: stored.fetchedAt };
}

/** Fetches, validates, enforces the floor, stores; rejects on any failure (see `VersionedDocumentSource`). */
export async function fetchAndStoreBridgeConfig(network: string): Promise<StoredBridgeConfig> {
  const { document, fetchedAt } = await source.fetchAndStore(network);
  return { config: document, fetchedAt };
}
