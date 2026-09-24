import React, { useCallback, useMemo, useRef } from 'react';

import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';

import { ActivityGroupList } from './ActivityGroupList';
import History from './History';
import { useActivityClaimList } from './useActivityClaimList';

interface ActivityGroupedHistoryProps {
  search: string;
  programId?: string | null;
}

/**
 * The Activity tab in its Groups view: the same loaded history, rolled up into one row per
 * counterparty or category.
 *
 * `History` still owns the loading and the paging — this only replaces what is drawn over the
 * entries (`renderEntries`) — so the two views can never disagree about which rows exist.
 *
 * No filter is passed: grouping the whole history by counterparty is what this view narrows by,
 * and there is no filter row here to say otherwise. The header's search still applies, because its
 * field is on screen while it does.
 *
 * Incoming transfers waiting for a claim have no group to live in, so their cards sit above the
 * groups, as actionable here as in the List view.
 */
export const ActivityGroupedHistory: React.FC<ActivityGroupedHistoryProps> = ({ search, programId }) => {
  const { account, listItems, renderPendingItem } = useActivityClaimList(search, 'all');
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

  return (
    // `pb-28` clears the floating navbar, as the feed's own scroller does.
    <div ref={scrollRef} data-testid="activity-groups" className="min-h-0 flex-1 overflow-y-auto pb-28">
      <div className="px-4">
        {listItems.length > 0 && (
          <div data-testid="activity-group-claims" className="flex flex-col gap-3 pt-4">
            {listItems.map(item => (
              <div key={item.note.id} data-pending-note-id={item.note.id}>
                {renderPendingItem(item)}
              </div>
            ))}
          </div>
        )}
        <History
          address={account.publicKey}
          programId={programId}
          fullHistory
          centerEmptyState
          scrollParentRef={scrollRef}
          searchQuery={search}
          pendingItems={listItems}
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
