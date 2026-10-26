import { ActivityReadState, isActivityRead } from 'lib/settings/activity-read';

import { ActivityGroup } from './activityGroups';
import { IHistoryEntry } from './IHistoryEntry';

/**
 * What the read state is keyed by.
 *
 * Namespaced, because the two kinds of activity are identified by different things and one of
 * them turns into the other: an incoming note is known by its note id long before the claim that
 * consumes it has a transaction id. Sharing one namespace would make the claim and the note it
 * came from indistinguishable, and reading either would clear both.
 */
export const historyEntryUnreadKey = (entry: Pick<IHistoryEntry, 'key' | 'txId'>): string =>
  `tx:${entry.txId ?? entry.key}`;

export const pendingNoteUnreadKey = (noteId: string): string => `note:${noteId}`;

/** Whether a row in the feed is still unread. */
export function isHistoryEntryUnread(state: ActivityReadState, entry: IHistoryEntry): boolean {
  return !isActivityRead(state, historyEntryUnreadKey(entry), entry.timestamp);
}

/**
 * Whether a group holds anything unread.
 *
 * Opening a group does not clear it — a group is a folder, and opening a folder does not read
 * what is in it. Its dot goes out exactly when the last of its children has been read, which is
 * what this computes.
 */
export function isActivityGroupUnread(state: ActivityReadState, group: ActivityGroup): boolean {
  return group.entries.some(entry => isHistoryEntryUnread(state, entry));
}
