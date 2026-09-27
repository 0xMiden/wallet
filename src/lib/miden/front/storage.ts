import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { mutate as mutateCache } from 'swr';

import { isExtension } from 'lib/platform';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { useRetryableSWR } from 'lib/swr';

export function useStorage<T = any>(key: string, fallback?: T): [T, (val: SetStateAction<T>) => Promise<void>] {
  const { data, mutate } = useRetryableSWR<T>(key, fetchForHook as (key: string) => Promise<T>, {
    suspense: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });

  useEffect(
    () =>
      onStorageChanged<T>(key, newValue => {
        supersedeReads(key);
        mutate(newValue);
      }),
    [key, mutate]
  );

  const value = fallback !== undefined ? (data ?? fallback) : data!;

  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const setValue = useCallback(
    async (val: SetStateAction<T>) => {
      const nextValue = typeof val === 'function' ? (val as any)(valueRef.current) : val;
      await writeThrough(key, nextValue);
      valueRef.current = nextValue;
    },
    [key]
  );

  return useMemo(() => [value, setValue], [value, setValue]);
}

export function usePassiveStorage<T = any>(key: string, fallback?: T): [T, Dispatch<SetStateAction<T>>] {
  const { data } = useRetryableSWR<T>(key, fetchForHook as (key: string) => Promise<T>, {
    suspense: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });
  const finalData = fallback !== undefined ? (data ?? fallback) : data!;

  const [value, setValue] = useState<T>(finalData as T);
  const prevValue = useRef(value);

  useEffect(() => {
    if (prevValue.current !== value) {
      prevValue.current = value;
      writeThrough(key, value);
    }
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

// Each key's preload read still in flight, with its value once it lands. A hook read, a write, a change event or a
// later preload removes or replaces the entry, so a preload still holding it when it lands is the key's newest read
// and replaces whatever the cache holds.
interface PreloadRead {
  landed?: { value: unknown };
}
const preloadReads = new Map<string, PreloadRead>();

// Bumped by every write, change event and preload start of a key, so an action that finishes late can tell whether
// a newer one of the key happened meanwhile.
const epochs = new Map<string, number>();

function bumpEpoch(key: string) {
  const epoch = (epochs.get(key) ?? 0) + 1;
  epochs.set(key, epoch);
  return epoch;
}

function supersedeReads(key: string) {
  preloadReads.delete(key);
  return bumpEpoch(key);
}

async function writeThrough(key: string, value: unknown) {
  const epoch = supersedeReads(key);
  await putToStorage(key, value);
  // The cache backs every reader of this key; off the extension no change event updates it. A newer write, change
  // event or preload of the key carries a newer value than this one, even when this write finishes last.
  if (epochs.get(key) === epoch) await mutateCache(key, value, { revalidate: false });
}

async function fetchForHook(key: string): Promise<unknown> {
  const preload = preloadReads.get(key);
  const epoch = epochs.get(key);
  preloadReads.delete(key);
  try {
    return await fetchFromStorage(key);
  } catch (error) {
    // Only a value already read: awaiting a preload still in flight could hang this reader with it.
    if (preload?.landed) return preload.landed.value;
    // Handed back, its landing fills the cache for a retry or remount, unless something newer reached the key.
    if (preload && epochs.get(key) === epoch) preloadReads.set(key, preload);
    throw error;
  }
}

/**
 * Reads storage keys into the SWR cache before any `useStorage` / `usePassiveStorage` asks for them.
 * Both hooks suspend while their key is uncached, and a suspension hides everything up to the nearest
 * Suspense boundary, so a key first read by a component that mounts late should be preloaded.
 * A key that a hook read, a write, a change event or a later preload reached meanwhile is left to that newer one.
 * Settles only after every key has, calling `onSettled` once per key; rejects once, naming each key that failed.
 */
export async function preloadStorage(
  keys: string[],
  { onSettled }: { onSettled?: (key: string) => void } = {}
): Promise<void> {
  const results = await Promise.allSettled(
    keys.map(async key => {
      bumpEpoch(key);
      const read = fetchFromStorage(key);
      const entry: PreloadRead = {};
      preloadReads.set(key, entry);
      try {
        const value = await read;
        entry.landed = { value };
        if (preloadReads.get(key) !== entry) return;
        await mutateCache(key, value, { revalidate: false });
      } finally {
        if (preloadReads.get(key) === entry) preloadReads.delete(key);
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
