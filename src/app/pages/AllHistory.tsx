import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { Icon, IconName } from 'app/icons/v2';
import History from 'app/templates/history/History';
import PendingNotesInfoDrawer from 'app/templates/PendingNotesInfoDrawer';
import { SearchInput, TabHeader } from 'components/ui';
import { reconcileAgglayerBridgedReceives } from 'lib/miden/activity';
import { useAccount, useLocalStorage } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { hapticLight, hapticSelection } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

type AllHistoryProps = {
  programId?: string | null;
};

type FilterId = 'all' | 'sent' | 'received' | 'faucet';

const GuardianRecoveryWarning: FC<{ accountId: string }> = ({ accountId }) => {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useLocalStorage(`guardian-recovery-warning-dismissed:${accountId}`, false);
  if (dismissed) return null;

  return (
    <div className="shrink-0 px-4 pt-3">
      <div
        role="status"
        className="flex items-start gap-2 rounded-xl border border-status-pending/30 bg-status-pending/10 p-3 text-text-primary-token"
      >
        <Icon
          name={IconName.WarningFill}
          size="sm"
          className="mt-0.5 shrink-0 text-status-pending"
          fill="currentColor"
        />
        <p className="grow font-heading text-sm font-medium leading-5">{t('incompleteTransactionHistory')}</p>
        <button
          type="button"
          aria-label={t('dismissIncompleteTransactionHistory')}
          onClick={() => {
            hapticLight();
            setDismissed(true);
          }}
          className="flex shrink-0 items-center justify-center rounded-md text-text-secondary-token focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
        >
          <Icon name={IconName.Close} size="sm" fill="currentColor" />
        </button>
      </div>
    </div>
  );
};

const AllHistory: FC<AllHistoryProps> = ({ programId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const { data: claimableNotes } = useClaimableNotes(account.publicKey);
  const pendingNotesCount = claimableNotes?.length ?? 0;
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterId>('all');
  const [infoDrawerOpen, setInfoDrawerOpen] = useState(false);
  const isRecovering =
    account.guardianTransactionRecoveryStatus === 'pending' ||
    account.guardianTransactionRecoveryStatus === 'recovering';

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

  if (isRecovering) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-app-bg">
        <TabHeader title={t('activity')} />
        <div
          role="status"
          aria-live="polite"
          className="flex flex-1 flex-col items-center justify-center gap-4 px-6 pb-28 text-center"
        >
          <ActivitySpinner height="48px" />
          <p className="font-heading text-sm font-semibold text-text-secondary-token">
            {t('recoveringTransactionHistory')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-app-bg">
      <TabHeader title={t('activity')} />

      {account.guardianTransactionRecoveryStatus === 'partial' && (
        <GuardianRecoveryWarning key={account.publicKey} accountId={account.publicKey} />
      )}

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
                'px-6 py-2 rounded-full font-heading text-sm leading-[100%] font-medium transition-colors',
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
