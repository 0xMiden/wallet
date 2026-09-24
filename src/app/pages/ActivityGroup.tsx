import React, { FC, useMemo, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { RestoreDeclinedTransfers } from 'app/templates/history/ActivityClaimsStatus';
import {
  ACTIVITY_GROUP_LABELS,
  activityClaimMatcher,
  activityGroupMatcher,
  isActivityGroupKind
} from 'app/templates/history/activityGroups';
import History from 'app/templates/history/History';
import { shortAddr } from 'app/templates/history/HistoryView';
import { useActivityClaimList } from 'app/templates/history/useActivityClaimList';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { useAccount } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { Redirect } from 'lib/woozie';

// Where the page goes back to when there is no history to pop, and where an unknown group redirects.
const ACTIVITY_PATH = '/history';

export interface ActivityGroupPageProps {
  /** `:kind` from the route. Anything this is not sends the user back to the tab. */
  kind?: string;
  /** `:id` — the counterparty address of an `address` group; absent for a category group. */
  id?: string;
}

/**
 * One activity group's own page: the Activity feed, narrowed to that group.
 *
 * It is the SAME list the tab renders, handed a predicate — so paging, the rows still in flight,
 * the date separators and every row's rendering and detail link come with it, and the page can
 * never describe a transaction differently from the feed it was opened from.
 */
export const ActivityGroupPage: FC<ActivityGroupPageProps> = ({ kind, id }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const { allContacts } = useFilteredContacts();
  const back = useBackWithFallback(ACTIVITY_PATH);
  const bodyRef = useRef<HTMLDivElement>(null);

  const address = kind === 'address' ? id?.trim() : undefined;
  const contactName = useMemo(() => {
    if (!address) return undefined;
    const wanted = address.toLowerCase();
    return allContacts.find(contact => contact.address.trim().toLowerCase() === wanted)?.name?.trim() || undefined;
  }, [allContacts, address]);

  const predicate = useMemo(() => (isActivityGroupKind(kind) ? activityGroupMatcher(kind, id) : undefined), [kind, id]);
  // Claims are drawn as the Activity views draw them: every represented claim keeps its consume row out, and
  // this group's own are drawn as cards, so a claim reads once here, in the groups and in the list.
  const { representedItems, renderPendingItem, hidden, declinedItems } = useActivityClaimList('', 'all');
  const claimMatcher = useMemo(
    () => (isActivityGroupKind(kind) ? activityClaimMatcher(kind, id) : undefined),
    [kind, id]
  );
  const drawnPendingItems = useMemo(
    () => (claimMatcher ? representedItems.filter(item => claimMatcher(item.note)) : []),
    [representedItems, claimMatcher]
  );
  const groupDeclinedIds = claimMatcher
    ? declinedItems.filter(item => claimMatcher(item.note)).map(item => item.note.id)
    : [];

  // An unknown kind, or an address group with no address: nothing to narrow by, so there is no
  // page to show. Back to the tab rather than an empty list that looks like "no activity".
  if (!isActivityGroupKind(kind) || !predicate) return <Redirect to={ACTIVITY_PATH} />;
  if (kind === 'address' && !address) return <Redirect to={ACTIVITY_PATH} />;

  const title =
    kind !== 'address'
      ? t(ACTIVITY_GROUP_LABELS[kind])
      : address && (
          <span className="flex min-w-0 items-center gap-2">
            <ContactAvatar address={address} name={contactName} size="sm" />
            <span className="min-w-0 truncate">{contactName ?? shortAddr(address)}</span>
          </span>
        );

  return (
    <SubPageLayout title={title} onBack={back} focusTitleOnMount bodyRef={bodyRef} data-testid="activity-group-page">
      <RestoreDeclinedTransfers count={groupDeclinedIds.length} onRestore={() => hidden.restore(groupDeclinedIds)} />
      <History
        address={account.publicKey}
        fullHistory
        centerEmptyState
        scrollParentRef={bodyRef}
        predicate={predicate}
        pendingItems={representedItems}
        drawnPendingItems={drawnPendingItems}
        renderPendingItem={renderPendingItem}
      />
    </SubPageLayout>
  );
};

export default ActivityGroupPage;
