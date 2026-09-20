import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { CardButton } from 'components/ui/Card';
import { EmptyState } from 'components/ui/EmptyState';
import { SectionHeader } from 'components/ui/SectionHeader';
import { TextAction } from 'components/ui/TextAction';
import { navigate } from 'lib/woozie';
import { EarnSummaryPanel, ProviderLogo } from 'screens/earn-flow/components';
import { EarnPosition, EarnVault } from 'screens/earn-flow/types';
import { useEarnPositions } from 'screens/earn-flow/useEarnPositions';

const Earn: FC = () => {
  const { t } = useTranslation();
  const { summary, positions, vaults } = useEarnPositions();

  return (
    <div className="h-full overflow-hidden bg-page" data-testid="earn-page">
      <div className="h-full overflow-y-auto">
        {/* The 16px page margin, 20px between sections, and Explore's bottom clearance: the two
            home-group tab pages end the same distance above the floating tab bar. */}
        <div className="flex flex-col gap-5 px-4 pt-3 pb-24">
          <EarnSummaryPanel summary={summary} titleId="earn-summary-title" />

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

            {positions.length === 0 ? (
              <EmptyState
                surface="dashed"
                icon={IconName.Earn}
                title={t('earnNoActivePositionsTitle')}
                description={t('earnNoActivePositionsBody')}
                data-testid="earn-positions-empty"
              />
            ) : (
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
            )}
          </section>

          <section aria-label={t('earnVaultsTitle')}>
            <SectionHeader size="xl">{t('earnVaultsTitle')}</SectionHeader>

            {/* Cards in a list are separated by space, 12px, not hairlines. */}
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

        <div className="flex shrink-0 flex-col items-end">
          <span className="text-value text-positive-tint-ink">{vault.apy}</span>
          <span className="text-caption text-muted">{t('earnVaultTvl', { tvl: vault.tvl })}</span>
        </div>
      </div>
    </CardButton>
  );
};

export default Earn;
