import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { HomeGroupPane } from 'app/layouts/HomeGroupPane';
import { CardButton } from 'components/ui/Card';
import { EmptyState } from 'components/ui/EmptyState';
import { SectionHeader } from 'components/ui/SectionHeader';
import { TextAction } from 'components/ui/TextAction';
import { navigate } from 'lib/woozie';
import { EarnSummaryPanel } from 'screens/earn-flow/components';
import { EarnLoadError } from 'screens/earn-flow/EarnLoadError';
import { ProviderLogo } from 'screens/earn-flow/ProviderLogo';
import { EarnPosition, EarnVault } from 'screens/earn-flow/types';
import { useEarnPositions } from 'screens/earn-flow/useEarnPositions';

const Earn: FC = () => {
  const { t } = useTranslation();
  const { summary, positions, vaults, isLoading, error, refetch } = useEarnPositions();
  // SWR keeps the error until a load succeeds, and a first load has none: a retry (which SWR reports
  // as isLoading) must not lift the failure and flash the empty state back.
  const loadFailed = Boolean(error);

  return (
    // The shared home-group pane (HomeGroupPane): the page margin, the offset to the title, the
    // scroll and gesture contract and the clearance over the tab bar, the same as Send, Receive
    // and Swap. 20px between sections is this page's own.
    <HomeGroupPane paneTestId="earn-page" title={t('earnTitle')} titleTestId="earn-title">
      <div className="flex flex-col gap-5 pt-5">
        {/* No summary until positions have loaded: an empty fallback, in flight or failed, would read as "$0". */}
        {!(positions.length === 0 && (isLoading || loadFailed)) && (
          <EarnSummaryPanel summary={summary} titleId="earn-summary-title" />
        )}

        <section aria-label={t('earnCurrentPositionsTitle')}>
          {/* The tab root's section title, with its text action, through the shared header. */}
          <SectionHeader
            size="xl"
            action={
              <TextAction onClick={() => navigate('/earn/positions')} data-testid="earn-see-all">
                {t('earnSeeAll')}
              </TextAction>
            }
          >
            {t('earnCurrentPositionsTitle')}
          </SectionHeader>

          {/* Only a load that settled with nothing says "no positions": while the first load is in
              flight the slot stays empty, and a failed load says so and retries - in place of the
              list when there is nothing to show, above the last-good cards when there is. */}
          {positions.length === 0 && loadFailed ? (
            <EarnLoadError onRetry={refetch} />
          ) : positions.length === 0 && isLoading ? null : positions.length === 0 ? (
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
              <div
                className="-mx-4 overflow-x-auto no-scrollbar touch-pan-x"
                onPointerDown={event => event.stopPropagation()}
              >
                <div className="flex gap-3 px-4 pb-1">
                  {positions.map(position => (
                    <PositionCard key={position.id} position={position} />
                  ))}
                </div>
              </div>
            </>
          )}
        </section>

        {/* Fed by the same read as the positions: with no vaults, loading, failed or settled, there is
            nothing to feature, and a failure is already said once above. */}
        {vaults.length > 0 && (
          <section aria-label={t('earnVaultsTitle')}>
            <SectionHeader size="xl">{t('earnVaultsTitle')}</SectionHeader>

            {/* Cards in a list are separated by space, 12px, not hairlines. */}
            <div className="flex flex-col gap-3">
              {vaults.map(vault => (
                <VaultRow key={vault.id} vault={vault} />
              ))}
            </div>
          </section>
        )}
      </div>
    </HomeGroupPane>
  );
};

const PositionCard: FC<{ position: EarnPosition }> = ({ position }) => {
  const { t } = useTranslation();

  return (
    <CardButton
      surface="outline"
      padding="tile"
      data-testid={`earn-position-card-${position.id}`}
      onClick={() => navigate(`/earn/positions/${position.id}`)}
      className="shrink-0"
    >
      <div className="flex items-center gap-10">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderLogo protocol={position.protocol} className="h-4 w-4" />
          <div className="text-row-title text-ink">
            {position.protocol} &bull; {position.asset}
          </div>
        </div>
        <div className="text-value text-positive-tint-ink">{t('earnPositionsApy', { apy: position.apy })}</div>
      </div>

      <div className="mt-3 text-entry-unit text-ink">{position.amount}</div>
      <div className="mt-2 text-caption text-positive-tint-ink">
        {position.rewards} &bull; {position.age}
      </div>
    </CardButton>
  );
};

const VaultRow: FC<{ vault: EarnVault }> = ({ vault }) => {
  const { t } = useTranslation();

  return (
    <CardButton
      surface="outline"
      padding="row"
      data-testid={`earn-vault-row-${vault.id}`}
      onClick={() => navigate(`/earn/vaults/${vault.id}`)}
    >
      <div className="flex w-full items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-fill">
          <ProviderLogo protocol={vault.protocol} className="h-8 w-8" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate text-row-title text-ink">{vault.protocol}</div>
          <div className="truncate text-caption text-muted">
            {t('earnVaultAssetOnNetwork', { asset: vault.asset, network: vault.network })}
          </div>
        </div>

        <span className="shrink-0 text-value text-positive-tint-ink">{vault.apy}</span>
      </div>
    </CardButton>
  );
};

export default Earn;
