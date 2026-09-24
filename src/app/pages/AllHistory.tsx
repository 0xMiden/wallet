import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { ActivityGroupedHistory } from 'app/templates/history/ActivityGroupedHistory';
import { ActivityPendingHistory } from 'app/templates/history/ActivityPendingHistory';
import { ActivityViewMenu } from 'app/templates/history/ActivityViewMenu';
import type { ActivityFilter } from 'app/templates/history/History';
import { DeadletteredNotesNotice } from 'components/DeadletteredNotesNotice';
import { TabHeaderAction, TabRootHeader } from 'components/ui';
import { SegmentedControlItem } from 'components/ui/SegmentedControl';
import { useAccount } from 'lib/miden/front';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { setActivityView, useActivityView } from 'lib/settings/activity-view';
import { HistoryAction, navigate, useLocation } from 'lib/woozie';

type AllHistoryProps = {
  programId?: string | null;
};

/**
 * The filter a link asked for, e.g. `/history?filter=pending` - which is where every
 * received-transfer notification and the home prompt now land (`ACTIVITY_PENDING_PATH`). Only an
 * id the segmented control offers is accepted.
 */
function filterFromSearch(
  search: string,
  filters: readonly SegmentedControlItem<ActivityFilter>[]
): ActivityFilter | undefined {
  const asked = new URLSearchParams(search).get('filter');
  return filters.find(candidate => candidate.id === asked)?.id;
}

const AllHistory: FC<AllHistoryProps> = ({ programId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [search, setSearch] = useState('');
  const { search: locationSearch } = useLocation();
  const filters = useMemo<SegmentedControlItem<ActivityFilter>[]>(
    () => [
      { id: 'all', label: t('all') },
      { id: 'pending', label: t('pending') },
      { id: 'sent', label: t('sent') },
      { id: 'received', label: t('received') },
      { id: 'faucet', label: t('faucet') }
    ],
    [t]
  );
  const [filter, setFilter] = useState<ActivityFilter>(() => filterFromSearch(locationSearch, filters) ?? 'all');
  // `TabLayout` keeps a visited tab mounted, so a notification arriving while Activity is already
  // open does not remount this page — the initial state above would never be re-read. Following
  // the location is what makes the deep link work on the second and every later tap.
  useEffect(() => {
    const asked = filterFromSearch(locationSearch, filters);
    if (asked) setFilter(asked);
  }, [locationSearch, filters]);
  // A pick is written back to the URL, so a later link to a filter the URL no longer names is a
  // change of location the effect above sees.
  const pickFilter = (next: ActivityFilter) => {
    setFilter(next);
    navigate(
      ({ pathname, hash, state }) => ({ pathname, search: `?filter=${next}`, hash, state }),
      HistoryAction.Replace
    );
  };
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Remembered per device in the app's settings module, so the tab reopens in the view the user
  // left it in; `list` until they choose otherwise.
  const view = useActivityView();
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  // The search button in the header shows and hides the search field. A
  // closed field also clears the query, so the list goes back to the full set.
  const toggleSearch = () => {
    setSearchOpen(open => {
      if (open) setSearch('');
      return !open;
    });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-app-bg">
      <TabRootHeader
        title={t('activity')}
        search={{ open: searchOpen, value: search, onChange: setSearch, placeholder: t('searchByNameOrSymbol') }}
        actions={
          <>
            <TabHeaderAction
              label={t('activitySearch')}
              icon={IconName.Search}
              active={searchOpen}
              onClick={toggleSearch}
            />
            <TabHeaderAction
              ref={menuAnchorRef}
              label={t('activityViewOptions')}
              icon={IconName.List}
              active={menuOpen}
              onClick={() => setMenuOpen(open => !open)}
              data-testid="activity-view-button"
            />
          </>
        }
        // The filter row belongs to the feed. The Groups view rolls the history up by counterparty,
        // which is its own filtering, so it carries no row — and no filter anywhere else either:
        // a narrowing with no visible control saying so is worse than none. The feed's choice is
        // kept while the user is away in Groups, and the row shows it again on the way back.
        filter={
          view === 'list'
            ? { items: filters, value: filter, onChange: pickFilter, 'aria-label': t('activityFilters') }
            : undefined
        }
      />

      <ActivityViewMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={menuAnchorRef}
        view={view}
        onViewChange={setActivityView}
      />

      {/* Notes the wallet gave up importing automatically (#788 follow-up) —
          possibly the only copy of the funds, so surfaced where the user looks
          for their incoming activity, with the manual drain the dead-letter
          store's contract assumes. Renders nothing while the store is empty.
          Under the filter row, so an empty store costs the page nothing. */}
      <DeadletteredNotesNotice className="shrink-0 mx-4 mt-2" />

      {/* Keyed by account and endpoint: its claim receipts belong to one account on one chain. */}
      {view === 'groups' ? (
        <ActivityGroupedHistory
          key={`${account.publicKey}|${getEffectiveRpcUrl()}|${getEffectiveNetworkName()}`}
          search={search}
          programId={programId}
        />
      ) : (
        <ActivityPendingHistory
          key={`${account.publicKey}|${getEffectiveRpcUrl()}|${getEffectiveNetworkName()}`}
          search={search}
          filter={filter}
          programId={programId}
        />
      )}
    </div>
  );
};

export default AllHistory;
