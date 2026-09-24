import React, { FC, useEffect, useMemo, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { Area, AreaChart, ReferenceLine, XAxis, YAxis } from 'recharts';

import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import { Button, ButtonVariant } from 'components/Button';
import { SpendingLimitChallenge } from 'components/SpendingLimitChallenge';
import { TokenLogo } from 'components/TokenLogo';
import { Card } from 'components/ui/Card';
import { getEarnCollateralFaucetId, MIDEN_USDC_DECIMALS, openEarnPosition } from 'lib/epoch';
import { stringToBigInt, toAdaptiveFixed } from 'lib/i18n/numbers';
import { useAccount } from 'lib/miden/front';
import { useMidenContext } from 'lib/miden/front/client';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import {
  type SpendingLimitAssessment,
  type SpendingLimitAuthorization,
  spendingLimitAssessmentFromError
} from 'lib/miden/spending-limits/types';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { ChartContainer } from 'lib/ui/charts';
import { navigate, useLocation } from 'lib/woozie';

import { EarnFlowHeader } from './components';
import { placeholderVault } from './earn-mapping';
import { EarnLoadError } from './EarnLoadError';
import { EarnVault } from './types';
import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

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
  const { vaults, isLoading, loadError, refetch } = useEarnPositions();
  const found = useMemo(() => vaults.find(item => item.id === vaultId), [vaults, vaultId]);
  const vault = useMemo(() => found ?? placeholderVault(), [found]);
  const { loadFailed, pending } = earnItemLoadState(found, { isLoading, error: loadError });

  const { t } = useTranslation();
  const account = useAccount();
  const depositSymbol = 'USDC';
  const { signTransaction } = useMidenContext();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [spendingLimitAssessment, setSpendingLimitAssessment] = useState<SpendingLimitAssessment>();
  const assessSpendingLimit = useWalletStore(state => state.assessSpendingLimit);
  const amountBaseUnits = useMemo(() => {
    try {
      return stringToBigInt(amount.replace(/,/g, ''), MIDEN_USDC_DECIMALS);
    } catch {
      return undefined;
    }
  }, [amount]);
  const faucetId = getEarnCollateralFaucetId();

  const runOpenPosition = async (authorization?: SpendingLimitAuthorization) => {
    if (amountBaseUnits === undefined) return;
    if (
      authorization !== undefined &&
      (authorization.accountId !== account.publicKey ||
        authorization.faucetId !== faucetId ||
        authorization.amount !== amountBaseUnits)
    ) {
      setSpendingLimitAssessment(undefined);
      return;
    }
    if (!account.evmAddress) {
      setSubmitError(t('earnNoEvmAddress'));
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await openEarnPosition({
        amount: amountBaseUnits,
        evmAddress: account.evmAddress,
        senderPublicKey: account.publicKey,
        deps: { signTransaction, guardianProvider: zustandProvider },
        onRowCreated: txId => navigate(`/generating-transaction-full/${encodeURIComponent(txId)}`),
        spendingLimitAuthorization: authorization
      });
    } catch (e) {
      const assessment = spendingLimitAssessmentFromError(e);
      if (assessment !== undefined) {
        setSpendingLimitAssessment(assessment);
      } else {
        setSubmitError(e instanceof Error ? e.message : t('earnFailedToOpenPosition'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenPosition = async () => {
    hapticLight();
    if (isSubmitting) return;
    if (!account.evmAddress) {
      setSubmitError(t('earnNoEvmAddress'));
      return;
    }
    if (amountBaseUnits === undefined) {
      setSubmitError(t('earnFailedToOpenPosition'));
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const assessment = await assessSpendingLimit(account.publicKey, faucetId, amountBaseUnits);
      if (assessment !== undefined && assessment.breaches.length > 0) {
        setSpendingLimitAssessment(assessment);
        setIsSubmitting(false);
        return;
      }
      await runOpenPosition();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('earnFailedToOpenPosition'));
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (
      spendingLimitAssessment !== undefined &&
      (spendingLimitAssessment.accountId !== account.publicKey ||
        spendingLimitAssessment.faucetId !== faucetId ||
        spendingLimitAssessment.amount !== amountBaseUnits)
    ) {
      setSpendingLimitAssessment(undefined);
    }
  }, [account.publicKey, amountBaseUnits, faucetId, spendingLimitAssessment]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-deposit-review-page">
      <EarnFlowHeader vault={found} />

      {loadFailed && !found ? (
        <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="mt-10 px-6" />
      ) : pending ? null : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
            <div className={clsx('flex flex-col px-6 pt-6')}>
              {loadFailed && <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="mb-6" />}
              <span className="font-heading text-2xl font-bold leading-none text-gray">
                {t('earnDepositAmountTitle')}
              </span>
              <div className="mt-3 font-heading text-[4rem] font-bold leading-none text-ink">
                {toAdaptiveFixed(amountValue)}
              </div>
              <div className="flex items-center gap-1">
                <TokenLogo symbol={depositSymbol} size="md" />
                <span className="font-heading text-2xl font-bold text-ink">{depositSymbol}</span>
              </div>

              <DepositProjection vault={vault} amount={amountValue} />
            </div>
          </div>

          <div className={clsx('shrink-0 pt-4 pb-6', isMobile() ? 'px-8' : 'px-6')}>
            {submitError && (
              <div className="mb-2 text-center text-sm leading-tight text-status-negative">{submitError}</div>
            )}
            <Button
              data-testid="earn-deposit-review-confirm"
              title={t('earnOpenPosition')}
              variant={ButtonVariant.Primary}
              onClick={handleOpenPosition}
              disabled={isSubmitting || amountValue <= 0 || !vault.id}
              className="w-full max-w-none"
            />
          </div>
        </>
      )}
      {spendingLimitAssessment !== undefined && (
        <SpendingLimitChallenge
          assessment={spendingLimitAssessment}
          asset={{ symbol: depositSymbol, decimals: MIDEN_USDC_DECIMALS }}
          onResult={authorization => {
            setSpendingLimitAssessment(undefined);
            if (authorization !== undefined) void runOpenPosition(authorization);
          }}
        />
      )}
    </div>
  );
};

const DepositProjection: FC<{ vault: EarnVault; amount: number }> = ({ vault, amount }) => {
  const { t } = useTranslation();
  const networkFee = useNetworkFeeEstimate();
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
      <Card padding="tile">
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
                  {t('earnProjectedRewardAmount', { amount: `$${toAdaptiveFixed(item.reward)}` })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="mt-4 space-y-6">
        <DetailRow label={t('earnCollateralLabel')} value={t('earnCollateralValue')} />
        <DetailRow
          label={t('route')}
          value={t('earnDepositRoute', { protocol: vault.protocol, network: vault.network })}
        />
        <DetailRow label={t('earnEstimatedTime')} value={t('earnEstimatedTimeValue')} />
        {/* The deposit is a fee-paying Miden transaction: `completeEarnDepositTransaction`
            records the charge and EarnSuccess renders it on the very next screen. */}
        {networkFee && <DetailRow label={t('networkFeeMax')} value={networkFee} />}
      </div>
    </div>
  );
};

const DetailRow: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-4 text-sm leading-tight">
    <div className="text-ink font-regular">{label}</div>
    <div className="text-right font-bold text-[#8C877F]">{value}</div>
  </div>
);

export default EarnDepositReview;
