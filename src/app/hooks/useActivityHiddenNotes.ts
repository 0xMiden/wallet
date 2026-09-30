import { createStoredIdSet } from 'lib/miden/front/stored-id-set';

/**
 * Which incoming transfers have been declined, per account, in a stored-id-set store
 * (`lib/miden/front/stored-id-set`): a decline taken on the Activity tab reaches the home banner
 * that `TabLayout` keeps mounted at once, so it stops counting the transfer as waiting.
 */

const store = createStoredIdSet('activity');

const storageKey = (address: string) => `activity-hidden-notes:${address}`;

/** Test seam: forgets every account's set, as a wipe does, without reading it again. */
export const resetActivityHiddenNotes = store.reset;

export function useActivityHiddenNotes(address: string) {
  const key = storageKey(address);
  const entry = store.useEntry(key);

  return {
    ids: entry.ids,
    loaded: entry.status === 'ready',
    failed: entry.status === 'unreadable' || entry.saveFailed,
    hide: (id: string) => store.save(key, hidden => new Set([...hidden, id])),
    /** Brings back the given notes, or every declined note when none are given. */
    restore: (ids?: readonly string[]) =>
      store.save(key, hidden => (ids ? new Set([...hidden].filter(id => !ids.includes(id))) : new Set<string>()))
  };
}
