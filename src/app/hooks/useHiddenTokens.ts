import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { createListenerSet } from 'lib/listener-set';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

/**
 * The tokens the user hid from Home (#813), per network and per account.
 *
 * The same shape as `useActivityHiddenNotes`'s store, but a separate one, read through
 * `useSyncExternalStore`, so a token hidden on its page leaves the Home that `TabLayout` keeps
 * mounted at once. An unreadable list stays read-only (writing it would replace every token hidden
 * before), saves for one key run one at a time, each from the list the previous one left, and a
 * failed write is rolled back.
 *
 * Ids are compared in their canonical form (`normalizedFaucetId`), so the hex and bech32 ids of one
 * faucet are one token. The native token pays every fee: it cannot be hidden, and a stored id that
 * names it (after an endpoint or native id change) is never reported.
 */

type HiddenTokensStatus = 'loading' | 'ready' | 'unreadable';

interface HiddenTokensEntry {
  /** As stored: an entry may be in either encoding. */
  ids: ReadonlySet<string>;
  status: HiddenTokensStatus;
  saveFailed: boolean;
}

export interface HiddenTokens {
  /** Canonical ids of the hidden tokens, never the native token's. */
  ids: ReadonlySet<string>;
  /** The stored set has been read, so it can be written. */
  loaded: boolean;
  /** The stored set could not be read (it is then read-only), or the last save was rolled back. */
  failed: boolean;
  /** The same function until the set changes, so a consumer can memoize on it. */
  isHidden: (tokenId: string) => boolean;
  /** Resolves `true` once stored; `false` for the native token, before it is known, or when the save failed. */
  hide: (tokenId: string) => Promise<boolean>;
  /** Resolves `true` once stored, `false` when the save was refused or rolled back. */
  unhide: (tokenId: string) => Promise<boolean>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
// One shared snapshot for every key not read yet: `useSyncExternalStore` compares by identity.
const LOADING: HiddenTokensEntry = { ids: EMPTY_IDS, status: 'loading', saveFailed: false };

const entries = new Map<string, HiddenTokensEntry>();
const loads = new Map<string, Promise<void>>();
const saves = new Map<string, Promise<boolean>>();
const { subscribe, notify } = createListenerSet();

// Faucet ids are per network, so the set is too.
const storageKey = (network: string, address: string) => `hidden-tokens:v1:${network}:${address}`;

const getEntry = (key: string): HiddenTokensEntry => entries.get(key) ?? LOADING;

function setEntry(key: string, entry: HiddenTokensEntry): void {
  entries.set(key, entry);
  notify();
}

/**
 * Reads one key's set, once unless the read fails. A read lands only on a `loading` or `unreadable`
 * entry: a `ready` one was written by a save, which stored what the read would bring back. A failed
 * read is not cached, so the next mount reads again.
 */
function load(key: string): Promise<void> {
  const inFlight = loads.get(key);
  if (inFlight) return inFlight;
  const run = fetchFromStorage<string[]>(key)
    .then(stored => {
      if (getEntry(key).status === 'ready') return;
      const ids = new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
      setEntry(key, { ids, status: 'ready', saveFailed: false });
    })
    .catch(error => {
      console.warn('[tokens] Could not load hidden tokens', error);
      if (getEntry(key).status !== 'ready') {
        setEntry(key, { ids: EMPTY_IDS, status: 'unreadable', saveFailed: false });
      }
      if (loads.get(key) === run) loads.delete(key);
    });
  loads.set(key, run);
  return run;
}

/** Resolves `true` once the change is stored, `false` when it was refused or rolled back. */
function save(key: string, change: (stored: ReadonlySet<string>) => ReadonlySet<string>): Promise<boolean> {
  if (getEntry(key).status !== 'ready') return Promise.resolve(false);
  const chain = (saves.get(key) ?? Promise.resolve(true)).then(async () => {
    const previous = getEntry(key);
    if (previous.status !== 'ready') return false;
    const ids = change(previous.ids);
    setEntry(key, { ids, status: 'ready', saveFailed: false });
    try {
      await putToStorage(key, [...ids]);
      return true;
    } catch (error) {
      setEntry(key, { ...previous, saveFailed: true });
      console.warn('[tokens] Could not save hidden tokens', error);
      return false;
    }
  });
  saves.set(key, chain);
  return chain;
}

/** Test seam: forgets every key's set, its in-flight read and its save chain. */
export function resetHiddenTokens(): void {
  entries.clear();
  loads.clear();
  saves.clear();
  notify();
}

export function useHiddenTokens(address: string): HiddenTokens {
  const key = storageKey(getEffectiveNetworkName(), address);
  const snapshot = () => getEntry(key);
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot);
  const nativeFaucetId = useMidenFaucetId();
  const nativeId = nativeFaucetId === null ? null : normalizedFaucetId(nativeFaucetId);

  useEffect(() => {
    void load(key);
  }, [key]);

  // Until the native id is known the stored set is reported as it is: withholding it would put every
  // hidden token back on Home for the first moments of each cold start.
  const ids = useMemo(() => {
    const canonical = new Set(Array.from(entry.ids, id => normalizedFaucetId(id)));
    if (nativeId !== null) canonical.delete(nativeId);
    return canonical;
  }, [entry.ids, nativeId]);

  const isHidden = useCallback((tokenId: string) => ids.has(normalizedFaucetId(tokenId)), [ids]);

  return {
    ids,
    loaded: entry.status === 'ready',
    failed: entry.status === 'unreadable' || entry.saveFailed,
    isHidden,
    hide: (tokenId: string) => {
      const id = normalizedFaucetId(tokenId);
      // Until the native id is known any token might be it, so nothing new is hidden yet.
      if (nativeId === null || id === nativeId) return Promise.resolve(false);
      return save(key, stored =>
        [...stored].some(storedId => normalizedFaucetId(storedId) === id) ? stored : new Set([...stored, id])
      );
    },
    unhide: (tokenId: string) => {
      const id = normalizedFaucetId(tokenId);
      return save(key, stored => new Set([...stored].filter(storedId => normalizedFaucetId(storedId) !== id)));
    }
  };
}
