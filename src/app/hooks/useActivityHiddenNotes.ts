import { useEffect, useRef, useState } from 'react';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

export function useActivityHiddenNotes(address: string) {
  const key = `activity-hidden-notes:${address}`;
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const current = useRef<ReadonlySet<string>>(new Set());
  // An unreadable list stays read-only: writing it would replace every transfer declined before
  // with the one being declined now.
  const [status, setStatus] = useState<'loading' | 'ready' | 'unreadable'>('loading');
  const [saveFailed, setSaveFailed] = useState(false);
  // Saves run one at a time, each from the list the previous one left, so none is dropped.
  const saves = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    // A read for an address this hook has moved past must not replace the current one.
    let cancelled = false;
    fetchFromStorage<string[]>(key)
      .then(stored => {
        if (cancelled) return;
        const next = new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
        current.current = next;
        setIds(next);
        setStatus('ready');
      })
      .catch(error => {
        console.warn('[activity] Could not load hidden notes', error);
        if (!cancelled) setStatus('unreadable');
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const save = (change: (hidden: ReadonlySet<string>) => ReadonlySet<string>) => {
    if (status !== 'ready') return Promise.resolve();
    saves.current = saves.current.then(async () => {
      const previous = current.current;
      const next = change(previous);
      current.current = next;
      setIds(next);
      setSaveFailed(false);
      try {
        await putToStorage(key, [...next]);
      } catch (error) {
        current.current = previous;
        setIds(previous);
        setSaveFailed(true);
        console.warn('[activity] Could not save hidden notes', error);
      }
    });
    return saves.current;
  };

  return {
    ids,
    loaded: status === 'ready',
    failed: status === 'unreadable' || saveFailed,
    hide: (id: string) => save(hidden => new Set([...hidden, id])),
    /** Brings back the given notes, or every declined note when none are given. */
    restore: (ids?: readonly string[]) =>
      save(hidden => (ids ? new Set([...hidden].filter(id => !ids.includes(id))) : new Set()))
  };
}
