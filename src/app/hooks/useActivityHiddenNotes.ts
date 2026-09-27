import { useEffect, useSyncExternalStore } from 'react';

import { createListenerSet } from 'lib/listener-set';
import { fetchFromStorage, onStorageChanged, putToStorage } from 'lib/miden/front/storage';

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
 * Every extension window (popup, side panel, full-page tab) holds its own copy of one stored list.
 * A save re-reads the list and applies its change to what it finds, under a Web Lock every window
 * shares, and each window takes the others' writes from the storage-change event as they land, so
 * a transfer declined or restored in one window shows in the others and no window's save undoes it.
 *
 * An unreadable list stays read-only (writing it would replace every transfer declined before
 * with the one being declined now), saves for one account run one at a time in the order they
 * were made, and a failed write is rolled back.
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
/** A key is here while this window has a save for it that has not finished writing. */
const saves = new Map<string, Promise<boolean>>();
const subscriptions = new Map<string, () => void>();
/** Keys whose stored list changed while a save was running, read again when it settles. */
const stale = new Set<string>();
const { subscribe, notify } = createListenerSet();

const storageKey = (address: string) => `activity-hidden-notes:${address}`;

const getEntry = (key: string): HiddenNotesEntry => entries.get(key) ?? LOADING;

function setEntry(key: string, entry: HiddenNotesEntry): void {
  entries.set(key, entry);
  notify();
}

/** Any stored value as a set: an array keeps its string ids, anything else is empty. */
function parseIds(stored: unknown): ReadonlySet<string> {
  return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
}

/** Makes a stored set the entry, keeping `saveFailed`. The same set wakes nobody. */
function adopt(key: string, ids: ReadonlySet<string>): void {
  const current = getEntry(key);
  if (current.status === 'ready' && current.ids.size === ids.size && [...ids].every(id => current.ids.has(id))) {
    return;
  }
  setEntry(key, { ids, status: 'ready', saveFailed: current.saveFailed });
}

// The event also echoes this window's own writes. While a save runs the entry is the save's: an
// echo of its earlier write would flicker back in, and a rollback would drop another window's
// change, so the key is only marked, and read again when the save settles.
function takeStored(key: string, value: unknown): void {
  if (saves.has(key)) stale.add(key);
  else adopt(key, parseIds(value));
}

/**
 * Reads one account's set, once per account unless the read fails.
 *
 * A read for an address the app has moved past settles into that address's OWN entry, so it
 * cannot replace the current one. It lands only on a `loading` or `unreadable` entry: a `ready`
 * one has been written by a save or a storage event, which is at least as new as the read. A failed
 * read is not cached, so the next mount reads again instead of staying unreadable until restart.
 */
function load(key: string): Promise<void> {
  // Before the read, and once per key for good: a write that lands while the read is out must
  // still arrive, and `onStorageChanged` only starts listening after an async import.
  if (!subscriptions.has(key)) {
    const unsubscribe = onStorageChanged<unknown>(key, value => takeStored(key, value));
    subscriptions.set(key, unsubscribe);
  }
  const inFlight = loads.get(key);
  if (inFlight) return inFlight;
  const run = fetchFromStorage(key)
    .then(stored => {
      if (getEntry(key).status === 'ready') return;
      setEntry(key, { ids: parseIds(stored), status: 'ready', saveFailed: false });
    })
    .catch(error => {
      console.warn('[activity] Could not load hidden notes', error);
      if (getEntry(key).status !== 'ready') {
        setEntry(key, { ids: EMPTY_IDS, status: 'unreadable', saveFailed: false });
      }
      if (loads.get(key) === run) loads.delete(key);
    });
  loads.set(key, run);
  return run;
}

type Change = (hidden: ReadonlySet<string>) => ReadonlySet<string>;

/** Applies the change to the list as stored now, not to this window's copy of it. */
async function applyChange(key: string, change: Change): Promise<boolean> {
  if (getEntry(key).status !== 'ready') return false;
  let stored: ReadonlySet<string>;
  try {
    stored = parseIds(await fetchFromStorage(key));
  } catch (error) {
    setEntry(key, { ...getEntry(key), saveFailed: true });
    console.warn('[activity] Could not read hidden notes before saving', error);
    return false;
  }
  const ids = change(stored);
  setEntry(key, { ids, status: 'ready', saveFailed: false });
  try {
    await putToStorage(key, [...ids]);
    return true;
  } catch (error) {
    setEntry(key, { ids: stored, status: 'ready', saveFailed: true });
    console.warn('[activity] Could not save hidden notes', error);
    return false;
  }
}

/** Resolves `true` once the change is stored, `false` when it was refused or rolled back. */
function save(key: string, change: Change): Promise<boolean> {
  if (getEntry(key).status !== 'ready') return Promise.resolve(false);
  // The turn `inWalletPromptStorageTurn` takes: every window shares the lock, so another window's
  // read and write cannot fall between this one's and write back a list without this change.
  const chain: Promise<boolean> = (saves.get(key) ?? Promise.resolve(true)).then(() =>
    navigator.locks.request<Promise<boolean>>(`turn:${key}`, async () => {
      const saved = await applyChange(key, change);
      if (saves.get(key) === chain) {
        saves.delete(key);
        if (stale.delete(key)) {
          try {
            adopt(key, parseIds(await fetchFromStorage(key)));
          } catch (error) {
            console.warn('[activity] Could not read hidden notes after saving', error);
          }
        }
      }
      return saved;
    })
  );
  saves.set(key, chain);
  return chain;
}

/** Test seam: forgets every account's set, its in-flight read, its save chain and its subscription. */
export function resetActivityHiddenNotes(): void {
  subscriptions.forEach(unsubscribe => unsubscribe());
  subscriptions.clear();
  stale.clear();
  entries.clear();
  loads.clear();
  saves.clear();
  notify();
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
    /** Brings back the given notes, or every declined note when none are given. */
    restore: (ids?: readonly string[]) =>
      save(key, hidden => (ids ? new Set([...hidden].filter(id => !ids.includes(id))) : EMPTY_IDS))
  };
}
