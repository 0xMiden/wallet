import React, { FC, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { Area, AreaChart, Tooltip, YAxis } from 'recharts';

import { Button, ButtonVariant } from 'components/Button';
import { SectionHeader } from 'components/ui/SectionHeader';
import { SegmentedControl, SegmentedControlItem } from 'components/ui/SegmentedControl';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { ChartContainer } from 'lib/ui/charts';
import { goBack, navigate } from 'lib/woozie';

import { EarnAssetMark, EarnHero, MetricCard } from './components';
import { placeholderVault } from './earn-mapping';
import { ChartDotProps, EarnVault } from './types';
import { useEarnPositions } from './useEarnPositions';

type EarnTimeframe = '1D' | '1W' | '1M' | 'All';

const TIMEFRAMES: EarnTimeframe[] = ['1D', '1W', '1M', 'All'];

const TIMEFRAME_ITEMS: SegmentedControlItem<EarnTimeframe>[] = TIMEFRAMES.map(tf => ({
  id: tf,
  label: tf
}));
// The chart's own ink, as a token rather than a literal: recharts takes SVG paint strings, so the
// CSS custom property goes in directly and follows the theme.
const CHART_POSITIVE = 'var(--status-positive)';
const CHART_DOT_RING = 'var(--ds-page)';

interface EarnVaultDetailProps {
  vaultId: string;
}

const EarnVaultDetail: FC<EarnVaultDetailProps> = ({ vaultId }) => {
  const [timeframe, setTimeframe] = useState<EarnTimeframe>('1M');
  const { t } = useTranslation();
  const { vaults } = useEarnPositions();
  const vault = useMemo(() => vaults.find(item => item.id === vaultId) ?? placeholderVault(), [vaults, vaultId]);

  return (
    // The shared pushed-page frame: the header, a body whose sections sit 20px apart, and the CTA
    // pinned under it instead of scrolling away at the end of the page.
    <SubPageLayout
      data-testid="earn-vault-detail-page"
      // Back and the protocol in the title; the asset and its network ride the header as one
      // compact mark, since a pill wide enough to spell them out took the width a two-word
      // protocol needed and wrapped the title onto a second line.
      title={vault.protocol}
      onBack={goBack}
      headerActions={<EarnAssetMark asset={vault.asset} network={vault.network} />}
      footer={
        <Button
          data-testid="earn-vault-deposit-btn"
          title={t('earnDeposit')}
          variant={ButtonVariant.Primary}
          accent="earn"
          disabled={!vault.id}
          onClick={() => navigate(`/earn/vaults/${vaultId}/deposit`)}
          className="max-w-none"
        />
      }
    >
      <EarnHero
        labelId="earn-vault-apy-title"
        value={vault.apy}
        valueClassName="text-positive-tint-ink"
        label={t('earnCurrentApy')}
        meta={vault.apyChange24h}
      />

      {/* The timeframe belongs to the chart above it, so the two travel as one section. */}
      <div>
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
      </div>

      <VaultStats vault={vault} />
      <VaultAbout vault={vault} />
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
              return (
                <div className="rounded-xl bg-ink px-2 py-1 text-pure-white shadow">
                  <div className="text-badge">{Number(point.value).toFixed(2)}%</div>
                  {/* An inverted surface: `muted` is tuned for `page` and `fill`, so the quiet line
                      here is the same white held back. */}
                  <div className="text-caption text-pure-white/70">{point.label}</div>
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
