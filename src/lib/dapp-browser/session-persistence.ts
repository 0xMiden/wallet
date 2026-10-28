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
import { removeSnapshotFromDisk } from './snapshot-persistence';

const STORAGE_KEY = 'miden.dapp.persistedSessions.v1';

/**
 * Upper bound on how many parked sessions we keep on disk. Each entry
 * is a few hundred bytes so this keeps the Preferences record well
 * under the ~1 MB UserDefaults / SharedPreferences soft limit even in
 * pathological cases. When the list grows past this, the oldest-parked
 * entries are evicted first (their on-disk snapshots are removed too
 * in `upsertPersistedSession` — callers don't have to clean up).
 */
export const MAX_PERSISTED_SESSIONS = 8;
export const MAX_PERSISTED_SESSION_BYTES = 16_384;
export const MAX_PERSISTED_SESSIONS_BYTES = 131_072;
const encoder = new TextEncoder();

function boundSessions(sessions: PersistedSession[]): PersistedSession[] {
  const byId = new Map<string, PersistedSession>();
  for (const session of sessions) byId.set(session.id, session);
  const ordered = [...byId.values()];
  if (ordered.length > MAX_PERSISTED_SESSIONS) ordered.sort((left, right) => right.parkedAt - left.parkedAt);
  const retained: PersistedSession[] = [];
  let bytes = 2;
  for (const session of ordered) {
    let next = session;
    let encoded = encoder.encode(JSON.stringify(next)).byteLength;
    if (encoded > MAX_PERSISTED_SESSION_BYTES && session.favicon !== null) {
      next = { ...session, favicon: null };
      encoded = encoder.encode(JSON.stringify(next)).byteLength;
    }
    const total = bytes + encoded + (retained.length > 0 ? 1 : 0);
    if (encoded > MAX_PERSISTED_SESSION_BYTES || total > MAX_PERSISTED_SESSIONS_BYTES) continue;
    retained.push(next);
    bytes = total;
  }
  return retained;
}

async function cleanEvicted(original: PersistedSession[], retained: PersistedSession[]): Promise<void> {
  const ids = new Set(retained.map(session => session.id));
  await Promise.all(
    original.filter(session => !ids.has(session.id)).map(session => removeSnapshotFromDisk(session.id))
  );
}

/**
 * What we store per session. Intentionally a subset of `DappSession` —
 * we drop ephemeral `status` and record the last-known url + origin so cross-
 * origin nav is preserved across an app restart. The pair must be consistent
 * (`origin === parseOrigin(url)`): a restore loads `url`, and the origin is what
 * every dApp request from that load is authorized against. Legacy records written
 * before the two were kept in lockstep can disagree, so the provider re-derives
 * the origin from `url` when it opens the webview rather than trusting this.
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

let persistence = Promise.resolve();

// Serialize the whole shared-list transaction, including reset and corrupt-record repair.
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = persistence.then(operation);
  persistence = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Load all persisted sessions. Returns [] when the store is empty or corrupt. */
export function loadPersistedSessions(): Promise<PersistedSession[]> {
  return serialize(loadSessions);
}

async function loadSessions(): Promise<PersistedSession[]> {
  try {
    const { value } = await Preferences.get({ key: STORAGE_KEY });
    if (!value) return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      console.warn('[session-persistence] stored value is not an array, clearing');
      await clearSessions();
      return [];
    }
    const sessions = parsed.filter(
      (s): s is PersistedSession =>
        s && typeof s.id === 'string' && typeof s.url === 'string' && typeof s.origin === 'string'
    );
    const retained = boundSessions(sessions);
    if (JSON.stringify(retained) !== value) {
      await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(retained) });
      await cleanEvicted(sessions, retained);
    }
    return retained;
  } catch (error) {
    console.warn('[session-persistence] load failed:', error);
    return [];
  }
}

/** Save the full list of persisted sessions. */
export function savePersistedSessions(sessions: PersistedSession[]): Promise<void> {
  return serialize(() => saveSessions(sessions));
}

async function saveSessions(sessions: PersistedSession[]): Promise<void> {
  try {
    const retained = boundSessions(sessions);
    const value = JSON.stringify(retained);
    const previous = await Preferences.get({ key: STORAGE_KEY });
    if (previous.value !== value) await Preferences.set({ key: STORAGE_KEY, value });
    await cleanEvicted(sessions, retained);
  } catch (error) {
    console.warn('[session-persistence] save failed:', error);
  }
}

/** Upsert a session, evicting the oldest entries and their snapshots above the limit. */
export function upsertPersistedSession(session: PersistedSession): Promise<void> {
  return serialize(async () => {
    const existing = await loadSessions();
    const deduped = existing.filter(s => s.id !== session.id);
    deduped.push(session);

    await saveSessions(deduped);
  });
}

/** Remove a single session after earlier list mutations have finished. */
export function removePersistedSession(id: string): Promise<void> {
  return serialize(async () => {
    const existing = await loadSessions();
    const next = existing.filter(s => s.id !== id);
    if (next.length !== existing.length) await saveSessions(next);
  });
}

/** Wipe every persisted session. Called on wallet reset. */
export function clearAllPersistedSessions(): Promise<void> {
  return serialize(clearSessions);
}

async function clearSessions(): Promise<void> {
  try {
    await Preferences.remove({ key: STORAGE_KEY });
  } catch (error) {
    console.warn('[session-persistence] clear failed:', error);
  }
}
