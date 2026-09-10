import { useEffect, useRef, useState } from 'react';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

export function useActivityHiddenNotes(address: string) {
  const key = `activity-hidden-notes:${address}`;
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const current = useRef<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const writing = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const read = async () => {
      try {
        const stored = await fetchFromStorage<string[]>(key);
        if (!mounted.current) return;
        const next = new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
        current.current = next;
        setIds(next);
      } catch (error) {
        if (mounted.current) setFailed(true);
        console.warn('[activity] Could not load hidden notes', error);
      } finally {
        if (mounted.current) setLoaded(true);
      }
    };
    read();
    return () => {
      mounted.current = false;
    };
  }, [key]);

  const save = async (next: ReadonlySet<string>) => {
    if (!loaded || writing.current) return;
    writing.current = true;
    const previous = current.current;
    current.current = next;
    setIds(next);
    setFailed(false);
    try {
      await putToStorage(key, [...next]);
    } catch (error) {
      current.current = previous;
      if (mounted.current) {
        setIds(previous);
        setFailed(true);
      }
      console.warn('[activity] Could not save hidden notes', error);
    } finally {
      writing.current = false;
    }
  };

  return {
    ids,
    loaded,
    failed,
    hide: (id: string) => save(new Set([...current.current, id])),
    restore: () => save(new Set())
  };
}
