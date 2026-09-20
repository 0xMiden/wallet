import React, { FC, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { Area, AreaChart, Tooltip, YAxis } from 'recharts';

import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { Pill } from 'components/ui/Pill';
import { SegmentedControl, SegmentedControlItem } from 'components/ui/SegmentedControl';
import { ChartContainer } from 'lib/ui/charts';
import { goBack, navigate } from 'lib/woozie';

import { MetricCard } from './components';
import { placeholderVault } from './earn-mapping';
import { EarnVault } from './types';
import { useEarnPositions } from './useEarnPositions';

type EarnTimeframe = '1D' | '1W' | '1M' | 'All';

const TIMEFRAMES: EarnTimeframe[] = ['1D', '1W', '1M', 'All'];

const TIMEFRAME_ITEMS: SegmentedControlItem<EarnTimeframe>[] = TIMEFRAMES.map(tf => ({
  id: tf,
  label: tf
}));
const CHART_GREEN = '#90BA89';

interface EarnVaultDetailProps {
  vaultId: string;
}

const EarnVaultDetail: FC<EarnVaultDetailProps> = ({ vaultId }) => {
  const [timeframe, setTimeframe] = useState<EarnTimeframe>('1M');
  const { t } = useTranslation();
  const { vaults } = useEarnPositions();
  const vault = useMemo(() => vaults.find(item => item.id === vaultId) ?? placeholderVault(), [vaults, vaultId]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-vault-detail-page">
      <PageHeader
        className="shrink-0 px-4"
        title={`${vault.protocol} • ${vault.asset}`}
        onBack={goBack}
        actions={
          <Pill className="shrink-0">{t('earnAssetOnNetwork', { asset: vault.asset, network: vault.network })}</Pill>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col px-4 pb-8 pt-8">
          <section aria-labelledby="earn-vault-apy-title">
            <div
              id="earn-vault-apy-title"
              className="font-heading text-[56px] font-bold leading-none text-status-positive"
            >
              {vault.apy}
            </div>
            <div className="mt-2 text-xs font-bold uppercase leading-none tracking-wide text-gray-secondary">
              {t('earnCurrentApy')}
            </div>
            <div className="mt-0.5 text-xl font-semibold leading-none text-status-positive">{vault.apyChange24h}</div>
          </section>

          <VaultAreaChart vault={vault} />

          <SegmentedControl
            items={TIMEFRAME_ITEMS}
            value={timeframe}
            onChange={setTimeframe}
            size="sm"
            layout="fill"
            aria-label={t('chartTimeframe')}
            className="mt-3"
          />

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
      <ChartContainer config={{ apy: { color: CHART_GREEN } }} className="h-full w-full aspect-auto">
        <AreaChart data={vault.chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="earn-vault-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_GREEN} stopOpacity={0.28} />
              <stop offset="95%" stopColor={CHART_GREEN} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={[min - padding, max + padding]} hide />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const point = payload[0].payload;
              return (
                <div className="rounded-lg bg-ink px-2 py-1 text-xs text-pure-white shadow">
                  <div className="font-heading font-semibold">{Number(point.value).toFixed(2)}%</div>
                  <div className="opacity-75">{point.label}</div>
                </div>
              );
            }}
          />
          <Area
            dataKey="value"
            type="natural"
            stroke="var(--color-apy)"
            strokeWidth={2.5}
            fill="url(#earn-vault-area)"
            activeDot={{ r: 4, stroke: CHART_GREEN, fill: CHART_GREEN, strokeWidth: 1 }}
            dot={(props: any) =>
              props.index === lastIndex ? (
                <circle cx={props.cx} cy={props.cy} r={4} fill={CHART_GREEN} stroke="#FFFFFF" strokeWidth={2} />
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
      <MetricCard label={t('earnRiskLabel')} value={vault.risk} valueClassName="text-[#009B3A]" className="px-3" />
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
      <h2 className="font-heading text-base font-bold leading-none text-ink">{t('about')}</h2>
      <p className="mt-3 text-sm leading-snug text-ink">{vault.about}</p>
    </section>
  );
};

export default EarnVaultDetail;
