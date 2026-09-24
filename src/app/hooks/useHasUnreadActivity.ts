import { useEffect, useState } from 'react';

import { useActivityHiddenNotes } from 'app/hooks/useActivityHiddenNotes';
import { useClaimCheckInvalidNoteIds } from 'app/hooks/useClaimNotes';
import { historyEntryUnreadKey, pendingNoteUnreadKey } from 'app/templates/history/activityUnread';
import { suppressLinkedConsumes } from 'app/templates/history/History';
import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import { getCompletedTransactions, getUncompletedTransactions } from 'lib/miden/activity';
import { ITransaction } from 'lib/miden/db/types';
import { useAccount } from 'lib/miden/front';
import { useManuallyClaimableNotes } from 'lib/miden/front/auto-managed-notes';
import { isActivityRead, useActivityReadState } from 'lib/settings/activity-read';

/**
 * How many of the account's completed and failed rows count.
 *
 * It bounds what counts, not what is read: the rows are read whole through History's own loaders.
 * Once the newest `RECENT_ROWS` of them are read, anything older is read too in every case that
 * matters: the read state collapses old reads into a high-water mark, and a user who has opened
 * the last fifty things has been down the list. Every in-flight row counts regardless.
 */
const RECENT_ROWS = 50;

interface RecentRow {
  id: string;
  timestamp: number;
}

const toRecentRow = (row: ITransaction, timestamp: number): RecentRow => ({
  id: historyEntryUnreadKey({ key: row.id, txId: row.id }),
  timestamp
});

/**
 * The rows History shows for `address`, through the same loaders and the same settlement-consume
 * suppression, so the tab never counts a row the feed does not show. Each is stamped the way
 * History dates it, so the two agree about which side of the high-water mark it falls on.
 */
async function readRecentRows(address: string): Promise<RecentRow[]> {
  const [uncompleted, completed] = await Promise.all([
    getUncompletedTransactions(address).then(suppressLinkedConsumes),
    getCompletedTransactions(address, undefined, undefined, true).then(suppressLinkedConsumes)
  ]);
  return [
    ...uncompleted.map(row => toRecentRow(row, row.initiatedAt)),
    // Ascending, so the newest are at the end.
    ...completed.slice(-RECENT_ROWS).map(row => toRecentRow(row, row.completedAt ?? row.initiatedAt))
  ];
}

/**
 * Whether anything in Activity is unread: an incoming transfer still waiting to be accepted or
 * declined, or a recent transaction whose detail has never been opened.
 *
 * Deliberately not "are there claimable notes", which is what the tab's dot used to mean: a
 * transfer the user has already declined is still claimable, and its dot never went out.
 *
 * Backed by a Dexie `liveQuery`, so the indicator lights the moment a transaction lands rather
 * than on the next poll, and by `useActivityReadState`, so it goes out the moment the last unread
 * row is read.
 */
export function useHasUnreadActivity(): boolean {
  const address = useAccount().publicKey;
  const { data: claimableNotes } = useManuallyClaimableNotes(address);
  const hiddenNotes = useActivityHiddenNotes(address);
  const unavailableNotes = useClaimCheckInvalidNoteIds(address);
  const readState = useActivityReadState();
  const [recent, setRecent] = useState<RecentRow[]>([]);

  useEffect(
    () =>
      subscribeToLiveQuery(() => readRecentRows(address), {
        next: setRecent,
        error: error => console.warn('[activity] Could not read recent transactions', error)
      }),
    [address]
  );

  // A DECLINED transfer is not waiting for anything, so it marks nothing unread. Declining marks
  // it read as it happens, but a transfer declined by a build that had no read state at all would
  // otherwise keep the tab lit forever; the hidden set is the authority either way. A transfer
  // Activity's check has found unavailable cannot be accepted, so it waits for nothing either.
  const unreadTransfer = (claimableNotes ?? []).some(
    note =>
      !hiddenNotes.ids.has(note.id) &&
      !unavailableNotes.has(note.id) &&
      !isActivityRead(readState, pendingNoteUnreadKey(note.id), note.receivedAt ?? Number.NaN)
  );
  if (unreadTransfer) return true;
  return recent.some(row => !isActivityRead(readState, row.id, row.timestamp));
}
