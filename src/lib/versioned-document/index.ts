import isEqual from 'fast-deep-equal';

import { inStorageTurn, putToStorage } from 'lib/miden/front/storage';
import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';
import { fetchBoundedJson, readTimestampedEntry } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

// The poll timing every page runtime of a versioned document shares; each keeps its own healthy and degraded cadences.
/** On open and on a return to the foreground, a copy older than this is refreshed. */
export const FOREGROUND_STALE_MS = 900_000;
export const MAX_BACKOFF_MS = 900_000;
const FIRST_BACKOFF_MS = 60_000;

/** The wait after `failures` consecutive failed fetches: 60 s, doubling to `MAX_BACKOFF_MS`. */
export const backoffDelay = (failures: number): number =>
  Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);

/**
 * Whether a check made at `checkedAt` is `threshold` old. A stamp later than the clock is skew and says nothing about
 * age, so it counts as due.
 */
export const isCheckDue = (checkedAt: number, threshold: number, now = Date.now()): boolean =>
  now < checkedAt || now - checkedAt >= threshold;

/** The age a foreground check refreshes at: 15 minutes, or a shorter `interval`. */
export const foregroundThreshold = (interval: number): number => Math.min(interval, FOREGROUND_STALE_MS);

/**
 * A remote JSON document, one per network, that a wallet accepts only at or above the highest version it has accepted
 * for that network (its floor), so a revert or a stale CDN copy can never bring an older document back.
 */
export interface VersionedDocumentSpec<T extends { version: number }> {
  /** Names the document in errors, as in `the testnet bridge config does not validate`. */
  label: string;
  /** Prefixes the warning logged when storage cannot be read, as in `[remote-config]`. */
  logTag: string;
  /** Holds `{ [network]: version }`; a wallet reset keeps it. */
  floorKey: string;
  /** Holds `{ fetchedAt, body }`, the accepted document with its body as fetched. */
  cacheKey: (network: string) => string;
  url: (network: string) => string;
  maxBytes: number;
  timeoutMs: number;
  /** The document for `network`, or null when it does not validate. Called on every read, a stored one included. */
  parse: (body: unknown, network: string) => T | null;
}

export interface AcceptedDocument<T> {
  document: T;
  fetchedAt: number;
}

export interface VersionedDocumentSource<T> {
  /** The stored document for `network`, validated again, or null when there is none or it no longer validates. */
  readStored(network: string): Promise<AcceptedDocument<T> | null>;
  /** The highest version accepted for `network`: 0 when there is none, or when storage cannot be read. */
  readFloor(network: string): Promise<number>;
  /**
   * Fetches, validates, enforces the floor, stores. Rejects on any failure. Nothing is stored unless the document
   * validates and is at or above the floor, and at the version of the stored document is that document; the floor is
   * raised before the document is written, so a failed document write can leave only a raised floor.
   */
  fetchAndStore(network: string): Promise<AcceptedDocument<T>>;
  /** Test-only: swap the storage, fetch and clock; with no argument, restore the defaults. */
  setDepsForTest(overrides?: { storage?: StorageProvider; fetch?: typeof fetch; now?: () => number }): void;
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

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

// An entry that is not a positive safe integer reads as no floor for that network.
function readFloors(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => isPositiveSafeInteger(entry[1]))
  );
}

export function versionedDocumentSource<T extends { version: number }>(
  spec: VersionedDocumentSpec<T>
): VersionedDocumentSource<T> {
  let deps = defaults();

  return {
    setDepsForTest(overrides = {}) {
      const base = defaults();
      const { storage } = overrides;
      deps = {
        read: storage ? keys => storage.get(keys) : base.read,
        write: storage ? (key, value) => storage.set({ [key]: value }) : base.write,
        fetch: overrides.fetch ?? base.fetch,
        now: overrides.now ?? base.now
      };
    },

    async readStored(network) {
      let stored: Record<string, unknown>;
      try {
        stored = await deps.read([spec.cacheKey(network), spec.floorKey]);
      } catch (error) {
        console.warn(`[${spec.logTag}] could not read the stored config for ${network}:`, error);
        return null;
      }
      const entry = readTimestampedEntry(stored[spec.cacheKey(network)]);
      if (!entry) return null;
      const document = spec.parse(entry.body, network);
      if (!document) return null;
      // Only a write racing a newer acceptance could leave one below the floor; it is never served.
      const floor = readFloors(stored[spec.floorKey])[network] ?? 0;
      return document.version >= floor ? { document, fetchedAt: entry.fetchedAt } : null;
    },

    async readFloor(network) {
      try {
        const stored = await deps.read([spec.floorKey]);
        return readFloors(stored[spec.floorKey])[network] ?? 0;
      } catch (error) {
        console.warn(`[${spec.logTag}] could not read the floor for ${network}:`, error);
        return 0;
      }
    },

    async fetchAndStore(network) {
      const body = await fetchBoundedJson(deps.fetch, spec.url(network), {
        maxBytes: spec.maxBytes,
        timeoutMs: spec.timeoutMs
      });
      const document = spec.parse(body, network);
      if (!document) throw new Error(`the ${network} ${spec.label} does not validate`);
      // One turn across every extension surface. Without it, two realms accepting at once both read the old floor, and
      // the older document, landing last, lowers the floor and replaces the newer one.
      return inStorageTurn(spec.floorKey, async () => {
        const stored = await deps.read([spec.floorKey, spec.cacheKey(network)]);
        const floors = readFloors(stored[spec.floorKey]);
        const floor = floors[network] ?? 0;
        if (document.version < floor) {
          throw new Error(`the ${network} ${spec.label} version ${document.version} is below the accepted ${floor}`);
        }
        // One version names one document: anything derived from it is bound to it by version. With none stored (a
        // reset keeps the floor and wipes the document) the version is open again.
        const entry = readTimestampedEntry(stored[spec.cacheKey(network)]);
        const accepted = entry ? spec.parse(entry.body, network) : null;
        if (entry && accepted?.version === document.version && !isEqual(entry.body, body)) {
          throw new Error(
            `the ${network} ${spec.label} version ${document.version} differs from the accepted document`
          );
        }
        if (document.version > floor) await deps.write(spec.floorKey, { ...floors, [network]: document.version });
        const fetchedAt = deps.now();
        await deps.write(spec.cacheKey(network), { fetchedAt, body });
        return { document, fetchedAt };
      });
    }
  };
}
