import { createStoredIdSet } from 'lib/miden/front/stored-id-set';

/**
 * Which incoming transfers have been declined, per account, in a stored-id-set store
 * (`lib/miden/front/stored-id-set`): a decline taken on the Activity tab reaches the home banner
 * that `TabLayout` keeps mounted at once, so it stops counting the transfer as waiting, and a
 * decline or restore in one extension window shows in the others without any window's save undoing it.
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
    /**
     * Removes exactly the given ids, so a decline another window stored, or one adopted from an
     * event for a transfer this window's list has not loaded, stays declined. The caller passes the
     * ids it counted: this window's set when the change applies can already hold another window's
     * decline, folded in by a save queued ahead of this one.
     *
     * The stored list is never pruned: an id with no transfer in this window's list may be for a
     * transfer this window has not loaded yet, which another window declined, and no window can tell
     * that apart from a transfer that is gone. So a decline stays stored until a window that counts it
     * restores it, at a cost of one id per decline carried in every save.
     */
    restore: (ids: readonly string[]) => store.save(key, hidden => new Set([...hidden].filter(id => !ids.includes(id))))
  };
}
