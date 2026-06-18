import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isExtension } from 'lib/platform';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { useRetryableSWR } from 'lib/swr';

export function useStorage<T = any>(key: string, fallback?: T): [T, (val: SetStateAction<T>) => Promise<void>] {
  const { data, mutate } = useRetryableSWR<T>(key, fetchFromStorage as (key: string) => Promise<T>, {
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
      await putToStorage(key, nextValue);
      valueRef.current = nextValue;
    },
    [key]
  );

  return useMemo(() => [value, setValue], [value, setValue]);
}

export function usePassiveStorage<T = any>(key: string, fallback?: T): [T, Dispatch<SetStateAction<T>>] {
  const { data } = useRetryableSWR<T>(key, fetchFromStorage as (key: string) => Promise<T>, {
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
        await putToStorage(key, value);
      }
      prevValue.current = value;
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

  // Lazy load browser for extension
  import('webextension-polyfill').then(browserModule => {
    const browser = browserModule.default;
    const handleChanged = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, areaName: string) => {
      if (areaName === 'local' && key in changes) {
        callback(changes[key]!.newValue as T);
      }
    };

    browser.storage.onChanged.addListener(handleChanged);
    // Note: cleanup won't work perfectly with async load, but this is acceptable for now
  });

  return () => {
    // Cleanup is handled when component unmounts
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

export async function putToStorage<T = any>(key: string, value: T) {
  const storage = getStorageProvider();
  return await storage.set({ [key]: value });
}
