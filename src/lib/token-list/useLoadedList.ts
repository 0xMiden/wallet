import { useEffect, useState } from 'react';

import { onTokenListUpdated } from './runtime';

type Loaded<T> = { network: string; value: T };

/**
 * What `load` gives `network`; until this hook's own load lands (on the first render and after a
 * network switch), what `peek` says the realm last loaded, so a list already loaded draws at once.
 * `undefined` while neither has a value and while `load` is `null` (which loads nothing). Loaded again
 * when a refresh of `network`'s list lands; a reload that `same` finds equal to what was last stored
 * stores nothing, so it renders nothing. `load`, `peek` and `same` must be stable, as module-level
 * functions are.
 */
export function useLoadedList<T>(
  network: string,
  load: ((network: string) => Promise<T>) | null,
  peek: (network: string) => T | undefined,
  same: (a: T, b: T) => boolean
): T | undefined {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);

  useEffect(() => {
    if (!load) return undefined;
    let current = true;
    // What this effect last stored: a functional update returning the old state would still render
    // once, so an unchanged reload must not reach setLoaded at all.
    let stored: { value: T } | undefined;
    const reload = () =>
      load(network).then(value => {
        if (!current || (stored && same(stored.value, value))) return;
        stored = { value };
        setLoaded({ network, value });
      });
    void reload();
    const unsubscribe = onTokenListUpdated(updated => {
      if (updated === network) void reload();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [network, load, same]);

  if (load === null) return undefined;
  // A value loaded for another network says nothing about this one.
  return loaded?.network === network ? loaded.value : peek(network);
}
