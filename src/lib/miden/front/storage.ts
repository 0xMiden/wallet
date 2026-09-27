import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { mutate as mutateCache } from 'swr';

import { isExtension } from 'lib/platform';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { useRetryableSWR } from 'lib/swr';

export function useStorage<T = any>(key: string, fallback?: T): [T, (val: SetStateAction<T>) => Promise<void>] {
  const { data, mutate } = useRetryableSWR<T | null>(key, fetchForHook as (key: string) => Promise<T | null>, {
    suspense: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });

  // A removed key reads as null, as in listenForChanges; undefined would suspend this mounted reader.
  useEffect(() => onStorageChanged<T | undefined>(key, newValue => mutate(newValue ?? null)), [key, mutate]);

  const value = fallback !== undefined ? (data ?? fallback) : data!;

  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const setValue = useCallback(
    async (val: SetStateAction<T>) => {
      const nextValue = typeof val === 'function' ? (val as any)(valueRef.current) : val;
      await putToStorage(key, nextValue);
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
        await putToStorage(key, value);
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

// Each key's preload read still in flight, with its value once it lands. Whatever supersedes a preload (see
// preloadStorage) removes or replaces its entry, so a preload still holding it when it lands is the key's newest read.
interface PreloadRead {
  read: Promise<unknown>;
  landed?: { value: unknown };
}
const preloadReads = new Map<string, PreloadRead>();

// The keys a hook read or a landed preload put in the SWR cache. Writes, wipes and change events update only these,
// so a key nobody read never gets a cache entry.
const cachedKeys = new Set<string>();
let listeningForChanges = false;

function markCached(key: string) {
  cachedKeys.add(key);
  if (!listeningForChanges && isExtension()) {
    listeningForChanges = true;
    listenForChanges();
  }
}

// A useStorage hook hears a change only while mounted, but the service worker or the options page can write or wipe
// a key this page cached for a passive reader or a preload no hook has read yet.
function listenForChanges() {
  import('webextension-polyfill').then(browserModule => {
    browserModule.default.storage.onChanged.addListener(
      (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, areaName: string) => {
        if (areaName !== 'local') return;
        for (const key of Object.keys(changes)) {
          // A removed key reads as null; an undefined cache entry would suspend its next reader instead.
          if (cachedKeys.has(key)) void mutateCache(key, changes[key]!.newValue ?? null, { revalidate: false });
        }
      }
    );
  });
}

async function fetchForHook(key: string): Promise<unknown> {
  markCached(key);
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
 * A hook read, a `putToStorage` write or a later preload of a key, started meanwhile, supersedes the key's preload,
 * and the cache keeps that newer value. An `invalidateStorageCache` wipe supersedes every preload in flight; a key
 * it does not re-read stays uncached until a hook reads it from storage.
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
        markCached(key);
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
  preloadReads.delete(key);
  await getStorageProvider().set({ [key]: value });
  // The cache backs every reader of this key; off the extension no change event updates it.
  if (cachedKeys.has(key)) await mutateCache(key, value, { revalidate: false });
}

/**
 * After a wipe of the key-value store, first drops every preload still in flight, then re-reads every storage
 * key the SWR cache holds, so a reader mounted afterwards renders what storage now holds rather than the
 * previous wallet's value. A key whose read fails keeps its cached value; the others still update.
 */
export async function invalidateStorageCache(): Promise<void> {
  preloadReads.clear();
  await Promise.allSettled(
    // With data, not a bare mutate(key), which SWR only turns into a revalidation of a mounted hook.
    [...cachedKeys].map(key => mutateCache(key, fetchFromStorage(key), { revalidate: false }))
  );
}
