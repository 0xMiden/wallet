import React, { FC, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import History from 'app/templates/history/History';
import { NavigationHeader } from 'components/NavigationHeader';
import { useAccount } from 'lib/miden/front';

type AllHistoryProps = {
  programId?: string | null;
};

const AllHistory: FC<AllHistoryProps> = ({ programId }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');

  // Content only - container and footer provided by TabLayout
  return (
    <>
      <NavigationHeader showBorder title={t('activity')} innerDivClassName="text-2xl" />
      <div className={classNames('flex-1 min-h-0 overflow-y-auto', 'bg-app-bg z-30 relative')} ref={scrollParentRef}>
        <div className="px-3">
          <input
            type="text"
            placeholder={t('searchByNameOrSymbol')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full mt-4 rounded-10 bg-white py-5  text-center text-sm placeholder:text-heading-gray outline-none placeholder:text-sm placeholder:font-medium"
          />
          <History
            address={account.publicKey}
            programId={programId}
            fullHistory={true}
            scrollParentRef={scrollParentRef}
            searchQuery={search}
          />
        </div>
      </div>
    </>
  );
};

export default AllHistory;
