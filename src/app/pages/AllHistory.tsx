import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import History from 'app/templates/history/History';
import PendingNotesInfoDrawer from 'app/templates/PendingNotesInfoDrawer';
import { SearchInput, TabHeader } from 'components/ui';
import { reconcileAgglayerBridgedReceives } from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { hapticLight, hapticSelection } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

type AllHistoryProps = {
  programId?: string | null;
};

type FilterId = 'all' | 'sent' | 'received' | 'faucet';

const AllHistory: FC<AllHistoryProps> = ({ programId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const { data: claimableNotes } = useClaimableNotes(account.publicKey);
  const pendingNotesCount = claimableNotes?.length ?? 0;
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterId>('all');
  const [infoDrawerOpen, setInfoDrawerOpen] = useState(false);

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

    void poll();
    const timer = setInterval(poll, 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const filters = useMemo<Array<{ id: FilterId; label: string }>>(
    () => [
      { id: 'all', label: t('all') },
      { id: 'sent', label: t('sent') },
      { id: 'received', label: t('received') },
      { id: 'faucet', label: t('faucet') }
    ],
    [t]
  );

  const handleFilterTap = (id: FilterId) => {
    if (id === filter) return;
    hapticSelection();
    setFilter(id);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-app-bg">
      <TabHeader title={t('activity')} />

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

      <div className="shrink-0 px-4">
        <SearchInput value={search} onChange={setSearch} placeholder={t('searchByNameOrSymbol')} />
      </div>

      {pendingNotesCount > 0 && (
        <div className="shrink-0 px-4 pt-4 pb-4 border-b-4 border-[#827C7C33]">
          <div className="flex items-center gap-1.5 mb-2">
            <h2 className="font-heading text-sm font-extrabold text-heading-gray dark:text-pure-white">
              {t('pendingNotes')}
            </h2>
            <button
              type="button"
              aria-label={t('whatArePendingNotes')}
              onClick={() => {
                hapticLight();
                setInfoDrawerOpen(true);
              }}
              className="flex items-center justify-center text-heading-gray dark:text-pure-white"
            >
              <Icon name={IconName.InformationFill} className="w-4! h-4!" fill="currentColor" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              hapticLight();
              navigate('/pending-notes');
            }}
            className="w-full text-left rounded-2xl bg-gray-25 py-3 px-4"
          >
            <div className="flex items-center gap-1">
              <span className="font-heading text-base font-extrabold text-heading-gray dark:text-pure-white">
                {t('consumeYourNotes')}
              </span>
              <span className="rounded-full bg-accent-primary w-12 h-4 flex items-center justify-center text-xs font-bold font-heading text-pure-white">
                {pendingNotesCount}
              </span>
            </div>
            <p className="text-sm text-heading-gray font-heading font-semibold">{t('consumeYourNotesDescription')}</p>
          </button>
        </div>
      )}

      <PendingNotesInfoDrawer open={infoDrawerOpen} onOpenChange={setInfoDrawerOpen} notesCount={pendingNotesCount} />

      <div ref={scrollParentRef} className="flex-1 min-h-0 overflow-y-auto pb-28">
        <div className="px-4">
          <History
            address={account.publicKey}
            programId={programId}
            fullHistory={true}
            centerEmptyState={true}
            scrollParentRef={scrollParentRef}
            searchQuery={search}
            filter={filter}
          />
        </div>
      </div>
    </div>
  );
};

export default AllHistory;
