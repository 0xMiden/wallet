import React, { useMemo, useRef } from 'react';

import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';

import { ClaimsLoadingBar, RestoreDeclinedTransfers } from './ActivityClaimsStatus';
import { ActivityGroupList } from './ActivityGroupList';
import { activityCounterpartyNames } from './activityGroups';
import { ActivityGroupsBoundary } from './ActivityGroupsBoundary';
import History from './History';
import { useActivityClaimList } from './useActivityClaimList';

interface ActivityGroupedHistoryProps {
  search: string;
  onReturnToList: () => void;
  programId?: string | null;
  /** Forwarded to the list below, which owns the loading state the caller reports on. */
  onInitialLoad?: () => void;
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
 * field is on screen while it does, but to the groups rather than the entries, so a group can be
 * found by the name or category label its row shows.
 *
 * The claim cards above the list offer the same actions as in the List view. Their transfers also
 * give the corresponding group a waiting count and a route into that group's activity.
 */
export const ActivityGroupedHistory: React.FC<ActivityGroupedHistoryProps> = ({
  search,
  programId,
  onInitialLoad,
  onReturnToList
}) => {
  const { account, representedItems, listItems, renderPendingItem, isLoadingNotes, hidden, declinedIds, hiddenCount } =
    useActivityClaimList(search, 'all');
  const { allContacts } = useFilteredContacts();
  const scrollRef = useRef<HTMLDivElement>(null);

  const nameOf = useMemo(() => activityCounterpartyNames(allContacts), [allContacts]);

  return (
    <>
      <ClaimsLoadingBar loading={isLoadingNotes} />
      {/* `pb-28` clears the floating navbar, as the feed's own scroller does. */}
      <div ref={scrollRef} data-testid="activity-groups" className="min-h-0 flex-1 overflow-y-auto pb-28">
        <RestoreDeclinedTransfers count={hiddenCount} onRestore={() => hidden.restore(declinedIds)} />
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
            pendingItems={representedItems}
            onInitialLoad={onInitialLoad}
            renderEntries={view => (
              <ActivityGroupsBoundary onReturnToList={onReturnToList}>
                <ActivityGroupList
                  entries={view.entries}
                  claims={representedItems}
                  nameOf={nameOf}
                  initialLoading={view.initialLoading}
                  loadError={view.loadError}
                  onRetry={view.onRetry}
                  // History pages the settled feed, so a count stays partial until that read is exhausted.
                  hasMore={view.hasMore}
                  loadMore={view.loadMore}
                  scrollParentRef={scrollRef}
                  searchQuery={search}
                />
              </ActivityGroupsBoundary>
            )}
          />
        </div>
      </div>
    </>
  );
};

export default ActivityGroupedHistory;
