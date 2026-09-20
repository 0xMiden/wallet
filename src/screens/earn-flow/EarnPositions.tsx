import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { CardButton } from 'components/ui/Card';
import { goBack, navigate } from 'lib/woozie';

import { EarnSummaryPanel, ProviderLogo } from './components';
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
    <div className="flex h-full flex-col overflow-hidden bg-app-bg" data-testid="earn-positions-page">
      <PageHeader className="shrink-0 px-4" title={t('earnPositionsTitle')} onBack={goBack} />

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col px-4 pb-8 pt-4">
          {showLoadError ? (
            <div
              className="mt-10 flex flex-col items-center gap-4 text-center"
              data-testid="earn-positions-load-error"
              role="alert"
            >
              <p className="max-w-xs text-body text-ink">{t('earnPositionsLoadError')}</p>
              {/* The shared compact secondary button, which brings the tap haptic and the press
                  motion with it. */}
              <Button
                type="button"
                data-testid="earn-positions-retry"
                variant={ButtonVariant.Secondary}
                size="sm"
                title={t('retry')}
                // `Button` fires the tap haptic itself; calling it here too would buzz twice.
                onClick={refetch}
                className="w-auto"
              />
            </div>
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
          <div className="truncate text-row-title text-ink">
            {position.protocol} &bull; {position.asset}
          </div>
        </div>
        {/* The APY reads as a figure, like the tab page's card: the tinted ink, not the raw
            #90BA89 fill, which is 2.2:1 under text. */}
        <div className="shrink-0 text-value text-positive-tint-ink">{t('earnPositionsApy', { apy: position.apy })}</div>
      </div>

      <div className="mt-4 text-hero-value text-ink">{position.amount}</div>
      <div className="mt-3 text-value text-positive-tint-ink">{position.rewards}</div>

      {/* A hairline inside a card only divides its rows. */}
      <div className="mt-2 mb-4 h-px bg-hairline" />

      <div className="flex items-center justify-between gap-4 text-body-sm text-muted">
        <div>
          {t('earnDeposited')} <span className="text-value text-ink">{position.depositedAmount}</span>
        </div>
        <div>{position.activeDuration}</div>
      </div>

      <Icon name={IconName.ChevronRightLucide} className="sr-only" fill="none" />
    </CardButton>
  );
};

export default EarnPositions;
