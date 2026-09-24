import React, { memo, RefObject, useMemo } from 'react';

import { formatDistanceToNowStrict } from 'date-fns';
import { useTranslation } from 'react-i18next';
import InfiniteScroll from 'react-infinite-scroller';

import { Icon, IconName } from 'app/icons/v2';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { EmptyState } from 'components/ui/EmptyState';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Spinner } from 'components/ui/Spinner';
import { StatusBadge } from 'components/ui/StatusBadge';
import { getDateFnsLocale } from 'lib/i18n';

import {
  ActivityCounterpartyName,
  ActivityGroup,
  ActivityGroupKind,
  activityGroupPath,
  groupActivityEntries
} from './activityGroups';
import { historyEntryMatchesSearch } from './History';
import { shortAddr } from './HistoryView';
import { IHistoryEntry } from './IHistoryEntry';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The glyph of each category group. An `address` group wears its counterparty's avatar instead. */
const KIND_ICONS: Record<Exclude<ActivityGroupKind, 'address'>, IconName> = {
  swap: IconName.Convert,
  faucet: IconName.Faucet,
  guardian: IconName.Key,
  other: IconName.More
};

/** The name of each category group. */
const KIND_LABELS: Record<Exclude<ActivityGroupKind, 'address'>, string> = {
  swap: 'activityGroupSwaps',
  faucet: 'activityGroupFaucet',
  guardian: 'activityGroupGuardian',
  other: 'activityGroupOther'
};

export function activityGroupTitle(group: ActivityGroup, t: Translate): string {
  if (group.kind !== 'address') return t(KIND_LABELS[group.kind]);
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
  if (entry.isCancelled) return t('cancelled');
  if (group.kind === 'faucet') return t('faucetRequestTitle');
  if (group.kind === 'swap' && entry.token && entry.requestedToken) {
    return `${t('swap')} ${entry.token} → ${entry.requestedToken}`;
  }
  const amount = amountLabel(entry);
  const message = entry.message.trim();
  if (!message) return amount ?? t('activity');
  return amount ? `${message} ${amount}` : message;
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
  /** Resolves a counterparty to a contact's or an own account's name. */
  nameOf: ActivityCounterpartyName;
  initialLoading: boolean;
  hasMore: boolean;
  loadMore: (page: number) => Promise<void>;
  scrollParentRef?: RefObject<HTMLDivElement>;
  searchQuery?: string;
}

/**
 * A group answers a search by what its row shows (the name, the address, the category's label) or by any of its
 * entries, the way the List view's rows would.
 */
function groupMatchesSearch(group: ActivityGroup, query: string, t: Translate): boolean {
  const addresses = group.kind === 'address' ? [group.id, shortAddr(group.id)] : [];
  const shown = [activityGroupTitle(group, t), group.name, ...addresses];
  if (shown.some(value => value?.toLowerCase().includes(query))) return true;
  return group.entries.some(entry => historyEntryMatchesSearch(entry, query));
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
  ({ entries, nameOf, initialLoading, hasMore, loadMore, scrollParentRef, searchQuery }) => {
    const { t } = useTranslation();
    const query = searchQuery?.trim().toLowerCase() ?? '';
    const groups = useMemo(() => {
      const all = groupActivityEntries(entries, nameOf);
      return query ? all.filter(group => groupMatchesSearch(group, query, t)) : all;
    }, [entries, nameOf, query, t]);

    if (groups.length === 0) {
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
        {groups.map(group => (
          <ListRow
            key={`${group.kind}:${group.id}`}
            to={activityGroupPath(group)}
            avatar={group.kind === 'address' ? <ContactAvatar address={group.id} name={group.name} /> : undefined}
            icon={
              group.kind === 'address' ? undefined : (
                <Icon name={KIND_ICONS[group.kind]} size="sm" fill="currentColor" />
              )
            }
            title={activityGroupTitle(group, t)}
            subtitle={activityGroupSubtitle(group, t)}
            trailing={
              <span className="flex items-center gap-2">
                {/* In flight rows stay visible as a badge on the group rather than dropping out
                    of a view that only counts settled history. */}
                {group.pendingCount > 0 && (
                  <StatusBadge status="pending" size="sm" data-testid="activity-group-pending" />
                )}
                <span className="text-body-sm text-muted tabular-nums">
                  {hasMore ? t('activityGroupPartialCount', { count: group.count }) : String(group.count)}
                </span>
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
        ))}
      </ListGroup>
    );

    return (
      <div className="flex w-full flex-col pb-6">
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
