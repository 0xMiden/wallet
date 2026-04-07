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

async function read(): Promise<RecentDapp[]> {
  if (cache) return cache;
  try {
    const { value } = await Preferences.get({ key: STORAGE_KEY });
    if (!value) {
      cache = [];
      return cache;
    }
    const parsed = JSON.parse(value) as RecentDapp[];
    cache = Array.isArray(parsed) ? parsed : [];
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
