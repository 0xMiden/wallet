import React, { FC, useMemo, useState } from 'react';

import { Area, AreaChart, ReferenceLine, XAxis, YAxis } from 'recharts';

import { IconName } from 'app/icons/v2';
import { CircleButton } from 'components/CircleButton';
import { ChartContainer } from 'lib/ui/charts';
import { goBack, navigate } from 'lib/woozie';
import { SelectAmount } from 'screens/send-flow/SelectAmount';
import { UIToken } from 'screens/send-flow/types';

import { EARN_DATA } from './data';
import { EarnVault } from './types';

const CHART_GREEN = '#90BA89';
const DEFAULT_VAULT = EARN_DATA.vaults[0]!;
const DEFAULT_POSITION_ID = EARN_DATA.positions[0]?.id ?? 'aave-usdc-1';

interface EarnDepositAmountProps {
  vaultId: string;
}

const projectionFactors = [
  { label: '1 MONTH', factor: 0.0164 },
  { label: '6 MONTHS', factor: 0.09825 },
  { label: '1 YEAR', factor: 0.1965 }
];

const parseAmount = (value: string): number => Number(value.replace(/,/g, '')) || 0;

const EarnDepositAmount: FC<EarnDepositAmountProps> = ({ vaultId }) => {
  const [amount, setAmount] = useState('0.00');
  const vault = useMemo(() => EARN_DATA.vaults.find(item => item.id === vaultId) ?? DEFAULT_VAULT, [vaultId]);
  const token = useMemo<UIToken>(
    () => ({
      id: vault.asset.toLowerCase(),
      name: vault.asset,
      decimals: 6,
      balance: 200,
      fiatPrice: 1
    }),
    [vault.asset]
  );

  const amountValue = parseAmount(amount);
  const hasAmount = amountValue > 0;
  const isValidAmount = hasAmount && amountValue <= token.balance;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-deposit-amount-page">
      <header className="shrink-0 border-b border-rule-default px-4 pb-4 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <CircleButton
            icon={IconName.ChevronLeft}
            onClick={goBack}
            className="h-10 w-10 bg-gray-25 text-heading-gray hover:bg-gray-50 focus:bg-gray-50"
            size="md"
            aria-label="Back"
          />
          <h1 className="min-w-0 truncate font-heading text-[26px] font-bold leading-none text-heading-gray">
            {vault.protocol} &bull; {vault.asset}
          </h1>
          <span className="shrink-0 rounded-full bg-[#DDD4CE] px-3 py-1.5 text-xs font-medium leading-none text-heading-gray">
            {vault.asset} on {vault.network}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <SelectAmount
          token={token}
          amount={amount}
          isValidAmount={isValidAmount}
          label="Deposit Amount"
          confirmTitle={isValidAmount ? 'Open position' : 'Confirm'}
          showNetworkPill={false}
          showBalanceHelper={!hasAmount}
          onAmountChange={setAmount}
          onSelectToken={() => undefined}
          onConfirm={() => {
            if (isValidAmount) navigate(`/earn/positions/${DEFAULT_POSITION_ID}`);
          }}
        >
          {isValidAmount && <DepositProjection vault={vault} amount={amountValue} />}
        </SelectAmount>
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
      <div className="rounded-10 border border-rule-default bg-white p-4 shadow-[0_12px_28px_rgba(27,31,35,0.08)]">
        <div className="h-[150px]">
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
              <ReferenceLine y={amount} stroke="#E7E7EA" strokeDasharray="5 6" />
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

        <div className="mt-3 border-t border-rule-default pt-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            {projections.map(item => (
              <div key={item.label}>
                <div className="text-xs font-bold uppercase leading-none text-[#8E8E93]">{item.label}</div>
                <div className="mt-1 font-heading text-base font-bold leading-none text-status-positive">
                  +${item.reward.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        <DetailRow label="Solver fee" value="0.30%" />
        <DetailRow label="Network fee" value="~$0.42" />
        <DetailRow label="Route" value={`Miden -> ${vault.protocol} (${vault.network})`} />
        <DetailRow label="Network fee" value="~30 seconds" />
      </div>
    </div>
  );
};

const DetailRow: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-4 text-base leading-tight">
    <div className="text-heading-gray">{label}</div>
    <div className="text-right font-bold text-[#8C877F]">{value}</div>
  </div>
);

export default EarnDepositAmount;
