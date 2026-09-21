import { useEffect, useSyncExternalStore } from 'react';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

/**
 * Which incoming transfers have been declined, per account.
 *
 * A MODULE-LEVEL store read through `useSyncExternalStore` — the same shape as
 * `lib/settings/activity-read.ts` and the activity-view setting — and NOT `useState` inside the
 * hook. That was a real bug: each caller held its own copy of the set, read once on mount, so a
 * decline taken on the Activity tab reached nobody else. `TabLayout` keeps a visited tab mounted,
 * so the home banner never remounted to re-read it either, and it went on counting declined
 * transfers in the total it said was waiting for the rest of the session. The set is one fact
 * about the account, so there is one store and every consumer sees a write immediately.
 *
 * The rest of the behaviour is unchanged: an unreadable list stays read-only (writing it would
 * replace every transfer declined before with the one being declined now), saves for one account
 * run one at a time, each from the list the previous one left, and a failed write is rolled back.
 */

type HiddenNotesStatus = 'loading' | 'ready' | 'unreadable';

interface HiddenNotesEntry {
  ids: ReadonlySet<string>;
  status: HiddenNotesStatus;
  saveFailed: boolean;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
// One shared object for every account not read yet: `useSyncExternalStore` compares snapshots by
// identity, so the pre-read snapshot has to be a constant rather than a fresh empty set per call.
const LOADING: HiddenNotesEntry = { ids: EMPTY_IDS, status: 'loading', saveFailed: false };

/** Keyed by STORAGE KEY, so each account's set is its own entry and cannot overwrite another's. */
const entries = new Map<string, HiddenNotesEntry>();
const loads = new Map<string, Promise<void>>();
const saves = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

const storageKey = (address: string) => `activity-hidden-notes:${address}`;

const getEntry = (key: string): HiddenNotesEntry => entries.get(key) ?? LOADING;

function setEntry(key: string, entry: HiddenNotesEntry): void {
  entries.set(key, entry);
  listeners.forEach(listener => listener());
}

/**
 * Reads one account's set, once per account.
 *
 * A read for an address the app has moved past settles into that address's OWN entry, so it
 * cannot replace the current one. It also never overwrites an entry that has left `loading`:
 * past that point a save has written the list, and what the read is holding is what that save
 * stored.
 */
function load(key: string): Promise<void> {
  const inFlight = loads.get(key);
  if (inFlight) return inFlight;
  const run = fetchFromStorage<string[]>(key)
    .then(stored => {
      if (getEntry(key).status !== 'loading') return;
      const ids = new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
      setEntry(key, { ids, status: 'ready', saveFailed: false });
    })
    .catch(error => {
      console.warn('[activity] Could not load hidden notes', error);
      if (getEntry(key).status === 'loading') {
        setEntry(key, { ids: EMPTY_IDS, status: 'unreadable', saveFailed: false });
      }
    });
  loads.set(key, run);
  return run;
}

function save(key: string, change: (hidden: ReadonlySet<string>) => ReadonlySet<string>): Promise<void> {
  if (getEntry(key).status !== 'ready') return Promise.resolve();
  const chain = (saves.get(key) ?? Promise.resolve()).then(async () => {
    const previous = getEntry(key);
    if (previous.status !== 'ready') return;
    const ids = change(previous.ids);
    setEntry(key, { ids, status: 'ready', saveFailed: false });
    try {
      await putToStorage(key, [...ids]);
    } catch (error) {
      setEntry(key, { ...previous, saveFailed: true });
      console.warn('[activity] Could not save hidden notes', error);
    }
  });
  saves.set(key, chain);
  return chain;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forgets every account's set, its in-flight read and its save chain. */
export function resetActivityHiddenNotes(): void {
  entries.clear();
  loads.clear();
  saves.clear();
  listeners.forEach(listener => listener());
}

export function useActivityHiddenNotes(address: string) {
  const key = storageKey(address);
  const snapshot = () => getEntry(key);
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    void load(key);
  }, [key]);

  return {
    ids: entry.ids,
    loaded: entry.status === 'ready',
    failed: entry.status === 'unreadable' || entry.saveFailed,
    hide: (id: string) => save(key, hidden => new Set([...hidden, id])),
    restore: () => save(key, () => EMPTY_IDS)
  };
}
