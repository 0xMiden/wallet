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
 * Hostnames that were once shipped as featured dApps but have since
 * been removed (X / Twitter when replaced by Lumina; Uniswap when
 * replaced by Qash). Stale entries can survive in user
 * `@capacitor/preferences` storage indefinitely, and there's no UI to
 * delete a recent yet — so we sweep them on every read. Match is by
 * hostname (with the `www.` prefix stripped) so any URL pointing at
 * the same site is caught regardless of path.
 */
const PURGED_RECENT_HOSTS = new Set(['x.com', 'twitter.com', 'app.uniswap.org', 'uniswap.org']);

/**
 * One-time normalization of legacy entries.
 *
 * 1. Before BrowserScreen.handleOpen started deriving a hostname-
 *    style name, recents were written with the raw `https://…` URL
 *    as `name`. Those entries persist in `@capacitor/preferences`
 *    across upgrades and make every tile fall back to the 'H' avatar
 *    letter. Replace the bad name with the hostname.
 * 2. Drop any entry whose host is in PURGED_RECENT_HOSTS (see above).
 *
 * Persists the migrated list when anything changed so subsequent
 * reads don't re-process.
 */
function migrateLegacyEntries(list: RecentDapp[]): { list: RecentDapp[]; migrated: boolean } {
  let migrated = false;
  const next: RecentDapp[] = [];
  for (const entry of list) {
    let host = '';
    try {
      host = new URL(entry.url).hostname.replace(/^www\./, '');
    } catch {
      // Unparseable URL — keep the entry as-is, no host to match against.
    }
    if (host && PURGED_RECENT_HOSTS.has(host)) {
      migrated = true;
      continue; // drop the entry
    }
    if (entry.name && entry.name.startsWith('http') && host && host !== entry.name) {
      migrated = true;
      next.push({ ...entry, name: host });
      continue;
    }
    next.push(entry);
  }
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
