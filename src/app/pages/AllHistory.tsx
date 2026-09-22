import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { ActivityPendingHistory } from 'app/templates/history/ActivityPendingHistory';
import type { ActivityFilter } from 'app/templates/history/History';
import { DeadletteredNotesNotice } from 'components/DeadletteredNotesNotice';
import { TabHeader, TabHeaderAction } from 'components/ui';
import { SegmentedControl, SegmentedControlItem } from 'components/ui/SegmentedControl';
import { useAccount } from 'lib/miden/front';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { beginFlow, FlowHandle } from 'lib/telemetry';

type AllHistoryProps = {
  programId?: string | null;
};

const AllHistory: FC<AllHistoryProps> = ({ programId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);

  /**
   * `activity_view` is a view flow, so its terminal state is the user actually
   * seeing their activity: it completes when the list's first load settles and
   * is cancelled when they leave before that. There is no later moment worth
   * calling "completed" — reading a list emits no such event, and inventing one
   * (a tap on a row, say) would report every ordinary visit as abandoned.
   * Held in a ref rather than state because settling must never re-render.
   */
  const flowRef = useRef<FlowHandle | null>(null);
  useEffect(() => {
    flowRef.current = beginFlow('activity_view');
    return () => {
      flowRef.current?.cancel();
      flowRef.current = null;
    };
  }, []);

  // Clearing the ref keeps this to one terminal call per visit, and keeps the
  // unmount above from re-reporting a view that already completed.
  const handleHistoryLoaded = useCallback(() => {
    const flow = flowRef.current;
    if (!flow) return;
    flowRef.current = null;
    flow.complete();
  }, []);

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
        onInitialLoad={handleHistoryLoaded}
      />
    </div>
  );
};

export default AllHistory;
