import React, { FC, useRef } from 'react';

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

  // Content only - container and footer provided by TabLayout
  return (
    <>
      <NavigationHeader showBorder title={t('activities')} innerDivClassName="text-2xl" />
      <div className={classNames('flex-1 min-h-0 overflow-y-auto', 'bg-white z-30 relative')} ref={scrollParentRef}>
        <div className="px-4">
          <History
            address={account.publicKey}
            programId={programId}
            fullHistory={true}
            scrollParentRef={scrollParentRef}
          />
        </div>
      </div>
    </>
  );
};

export default AllHistory;
