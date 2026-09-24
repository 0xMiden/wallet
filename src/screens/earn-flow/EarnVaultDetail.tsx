import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';
import { Area, AreaChart, Tooltip, YAxis } from 'recharts';

import { Button, ButtonVariant } from 'components/Button';
import { SectionHeader } from 'components/ui/SectionHeader';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { CHART_DOT_RING, CHART_POSITIVE, ChartContainer, ChartValueTooltip } from 'lib/ui/charts';
import { goBack, navigate } from 'lib/woozie';

import { EarnAssetMark, EarnHero, MetricCard } from './components';
import { placeholderVault } from './earn-mapping';
import { EarnLoadError } from './EarnLoadError';
import { ChartDotProps, EarnVault } from './types';
import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

interface EarnVaultDetailProps {
  vaultId: string;
}

const EarnVaultDetail: FC<EarnVaultDetailProps> = ({ vaultId }) => {
  const { t } = useTranslation();
  const { vaults, isLoading, loadError, refetch } = useEarnPositions();
  const found = useMemo(() => vaults.find(item => item.id === vaultId), [vaults, vaultId]);
  const vault = useMemo(() => found ?? placeholderVault(), [found]);
  const { loadFailed, pending } = earnItemLoadState(found, { isLoading, error: loadError });

  return (
    // The shared pushed-page frame: the header, a body whose sections sit 20px apart, and the CTA
    // pinned under it instead of scrolling away at the end of the page.
    <SubPageLayout
      data-testid="earn-vault-detail-page"
      // Back and the protocol in the title; the asset and its network ride the header as one
      // compact mark, since a pill wide enough to spell them out took the width a two-word
      // protocol needed and wrapped the title onto a second line. Until the vault is found the
      // header names the route, never a placeholder vault.
      title={found ? found.protocol : t('earnDeposit')}
      onBack={goBack}
      headerActions={found && <EarnAssetMark asset={found.asset} network={found.network} />}
      footer={
        (loadFailed && !found) || pending ? undefined : (
          <Button
            data-testid="earn-vault-deposit-btn"
            title={t('earnDeposit')}
            variant={ButtonVariant.Primary}
            accent="earn"
            disabled={!vault.id}
            onClick={() => navigate(`/earn/vaults/${vaultId}/deposit`)}
            className="max-w-none"
          />
        )
      }
    >
      {/* A failed load never draws the placeholder vault as if it were real; with the vault in
          hand from an earlier load, it is still shown, under a notice that it may be stale. */}
      {loadFailed && !found ? (
        <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="mt-10" />
      ) : pending ? null : (
        <>
          {loadFailed && <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} />}
          <EarnHero
            labelId="earn-vault-apy-title"
            value={vault.apy}
            valueClassName="text-positive-tint-ink"
            label={t('earnCurrentApy')}
            meta={vault.apyChange24h}
          />

          <VaultAreaChart vault={vault} />

          <VaultStats vault={vault} />
          <VaultAbout vault={vault} />
        </>
      )}
    </SubPageLayout>
  );
};

const VaultAreaChart: FC<{ vault: EarnVault }> = ({ vault }) => {
  const values = vault.chartData.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = (max - min) * 0.18 || 1;
  const lastIndex = vault.chartData.length - 1;

  return (
    <div className="h-[140px]">
      <ChartContainer config={{ apy: { color: CHART_POSITIVE } }} className="h-full w-full aspect-auto">
        <AreaChart data={vault.chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="earn-vault-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_POSITIVE} stopOpacity={0.28} />
              <stop offset="95%" stopColor={CHART_POSITIVE} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={[min - padding, max + padding]} hide />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const point = payload[0].payload;
              return <ChartValueTooltip value={`${Number(point.value).toFixed(2)}%`} label={point.label} />;
            }}
          />
          <Area
            dataKey="value"
            type="natural"
            stroke="var(--color-apy)"
            strokeWidth={2.5}
            fill="url(#earn-vault-area)"
            activeDot={{ r: 4, stroke: CHART_POSITIVE, fill: CHART_POSITIVE, strokeWidth: 1 }}
            dot={(props: ChartDotProps) =>
              props.index === lastIndex ? (
                <circle
                  cx={props.cx}
                  cy={props.cy}
                  r={4}
                  fill={CHART_POSITIVE}
                  stroke={CHART_DOT_RING}
                  strokeWidth={2}
                />
              ) : null
            }
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
};

const VaultStats: FC<{ vault: EarnVault }> = ({ vault }) => {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-3 gap-2">
      <MetricCard label={t('earnTvlLabel')} value={vault.tvl} />
      <MetricCard label={t('earnRiskLabel')} value={vault.risk} valueClassName="text-positive-tint-ink" />
      <MetricCard
        label={t('earnAuditedLabel')}
        value={vault.audited ? `✓ ${t('yes')}` : t('no')}
        valueClassName={vault.audited ? 'text-ink' : undefined}
      />
    </div>
  );
};

const VaultAbout: FC<{ vault: EarnVault }> = ({ vault }) => {
  const { t } = useTranslation();

  return (
    <section>
      <SectionHeader size="lg">{t('about')}</SectionHeader>
      {/* The 4px inset the section label takes, so the copy lines up under it. */}
      <p className="px-1 text-body text-muted">{vault.about}</p>
    </section>
  );
};

export default EarnVaultDetail;
