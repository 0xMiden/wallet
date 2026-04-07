/**
 * Recent dApps storage backed by `@capacitor/preferences`.
 *
 * The launcher's "My dApps" grid mixes user-recents with the hardcoded
 * featured list. This module owns the recents — it stores up to
 * `MAX_RECENTS` entries keyed by URL with a `lastOpenedAt` timestamp so
 * the grid can sort newest-first.
 *
 * On extension/desktop platforms `@capacitor/preferences` falls back to
 * an in-memory store, which is fine — recents are non-critical and the
 * user typically has only one shell open at a time.
 */

import { Preferences } from '@capacitor/preferences';

const STORAGE_KEY = 'miden:dapp-browser:recents';
const MAX_RECENTS = 12;

export interface RecentDapp {
  url: string;
  /** Display name (from the dApp's <title> if available, else origin). */
  name: string;
  /** Origin string for favicon lookup. */
  origin: string;
  /** Cached favicon URL or data: URL — optional. */
  favicon?: string;
  /** Epoch ms of the most recent open. */
  lastOpenedAt: number;
}

let cache: RecentDapp[] | null = null;

/**
 * One-time normalization of legacy entries.
 *
 * Before BrowserScreen.handleOpen started deriving a hostname-style
 * name, recents were written with the raw `https://…` URL as `name`.
 * Those entries persist in `@capacitor/preferences` across upgrades and
 * make every tile fall back to the 'H' avatar letter (the first char
 * of `https`). Migrate any such entry on read by replacing the bad
 * name with the hostname; persist the migrated list so subsequent
 * reads don't re-process.
 */
function migrateLegacyEntries(list: RecentDapp[]): { list: RecentDapp[]; migrated: boolean } {
  let migrated = false;
  const next = list.map(entry => {
    if (!entry.name || !entry.name.startsWith('http')) return entry;
    try {
      const host = new URL(entry.url).hostname.replace(/^www\./, '');
      if (host && host !== entry.name) {
        migrated = true;
        return { ...entry, name: host };
      }
    } catch {
      // Leave the entry alone if the URL doesn't parse.
    }
    return entry;
  });
  return { list: next, migrated };
}

async function read(): Promise<RecentDapp[]> {
  if (cache) return cache;
  try {
    const { value } = await Preferences.get({ key: STORAGE_KEY });
    if (!value) {
      cache = [];
      return cache;
    }
    const parsed = JSON.parse(value) as RecentDapp[];
    if (!Array.isArray(parsed)) {
      cache = [];
      return cache;
    }
    const { list, migrated } = migrateLegacyEntries(parsed);
    cache = list;
    if (migrated) {
      // Best-effort persist of the migration so we don't repeat it.
      void write(list);
    }
    return cache;
  } catch {
    cache = [];
    return cache;
  }
}

async function write(list: RecentDapp[]): Promise<void> {
  cache = list;
  try {
    await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(list) });
  } catch {
    // Persistence is best-effort; in-memory cache still serves the session.
  }
}

/** Returns the recents list sorted newest-first. */
export async function getRecentDapps(): Promise<RecentDapp[]> {
  const list = await read();
  return [...list].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/** Records (or refreshes) a recent open. */
export async function recordRecentDapp(entry: Omit<RecentDapp, 'lastOpenedAt'>): Promise<void> {
  const list = await read();
  const filtered = list.filter(d => d.url !== entry.url);
  filtered.unshift({ ...entry, lastOpenedAt: Date.now() });
  await write(filtered.slice(0, MAX_RECENTS));
}

/** Removes a recent entry by URL. */
export async function forgetRecentDapp(url: string): Promise<void> {
  const list = await read();
  await write(list.filter(d => d.url !== url));
}
