import React, { FC, useMemo } from 'react';

import clsx from 'clsx';
import { Area, AreaChart, ReferenceLine, XAxis, YAxis } from 'recharts';

import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { ChartContainer } from 'lib/ui/charts';
import { navigate, useLocation } from 'lib/woozie';

import { EarnFlowHeader } from './components';
import { EARN_DATA } from './data';
import { EarnVault } from './types';

const CHART_GREEN = '#90BA89';
const DEFAULT_VAULT = EARN_DATA.vaults[0]!;
const DEFAULT_POSITION_ID = EARN_DATA.positions[0]?.id ?? 'aave-usdc-1';

const projectionFactors = [
  { label: '1 MONTH', factor: 0.0164 },
  { label: '6 MONTHS', factor: 0.09825 },
  { label: '1 YEAR', factor: 0.1965 }
];

const parseAmount = (value: string): number => Number(value.replace(/,/g, '')) || 0;

interface EarnDepositReviewProps {
  vaultId: string;
}

const EarnDepositReview: FC<EarnDepositReviewProps> = ({ vaultId }) => {
  const { search } = useLocation();
  const amount = useMemo(() => new URLSearchParams(search).get('amount') ?? '0', [search]);
  const amountValue = parseAmount(amount);
  const vault = useMemo(() => EARN_DATA.vaults.find(item => item.id === vaultId) ?? DEFAULT_VAULT, [vaultId]);

  const handleOpenPosition = () => {
    hapticLight();
    navigate(`/earn/positions/${DEFAULT_POSITION_ID}`);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-deposit-review-page">
      <EarnFlowHeader vault={vault} />

      <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
        <div className={clsx('flex flex-col px-6 pt-6')}>
          <span className="font-heading text-2xl font-bold leading-none text-[#808080]">Deposit Amount</span>
          <div className="mt-3 font-heading text-[4rem] font-bold leading-none text-heading-gray">
            {amountValue.toFixed(2)}
          </div>
          <div className="flex items-center gap-1">
            <TokenLogo symbol={vault.asset} size="md" />
            <span className="font-heading text-2xl font-bold text-heading-gray">{vault.asset}</span>
          </div>

          <DepositProjection vault={vault} amount={amountValue} />
        </div>
      </div>

      <div className={clsx('shrink-0 pt-4 pb-6', isMobile() ? 'px-8' : 'px-6')}>
        <Button
          title="Open position"
          variant={ButtonVariant.Primary}
          onClick={handleOpenPosition}
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};

const DepositProjection: FC<{ vault: EarnVault; amount: number }> = ({ vault, amount }) => {
  const projections = projectionFactors.map(item => ({
    ...item,
    reward: amount * item.factor
  }));
  const chartData = [
    { label: 'Now', value: amount },
    ...projections.map(item => ({
      label: item.label,
      value: amount + item.reward
    }))
  ];

  return (
    <div className="mt-8 pb-4">
      <div className="rounded-10 border border-[#EFEFF2] bg-white py-4 px-5 ">
        <div className="h-22">
          <ChartContainer config={{ projected: { color: CHART_GREEN } }} className="h-full w-full aspect-auto">
            <AreaChart data={chartData} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="earn-deposit-projection-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_GREEN} stopOpacity={0.32} />
                  <stop offset="95%" stopColor={CHART_GREEN} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" hide />
              <YAxis domain={[amount * 0.98, chartData[chartData.length - 1]!.value * 1.02]} hide />
              <ReferenceLine y={amount * 0.98} stroke="#E7E7EA" strokeDasharray="5 6" className="pt-0.5" />
              <Area
                dataKey="value"
                type="natural"
                stroke="var(--color-projected)"
                strokeWidth={3}
                fill="url(#earn-deposit-projection-area)"
                baseValue={amount}
                dot={{ r: 0 }}
                activeDot={false}
              />
            </AreaChart>
          </ChartContainer>
        </div>

        <div className="mt-4 border-t border-rule-default pt-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            {projections.map(item => (
              <div key={item.label}>
                <div className="text-xs font-semibold uppercase leading-none text-[#8E8E93]">{item.label}</div>
                <div className="mt-1 font-heading text-sm font-bold leading-none text-status-positive">
                  +${item.reward.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-6">
        <DetailRow label="Solver fee" value="0.30%" />
        <DetailRow label="Network fee" value="~$0.42" />
        <DetailRow label="Route" value={`Miden -> ${vault.protocol} (${vault.network})`} />
        <DetailRow label="Network fee" value="~30 seconds" />
      </div>
    </div>
  );
};

const DetailRow: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-4 text-sm leading-tight">
    <div className="text-heading-gray font-regular">{label}</div>
    <div className="text-right font-bold text-[#8C877F]">{value}</div>
  </div>
);

export default EarnDepositReview;
