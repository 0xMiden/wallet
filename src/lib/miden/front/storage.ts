import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import isEqual from 'fast-deep-equal';
import { mutate as mutateCache, useSWRConfig } from 'swr';

import { isExtension } from 'lib/platform';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { useRetryableSWR } from 'lib/swr';

/** The setter rejects when the write fails, so a caller that does not await it must catch. */
export function useStorage<T = any>(key: string, fallback?: T): [T, (val: SetStateAction<T>) => Promise<void>] {
  const { data } = useRetryableSWR<T | null>(key, readThrough<T>, {
    suspense: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });
  const { cache } = useSWRConfig();

  const value = fallback !== undefined ? (data ?? fallback) : data!;

  const setValue = useCallback(
    async (val: SetStateAction<T>) => {
      // The base is the cache, which holds the newest value that landed from any writer; the rendered value can lag it.
      const current: T = cache.get(key)?.data ?? fallback;
      await putToStorage(key, isUpdater(val) ? val(current) : val);
    },
    [cache, key, fallback]
  );

  return useMemo(() => [value, setValue], [value, setValue]);
}

// A stored value is never a function, so a function is SetStateAction's updater form.
function isUpdater<T>(val: SetStateAction<T>): val is (prev: T) => T {
  return typeof val === 'function';
}

/** A failed write is swallowed, and the component keeps its value. */
export function usePassiveStorage<T = any>(key: string, fallback?: T): [T, Dispatch<SetStateAction<T>>] {
  const { data } = useRetryableSWR<T | null>(key, readThrough<T>, {
    suspense: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });
  const finalData = fallback !== undefined ? (data ?? fallback) : data!;

  const [value, setValue] = useState<T>(finalData as T);
  const prevValue = useRef(value);

  useEffect(() => {
    if (prevValue.current === value) return;
    // Set before the write, so going back to the stored value while it is in flight writes again. The component's
    // value leads: a failed write leaves it shown and the cache as it was.
    prevValue.current = value;
    void putToStorage(key, value).catch(ignoreFailedWrite);
  }, [key, value]);

  return [value, setValue];
}

export function onStorageChanged<T = any>(key: string, callback: (newValue: T) => void) {
  // On mobile/desktop, storage change events are not available
  // Return a no-op cleanup function
  if (!isExtension()) {
    return () => {};
  }

  // Lazy load browser for extension. The import resolves after this function
  // returns, so unsubscribing has to cope with both orders: cancelled before
  // the listener was ever added, and cancelled after.
  let unsubscribe: (() => void) | undefined;
  let cancelled = false;

  import('webextension-polyfill').then(browserModule => {
    if (cancelled) return;
    const browser = browserModule.default;
    const handleChanged = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, areaName: string) => {
      if (areaName === 'local' && key in changes) {
        callback(changes[key]!.newValue as T);
      }
    };

    browser.storage.onChanged.addListener(handleChanged);
    unsubscribe = () => browser.storage.onChanged.removeListener(handleChanged);
  });

  return () => {
    cancelled = true;
    unsubscribe?.();
    unsubscribe = undefined;
  };
}

export async function fetchFromStorage<T = unknown>(key: string): Promise<T | null> {
  const storage = getStorageProvider();
  const items = await storage.get([key]);
  if (key in items) {
    return items[key] as T;
  } else {
    return null;
  }
}

// Every storage operation on a key takes a number when this page issues or receives it (a read, a wipe's re-read
// included, a putToStorage write, a change event), and the cache keeps the value of the highest-numbered one that
// succeeded: an action gives way only to a newer one that landed, so a failure never blocks an older success. Issue
// order is storage order, since each backend runs a page's calls in call order.
let lastSeq = 0;
// Per key, the number of the operation whose value the cache entry holds.
const appliedSeq = new Map<string, number>();
// The keys a storage hook or a preload has read, each marked when its read is issued. The cache holds only these: an
// operation on any other key takes a number and settles nothing, so a realm with no reader never touches SWR.
const cachedKeys = new Set<string>();
const begin = () => ++lastSeq;

// The only writer of a storage key's SWR cache entry. A mutate with a value or a sync updater writes before its first
// await, so the check and the write are one step. A read parses a fresh copy and consumers key effects on the value's
// identity, so an equal value keeps the cached reference. A removed key settles as null: an undefined entry is an
// uncached one, which suspends every reader of the key.
function settle(key: string, seq: number, value: unknown) {
  if (!cachedKeys.has(key) || seq <= (appliedSeq.get(key) ?? 0)) return;
  appliedSeq.set(key, seq);
  const next = value ?? null;
  void mutateCache(key, (cached: unknown) => (isEqual(cached, next) ? cached : next), { revalidate: false });
}

const ignoreFailedWrite = () => {};

let changeListener: Promise<void> | 'attached' | undefined;

// One listener per extension page settles every cached key, mounted or not, from any realm's commit (a removal carries
// no newValue). It is never removed. Returns the pending attach; undefined off the extension and once attached. A
// failed attach, the import or addListener, resets so the next read retries; a kept rejection would fail every read.
function listenForChanges(): Promise<void> | undefined {
  if (changeListener === 'attached' || !isExtension()) return undefined;
  changeListener ??= import('webextension-polyfill')
    .then(({ default: browser }) => {
      browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        for (const [key, change] of Object.entries(changes)) settle(key, begin(), change.newValue);
      });
      changeListener = 'attached';
    })
    .catch(error => {
      changeListener = undefined;
      console.warn('[storage] not listening for storage changes yet:', error);
    });
  return changeListener;
}

// SWR keeps a fetch result only when no mutate touched the key after the fetch began. Here one always did: this
// read's own settle, or the newer operation that outnumbered it, so the cache only ever takes settle's value.
async function readThrough<T>(key: string): Promise<T | null> {
  // Marked before the read is issued, so a write that lands while the read is in flight settles too.
  cachedKeys.add(key);
  // Off the extension, or once the listener is attached, a read is numbered when it is called, so a write
  // called after it is numbered after it. Every read issued while an attach is pending (a page's first reads,
  // and reads after a failed attach) waits for the attach and is numbered when its storage call is issued: if
  // the attach succeeds, a change committed after that call is heard; if it fails, the read goes through
  // unheard and the next read retries.
  const attaching = listenForChanges();
  if (attaching) await attaching;
  const seq = begin();
  const value = await fetchFromStorage<T>(key);
  settle(key, seq, value);
  return value;
}

/**
 * Reads storage keys into the SWR cache before any `useStorage` / `usePassiveStorage` asks for them.
 * Both hooks suspend while their key is uncached, and a suspension hides everything up to the nearest
 * Suspense boundary, so a key first read by a component that mounts late should be preloaded.
 * `rereadStorageCache` re-reads every cached key through here after a wipe.
 * A key's read replaces the cached value unless an operation on the key that started after it (a read, a write
 * or a change event) landed first; one that failed does not count.
 * Settles only after every key has, calling `onSettled` once per key; rejects once, naming each key that failed.
 */
export async function preloadStorage(
  keys: string[],
  { onSettled }: { onSettled?: (key: string) => void } = {}
): Promise<void> {
  const results = await Promise.allSettled(
    keys.map(async key => {
      try {
        await readThrough(key);
      } finally {
        onSettled?.(key);
      }
    })
  );
  const failures = keys.flatMap((key, index) => {
    const result = results[index];
    return result?.status === 'rejected' ? [`${key} (${String(result.reason)})`] : [];
  });
  if (failures.length > 0) {
    throw new Error(`storage preload failed for ${failures.length} of ${keys.length} keys: ${failures.join('; ')}`);
  }
}

/**
 * After a wipe of the key-value store: re-reads every key a storage hook or a preload has read, through the numbered
 * read path, so each reader mounted afterwards renders what storage holds now. Never rejects; a key whose read fails
 * keeps its cached value, and the failure is logged.
 */
export async function rereadStorageCache(): Promise<void> {
  await preloadStorage([...cachedKeys]).catch(error => console.warn('[storage] re-read after a wipe failed:', error));
}

/**
 * Writes a key and, once storage takes it, settles the value into the storage hooks' cache, numbered when the write
 * is issued. Write a key a storage hook reads only through here or the hook's setter: `getStorageProvider().set`
 * bypasses the cache, which then stays stale on mobile and desktop, where no change event reaches it.
 */
export async function putToStorage<T = any>(key: string, value: T) {
  const seq = begin();
  await getStorageProvider().set({ [key]: value });
  settle(key, seq, value);
}

// Each turn name's chain in this realm, used only without Web Locks (iOS before 15.4, older macOS web views), where
// this realm is the only writer, so ordering its own turns is enough.
const storageTurnTails = new Map<string, Promise<void>>();

/**
 * Runs `operation` as one turn named `name`: under the Web Lock of that name, which every extension surface (popup,
 * side panel, tabs, service worker) shares, or, without Web Locks, after this realm's earlier turns of that name. A
 * turn whose operation fails does not stop the next one.
 */
export async function inStorageTurn<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    // The type argument: without it @types/web-locks-api's `Promise<undefined>` overload wins over the generic one.
    return navigator.locks.request<Promise<T>>(name, operation);
  }
  const run = (storageTurnTails.get(name) ?? Promise.resolve()).then(operation);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  storageTurnTails.set(name, settled);
  return run;
}
