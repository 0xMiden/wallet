import React, { FC, useCallback, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useActionableActivity } from 'app/hooks/useActionableActivity';
import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useClaimNotes } from 'app/hooks/useClaimNotes';
import { Icon, IconName } from 'app/icons/v2';
import { groupActivity } from 'app/templates/history/activity-grouping';
import History from 'app/templates/history/History';
import HistoryView from 'app/templates/history/HistoryView';
import { formatDate } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { useAccount } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { hapticLight } from 'lib/mobile/haptics';

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
  const { actions } = useActionableActivity();
  const { handleClaimActivityGroup } = useClaimNotes();
  const [claimingGroupId, setClaimingGroupId] = useState<string | null>(null);
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const handleBack = useBackWithFallback('/history');

  const decodedId = decodeURIComponent(groupId);

  // Claim right here rather than routing to the pending-notes screen: the group
  // already knows exactly which notes are waiting, so sending the user to a
  // list of everything and asking them to find this counterparty again is a
  // detour through work they already did. A successful batch navigates itself
  // to the generating-transaction page.
  const handleClaim = useCallback(
    async (id: string) => {
      hapticLight();
      setClaimingGroupId(id);
      try {
        await handleClaimActivityGroup(id);
      } finally {
        setClaimingGroupId(null);
      }
    },
    [handleClaimActivityGroup]
  );

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
              protocolNames: {
                swap: t('swap'),
                earn: t('earn'),
                bridge: t('activityBridgeGroup'),
                faucet: t('faucetRequest')
              },
              actions
            }).find(candidate => candidate.id === decodedId);

            const title = !group ? t('activity') : group.kind === 'unknown' ? t('activityUnknownGroup') : group.name;

            return (
              <>
                <NavigationHeader title={title} onBack={handleBack} variant="prominent" titleAlign="left" />
                {group && group.pendingCount > 0 && (
                  <div className="px-4 pb-3">
                    <div className="rounded-2xl bg-gray-25 py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-heading text-base font-extrabold text-heading-gray dark:text-pure-white">
                            {t('activityActionWaiting')}
                          </p>
                          <p className="text-sm font-heading font-semibold text-heading-gray">
                            {t('activityActionCount', { count: group.pendingCount })}
                          </p>
                        </div>
                        <Button
                          data-testid="activity-group-claim"
                          className="w-auto shrink-0 px-4 h-8 text-sm leading-none"
                          variant={ButtonVariant.Primary}
                          disabled={claimingGroupId === group.id}
                          onClick={() => handleClaim(group.id)}
                          title={t('claim')}
                        />
                      </div>
                      {group.nextDeadlineAt !== undefined && (
                        <div className="mt-2.5 flex items-center gap-2 rounded-10 bg-yellow-300 dark:bg-yellow-600/25 px-2.5 py-1.5">
                          <Icon
                            name={IconName.Time}
                            className="w-3! h-3! shrink-0 text-yellow-800 dark:text-yellow-300 [&_path]:fill-current"
                          />
                          <span className="font-heading text-xs font-semibold leading-tight text-yellow-700 dark:text-yellow-300">
                            {t('noteReturnsToSenderBy', { date: formatDate(group.nextDeadlineAt / 1000) })}
                          </span>
                        </div>
                      )}
                    </div>
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
