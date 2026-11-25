import React, { memo, RefObject, useMemo, useRef } from 'react';

import { formatDistanceToNowStrict } from 'date-fns';
import { useTranslation } from 'react-i18next';
import InfiniteScroll from 'react-infinite-scroller';

import { IconName } from 'app/icons/v2';
import { EmptyState } from 'components/ui/EmptyState';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Spinner } from 'components/ui/Spinner';
import { StatusBadge } from 'components/ui/StatusBadge';
import { getDateFnsLocale } from 'lib/i18n';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useActivityReadState } from 'lib/settings/activity-read';

import { ActivityGroupAvatar } from './ActivityGroupAvatar';
import {
  ACTIVITY_GROUP_LABELS,
  ActivityCounterpartyName,
  ActivityGroup,
  activityGroupPath,
  groupActivityEntries
} from './activityGroups';
import { isActivityGroupUnread } from './activityUnread';
import { historyEntryActionTitle } from './guardianHistoryLabels';
import { historyEntryMatchesSearch } from './History';
import { HistoryLoadErrorCard, HistoryLoadErrorNotice, shortAddr } from './HistoryView';
import { IHistoryEntry } from './IHistoryEntry';
import { isActivityClaimWaiting, type PendingActivityItem } from './PendingActivityCard';
import { activityClaimMatchesSearch } from './useActivityClaimList';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function activityGroupTitle(group: ActivityGroup, t: Translate): string {
  if (group.kind !== 'address') return t(ACTIVITY_GROUP_LABELS[group.kind]);
  // A counterparty the address book (or one of the user's own accounts) knows shows its name;
  // anything else shows the address, ellipsised the way every activity row shows one.
  return group.name ?? shortAddr(group.id);
}

/**
 * What the group's newest entry was, as the row's subtitle: "Sent 1 MIDEN · 2 hours".
 *
 * The event half is deliberately the same text the feed's own row shows for that entry, so the
 * two views never describe one transaction differently.
 */
export function activityGroupSubtitle(group: ActivityGroup, t: Translate): string {
  const event = latestEvent(group, t);
  const when = relativeTime(group.latestTimestamp);
  return when ? `${event} · ${when}` : event;
}

function latestEvent(group: ActivityGroup, t: Translate): string {
  const entry = group.latest;
  if (!entry) return t('received');
  if (entry.isUnconfirmed) return t('notConfirmed');
  if (entry.isCancelled) return t('cancelled');
  if (group.kind === 'faucet') return t('faucetRequestTitle');
  if (group.kind === 'swap' && entry.token && entry.requestedToken) {
    const pair = `${t('swap')} ${entry.token} → ${entry.requestedToken}`;
    if (entry.swapFillProgress !== undefined) {
      return `${pair} · ${t('amountFilled')}: ${t('swapProgressPercent', { percentage: entry.swapFillProgress })}`;
    }
    return pair;
  }
  const amount = amountLabel(entry);
  const label = historyEntryActionTitle(entry, t);
  return amount ? `${label} ${amount}` : label;
}

function amountLabel(entry: IHistoryEntry): string | undefined {
  // The symbol alone is worth showing: a faucet with no known scale names the asset and withholds
  // the number, exactly as the feed's row does.
  if (entry.amount === undefined) return entry.token;
  return entry.token ? `${entry.amount} ${entry.token}` : entry.amount;
}

/** `-Infinity` (a row whose timestamp is unusable) has no "when" to state, so it gets none. */
function relativeTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return undefined;
  return formatDistanceToNowStrict(date, { locale: getDateFnsLocale() });
}

export interface ActivityGroupListProps {
  entries: IHistoryEntry[];
  claims?: readonly PendingActivityItem[];
  /** Hidden notes have loaded, so the claim card offers Decline. A fee-blocked transfer counts only then. */
  hiddenLoaded?: boolean;
  /** Resolves a counterparty to a contact's or an own account's name. */
  nameOf: ActivityCounterpartyName;
  initialLoading: boolean;
  /** A read behind `entries` failed: shown in place of the empty state, or above the groups. */
  loadError?: boolean;
  /** Re-runs the failed reads; backs the load-error Retry. */
  onRetry?: () => void;
  hasMore: boolean;
  loadMore: (page: number) => Promise<void>;
  scrollParentRef?: RefObject<HTMLDivElement>;
  searchQuery?: string;
  /** Drops this list's activity-key memory when the wallet account changes. */
  accountAddress?: string;
}

/**
 * A group answers a search by what its row shows (the name, the address, the category's label), by any of its
 * entries, or by a claim the cards would match: note symbol, resolved token label, asset name, and sender.
 */
function groupMatchesSearch(
  group: ActivityGroup,
  query: string,
  t: Translate,
  bridgeConfig: BridgeConfigSnapshot
): boolean {
  const addresses = group.kind === 'address' ? [group.id, shortAddr(group.id)] : [];
  const shown = [activityGroupTitle(group, t), group.name, ...addresses];
  if (shown.some(value => value?.toLowerCase().includes(query))) return true;
  if (group.entries.some(entry => historyEntryMatchesSearch(entry, query, t))) return true;
  return group.claims.some(claim => activityClaimMatchesSearch(claim, query, bridgeConfig));
}

/**
 * The Activity tab's Groups view: one row per counterparty or category, newest first, each with
 * the group's latest event as its subtitle and its count on the right.
 *
 * A count is a count of the entries LOADED so far, never of the whole history — grouping only
 * ever sees what has been paged in. While more pages can still arrive the count is shown with a
 * trailing `+`, and the scroller keeps loading as the user goes down the list; once the history is
 * exhausted (`hasMore` false) the `+` goes and the number is final.
 */
export const ActivityGroupList = memo<ActivityGroupListProps>(
  ({
    entries,
    claims,
    hiddenLoaded = false,
    nameOf,
    initialLoading,
    loadError,
    onRetry,
    hasMore,
    loadMore,
    scrollParentRef,
    searchQuery,
    accountAddress
  }) => {
    const { t } = useTranslation();
    const readState = useActivityReadState();
    const bridgeConfig = useBridgeConfigSnapshot({ load: false });
    const query = searchQuery?.trim().toLowerCase() ?? '';
    // Created with the list and replaced only when the account changes, so a new page of entries
    // keeps the keys already resolved for this account.
    const storedKeys = useRef<{ account: string | undefined; keys: Map<string, string> } | undefined>(undefined);
    if (storedKeys.current === undefined || storedKeys.current.account !== accountAddress) {
      storedKeys.current = { account: accountAddress, keys: new Map() };
    }
    const activityKeys = storedKeys.current.keys;
    const groups = useMemo(() => {
      const all = groupActivityEntries(entries, nameOf, claims, activityKeys);
      return query ? all.filter(group => groupMatchesSearch(group, query, t, bridgeConfig)) : all;
    }, [entries, claims, nameOf, query, t, bridgeConfig, activityKeys]);

    if (groups.length === 0) {
      // As in the List view, a failed read outranks one still loading and never reads as "no activity".
      if (loadError) {
        return (
          <div className="flex flex-col pt-4">
            <HistoryLoadErrorCard onRetry={onRetry} />
          </div>
        );
      }
      if (initialLoading) {
        return (
          <div className="flex h-8 justify-center pt-5">
            <Spinner />
          </div>
        );
      }
      return (
        <div className="flex flex-col pt-4">
          <EmptyState icon={IconName.ArrowUpDown} title={t('noOperationsFound')} className="w-full" />
        </div>
      );
    }

    const list = (
      // `plain`, not a card: this page IS the list, so the rows sit on the page's own margin with
      // full-width hairlines between them — the Settings root and Explore's app lists again, and
      // the reading Brian asked for on the simulator ("just rows, like a chat interface").
      // `outline` would put a box around a whole screen of rows, which is the thing the three
      // list surfaces exist to stop. It also starts right under the header's own gap: a chat list
      // has no block of air between the rule and the first conversation.
      <ListGroup surface="plain" data-testid="activity-group-list">
        {groups.map(group => {
          const waitingCount = group.claims.filter(claim => isActivityClaimWaiting(claim, hiddenLoaded)).length;
          return (
            <ListRow
              key={`${group.kind}:${group.id}`}
              to={activityGroupPath(group)}
              // Every kind takes the same 40px round mark, so the title column starts at one x
              // down the whole list. See `ActivityGroupAvatar`.
              avatar={<ActivityGroupAvatar kind={group.kind} id={group.id} name={group.name} />}
              // Opening a group does not read what is inside it — the dot goes out when the last
              // unread child has been opened. See `isActivityGroupUnread`.
              unread={isActivityGroupUnread(readState, group)}
              unreadLabel={t('activityUnread')}
              title={activityGroupTitle(group, t)}
              subtitle={activityGroupSubtitle(group, t)}
              trailing={
                <span className="flex items-center gap-2">
                  {/* In flight rows stay visible as a badge on the group rather than dropping out
                      of a view that only counts settled history. */}
                  {group.pendingCount > 0 && (
                    <StatusBadge status="pending" size="sm" data-testid="activity-group-pending" />
                  )}
                  {waitingCount > 0 && (
                    <span className="text-body-sm font-medium text-ink">
                      {t('activityPendingWaiting', { count: waitingCount })}
                    </span>
                  )}
                  {group.count > 0 && (
                    <span className="text-body-sm text-muted tabular-nums">
                      {hasMore ? t('activityGroupPartialCount', { count: group.count }) : String(group.count)}
                    </span>
                  )}
                </span>
              }
              data-testid="activity-group-row"
              dataAttributes={{
                'data-group-kind': group.kind,
                'data-group-id': group.id,
                'data-group-count': String(group.count),
                'data-group-pending': String(group.pendingCount)
              }}
            />
          );
        })}
      </ListGroup>
    );

    return (
      <div className="flex w-full flex-col pb-6">
        {loadError && <HistoryLoadErrorNotice onRetry={onRetry} />}
        {scrollParentRef ? (
          <InfiniteScroll
            loadMore={loadMore}
            hasMore={hasMore}
            useWindow={false}
            getScrollParent={() => scrollParentRef.current}
          >
            {list}
          </InfiniteScroll>
        ) : (
          list
        )}
      </div>
    );
  }
);

export default ActivityGroupList;
