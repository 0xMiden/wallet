import React, { FC, useMemo, useState } from 'react';

import classNames from 'clsx';
import { Area, AreaChart, Tooltip, YAxis } from 'recharts';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { CircleButton } from 'components/CircleButton';
import { hapticLight, hapticSelection } from 'lib/mobile/haptics';
import { ChartContainer } from 'lib/ui/charts';
import { goBack, navigate } from 'lib/woozie';

import { EarnSummaryPanel, MetricCard, PositionLogo } from './components';
import { placeholderPosition } from './earn-mapping';
import { EarnPosition } from './types';
import { useEarnPositions } from './useEarnPositions';

const TIMEFRAMES = ['1D', '1W', '1M', 'All'];
const CHART_GREEN = '#90BA89';

interface EarnPositionDetailProps {
  positionId: string;
}

const EarnPositionDetail: FC<EarnPositionDetailProps> = ({ positionId }) => {
  const [timeframe, setTimeframe] = useState('1M');
  const { summary, positions } = useEarnPositions();
  const position = useMemo(
    () => positions.find(item => item.id === positionId) ?? placeholderPosition(),
    [positions, positionId]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-position-detail-page">
      <header className="shrink-0 border-b border-rule-default px-4 pb-4 pt-5">
        <div className="flex items-center gap-3">
          <CircleButton
            icon={IconName.ChevronLeft}
            onClick={goBack}
            className="h-10 w-10 bg-gray-25 text-heading-gray hover:bg-gray-50 focus:bg-gray-50"
            size="md"
            aria-label="Back"
          />
          <h1 className="min-w-0 truncate font-heading text-[26px] font-bold leading-none text-heading-gray">
            My {position.protocol} &bull; {position.asset} position
          </h1>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col px-4 pb-8 pt-6">
          <EarnSummaryPanel summary={summary} titleId="earn-position-summary-title" showMetrics={false} />

          <PositionAreaChart position={position} />

          <div className="mt-4 flex items-center justify-between px-4 text-sm font-medium text-gray-secondary">
            {TIMEFRAMES.map(item => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  hapticSelection();
                  setTimeframe(item);
                }}
                className={classNames(
                  'rounded-full px-3 py-2 leading-none',
                  timeframe === item ? 'bg-[#F2F2F4] font-semibold text-pure-black' : 'text-gray-secondary'
                )}
              >
                {item}
              </button>
            ))}
          </div>

          <PositionHeading position={position} />
          <PositionStats position={position} />
          <ProjectedEarnings position={position} />
          <PositionDetails position={position} />
          <PositionActions position={position} />
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
                <div className="rounded-lg bg-heading-gray px-2 py-1 text-xs text-pure-white shadow">
                  <div className="font-heading font-semibold">${Number(point.value).toFixed(2)}</div>
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

const PositionHeading: FC<{ position: EarnPosition }> = ({ position }) => (
  <div className="mt-4 flex items-center gap-2">
    <PositionLogo asset={position.asset} className="h-6 w-6" />
    <h2 className="font-heading text-[26px] font-bold leading-none text-heading-gray">
      {position.protocol} &bull; {position.asset}
    </h2>
    <span className="rounded-full bg-[#DDD4CE] px-2 py-1 text-[10px] font-medium leading-none text-heading-gray">
      {position.asset} on {position.network}
    </span>
  </div>
);

const PositionStats: FC<{ position: EarnPosition }> = ({ position }) => (
  <div className="mt-4 grid grid-cols-3 gap-2">
    <MetricCard label="Deposited" value={position.depositedAmount} className="px-2" />
    <MetricCard label="Total Earned" value={position.rewards} valueClassName="text-status-positive" className="px-2" />
    <MetricCard label="APY" value={position.apy} valueClassName="text-status-positive" className="px-2" />
    <MetricCard
      label="Daily Avg"
      value={position.dailyAverage}
      valueClassName="text-status-positive"
      className="px-2"
    />
    <MetricCard label="Time Active" value={position.age} className="px-2" />
    <MetricCard label="Started" value={position.started} className="px-2" />
  </div>
);

const ProjectedEarnings: FC<{ position: EarnPosition }> = ({ position }) => (
  <div className="mt-2 flex h-12 items-center justify-center rounded-full bg-status-positive px-4 text-sm md:text-base font-bold leading-none text-white">
    <ProjectedEarningsIcon className="mr-2 h-4 w-5" />~ {position.yearlyEstimate} &middot; at {position.apy} APY
  </div>
);

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
  const rows = [
    {
      label: 'Protocol',
      value: (
        <span className="inline-flex items-center gap-1 text-[#8F82EC]">
          <span className="h-3.5 w-3.5 rounded-full bg-[#8F82EC]" />
          {position.protocol}
        </span>
      )
    },
    { label: 'Network', value: position.network },
    { label: 'Position', value: `${position.asset} on ${position.network}` },
    { label: 'Route', value: position.route },
    { label: 'Withdraw', value: position.withdrawTime }
  ];

  return (
    <div className="mt-5 border-t-4 border-[#F1F1F1] pt-4">
      <div className="flex flex-col gap-5">
        {rows.map(row => (
          <div key={row.label} className="flex items-center justify-between gap-4 text-base leading-tight">
            <div className="text-heading-gray">{row.label}</div>
            <div className="text-right font-bold text-heading-gray">{row.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const PositionActions: FC<{ position: EarnPosition }> = ({ position }) => (
  <div className="mt-16 grid grid-cols-2 gap-3">
    <Button
      title="Deposit more"
      variant={ButtonVariant.Secondary}
      disabled={!position.vaultId}
      onClick={() => {
        hapticLight();
        navigate(`/earn/vaults/${position.vaultId}/deposit`);
      }}
      className="h-14 max-w-none rounded-full border-rule-strong bg-white text-base font-bold text-accent-primary hover:bg-white focus:bg-white"
    />
    <Button
      title="Withdraw"
      variant={ButtonVariant.Primary}
      className="h-14 max-w-none rounded-full text-base font-bold"
    />
  </div>
);

export default EarnPositionDetail;
