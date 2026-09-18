import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import clsx from 'clsx';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { ActivityPendingHistory } from 'app/templates/history/ActivityPendingHistory';
import type { ActivityFilter } from 'app/templates/history/History';
import { DeadletteredNotesNotice } from 'components/DeadletteredNotesNotice';
import { TabHeader, TabHeaderAction } from 'components/ui';
import { Pill } from 'components/ui/Pill';
import { springs, useMotion } from 'lib/animation';
import { useAccount } from 'lib/miden/front';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { hapticSelection } from 'lib/mobile/haptics';

type AllHistoryProps = {
  programId?: string | null;
};

// One fill shared by every filter pill: Framer's layoutId slides it from the
// old selection to the new one instead of each pill snapping its own
// background on and off (same technique as `BottomNav`'s tab pill).
const FILTER_PILL_LAYOUT_ID = 'activity-filter-pill';

const AllHistory: FC<AllHistoryProps> = ({ programId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const pillTransition = useMotion(springs.pill);
  const reduceMotion = useReducedMotion();
  const filterRefs = useRef<Partial<Record<ActivityFilter, HTMLDivElement | null>>>({});

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

  // Keeps the newly-selected chip on screen when the row scrolls further than
  // the viewport (five chips can outrun a 360px extension popup).
  useEffect(() => {
    filterRefs.current[filter]?.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest'
    });
  }, [filter, reduceMotion]);

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

      <div className="shrink-0 px-4 py-3 flex items-center gap-2 overflow-x-auto no-scrollbar">
        {filters.map(f => {
          const isActive = f.id === filter;
          return (
            <div
              key={f.id}
              ref={el => {
                filterRefs.current[f.id] = el;
              }}
              className="relative shrink-0"
            >
              {isActive && (
                <motion.span
                  layoutId={FILTER_PILL_LAYOUT_ID}
                  className="pointer-events-none absolute inset-0 rounded-full bg-accent-tint"
                  transition={pillTransition}
                />
              )}
              <Pill
                tone={isActive ? 'plain' : 'neutral'}
                selected={isActive}
                onClick={() => handleFilterTap(f.id)}
                className={clsx(
                  'transition-colors motion-reduce:transition-none',
                  isActive && 'bg-transparent text-accent-tint-ink'
                )}
              >
                {f.label}
              </Pill>
            </div>
          );
        })}
      </div>

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
