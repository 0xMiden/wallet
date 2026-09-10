import React, { FC, useEffect, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { ActivityPendingHistory } from 'app/templates/history/ActivityPendingHistory';
import type { ActivityFilter } from 'app/templates/history/History';
import { DeadletteredNotesNotice } from 'components/DeadletteredNotesNotice';
import { TabHeader, TabHeaderAction } from 'components/ui';
import { reconcileAgglayerBridgedReceives } from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { hapticSelection } from 'lib/mobile/haptics';

type AllHistoryProps = {
  programId?: string | null;
};

const AllHistory: FC<AllHistoryProps> = ({ programId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let running = false;

    const poll = async () => {
      if (cancelled || running) return;
      running = true;
      try {
        await reconcileAgglayerBridgedReceives();
      } catch (error) {
        console.warn('[activity] AggLayer bridge poll failed', error);
      } finally {
        running = false;
      }
    };

    poll();
    const timer = setInterval(poll, 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const filters = useMemo<Array<{ id: ActivityFilter; label: string }>>(
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

  const handleFilterTap = (id: ActivityFilter) => {
    if (id === filter) return;
    hapticSelection();
    setFilter(id);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-app-bg">
      <TabHeader
        title={t('activity')}
        hideSettings
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

      <div className="shrink-0 px-4 py-3 flex items-center gap-2 overflow-x-auto no-scrollbar">
        {filters.map(f => {
          const isActive = f.id === filter;
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => handleFilterTap(f.id)}
              className={classNames(
                'px-6 py-3 rounded-full font-heading text-sm leading-[100%] font-medium transition-colors',
                isActive
                  ? 'bg-accent-primary text-pure-white font-semibold'
                  : 'bg-white text-text-primary-token border border-rule-strong'
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <ActivityPendingHistory key={account.publicKey} search={search} filter={filter} programId={programId} />
    </div>
  );
};

export default AllHistory;
