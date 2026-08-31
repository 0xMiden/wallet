import React, { FC, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { groupActivity } from 'app/templates/history/activity-grouping';
import History from 'app/templates/history/History';
import HistoryView from 'app/templates/history/HistoryView';
import { NavigationHeader } from 'components/NavigationHeader';
import { useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { navigate } from 'lib/woozie';

interface ActivityGroupDetailProps {
  groupId: string;
}

/**
 * One counterparty's activity, chronological — the drill-in from the grouped
 * Activity view.
 *
 * Regroups from the same `History` source rather than receiving the group
 * through navigation state, so a deep link or a reload lands on the same
 * screen. A group whose id no longer matches anything renders as empty rather
 * than redirecting, since the user asked for this screen.
 */
const ActivityGroupDetail: FC<ActivityGroupDetailProps> = ({ groupId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const { allContacts } = useFilteredContacts();
  const { data: claimableNotes } = useClaimableNotes(account.publicKey);
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const handleBack = useBackWithFallback('/history');

  const decodedId = decodeURIComponent(groupId);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-app-bg">
      <div ref={scrollParentRef} className="flex-1 min-h-0 overflow-y-auto pb-28">
        <History
          address={account.publicKey}
          fullHistory
          centerEmptyState
          scrollParentRef={scrollParentRef}
          renderEntries={(entries, { initialLoading }) => {
            const group = groupActivity(entries, {
              contacts: allContacts,
              protocolNames: { swap: t('swap') },
              pendingClaims: (claimableNotes ?? []).map(note => ({ id: note.id, senderAddress: note.senderAddress }))
            }).find(candidate => candidate.id === decodedId);

            const title = !group ? t('activity') : group.kind === 'unknown' ? t('activityUnknownGroup') : group.name;

            return (
              <>
                <NavigationHeader title={title} onBack={handleBack} variant="prominent" titleAlign="left" />
                {group && group.pendingCount > 0 && (
                  <div className="px-4 pb-3">
                    <button
                      type="button"
                      data-testid="activity-group-claim"
                      onClick={() => navigate('/pending-notes')}
                      className="w-full text-left rounded-2xl bg-gray-25 py-3 px-4 font-heading text-base font-extrabold text-heading-gray dark:text-pure-white"
                    >
                      {t('activityGroupPendingClaims', { count: group.pendingCount })}
                    </button>
                  </div>
                )}
                <div className="px-4">
                  <HistoryView
                    entries={group?.entries ?? []}
                    initialLoading={initialLoading}
                    // Paging is driven by the grouped root; this drill-in renders
                    // whatever has been loaded rather than fetching its own page.
                    loadMore={async () => {}}
                    hasMore={false}
                    scrollParentRef={scrollParentRef}
                    fullHistory
                    centerEmptyState
                  />
                </div>
              </>
            );
          }}
        />
      </div>
    </div>
  );
};

export default ActivityGroupDetail;
