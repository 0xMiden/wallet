import React, { FC, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { AgglayerBridgeBanner } from 'app/templates/history/AgglayerBridgeBanner';
import History from 'app/templates/history/History';
import { SearchInput } from 'components/ui';
import { useAccount } from 'lib/miden/front';
import { hapticSelection } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

type AllHistoryProps = {
  programId?: string | null;
};

type FilterId = 'all' | 'sent' | 'received' | 'faucet';

const AllHistory: FC<AllHistoryProps> = ({ programId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterId>('all');

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
      <header className="shrink-0 px-4 py-4 flex items-center justify-between">
        <h1 className="text-[28px] font-semibold text-heading-gray dark:text-pure-white">{t('activity')}</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t('settings')}
            onClick={() => navigate('/settings')}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-25 text-text-primary-token"
          >
            <Icon name={IconName.Settings} className="w-4 h-4" fill="currentColor" />
          </button>
        </div>
      </header>

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
                'px-6 py-2 rounded-10 text-sm leading-[100%] font-medium transition-colors',
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

      <div ref={scrollParentRef} className="flex-1 min-h-0 overflow-y-auto pb-28">
        <div className="px-4">
          <AgglayerBridgeBanner />
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
