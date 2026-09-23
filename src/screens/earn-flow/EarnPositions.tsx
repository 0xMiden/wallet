import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { PageHeader } from 'components/PageHeader';
import { CardButton } from 'components/ui/Card';
import { goBack, navigate } from 'lib/woozie';

import { EarnSummaryPanel, ProviderLogo } from './components';
import { EarnLoadError } from './EarnLoadError';
import { EarnPosition } from './types';
import { useEarnPositions } from './useEarnPositions';

const EarnPositions: FC = () => {
  const { t } = useTranslation();
  const { summary, positions, error, isLoading, refetch } = useEarnPositions();

  // A failed load with nothing to fall back on must NOT read as "you have no
  // positions / $0" — that misrepresents a network/service problem as an empty
  // portfolio. Show a distinct, retryable error instead. If there is last-good
  // data (positions present via keepPreviousData), keep showing it rather than
  // hiding real balances behind a transient error.
  const showLoadError = Boolean(error) && positions.length === 0 && !isLoading;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-positions-page">
      <PageHeader className="shrink-0 px-4" title={t('earnPositionsTitle')} onBack={goBack} />

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col px-4 pb-8 pt-4">
          {showLoadError ? (
            <EarnLoadError onRetry={refetch} className="mt-10" />
          ) : (
            <>
              <EarnSummaryPanel summary={summary} titleId="earn-positions-summary-title" />

              <section className="mt-7 flex flex-col gap-5" aria-label={t('earnPositionsRegionLabel')}>
                {positions.map(position => (
                  <EarnPositionDetailCard key={position.id} position={position} />
                ))}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const EarnPositionDetailCard: FC<{ position: EarnPosition }> = ({ position }) => {
  const { t } = useTranslation();

  return (
    <CardButton
      padding="tile"
      data-testid={`earn-position-card-${position.id}`}
      onClick={() => navigate(`/earn/positions/${position.id}`)}
      className="w-full"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderLogo protocol={position.protocol} className="h-4 w-4" />
          <div className="truncate text-base font-medium leading-none text-ink">
            {position.protocol} &bull; {position.asset}
          </div>
        </div>
        <div className="shrink-0 rounded-full bg-green-100 px-3 py-1.5 text-xs font-bold leading-none text-status-positive">
          {t('earnPositionsApy', { apy: position.apy })}
        </div>
      </div>

      <div className="mt-4 font-heading text-[36px] font-bold leading-none text-ink">{position.amount}</div>
      <div className="mt-3 text-base font-bold leading-none text-green-500">{position.rewards}</div>

      <div className="mt-2 mb-4 h-px bg-[#2525251C]" />

      <div className="flex items-center justify-between gap-4 text-sm leading-none text-ink">
        <div>
          {t('earnDeposited')} <span className="font-bold">{position.depositedAmount}</span>
        </div>
        <div>{position.activeDuration}</div>
      </div>

      <Icon name={IconName.ChevronRightLucide} className="sr-only" fill="none" />
    </CardButton>
  );
};

export default EarnPositions;
