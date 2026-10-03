import { inStorageTurn, putToStorage } from 'lib/miden/front/storage';
import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';
import { fetchBoundedJson, readTimestampedEntry } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

import { type BridgeConfig, parseBridgeConfig } from './schema';

/** The highest document version each network has accepted, as `{ [network]: number }`. A wallet reset keeps it. */
export const BRIDGE_CONFIG_FLOOR_KEY = 'bridge_config_floor_v1';
const PUBLISHED_BASE_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BYTES = 32 * 1_024;

export interface StoredBridgeConfig {
  config: BridgeConfig;
  fetchedAt: number;
}

interface Dependencies {
  read: (keys: string[]) => Promise<Record<string, unknown>>;
  write: (key: string, value: unknown) => Promise<void>;
  fetch: typeof fetch;
  now: () => number;
}

const defaults = (): Dependencies => ({
  read: keys => getStorageProvider().get(keys),
  write: putToStorage,
  fetch: (...args) => fetch(...args),
  now: Date.now
});
let deps = defaults();

/** Test-only: swap the storage, fetch and clock; with no argument, restore the defaults. */
export function _setBridgeConfigSourceDepsForTest(
  overrides: { storage?: StorageProvider; fetch?: typeof fetch; now?: () => number } = {}
): void {
  const base = defaults();
  const { storage } = overrides;
  deps = {
    read: storage ? keys => storage.get(keys) : base.read,
    write: storage ? (key, value) => storage.set({ [key]: value }) : base.write,
    fetch: overrides.fetch ?? base.fetch,
    now: overrides.now ?? base.now
  };
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

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

// An entry that is not a positive safe integer reads as no floor for that network.
function readFloors(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => isPositiveSafeInteger(entry[1]))
  );
}

/** The accepted document stored for `network`, validated again, or null when there is none or it no longer validates. */
export async function readStoredBridgeConfig(network: string): Promise<StoredBridgeConfig | null> {
  let stored: Record<string, unknown>;
  try {
    stored = await deps.read([bridgeConfigCacheKey(network), BRIDGE_CONFIG_FLOOR_KEY]);
  } catch (error) {
    console.warn(`[remote-config] could not read the stored config for ${network}:`, error);
    return null;
  }
  const entry = readTimestampedEntry(stored[bridgeConfigCacheKey(network)]);
  if (!entry) return null;
  const config = parseBridgeConfig(entry.body, network, parseOptions());
  if (!config) return null;
  // Only a write racing a newer acceptance could leave one below the floor; it is never served.
  const floor = readFloors(stored[BRIDGE_CONFIG_FLOOR_KEY])[network] ?? 0;
  return config.version >= floor ? { config, fetchedAt: entry.fetchedAt } : null;
}

/**
 * Fetches, validates, enforces the floor, stores. Rejects on any failure. Nothing is stored unless the document validates
 * and is at or above the floor; the floor is raised before the document is written, so a failed document write can leave
 * only a raised floor.
 */
export async function fetchAndStoreBridgeConfig(network: string): Promise<StoredBridgeConfig> {
  const body = await fetchBoundedJson(deps.fetch, bridgeConfigUrl(network), {
    maxBytes: MAX_BYTES,
    timeoutMs: REQUEST_TIMEOUT_MS
  });
  const config = parseBridgeConfig(body, network, parseOptions());
  if (!config) throw new Error(`the ${network} bridge config does not validate`);
  // One turn across every extension surface. Without it, two realms accepting at once both read the old floor, and
  // the older document, landing last, lowers the floor and replaces the newer one.
  return inStorageTurn(BRIDGE_CONFIG_FLOOR_KEY, async () => {
    const floors = readFloors((await deps.read([BRIDGE_CONFIG_FLOOR_KEY]))[BRIDGE_CONFIG_FLOOR_KEY]);
    const floor = floors[network] ?? 0;
    if (config.version < floor) {
      throw new Error(`the ${network} bridge config version ${config.version} is below the accepted ${floor}`);
    }
    if (config.version > floor) await deps.write(BRIDGE_CONFIG_FLOOR_KEY, { ...floors, [network]: config.version });
    const fetchedAt = deps.now();
    await deps.write(bridgeConfigCacheKey(network), { fetchedAt, body });
    return { config, fetchedAt };
  });
}
