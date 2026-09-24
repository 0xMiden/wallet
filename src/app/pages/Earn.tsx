import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { CardButton } from 'components/ui/Card';
import { EmptyState } from 'components/ui/EmptyState';
import { TextAction } from 'components/ui/TextAction';
import { navigate } from 'lib/woozie';
import { EarnSummaryPanel, ProviderLogo } from 'screens/earn-flow/components';
import { EarnLoadError } from 'screens/earn-flow/EarnLoadError';
import { EarnPosition, EarnVault } from 'screens/earn-flow/types';
import { useEarnPositions } from 'screens/earn-flow/useEarnPositions';

const Earn: FC = () => {
  const { t } = useTranslation();
  const { summary, positions, vaults, isLoading, error, refetch } = useEarnPositions();
  const loadFailed = Boolean(error) && !isLoading;

  return (
    <div className="h-full overflow-hidden bg-page" data-testid="earn-page">
      <div className="h-full overflow-y-auto">
        <div className="flex flex-col gap-5 px-4 pt-3 pb-32">
          {/* A failed first load draws no summary: with no positions behind it, it would read as "$0". */}
          {!(loadFailed && positions.length === 0) && (
            <EarnSummaryPanel summary={summary} titleId="earn-summary-title" />
          )}

          <section className="flex flex-col gap-3" aria-labelledby="earn-positions-title">
            <div className="flex items-center justify-between">
              <h2 id="earn-positions-title" className="text-title-page text-ink">
                {t('earnCurrentPositionsTitle')}
              </h2>
              <TextAction onClick={() => navigate('/earn/positions')} data-testid="earn-see-all">
                {t('earnSeeAll')}
              </TextAction>
            </div>

            {/* Only a load that settled with nothing says "no positions": while the first load is in
                flight the slot stays empty, and a failed load says so and retries - in place of the
                list when there is nothing to show, above the last-good cards when there is. */}
            {positions.length === 0 && isLoading ? null : positions.length === 0 && loadFailed ? (
              <EarnLoadError onRetry={refetch} />
            ) : positions.length === 0 ? (
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

          <section className="flex flex-col gap-3" aria-labelledby="earn-vaults-title">
            <h2 id="earn-vaults-title" className="text-title-page text-ink">
              {t('earnVaultsTitle')}
            </h2>

            <div className="flex flex-col gap-3">
              {vaults.map(vault => (
                <VaultRow key={vault.id} vault={vault} />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
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
