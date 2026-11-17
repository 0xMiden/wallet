import { useEffect, useState } from 'react';

import { useActivityHiddenNotes } from 'app/hooks/useActivityHiddenNotes';
import { useClaimCheckInvalidNoteIds } from 'app/hooks/useClaimNotes';
import { historyEntryUnreadKey, pendingNoteUnreadKey } from 'app/templates/history/activityUnread';
import { suppressLinkedConsumes } from 'app/templates/history/History';
import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import { CompletedHistoryCursor, getCompletedTransactionsPage, getUncompletedTransactions } from 'lib/miden/activity';
import { ITransaction } from 'lib/miden/db/types';
import { useAccount } from 'lib/miden/front';
import { useManuallyClaimableNotes } from 'lib/miden/front/auto-managed-notes';
import { isActivityRead, useActivityReadState } from 'lib/settings/activity-read';

/**
 * How many of the account's completed and failed rows count.
 *
 * Read completed history in batches until this many visible rows are found.
 * Every queued or running row counts, regardless of its age.
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

async function readRecentCompletedRows(address: string): Promise<RecentRow[]> {
  const recent: RecentRow[] = [];
  let cursor: CompletedHistoryCursor | null = null;
  while (recent.length < RECENT_ROWS) {
    const page = await getCompletedTransactionsPage({
      accountId: address,
      includeFailed: true,
      limit: RECENT_ROWS,
      cursor
    });
    const visible = await suppressLinkedConsumes(page.transactions);
    recent.push(
      ...visible.slice(0, RECENT_ROWS - recent.length).map(row => toRecentRow(row, row.completedAt ?? row.initiatedAt))
    );
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return recent;
}

/**
 * The rows History shows for `address`, through the same loaders and the same suppression
 * (`suppressLinkedConsumes`: consumes a linked swap, bridge receive or Earn withdraw row stands for,
 * and failed claims this account has since claimed), so the tab never counts a row the feed does
 * not show. Each is stamped the way History dates it, so the two agree about which side of the
 * high-water mark it falls on.
 */
async function readRecentRows(address: string): Promise<RecentRow[]> {
  const [uncompleted, completed] = await Promise.all([
    getUncompletedTransactions(address).then(suppressLinkedConsumes),
    readRecentCompletedRows(address)
  ]);
  return [...uncompleted.map(row => toRecentRow(row, row.initiatedAt)), ...completed];
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
