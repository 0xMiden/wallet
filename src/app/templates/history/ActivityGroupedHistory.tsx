import React, { useCallback, useMemo, useRef } from 'react';

import { useAccount } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';

import { ActivityGroupList } from './ActivityGroupList';
import { isPendingActivityEntry } from './activityGroups';
import History, { ActivityFilter } from './History';

interface ActivityGroupedHistoryProps {
  search: string;
  filter: ActivityFilter;
  programId?: string | null;
}

/**
 * The Activity tab in its Groups view: the same loaded history, rolled up into one row per
 * counterparty or category.
 *
 * `History` still owns the loading and the paging — this only replaces what is drawn over the
 * entries (`renderEntries`) — so the two views can never disagree about which rows exist.
 *
 * The Pending filter is the one thing that reads differently here. In the feed it means "the
 * transfers waiting to be claimed", which are note cards with no counterparty to group by; here it
 * means the transactions still in flight, so it is passed as a predicate over the entries rather
 * than as the feed's filter. That leaves the feed's own Pending behaviour untouched.
 */
export const ActivityGroupedHistory: React.FC<ActivityGroupedHistoryProps> = ({ search, filter, programId }) => {
  const account = useAccount();
  const { allContacts } = useFilteredContacts();
  const scrollRef = useRef<HTMLDivElement>(null);

  const namesByAddress = useMemo(() => {
    const names = new Map<string, string>();
    for (const contact of allContacts) {
      const name = contact.name?.trim();
      if (name) names.set(contact.address.trim().toLowerCase(), name);
    }
    return names;
  }, [allContacts]);

  const nameOf = useCallback((address: string) => namesByAddress.get(address.trim().toLowerCase()), [namesByAddress]);

  const pendingOnly = filter === 'pending';

  return (
    // `pb-28` clears the floating navbar, as the feed's own scroller does.
    <div ref={scrollRef} data-testid="activity-groups" className="min-h-0 flex-1 overflow-y-auto pb-28">
      <div className="px-4">
        <History
          address={account.publicKey}
          programId={programId}
          fullHistory
          centerEmptyState
          scrollParentRef={scrollRef}
          searchQuery={search}
          filter={pendingOnly ? 'all' : filter}
          predicate={pendingOnly ? isPendingActivityEntry : undefined}
          renderEntries={view => (
            <ActivityGroupList
              entries={view.entries}
              nameOf={nameOf}
              initialLoading={view.initialLoading}
              hasMore={view.hasMore}
              loadMore={view.loadMore}
              scrollParentRef={scrollRef}
            />
          )}
        />
      </div>
    </div>
  );
};

export default ActivityGroupedHistory;
