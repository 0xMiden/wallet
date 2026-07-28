import React, { FC, useMemo, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { Area, AreaChart, ReferenceLine, XAxis, YAxis } from 'recharts';

import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { MIDEN_USDC_DECIMALS, openEarnPosition } from 'lib/epoch';
import { stringToBigInt } from 'lib/i18n/numbers';
import { useAccount } from 'lib/miden/front';
import { useMidenContext } from 'lib/miden/front/client';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { ChartContainer } from 'lib/ui/charts';
import { navigate, useLocation } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

import { EarnFlowHeader } from './components';
import { placeholderVault } from './earn-mapping';
import { EarnVault } from './types';
import { useEarnPositions } from './useEarnPositions';

const CHART_GREEN = '#90BA89';

// Fractions of a year for the projection columns; rewards = amount × APY × fraction.
const projectionPeriods = [
  { labelKey: 'earnProjection1Month', yearFraction: 1 / 12 },
  { labelKey: 'earnProjection6Months', yearFraction: 1 / 2 },
  { labelKey: 'earnProjection1Year', yearFraction: 1 }
];

const parseAmount = (value: string): number => Number(value.replace(/,/g, '')) || 0;

interface EarnDepositReviewProps {
  vaultId: string;
}

const EarnDepositReview: FC<EarnDepositReviewProps> = ({ vaultId }) => {
  const { search } = useLocation();
  const amount = useMemo(() => new URLSearchParams(search).get('amount') ?? '0', [search]);
  const amountValue = parseAmount(amount);
  const { vaults } = useEarnPositions();
  const vault = useMemo(() => vaults.find(item => item.id === vaultId) ?? placeholderVault(), [vaults, vaultId]);

  const { t } = useTranslation();
  const account = useAccount();
  const depositSymbol = 'USDC';
  const { signTransaction } = useMidenContext();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Earn deposits need a P2IDE collateral note with a reclaim height; Guardian
  // proposals can only express a plain P2ID (see GUARDIAN_EARN_DEPOSIT_UNSUPPORTED).
  // `openEarnPosition` refuses these too — this just avoids a dead-end CTA.
  const isGuardian = account.type === WalletType.Guardian;

  const handleOpenPosition = async () => {
    hapticLight();
    if (isSubmitting || isGuardian) return;
    if (!account.evmAddress) {
      setSubmitError(t('earnNoEvmAddress'));
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await openEarnPosition({
        amount: stringToBigInt(amount.replace(/,/g, ''), MIDEN_USDC_DECIMALS),
        evmAddress: account.evmAddress,
        senderPublicKey: account.publicKey,
        deps: { signTransaction, guardianProvider: zustandProvider },
        onRowCreated: txId => navigate(`/generating-transaction-full/${encodeURIComponent(txId)}`)
      });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : t('earnFailedToOpenPosition'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-deposit-review-page">
      <EarnFlowHeader vault={vault} />

      <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
        <div className={clsx('flex flex-col px-6 pt-6')}>
          <span className="font-heading text-2xl font-bold leading-none text-gray">{t('earnDepositAmountTitle')}</span>
          <div className="mt-3 font-heading text-[4rem] font-bold leading-none text-heading-gray">
            {amountValue.toFixed(2)}
          </div>
          <div className="flex items-center gap-1">
            <TokenLogo symbol={depositSymbol} size="md" />
            <span className="font-heading text-2xl font-bold text-heading-gray">{depositSymbol}</span>
          </div>

          <DepositProjection vault={vault} amount={amountValue} />
        </div>
      </div>

      <div className={clsx('shrink-0 pt-4 pb-6', isMobile() ? 'px-8' : 'px-6')}>
        {isGuardian && (
          <div className="mb-2 text-center text-sm leading-tight text-status-negative">
            {t('earnDepositGuardianUnsupported')}
          </div>
        )}
        {submitError && (
          <div className="mb-2 text-center text-sm leading-tight text-status-negative">{submitError}</div>
        )}
        <Button
          data-testid="earn-deposit-review-confirm"
          title={t('earnOpenPosition')}
          variant={ButtonVariant.Primary}
          onClick={handleOpenPosition}
          disabled={isSubmitting || amountValue <= 0 || !vault.id || isGuardian}
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};

const DepositProjection: FC<{ vault: EarnVault; amount: number }> = ({ vault, amount }) => {
  const { t } = useTranslation();
  // `apy` is a pre-formatted display string ("2.00%", or "—" while loading).
  const apyFraction = (Number.parseFloat(vault.apy) || 0) / 100;
  const projections = projectionPeriods.map(item => ({
    label: t(item.labelKey),
    yearFraction: item.yearFraction,
    reward: amount * apyFraction * item.yearFraction
  }));
  const chartData = [
    { label: t('earnProjectionNow'), value: amount },
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
                <div className="text-xs font-semibold uppercase leading-none text-gray-secondary">{item.label}</div>
                <div className="mt-1 font-heading text-sm font-bold leading-none text-status-positive">
                  {t('earnProjectedRewardAmount', { amount: item.reward.toFixed(2) })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-6">
        <DetailRow label={t('earnCollateralLabel')} value={t('earnCollateralValue')} />
        <DetailRow
          label={t('route')}
          value={t('earnDepositRoute', { protocol: vault.protocol, network: vault.network })}
        />
        <DetailRow label={t('earnEstimatedTime')} value={t('earnEstimatedTimeValue')} />
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
