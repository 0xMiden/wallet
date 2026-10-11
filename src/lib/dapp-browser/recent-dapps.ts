/**
 * Recent dApps, kept in the platform's key-value store (`lib/platform/storage-adapter`), so every
 * wallet reset wipes them with the rest of it.
 *
 * Stores up to `MAX_RECENTS` entries keyed by URL with a `lastOpenedAt`
 * timestamp; `getRecentDapps` returns them newest-first, and Explore's
 * Recents section lists them as rows. Two writers: BrowserScreen records
 * each dApp opened from Explore (a row, the featured card, a Recents row,
 * the address bar) except a web search, and DappActionsSheet's My-dApps
 * toggle saves (under the same no-search rule) or removes the open dApp.
 * The actions sheet's Reopen starts a fresh session without recording, and
 * a desktop open goes to its own window and records nothing. On the extension
 * BrowserScreen records each dApp it opens in a new tab, under the same rule.
 */

import { fetchFromStorage, putToStorage, registerStorageReread } from 'lib/miden/front/storage';

const STORAGE_KEY = 'miden:dapp-browser:recents';
const MAX_RECENTS = 12;

export interface RecentDapp {
  url: string;
  /**
   * `getDappDisplayName`'s label: the hostname when BrowserScreen records an
   * open (a fresh session's title is still its origin), or a non-URL page
   * title when the actions sheet saves a dApp whose page has loaded.
   */
  name: string;
  /** Explore builds a Recents row's fallback logo from it. */
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
 * storage indefinitely, and the only way to remove
 * a recent is the actions sheet's toggle on an open dApp - so we sweep them
 * on every read. Match is by
 * hostname (with the `www.` prefix stripped) so any URL pointing at
 * the same site is caught regardless of path.
 */
const PURGED_RECENT_HOSTS = new Set(['x.com', 'twitter.com', 'app.uniswap.org', 'uniswap.org']);

/**
 * One-time normalization of legacy entries.
 *
 * 1. Before BrowserScreen.handleOpen started deriving a hostname-
 *    style name, recents were written with the raw `https://…` URL
 *    as `name`. Those entries persist in storage
 *    across upgrades, show the raw URL as the Recents row's title, and
 *    make 'H' the initial drawn when its logo fails to load. Replace the
 *    bad name with the hostname.
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

// A wipe empties storage under this realm's copy, which would otherwise keep showing the old list.
registerStorageReread(async () => {
  cache = null;
});

async function read(): Promise<RecentDapp[]> {
  if (cache) return cache;
  try {
    const parsed = await fetchFromStorage<RecentDapp[]>(STORAGE_KEY);
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
    await putToStorage(STORAGE_KEY, list);
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
  const stored = list.find(d => d.url === entry.url);
  const filtered = list.filter(d => d.url !== entry.url);
  // DappActionsSheet passes `favicon: undefined` when it has none, so a spread would erase a stored one.
  filtered.unshift({ ...entry, favicon: entry.favicon ?? stored?.favicon, lastOpenedAt: Date.now() });
  await write(filtered.slice(0, MAX_RECENTS));
}

/** Removes a recent entry by URL. */
export async function forgetRecentDapp(url: string): Promise<void> {
  const list = await read();
  await write(list.filter(d => d.url !== url));
}
