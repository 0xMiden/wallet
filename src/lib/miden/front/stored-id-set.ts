import { useEffect, useSyncExternalStore } from 'react';

import { createListenerSet } from 'lib/listener-set';

import {
  fetchFromStorage,
  inStorageTurn,
  onStorageChanged,
  putToStorage,
  registerStorageReread,
  StorageChangeSubscription
} from './storage';

/**
 * A set of ids kept in storage per key (Activity's declined transfers, Home's hidden tokens), as a MODULE-LEVEL store
 * read through `useSyncExternalStore`, not `useState` in each hook. That was a real bug: each caller held its own copy,
 * read once on mount, so a decline taken on the Activity tab reached nobody else, and `TabLayout` keeps a visited tab
 * mounted, so the home banner never remounted to read it again. One store per set, and every consumer sees a write at
 * once.
 *
 * An unreadable set stays read-only: writing it would replace every id stored before with the one being added now.
 *
 * A save runs in its key's storage turn (`inStorageTurn`), which every extension surface shares, and computes the change
 * from what storage holds, not from this realm's copy: a surface that saved from its copy would drop another surface's
 * commit it had not heard yet. While this realm has a save for a key out, a change event for that key is held back:
 * the event also echoes this realm's own earlier writes, and one landing over a save's list would flicker it back and
 * leave a failed write neither rolled back nor reported. The key is read once more when its last save settles.
 *
 * Each key the store holds is subscribed to its storage changes from its first load until the store forgets it, so a
 * commit from another surface, or a wipe in the service worker, reaches a reader that stays mounted. After a wipe in
 * this realm the store forgets every key and reads each again (`registerStorageReread`).
 */

export type StoredIdSetStatus = 'loading' | 'ready' | 'unreadable';

export interface StoredIdSetEntry {
  /** As stored. */
  ids: ReadonlySet<string>;
  status: StoredIdSetStatus;
  /** The last save failed, in its read or its write. */
  saveFailed: boolean;
}

export interface StoredIdSet {
  /** The key's entry, read on mount. */
  useEntry: (key: string) => StoredIdSetEntry;
  /** Resolves `true` once `change` of what storage holds is stored; `false` when refused or when the save failed. */
  save: (key: string, change: (stored: ReadonlySet<string>) => ReadonlySet<string>) => Promise<boolean>;
  /** Forgets every key, as a wipe does, without reading any again. */
  reset: () => void;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
// One shared snapshot for every key not read yet: `useSyncExternalStore` compares snapshots by identity.
const LOADING: StoredIdSetEntry = { ids: EMPTY_IDS, status: 'loading', saveFailed: false };

// Only the strings of an array: anything else a key holds reads as empty.
const toIds = (stored: unknown): ReadonlySet<string> =>
  new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(id => b.has(id));

/** `logLabel` tags the store's warnings. */
export function createStoredIdSet(logLabel: string): StoredIdSet {
  // Keyed by storage key, so one account's or network's set cannot overwrite another's.
  const entries = new Map<string, StoredIdSetEntry>();
  const loads = new Map<string, Promise<void>>();
  const subscriptions = new Map<string, StorageChangeSubscription>();
  // Moves when the store forgets its keys: a load or turn that began before lands nothing and writes nothing.
  let generation = 0;
  // Saves this realm has out per key, and keys whose stored set changed while one was out.
  const pendingSaves = new Map<string, number>();
  const stale = new Set<string>();
  const { subscribe, notify } = createListenerSet();

  const getEntry = (key: string): StoredIdSetEntry => entries.get(key) ?? LOADING;

  function setEntry(key: string, entry: StoredIdSetEntry): void {
    entries.set(key, entry);
    notify();
  }

  // Takes what storage holds, keeping saveFailed. An equal set keeps its entry: readers memoize on its identity.
  function adopt(key: string, ids: ReadonlySet<string>): void {
    const entry = getEntry(key);
    if (entry.status === 'ready' && sameIds(entry.ids, ids)) return;
    setEntry(key, { ids, status: 'ready', saveFailed: entry.saveFailed });
  }

  // A change event carries what storage now holds; while a save for the key is out it only marks the key.
  function listen(key: string): StorageChangeSubscription {
    const subscription = onStorageChanged<unknown>(key, stored => {
      if (pendingSaves.has(key)) stale.add(key);
      else adopt(key, toIds(stored));
    });
    subscriptions.set(key, subscription);
    return subscription;
  }

  /**
   * Reads one key, once unless the read fails. On the extension the read is issued only once the key's change listener
   * is attached, so a commit landing while it is in flight is heard. A read lands only on an entry that is not `ready`:
   * a ready one came from a save or an event, both newer. A failed read is not cached, so the next mount reads again.
   */
  function load(key: string): Promise<void> {
    const inFlight = loads.get(key);
    if (inFlight) return inFlight;
    const started = generation;
    const subscription = subscriptions.get(key) ?? listen(key);
    const run = (async () => {
      const attaching = subscription.attached;
      if (attaching) await attaching;
      if (generation !== started) return;
      const stored = await fetchFromStorage<unknown>(key);
      if (generation !== started || getEntry(key).status === 'ready') return;
      setEntry(key, { ids: toIds(stored), status: 'ready', saveFailed: false });
    })().catch((error: unknown) => {
      console.warn(`[${logLabel}] Could not load the hidden set`, error);
      if (generation !== started) return;
      if (getEntry(key).status !== 'ready') {
        setEntry(key, { ids: EMPTY_IDS, status: 'unreadable', saveFailed: false });
      }
      if (loads.get(key) === run) loads.delete(key);
    });
    loads.set(key, run);
    return run;
  }

  /**
   * Every writer of a key takes its turn, so what the turn reads is what storage holds until its own write lands. The
   * change shows before the write settles; a failed write rolls back to the set the turn read, which storage still holds.
   */
  async function applyChange(
    key: string,
    change: (stored: ReadonlySet<string>) => ReadonlySet<string>,
    started: number
  ): Promise<boolean> {
    if (generation !== started) return false;
    let stored: ReadonlySet<string>;
    try {
      stored = toIds(await fetchFromStorage<unknown>(key));
    } catch (error) {
      console.warn(`[${logLabel}] Could not save the hidden set`, error);
      if (generation === started) setEntry(key, { ...getEntry(key), saveFailed: true });
      return false;
    }
    if (generation !== started) return false;
    const optimistic: StoredIdSetEntry = { ids: change(stored), status: 'ready', saveFailed: false };
    setEntry(key, optimistic);
    try {
      await putToStorage(key, [...optimistic.ids]);
      return true;
    } catch (error) {
      console.warn(`[${logLabel}] Could not save the hidden set`, error);
      if (generation === started) setEntry(key, { ids: stored, status: 'ready', saveFailed: true });
      return false;
    }
  }

  /**
   * Counts itself until it settles, so the key's change events are held back meanwhile, and releases exactly that count,
   * once and only in the generation that took it, whether or not its turn ran: a count left behind would hold the key's
   * events back for good. The last save out reads a key that changed meanwhile once more, inside its turn.
   */
  function save(key: string, change: (stored: ReadonlySet<string>) => ReadonlySet<string>): Promise<boolean> {
    if (getEntry(key).status !== 'ready') return Promise.resolve(false);
    const started = generation;
    pendingSaves.set(key, (pendingSaves.get(key) ?? 0) + 1);
    let released = false;
    const release = (): boolean => {
      if (released || generation !== started) return false;
      released = true;
      const left = (pendingSaves.get(key) ?? 1) - 1;
      if (left > 0) {
        pendingSaves.set(key, left);
        return false;
      }
      pendingSaves.delete(key);
      return stale.delete(key);
    };
    return inStorageTurn(key, async () => {
      try {
        return await applyChange(key, change, started);
      } finally {
        if (release()) {
          try {
            const ids = toIds(await fetchFromStorage<unknown>(key));
            if (generation === started) adopt(key, ids);
          } catch (error) {
            console.warn(`[${logLabel}] Could not read the hidden set after saving`, error);
          }
        }
      }
    }).finally(release);
  }

  // A mounted reader shows its key loading until the key is read again.
  function forget(): string[] {
    const held = [...subscriptions.keys()];
    generation += 1;
    subscriptions.forEach(unsubscribe => unsubscribe());
    subscriptions.clear();
    entries.clear();
    loads.clear();
    pendingSaves.clear();
    stale.clear();
    notify();
    return held;
  }

  registerStorageReread(async () => {
    await Promise.all(forget().map(key => load(key)));
  });

  function useEntry(key: string): StoredIdSetEntry {
    const snapshot = () => getEntry(key);
    const entry = useSyncExternalStore(subscribe, snapshot, snapshot);
    useEffect(() => {
      void load(key);
    }, [key]);
    return entry;
  }

  return {
    useEntry,
    save,
    reset: () => {
      forget();
    }
  };
}
