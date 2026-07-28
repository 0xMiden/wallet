import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { CircleButton } from 'components/CircleButton';
import { hapticLight } from 'lib/mobile/haptics';
import { goBack, navigate } from 'lib/woozie';

import { EarnSummaryPanel, ProviderLogo } from './components';
import { EarnPosition } from './types';
import { useEarnPositions } from './useEarnPositions';

const EarnPositions: FC = () => {
  const { t } = useTranslation();
  const { summary, positions } = useEarnPositions();

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-positions-page">
      <header className="shrink-0 border-b border-rule-default px-4 pb-4 pt-5">
        <div className="flex items-center gap-3">
          <CircleButton
            icon={IconName.ChevronLeft}
            onClick={goBack}
            className="h-10 w-10 bg-gray-25 text-heading-gray hover:bg-gray-50 focus:bg-gray-50"
            size="md"
            aria-label={t('back')}
          />
          <h1 className="font-heading text-[26px] font-bold leading-none text-heading-gray">
            {t('earnPositionsTitle')}
          </h1>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col px-4 pb-8 pt-4">
          <EarnSummaryPanel summary={summary} titleId="earn-positions-summary-title" />

          <section className="mt-7 flex flex-col gap-5" aria-label={t('earnPositionsRegionLabel')}>
            {positions.map(position => (
              <EarnPositionDetailCard key={position.id} position={position} />
            ))}
          </section>
        </div>
      </div>
    </div>
  );
};

const EarnPositionDetailCard: FC<{ position: EarnPosition }> = ({ position }) => {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      data-testid={`earn-position-card-${position.id}`}
      onClick={() => {
        hapticLight();
        navigate(`/earn/positions/${position.id}`);
      }}
      className={classNames('w-full rounded-2xl border border-[#EFEFF2] bg-white px-4 py-6 text-left')}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderLogo protocol={position.protocol} className="h-4 w-4" />
          <div className="truncate text-base font-medium leading-none text-heading-gray">
            {position.protocol} &bull; {position.asset}
          </div>
        </div>
        <div className="shrink-0 rounded-full bg-green-100 px-3 py-1.5 text-xs font-bold leading-none text-status-positive">
          {t('earnPositionsApy', { apy: position.apy })}
        </div>
      </div>

      <div className="mt-4 font-heading text-[36px] font-bold leading-none text-heading-gray">{position.amount}</div>
      <div className="mt-3 text-base font-bold leading-none text-green-500">{position.rewards}</div>

      <div className="mt-2 mb-4 h-px bg-[#2525251C]" />

      <div className="flex items-center justify-between gap-4 text-sm leading-none text-heading-gray">
        <div>
          {t('earnDeposited')} <span className="font-bold">{position.depositedAmount}</span>
        </div>
        <div>{position.activeDuration}</div>
      </div>

      <Icon name={IconName.ChevronRightLucide} className="sr-only" fill="none" />
    </button>
  );
};

export default EarnPositions;
