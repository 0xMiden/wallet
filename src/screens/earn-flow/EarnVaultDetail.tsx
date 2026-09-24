import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';
import { Area, AreaChart, Tooltip, YAxis } from 'recharts';

import { Button, ButtonVariant } from 'components/Button';
import { SectionHeader } from 'components/ui/SectionHeader';
import { CHART_DOT_RING, CHART_POSITIVE, ChartContainer, ChartValueTooltip } from 'lib/ui/charts';
import { navigate } from 'lib/woozie';

import { EarnFlowHeader, MetricCard } from './components';
import { placeholderVault } from './earn-mapping';
import { EarnLoadError } from './EarnLoadError';
import { EarnVault } from './types';
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
    <div className="flex h-full flex-col overflow-hidden bg-app-bg" data-testid="earn-vault-detail-page">
      <EarnFlowHeader vault={found} />

      <div className="flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col px-4 pb-8">
          {/* A failed load never draws the placeholder vault as if it were real; with the vault in
              hand from an earlier load, it is still shown, under a notice that it may be stale. */}
          {loadFailed && !found ? (
            <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="mt-10" />
          ) : pending ? null : (
            <>
              {loadFailed && <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="mb-6" />}
              <section aria-labelledby="earn-vault-apy-title">
                {/* The figure the page is about, then its label and its 24h move - all on named type
                    styles, and on `positive-tint-ink`, the only green that carries text. */}
                <div id="earn-vault-apy-title" className="text-display text-positive-tint-ink">
                  {vault.apy}
                </div>
                <div className="mt-2 text-label text-muted">{t('earnCurrentApy')}</div>
                <div className="mt-0.5 text-value text-positive-tint-ink">{vault.apyChange24h}</div>
              </section>

              <VaultAreaChart vault={vault} />

              <VaultStats vault={vault} />
              <VaultAbout vault={vault} />

              <div className="mt-auto pt-16">
                <Button
                  data-testid="earn-vault-deposit-btn"
                  title={t('earnDeposit')}
                  variant={ButtonVariant.Primary}
                  accent="earn"
                  disabled={!vault.id}
                  onClick={() => navigate(`/earn/vaults/${vaultId}/deposit`)}
                  className="max-w-none"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const VaultAreaChart: FC<{ vault: EarnVault }> = ({ vault }) => {
  const values = vault.chartData.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = (max - min) * 0.18 || 1;
  const lastIndex = vault.chartData.length - 1;

  return (
    <div className="mt-10 h-[140px]">
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
            dot={(props: any) =>
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
    <div className="mt-6 grid grid-cols-3 gap-2">
      <MetricCard label={t('earnTvlLabel')} value={vault.tvl} className="px-3" />
      <MetricCard
        label={t('earnRiskLabel')}
        value={vault.risk}
        valueClassName="text-positive-tint-ink"
        className="px-3"
      />
      <MetricCard
        label={t('earnAuditedLabel')}
        value={vault.audited ? `✓ ${t('yes')}` : t('no')}
        className="px-3"
        valueClassName={vault.audited ? 'text-ink' : undefined}
      />
    </div>
  );
};

const VaultAbout: FC<{ vault: EarnVault }> = ({ vault }) => {
  const { t } = useTranslation();

  return (
    <section className="mt-4">
      <SectionHeader size="lg" className="px-0">
        {t('about')}
      </SectionHeader>
      <p className="text-body text-muted">{vault.about}</p>
    </section>
  );
};

export default EarnVaultDetail;
