import { useRef } from 'react';

/**
 * The data a read shows: its live data while it runs, and the last data it received for this same key while it does
 * not (a retained page off screen stays visible behind the page above it). Never data from another key.
 */
export function useLastData<T>(key: unknown[], running: boolean, live: T | undefined): T | undefined {
  const last = useRef<{ id: string; data: T } | null>(null);
  const id = JSON.stringify(key);
  if (running && live !== undefined) last.current = { id, data: live };
  const kept = last.current?.id === id ? last.current.data : undefined;
  return running ? (live ?? kept) : kept;
}
