import React, { FC, useMemo, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { RestoreDeclinedTransfers } from 'app/templates/history/ActivityClaimsStatus';
import { ActivityGroupAvatar } from 'app/templates/history/ActivityGroupAvatar';
import {
  ACTIVITY_GROUP_LABELS,
  activityClaimMatcher,
  activityCounterpartyNames,
  activityGroupMatcher,
  isActivityGroupKind,
  retainActivityKeyMemory
} from 'app/templates/history/activityGroups';
import History from 'app/templates/history/History';
import { shortAddr } from 'app/templates/history/HistoryView';
import type { IHistoryEntry } from 'app/templates/history/IHistoryEntry';
import { useActivityClaimList } from 'app/templates/history/useActivityClaimList';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { useAccount } from 'lib/miden/front';
import { useActivityContacts } from 'lib/miden/front/use-filtered-contacts.hook';
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
 * It is the same list the tab renders, narrowed by group, so paging, the rows still in flight,
 * the date separators and every row's rendering and detail link come with it, and the page can
 * never describe a transaction differently from the feed it was opened from.
 */
export const ActivityGroupPage: FC<ActivityGroupPageProps> = ({ kind, id }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const activityContacts = useActivityContacts();
  const back = useBackWithFallback(ACTIVITY_PATH);
  const bodyRef = useRef<HTMLDivElement>(null);

  const address = kind === 'address' ? id?.trim() : undefined;
  const storedKeys = useRef<{
    account: string;
    route?: string;
    keys: Map<string, string>;
  }>();
  if (storedKeys.current?.account !== account.publicKey || storedKeys.current.route !== address) {
    storedKeys.current = { account: account.publicKey, route: address, keys: new Map() };
  }
  const activityKeys = storedKeys.current.keys;
  const nameOf = useMemo(
    () => activityCounterpartyNames(activityContacts, activityKeys),
    [activityContacts, activityKeys]
  );
  const contactName = address && nameOf(address);

  // Claims are drawn as the Activity views draw them: every represented claim keeps its consume row out, and
  // this group's own are drawn as cards, so a claim reads once here, in the groups and in the list.
  const { representedItems, renderPendingItem, hidden, declinedItems } = useActivityClaimList('', 'all');
  const claimMatcher = useMemo(
    () => (isActivityGroupKind(kind) ? activityClaimMatcher(kind, id, activityKeys) : undefined),
    [kind, id, activityKeys]
  );
  const drawnPendingItems = useMemo(
    () => (claimMatcher ? representedItems.filter(item => claimMatcher(item.note)) : []),
    [representedItems, claimMatcher]
  );
  const groupDeclinedItems = useMemo(
    () => (claimMatcher ? declinedItems.filter(item => claimMatcher(item.note)) : []),
    [declinedItems, claimMatcher]
  );
  const groupDeclinedIds = groupDeclinedItems.map(item => item.note.id);

  const filterEntries = useMemo(() => {
    if (!isActivityGroupKind(kind)) return undefined;
    const claimSenders = [...drawnPendingItems, ...groupDeclinedItems].map(item => item.note.senderAddress);
    return (entries: readonly IHistoryEntry[]) => {
      const matched = entries.filter(activityGroupMatcher(kind, id, activityKeys));
      const addresses = address ? [address, ...claimSenders] : [...claimSenders];
      for (const entry of matched) {
        if (entry.secondaryAddress) addresses.push(entry.secondaryAddress);
      }
      retainActivityKeyMemory(activityKeys, addresses);
      return matched;
    };
  }, [kind, id, address, activityKeys, drawnPendingItems, groupDeclinedItems]);

  // An unknown kind, or an address group with no address: nothing to narrow by, so there is no
  // page to show. Back to the tab rather than an empty list that looks like "no activity".
  if (!isActivityGroupKind(kind) || !filterEntries) return <Redirect to={ACTIVITY_PATH} />;
  if (kind === 'address' && !address) return <Redirect to={ACTIVITY_PATH} />;

  // The title wears the same mark as the row that opened it: a contact's avatar, or the
  // category's glyph on its own colour (`ActivityGroupAvatar`).
  const title = (
    <span className="flex min-w-0 items-center gap-2">
      <ActivityGroupAvatar kind={kind} id={address ?? kind} name={contactName} size="sm" />
      <span className="min-w-0 truncate">
        {kind !== 'address' ? t(ACTIVITY_GROUP_LABELS[kind]) : address && (contactName ?? shortAddr(address))}
      </span>
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
        filterEntries={filterEntries}
        pendingItems={representedItems}
        drawnPendingItems={drawnPendingItems}
        renderPendingItem={renderPendingItem}
      />
    </SubPageLayout>
  );
};

export default ActivityGroupPage;
