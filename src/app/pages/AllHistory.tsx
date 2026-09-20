import React, { FC, useMemo, useRef, useState } from 'react';

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

type AllHistoryProps = {
  programId?: string | null;
};

const AllHistory: FC<AllHistoryProps> = ({ programId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Remembered per device in the app's settings module, so the tab reopens in the view the user
  // left it in; `list` until they choose otherwise.
  const view = useActivityView();
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

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
            ? { items: filters, value: filter, onChange: setFilter, 'aria-label': t('activityFilters') }
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
