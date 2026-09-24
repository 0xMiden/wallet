import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { CardButton } from 'components/ui/Card';
import { EmptyState } from 'components/ui/EmptyState';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { goBack, navigate } from 'lib/woozie';

import { EarnSummaryPanel } from './components';
import { EarnLoadError } from './EarnLoadError';
import { ProviderLogo } from './ProviderLogo';
import { EarnPosition } from './types';
import { useEarnPositions } from './useEarnPositions';

const EarnPositions: FC = () => {
  const { t } = useTranslation();
  const { summary, positions, isLoading, error, refetch } = useEarnPositions();

  // A failed load must NOT read as "you have no positions / $0": with nothing to fall back on it
  // replaces the list; with last-good positions on screen (a failed refresh keeps them) they stay,
  // under a notice that they may be incomplete.
  const loadFailed = Boolean(error);
  const showLoadError = loadFailed && positions.length === 0;
  // A first load in flight has nothing to show yet: its empty summary would read as "$0".
  const pending = !loadFailed && positions.length === 0 && isLoading;
  const empty = !loadFailed && positions.length === 0 && !isLoading;

  return (
    <SubPageLayout data-testid="earn-positions-page" title={t('earnPositionsTitle')} onBack={goBack}>
      {showLoadError ? (
        <EarnLoadError onRetry={refetch} className="mt-10" />
      ) : pending ? null : empty ? (
        <EmptyState
          surface="dashed"
          icon={IconName.Earn}
          title={t('earnNoActivePositionsTitle')}
          description={t('earnNoActivePositionsBody')}
          data-testid="earn-positions-empty"
        />
      ) : (
        <>
          {loadFailed && <EarnLoadError onRetry={refetch} />}
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
