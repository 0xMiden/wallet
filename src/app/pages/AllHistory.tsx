import React, { FC, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import History from 'app/templates/history/History';
import { hapticSelection } from 'lib/mobile/haptics';
import { useAccount } from 'lib/miden/front';
import { navigate } from 'lib/woozie';
import { SearchInput } from 'components/ui';

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
    <div className="flex-1 flex flex-col min-h-0 bg-white">
      <header className="shrink-0 px-4 pt-3 pb-2 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-text-primary-token">{t('activity')}</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Profile"
            onClick={() => navigate('/select-account')}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-25 text-text-primary-token"
          >
            <Icon name={IconName.User} className="w-5 h-5" fill="currentColor" />
          </button>
          <button
            type="button"
            aria-label={t('settings')}
            onClick={() => navigate('/settings')}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-25 text-text-primary-token"
          >
            <Icon name={IconName.Settings} className="w-5 h-5" fill="currentColor" />
          </button>
        </div>
      </header>

      <div className="shrink-0 px-4 pb-3 flex items-center gap-2 overflow-x-auto no-scrollbar">
        {filters.map(f => {
          const isActive = f.id === filter;
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => handleFilterTap(f.id)}
              className={classNames(
                'shrink-0 px-4 h-9 rounded-full text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent-primary text-text-on-accent'
                  : 'bg-white text-text-primary-token border border-rule-strong'
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <div className="shrink-0 px-4 pb-3">
        <SearchInput value={search} onChange={setSearch} placeholder={t('searchByNameOrSymbol')} />
      </div>

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
