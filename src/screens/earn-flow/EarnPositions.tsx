import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { CardButton } from 'components/ui/Card';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { goBack, navigate } from 'lib/woozie';

import { EarnSummaryPanel } from './components';
import { usdFigureFormatter } from './earn-mapping';
import { ProviderLogo } from './ProviderLogo';
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
    <SubPageLayout data-testid="earn-positions-page" title={t('earnPositionsTitle')} onBack={goBack}>
      {showLoadError ? (
        <div className="flex flex-col items-center gap-4">
          {/* The shared notice, in the negative tone, rather than a page-local alert block. */}
          <Notice tone="negative" role="alert" data-testid="earn-positions-load-error">
            {t('earnPositionsLoadError')}
          </Notice>
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

          {/* Cards in a list are separated by space, 12px, as on the tab root. */}
          <section className="flex flex-col gap-3" aria-label={t('earnPositionsRegionLabel')}>
            {positions.map(position => (
              <EarnPositionDetailCard key={position.id} position={position} />
            ))}
          </section>
        </>
      )}
    </SubPageLayout>
  );
};

const EarnPositionDetailCard: FC<{ position: EarnPosition }> = ({ position }) => {
  const { t } = useTranslation();

  return (
    // Outlined, like the same position's card on the tab root: one card standing on the page, not a
    // grey block. `5a0abd807` moved the tab root's cards here and left this page's behind.
    <CardButton
      surface="outline"
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
        <AnimatedNumber
          className="shrink-0 text-value text-positive-tint-ink"
          value={position.aprPercent}
          format={apr => t('earnPositionsApy', { apy: `${apr.toFixed(2)}%` })}
          placeholder={t('earnPositionsApy', { apy: position.apy })}
        />
      </div>

      <AnimatedNumber
        className="mt-4 block text-hero-value text-ink"
        value={position.depositsUsd}
        format={usdFigureFormatter(position.depositsUsd)}
        placeholder={position.amount}
      />
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
