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

  useEffect(() => onStorageChanged(key, mutate), [key, mutate]);

  const value = fallback !== undefined ? (data ?? fallback) : data!;

  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const setValue = useCallback(
    async (val: SetStateAction<T>) => {
      const nextValue = typeof val === 'function' ? (val as any)(valueRef.current) : val;
      preloadReads.delete(key);
      await putToStorage(key, nextValue);
      // The cache backs every reader of this key; off the extension no change event updates it.
      await mutateCache(key, nextValue, { revalidate: false });
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
    const put = async () => {
      if (prevValue.current !== value) {
        prevValue.current = value;
        preloadReads.delete(key);
        await putToStorage(key, value);
        await mutateCache(key, value, { revalidate: false });
      }
    };
    put();
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

// Each key's preload read still in flight, with its value once it lands. A hook read, a write, or a later preload
// removes or replaces the entry, so a preload still holding it when it lands is the key's newest read and replaces
// whatever the cache holds.
interface PreloadRead {
  read: Promise<unknown>;
  landed?: { value: unknown };
}
const preloadReads = new Map<string, PreloadRead>();

async function fetchForHook(key: string): Promise<unknown> {
  const preload = preloadReads.get(key);
  preloadReads.delete(key);
  try {
    return await fetchFromStorage(key);
  } catch (error) {
    // Only a value already read: awaiting a preload still in flight could hang this reader with it.
    if (preload?.landed) return preload.landed.value;
    throw error;
  }
}

/**
 * Reads storage keys into the SWR cache before any `useStorage` / `usePassiveStorage` asks for them.
 * Both hooks suspend while their key is uncached, and a suspension hides everything up to the nearest
 * Suspense boundary, so a key first read by a component that mounts late should be preloaded.
 * A key whose read a hook, a write, or a later preload started meanwhile is left to that newer read.
 * Settles only after every key has, calling `onSettled` once per key; rejects once, naming each key that failed.
 */
export async function preloadStorage(
  keys: string[],
  { onSettled }: { onSettled?: (key: string) => void } = {}
): Promise<void> {
  const results = await Promise.allSettled(
    keys.map(async key => {
      const entry: PreloadRead = { read: fetchFromStorage(key) };
      preloadReads.set(key, entry);
      try {
        const value = await entry.read;
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
