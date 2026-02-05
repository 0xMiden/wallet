import React, { FC, useRef } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import History from 'app/templates/history/History';
import { useAccount } from 'lib/miden/front';
import { isMobile } from 'lib/platform';

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
      {/* Header */}
      <div
        className={classNames(
          'flex w-full items-center justify-center px-4 bg-white border-b-[0.5px] border-[#48484833] border-dashed',
          isMobile() ? 'pt-6 pb-[18px]' : 'py-[18px]'
        )}
      >
        <h1 className="text-xl font-medium text-heading-gray">{t('activities')}</h1>
      </div>

      {/* Content */}
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
