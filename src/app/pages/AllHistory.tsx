import React, { FC, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { ActivityPendingHistory } from 'app/templates/history/ActivityPendingHistory';
import type { ActivityFilter } from 'app/templates/history/History';
import { DeadletteredNotesNotice } from 'components/DeadletteredNotesNotice';
import { TabHeader, TabHeaderAction } from 'components/ui';
import { SegmentedControl, SegmentedControlItem } from 'components/ui/SegmentedControl';
import { useAccount } from 'lib/miden/front';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';

type AllHistoryProps = {
  programId?: string | null;
};

const AllHistory: FC<AllHistoryProps> = ({ programId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);

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
      <TabHeader
        title={t('activity')}
        search={{ open: searchOpen, value: search, onChange: setSearch, placeholder: t('searchByNameOrSymbol') }}
        actions={
          <TabHeaderAction
            label={t('activitySearch')}
            icon={IconName.Search}
            active={searchOpen}
            onClick={toggleSearch}
          />
        }
      />

      {/* Notes the wallet gave up importing automatically (#788 follow-up) —
          possibly the only copy of the funds, so surfaced where the user looks
          for their incoming activity, with the manual drain the dead-letter
          store's contract assumes. Renders nothing while the store is empty. */}
      <DeadletteredNotesNotice className="shrink-0 mx-4 mt-3" />

      <SegmentedControl
        items={filters}
        value={filter}
        onChange={setFilter}
        aria-label={t('activityFilters')}
        className="shrink-0 px-4 py-2"
      />

      {/* Keyed by account and endpoint: its claim receipts belong to one account on one chain. */}
      <ActivityPendingHistory
        key={`${account.publicKey}|${getEffectiveRpcUrl()}|${getEffectiveNetworkName()}`}
        search={search}
        filter={filter}
        programId={programId}
      />
    </div>
  );
};

export default AllHistory;
