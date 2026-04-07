/**
 * Persistent store for parked dApp session metadata.
 *
 * PR-6 cold-bubble lifecycle:
 *  - On park, the provider writes the session into this store so the
 *    bubble can be restored across an app restart.
 *  - On first mount, the provider reads this store and rehydrates the
 *    sessions as "cold" — no native WKWebView instance yet, just the
 *    URL + title + cached snapshot. The native webview is lazily
 *    instantiated on the first restore tap so we don't pay the memory
 *    cost of N webviews for dApps the user hasn't touched yet.
 *
 * Storage: Capacitor `@capacitor/preferences` (iOS `UserDefaults`,
 * Android `SharedPreferences`). These have a size soft limit around
 * 1 MB on both platforms; we store only session metadata here (a few
 * hundred bytes per entry), NEVER snapshots. Snapshots live in the
 * filesystem via `snapshot-persistence.ts`.
 *
 * Why this isn't in IndexedDB: Capacitor Preferences writes commit
 * synchronously and are guaranteed to be available even if the wallet
 * is killed immediately after a park. IndexedDB in mobile WebViews has
 * a reputation for losing recent writes on background-kill.
 */

import { Preferences } from '@capacitor/preferences';

import { type DappSession } from './dapp-session';

const STORAGE_KEY = 'miden.dapp.persistedSessions.v1';

/**
 * What we store per session. Intentionally a subset of `DappSession` —
 * we drop ephemeral `status` and record the last-known origin so cross-
 * origin nav is preserved across an app restart.
 */
export interface PersistedSession {
  id: string;
  url: string;
  origin: string;
  title: string;
  favicon: string | null;
  openedAt: number;
  /** Wall-clock time of the last park, used for LRU eviction. */
  parkedAt: number;
}

/** Convert a live session model into its persisted form. */
export function toPersisted(session: DappSession, parkedAt = Date.now()): PersistedSession {
  return {
    id: session.id,
    url: session.url,
    origin: session.origin,
    title: session.title,
    favicon: session.favicon,
    openedAt: session.openedAt,
    parkedAt
  };
}

/** Convert a persisted session into the live session model. */
export function fromPersisted(persisted: PersistedSession): DappSession {
  return {
    id: persisted.id,
    url: persisted.url,
    origin: persisted.origin,
    title: persisted.title,
    favicon: persisted.favicon,
    openedAt: persisted.openedAt,
    status: 'parked'
  };
}

/** Load all persisted sessions. Returns [] when the store is empty or corrupt. */
export async function loadPersistedSessions(): Promise<PersistedSession[]> {
  try {
    const { value } = await Preferences.get({ key: STORAGE_KEY });
    if (!value) return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      console.warn('[session-persistence] stored value is not an array, clearing');
      await clearAllPersistedSessions();
      return [];
    }
    // Filter out malformed entries defensively — a bad write shouldn't
    // prevent the wallet from starting.
    return parsed.filter(
      (s): s is PersistedSession =>
        s && typeof s.id === 'string' && typeof s.url === 'string' && typeof s.origin === 'string'
    );
  } catch (error) {
    console.warn('[session-persistence] load failed:', error);
    return [];
  }
}

/** Save the full list of persisted sessions. */
export async function savePersistedSessions(sessions: PersistedSession[]): Promise<void> {
  try {
    await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(sessions) });
  } catch (error) {
    console.warn('[session-persistence] save failed:', error);
  }
}

/** Upsert a single session. Replaces any existing entry with the same id. */
export async function upsertPersistedSession(session: PersistedSession): Promise<void> {
  const existing = await loadPersistedSessions();
  const next = existing.filter(s => s.id !== session.id);
  next.push(session);
  await savePersistedSessions(next);
}

/** Remove a single session from persistence. */
export async function removePersistedSession(id: string): Promise<void> {
  const existing = await loadPersistedSessions();
  const next = existing.filter(s => s.id !== id);
  if (next.length !== existing.length) {
    await savePersistedSessions(next);
  }
}

/** Wipe every persisted session. Called on wallet reset. */
export async function clearAllPersistedSessions(): Promise<void> {
  try {
    await Preferences.remove({ key: STORAGE_KEY });
  } catch (error) {
    console.warn('[session-persistence] clear failed:', error);
  }
}
