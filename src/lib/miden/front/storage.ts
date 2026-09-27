import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import isEqual from 'fast-deep-equal';
import { mutate as mutateCache, useSWRConfig } from 'swr';

import { isExtension } from 'lib/platform';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { useRetryableSWR } from 'lib/swr';

/** The setter rejects when the write fails, so a caller that does not await it must catch. */
export function useStorage<T = any>(key: string, fallback?: T): [T, (val: SetStateAction<T>) => Promise<void>] {
  const { data } = useRetryableSWR<T | null>(key, readForHook<T>, {
    suspense: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });
  const { cache } = useSWRConfig();

  // On the extension each commit to the key arrives here, this page's own included; a removal carries no newValue.
  useEffect(() => onStorageChanged<unknown>(key, newValue => settle(key, begin(), newValue ?? null)), [key]);

  const value = fallback !== undefined ? (data ?? fallback) : data!;

  const setValue = useCallback(
    async (val: SetStateAction<T>) => {
      // The base is the cache, which holds the newest value that landed; the rendered value can lag it.
      const current: T = cache.get(key)?.data ?? fallback;
      await writeThrough(key, isUpdater(val) ? val(current) : val);
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
  const { data } = useRetryableSWR<T | null>(key, readForHook<T>, {
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
    void writeThrough(key, value).catch(ignoreFailedWrite);
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

// Every storage operation on a key takes a number when this page issues or receives it, and the cache keeps the
// value of the highest-numbered one that succeeded: an action gives way only to a newer one that landed, so a
// failure never blocks an older success. Issue order is storage order, since each backend runs a page's calls
// in call order.
let lastSeq = 0;
// Per key, the number of the operation whose value the cache entry holds.
const appliedSeq = new Map<string, number>();
const begin = () => ++lastSeq;

// The only writer of a storage key's SWR cache entry. A mutate with a value or a sync updater writes before its first
// await, so the check and the write are one step. A read parses a fresh copy and consumers key effects on the value's
// identity, so an equal value keeps the cached reference.
function settle(key: string, seq: number, value: unknown) {
  if (seq <= (appliedSeq.get(key) ?? 0)) return;
  appliedSeq.set(key, seq);
  void mutateCache(key, (cached: unknown) => (isEqual(cached, value) ? cached : value), { revalidate: false });
}

const ignoreFailedWrite = () => {};

async function writeThrough(key: string, value: unknown): Promise<void> {
  const seq = begin();
  await putToStorage(key, value);
  settle(key, seq, value);
}

// SWR keeps a fetch result only when no mutate touched the key after the fetch began. Here one always did: this
// read's own settle, or the newer operation that outnumbered it, so the cache only ever takes settle's value.
async function readForHook<T>(key: string): Promise<T | null> {
  const seq = begin();
  const value = await fetchFromStorage<T>(key);
  settle(key, seq, value);
  return value;
}

/**
 * Reads storage keys into the SWR cache before any `useStorage` / `usePassiveStorage` asks for them.
 * Both hooks suspend while their key is uncached, and a suspension hides everything up to the nearest
 * Suspense boundary, so a key first read by a component that mounts late should be preloaded.
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
      const seq = begin();
      try {
        settle(key, seq, await fetchFromStorage(key));
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

export async function putToStorage<T = any>(key: string, value: T) {
  const storage = getStorageProvider();
  return await storage.set({ [key]: value });
}
