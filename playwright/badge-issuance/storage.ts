import { useSyncExternalStore } from 'react';
import { BADGE_STORAGE_KEY } from '../../src/lib/badges/types';

const listeners = new Set<() => void>();
let value: unknown = JSON.parse(localStorage.getItem(BADGE_STORAGE_KEY) ?? '[]');
export const fetchFromStorage = async () => value;
export async function putToStorage(key: string, next: unknown) {
  localStorage.setItem(key, JSON.stringify(next));
  value = next;
  listeners.forEach(listener => listener());
}
export function useStorage() {
  return [
    useSyncExternalStore(
      listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => value
    )
  ];
}
export const inStorageTurn = async <T>(_key: string, operation: () => Promise<T>) => operation();
