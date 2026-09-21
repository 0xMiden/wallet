import { useEffect, useState } from 'react';

import { useActivityHiddenNotes } from 'app/hooks/useActivityHiddenNotes';
import { historyEntryUnreadKey, pendingNoteUnreadKey } from 'app/templates/history/activityUnread';
import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import { ITransaction } from 'lib/miden/db/types';
import { useAccount } from 'lib/miden/front';
import { useManuallyClaimableNotes } from 'lib/miden/front/auto-managed-notes';
import * as Repo from 'lib/miden/repo';
import { isActivityRead, useActivityReadState } from 'lib/settings/activity-read';

/**
 * How far back the tab's indicator looks.
 *
 * It does not need the whole history. Once the newest `RECENT_ROWS` rows are read, anything older
 * is read too in every case that matters: the read state collapses old reads into a high-water
 * mark, and a user who has opened the last fifty things has been down the list. Re-reading the
 * whole table on every write, to decide whether to draw a dot, would not be worth it.
 */
const RECENT_ROWS = 50;

interface RecentRow {
  id: string;
  timestamp: number;
}

/**
 * The newest rows by both stamps. A queued transaction has no `completedAt` at all, so an index
 * scan on that alone would never see the rows most likely to be unread.
 */
async function readRecentRows(): Promise<RecentRow[]> {
  const [byCompleted, byInitiated] = await Promise.all([
    Repo.transactions.orderBy('completedAt').reverse().limit(RECENT_ROWS).toArray(),
    Repo.transactions.orderBy('initiatedAt').reverse().limit(RECENT_ROWS).toArray()
  ]);
  const rows = new Map<string, ITransaction>();
  for (const row of [...byCompleted, ...byInitiated]) rows.set(row.id, row);
  return (
    [...rows.values()]
      // The same stamp `History` dates the row by, so the tab and the feed agree about which side
      // of the high-water mark a transaction falls on.
      .map(row => ({
        id: historyEntryUnreadKey({ key: row.id, txId: row.id }),
        timestamp: row.completedAt ?? row.initiatedAt
      }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, RECENT_ROWS)
  );
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
  const account = useAccount();
  const { data: claimableNotes } = useManuallyClaimableNotes(account.publicKey);
  const hiddenNotes = useActivityHiddenNotes(account.publicKey);
  const readState = useActivityReadState();
  const [recent, setRecent] = useState<RecentRow[]>([]);

  useEffect(
    () =>
      subscribeToLiveQuery(readRecentRows, {
        next: setRecent,
        error: error => console.warn('[activity] Could not read recent transactions', error)
      }),
    []
  );

  // A DECLINED transfer is not waiting for anything, so it marks nothing unread. Declining marks
  // it read as it happens, but a transfer declined by a build that had no read state at all would
  // otherwise keep the tab lit forever; the hidden set is the authority either way.
  const unreadTransfer = (claimableNotes ?? []).some(
    note =>
      !hiddenNotes.ids.has(note.id) &&
      !isActivityRead(readState, pendingNoteUnreadKey(note.id), note.receivedAt ?? Number.NaN)
  );
  if (unreadTransfer) return true;
  return recent.some(row => !isActivityRead(readState, row.id, row.timestamp));
}
