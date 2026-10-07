import type { StorageProvider } from 'lib/platform/storage-adapter';
import { versionedDocumentSource } from 'lib/versioned-document';

import { EXPLORE_CONFIG_FLOOR_KEY } from './floor-key';
import { type ExploreCatalog, parseExploreConfig } from './schema';
import { BUNDLED_EXPLORE_ICONS, bundledExploreConfig } from './snapshot';

export const PUBLISHED_EXPLORE_BASE_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-explore/main';

export interface StoredExploreConfig {
  catalog: ExploreCatalog;
  fetchedAt: number;
}

/** `explore_config_v1:<network>`, holding `{ fetchedAt, body }` with the body as fetched. */
export function exploreConfigCacheKey(network: string): string {
  return `explore_config_v1:${network}`;
}

// Vite folds both reads to literals, and a production build's MIDEN_E2E_TEST is 'false', so a leaked
// MIDEN_EXPLORE_CONFIG_URL can never point a shipped wallet at another catalog.
function e2eBaseUrl(): string | null {
  if (process.env.MIDEN_E2E_TEST !== 'true') return null;
  const base = process.env.MIDEN_EXPLORE_CONFIG_URL;
  return base ? base.replace(/\/+$/, '') : null;
}

/** Where this build reads the catalogs, and so their icons, from. */
export function exploreConfigBaseUrl(): string {
  return e2eBaseUrl() ?? PUBLISHED_EXPLORE_BASE_URL;
}

export function exploreConfigUrl(network: string): string {
  return `${exploreConfigBaseUrl()}/${network}.json`;
}

const source = versionedDocumentSource<ExploreCatalog>({
  label: 'Explore catalog',
  logTag: 'explore-config',
  floorKey: EXPLORE_CONFIG_FLOOR_KEY,
  cacheKey: exploreConfigCacheKey,
  url: exploreConfigUrl,
  maxBytes: 32 * 1_024,
  timeoutMs: 10_000,
  // Local http only in a catalog an E2E build serves itself, whose icons resolve against that same base.
  parse: (body, network) =>
    parseExploreConfig(body, network, { allowLocalHttp: e2eBaseUrl() !== null, baseUrl: exploreConfigBaseUrl() })
});

/** Test-only: swap the storage, fetch and clock; with no argument, restore the defaults. */
export function _setExploreConfigSourceDepsForTest(
  overrides: { storage?: StorageProvider; fetch?: typeof fetch; now?: () => number } = {}
): void {
  source.setDepsForTest(overrides);
}

/**
 * The catalog this build bundles for `network`, or null for a network with none. Its icons are the bundled files; one
 * the build does not ship comes from the published repo, as a fetched catalog's icons all do.
 */
export function bundledExploreCatalog(network: string): ExploreCatalog | null {
  return parseExploreConfig(bundledExploreConfig(network), network, {
    baseUrl: PUBLISHED_EXPLORE_BASE_URL,
    bundledIcons: BUNDLED_EXPLORE_ICONS
  });
}

/** The accepted catalog stored for `network`, validated again, or null when there is none or it no longer validates. */
export async function readStoredExploreConfig(network: string): Promise<StoredExploreConfig | null> {
  const stored = await source.readStored(network);
  return stored && { catalog: stored.document, fetchedAt: stored.fetchedAt };
}

/** Fetches, validates, enforces the floor, stores; rejects on any failure (see `VersionedDocumentSource`). */
export async function fetchAndStoreExploreConfig(network: string): Promise<StoredExploreConfig> {
  const { document, fetchedAt } = await source.fetchAndStore(network);
  return { catalog: document, fetchedAt };
}
