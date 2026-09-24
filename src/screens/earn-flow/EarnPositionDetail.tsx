import React, { FC, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { Area, AreaChart, Tooltip, YAxis } from 'recharts';

import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { SegmentedControl, SegmentedControlItem } from 'components/ui/SegmentedControl';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { hapticLight } from 'lib/mobile/haptics';
import { ChartContainer } from 'lib/ui/charts';
import { goBack, navigate } from 'lib/woozie';

import { EarnSummaryPanel, MetricCard, PositionLogo } from './components';
import { placeholderPosition } from './earn-mapping';
import { EarnLoadError } from './EarnLoadError';
import { EarnPosition } from './types';
import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

type EarnTimeframe = '1D' | '1W' | '1M' | 'All';

const TIMEFRAMES: EarnTimeframe[] = ['1D', '1W', '1M', 'All'];

const TIMEFRAME_ITEMS: SegmentedControlItem<EarnTimeframe>[] = TIMEFRAMES.map(tf => ({
  id: tf,
  label: tf
}));
const CHART_GREEN = '#90BA89';

interface EarnPositionDetailProps {
  positionId: string;
}

const EarnPositionDetail: FC<EarnPositionDetailProps> = ({ positionId }) => {
  const { t } = useTranslation();
  const [timeframe, setTimeframe] = useState<EarnTimeframe>('1M');
  const { summary, positions, isLoading, error, refetch } = useEarnPositions();
  const found = useMemo(() => positions.find(item => item.id === positionId), [positions, positionId]);
  const position = useMemo(() => found ?? placeholderPosition(), [found]);
  const { loadFailed, pending } = earnItemLoadState(found, { isLoading, error });

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-position-detail-page">
      <PageHeader
        className="shrink-0 px-4"
        // Until the position is found the header names the route, never a placeholder position.
        title={
          found
            ? t('earnPositionHeaderTitle', { protocol: found.protocol, asset: found.asset })
            : t('earnPositionsTitle')
        }
        onBack={goBack}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col px-4 pb-8 pt-6">
          {/* A failed load never draws the placeholder position, or a $0 summary, as if it were real. */}
          {loadFailed && !found ? (
            <EarnLoadError onRetry={refetch} className="mt-10" />
          ) : pending ? null : (
            <>
              {loadFailed && <EarnLoadError onRetry={refetch} className="mb-6" />}
              <EarnSummaryPanel summary={summary} titleId="earn-position-summary-title" showMetrics={false} />

              <PositionAreaChart position={position} />

              <SegmentedControl
                items={TIMEFRAME_ITEMS}
                value={timeframe}
                onChange={setTimeframe}
                size="sm"
                layout="fill"
                aria-label={t('chartTimeframe')}
                className="mt-3"
              />

              <PositionHeading position={position} />
              <PositionStats position={position} />
              <ProjectedEarnings position={position} />
              <PositionDetails position={position} />
              <PositionActions
                position={position}
                onWithdraw={() => navigate(`/earn/positions/${encodeURIComponent(position.id)}/withdraw/review`)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const PositionAreaChart: FC<{ position: EarnPosition }> = ({ position }) => {
  const values = position.chartData.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = (max - min) * 0.18 || 1;
  const lastIndex = position.chartData.length - 1;

  return (
    <div className="mt-5 h-[140px]">
      <ChartContainer config={{ rewards: { color: CHART_GREEN } }} className="h-full w-full aspect-auto">
        <AreaChart data={position.chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="earn-position-area" x1="0" y1="0" x2="0" y2="1">
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
                  <div className="font-heading font-semibold">${toAdaptiveFixed(point.value)}</div>
                  <div className="opacity-75">{point.label}</div>
                </div>
              );
            }}
          />
          <Area
            dataKey="value"
            type="natural"
            stroke="var(--color-rewards)"
            strokeWidth={2.5}
            fill="url(#earn-position-area)"
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

const PositionHeading: FC<{ position: EarnPosition }> = ({ position }) => {
  const { t } = useTranslation();

  return (
    <div className="mt-4 flex items-center gap-2">
      <PositionLogo asset={position.asset} className="h-6 w-6" />
      <h2 className="font-heading text-[26px] font-bold leading-none text-ink">
        {position.protocol} &bull; {position.asset}
      </h2>
      <span className="rounded-full bg-[#DDD4CE] px-2 py-1 text-[10px] font-medium leading-none text-ink">
        {t('earnAssetOnNetwork', { asset: position.asset, network: position.network })}
      </span>
    </div>
  );
};

const PositionStats: FC<{ position: EarnPosition }> = ({ position }) => {
  const { t } = useTranslation();

  return (
    <div className="mt-4 grid grid-cols-3 gap-2">
      <MetricCard label={t('earnMetricDeposited')} value={position.depositedAmount} className="px-2" />
      <MetricCard
        label={t('earnMetricTotalEarned')}
        value={position.rewards}
        valueClassName="text-status-positive"
        className="px-2"
      />
      <MetricCard
        label={t('earnApyLabel')}
        value={position.apy}
        valueClassName="text-status-positive"
        className="px-2"
      />
      <MetricCard
        label={t('earnMetricDailyAvg')}
        value={position.dailyAverage}
        valueClassName="text-status-positive"
        className="px-2"
      />
      <MetricCard label={t('earnMetricTimeActive')} value={position.age} className="px-2" />
      <MetricCard label={t('earnMetricStarted')} value={position.started} className="px-2" />
    </div>
  );
};

const ProjectedEarnings: FC<{ position: EarnPosition }> = ({ position }) => {
  const { t } = useTranslation();

  return (
    <div className="mt-2 flex h-12 items-center justify-center rounded-full bg-status-positive px-4 text-sm md:text-base font-bold leading-none text-white">
      <ProjectedEarningsIcon className="mr-2 h-4 w-5" />
      {t('earnProjectedEarnings', { estimate: position.yearlyEstimate, apy: position.apy })}
    </div>
  );
};

const ProjectedEarningsIcon: FC<{ className?: string }> = ({ className }) => (
  <svg className={className} width="13" height="8" viewBox="0 0 13 8" fill="none" aria-hidden="true">
    <path
      d="M0.75 6.375L4.5 2.625L7 5.125L11.375 0.75M7.625 0.75H12V5.125"
      stroke="white"
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
        <span className="inline-flex items-center gap-1 text-[#8F82EC]">
          <span className="h-3.5 w-3.5 rounded-full bg-[#8F82EC]" />
          {position.protocol}
        </span>
      )
    },
    { label: t('network'), value: position.network },
    { label: t('position'), value: t('earnAssetOnNetwork', { asset: position.asset, network: position.network }) },
    { label: t('route'), value: position.route },
    { label: t('withdraw'), value: position.withdrawTime }
  ];

  return (
    <div className="mt-5 border-t-4 border-rule-default pt-4">
      <div className="flex flex-col gap-5">
        {rows.map(row => (
          <div key={row.label} className="flex items-center justify-between gap-4 text-base leading-tight">
            <div className="text-ink">{row.label}</div>
            <div className="text-right font-bold text-ink">{row.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const PositionActions: FC<{
  position: EarnPosition;
  onWithdraw: () => void;
}> = ({ position, onWithdraw }) => {
  const { t } = useTranslation();

  return (
    <div className="mt-16">
      <div className="grid grid-cols-2 gap-2.5">
        <Button
          data-testid="earn-deposit-more-btn"
          title={t('earnDepositMore')}
          variant={ButtonVariant.Secondary}
          disabled={!position.vaultId}
          onClick={() => {
            hapticLight();
            navigate(`/earn/vaults/${position.vaultId}/deposit`);
          }}
          className="max-w-none"
        />
        <Button
          data-testid="earn-withdraw-btn"
          title={t('withdraw')}
          variant={ButtonVariant.Primary}
          disabled={!position.id || Number(position.withdrawable) <= 0}
          onClick={() => {
            hapticLight();
            onWithdraw();
          }}
          className="max-w-none"
        />
      </div>
    </div>
  );
};

export default EarnPositionDetail;
