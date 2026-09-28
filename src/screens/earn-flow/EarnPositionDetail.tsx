import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';
import { Area, AreaChart, Tooltip, YAxis } from 'recharts';

import { Button, ButtonVariant } from 'components/Button';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { CHART_DOT_RING, CHART_POSITIVE, ChartContainer, ChartValueTooltip } from 'lib/ui/charts';
import { goBack, navigate } from 'lib/woozie';

import { EarnAssetMark, EarnSummaryPanel, MetricCard } from './components';
import { formatApy, placeholderPosition, usdFigureFormatter } from './earn-mapping';
import { EarnLoadError } from './EarnLoadError';
import { ChartDotProps, EarnPosition } from './types';
import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

interface EarnPositionDetailProps {
  positionId: string;
}

const EarnPositionDetail: FC<EarnPositionDetailProps> = ({ positionId }) => {
  const { t } = useTranslation();
  const { summary, positions, isLoading, error, refetch } = useEarnPositions();
  const found = useMemo(() => positions.find(item => item.id === positionId), [positions, positionId]);
  const position = useMemo(() => found ?? placeholderPosition(), [found]);
  const { loadFailed, pending } = earnItemLoadState(found, { isLoading, error });

  return (
    // The shared pushed-page frame, so this page's header, section rhythm and pinned actions are
    // the vault page's.
    <SubPageLayout
      data-testid="earn-position-detail-page"
      // Until the position is found the header names the route, never a placeholder position.
      title={
        found ? t('earnPositionHeaderTitle', { protocol: found.protocol, asset: found.asset }) : t('earnPositionsTitle')
      }
      onBack={goBack}
      footer={
        (loadFailed && !found) || pending ? undefined : (
          <>
            <Button
              data-testid="earn-deposit-more-btn"
              title={t('earnDepositMore')}
              variant={ButtonVariant.Secondary}
              disabled={!position.vaultId}
              // `Button` fires the tap haptic itself; calling it here too would buzz twice.
              onClick={() => navigate(`/earn/vaults/${position.vaultId}/deposit`)}
              className="flex-1 max-w-none"
            />
            <Button
              data-testid="earn-withdraw-btn"
              title={t('withdraw')}
              variant={ButtonVariant.Primary}
              accent="earn"
              disabled={!position.id || Number(position.withdrawable) <= 0}
              onClick={() => navigate(`/earn/positions/${encodeURIComponent(position.id)}/withdraw/review`)}
              className="flex-1 max-w-none"
            />
          </>
        )
      }
    >
      {/* A failed load never draws the placeholder position, or a $0 summary, as if it were real. */}
      {loadFailed && !found ? (
        <EarnLoadError onRetry={refetch} className="mt-10" />
      ) : pending ? null : (
        <>
          {loadFailed && <EarnLoadError onRetry={refetch} />}
          <EarnSummaryPanel summary={summary} titleId="earn-position-summary-title" showMetrics={false} />

          <PositionAreaChart position={position} />

          <PositionHeading position={position} />
          <PositionStats position={position} />
          <ProjectedEarnings position={position} />
          <PositionDetails position={position} />
        </>
      )}
    </SubPageLayout>
  );
};

const PositionAreaChart: FC<{ position: EarnPosition }> = ({ position }) => {
  const values = position.chartData.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = (max - min) * 0.18 || 1;
  const lastIndex = position.chartData.length - 1;

  return (
    <div className="h-[140px]">
      <ChartContainer config={{ rewards: { color: CHART_POSITIVE } }} className="h-full w-full aspect-auto">
        <AreaChart data={position.chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="earn-position-area" x1="0" y1="0" x2="0" y2="1">
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
              return <ChartValueTooltip value={`$${toAdaptiveFixed(point.value)}`} label={point.label} />;
            }}
          />
          <Area
            dataKey="value"
            type="natural"
            stroke="var(--color-rewards)"
            strokeWidth={2.5}
            fill="url(#earn-position-area)"
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

/** What the rest of the page is about: the position itself, under the account-wide summary. The
 *  asset and its network are the shared mark, not a second pill. */
const PositionHeading: FC<{ position: EarnPosition }> = ({ position }) => (
  <div className="flex items-center gap-2">
    <EarnAssetMark asset={position.asset} network={position.network} />
    <h2 className="min-w-0 text-hero-name text-ink">
      {position.protocol} &bull; {position.asset}
    </h2>
  </div>
);

const PositionStats: FC<{ position: EarnPosition }> = ({ position }) => {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-3 gap-2">
      <MetricCard
        label={t('earnMetricDeposited')}
        value={
          <AnimatedNumber
            value={position.depositsUsd}
            format={usdFigureFormatter(position.depositsUsd)}
            placeholder={position.depositedAmount}
          />
        }
      />
      <MetricCard label={t('earnMetricTotalEarned')} value={position.rewards} valueClassName="text-positive-tint-ink" />
      <MetricCard
        label={t('earnApyLabel')}
        value={<AnimatedNumber value={position.aprPercent} format={formatApy} placeholder={position.apy} />}
        valueClassName="text-positive-tint-ink"
      />
      <MetricCard
        label={t('earnMetricDailyAvg')}
        value={position.dailyAverage}
        valueClassName="text-positive-tint-ink"
      />
      <MetricCard label={t('earnMetricTimeActive')} value={position.age} />
      <MetricCard label={t('earnMetricStarted')} value={position.started} />
    </div>
  );
};

const ProjectedEarnings: FC<{ position: EarnPosition }> = ({ position }) => {
  const { t } = useTranslation();

  // The shared notice in its positive tone, rather than a page-local tinted bar: same tint, same
  // ink, and the glyph slot the component already draws.
  return (
    <Notice tone="positive" icon={<ProjectedEarningsIcon />} data-testid="earn-projected-earnings">
      {t('earnProjectedEarnings', { estimate: position.yearlyEstimate, apy: position.apy })}
    </Notice>
  );
};

const ProjectedEarningsIcon: FC = () => (
  <svg viewBox="0 0 13 8" fill="none" aria-hidden="true">
    <path
      d="M0.75 6.375L4.5 2.625L7 5.125L11.375 0.75M7.625 0.75H12V5.125"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const PositionDetails: FC<{ position: EarnPosition }> = ({ position }) => {
  const { t } = useTranslation();
  const rows = [
    {
      label: t('protocol'),
      value: (
        // The dot and the name in the Earn flow's own colour: the tab's slate, with its ink under
        // the text, rather than a protocol-specific purple nothing else in the app knows.
        <span className="inline-flex items-center gap-1 text-accent-earn-ink">
          <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full bg-accent-earn" />
          {position.protocol}
        </span>
      )
    },
    { label: t('network'), value: position.network },
    { label: t('position'), value: t('earnAssetOnNetwork', { asset: position.asset, network: position.network }) },
    { label: t('route'), value: position.route },
    { label: t('withdraw'), value: position.withdrawTime }
  ];

  // One `fill` card of label/value rows with hairlines between them, in place of the 4px rule and
  // five hand-built rows.
  return (
    <DetailCard>
      {rows.map(row => (
        <DetailRow key={row.label} label={row.label}>
          {row.value}
        </DetailRow>
      ))}
    </DetailCard>
  );
};

export default EarnPositionDetail;
