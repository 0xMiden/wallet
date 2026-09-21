import React, { FC, useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { Area, AreaChart, ReferenceLine, XAxis, YAxis } from 'recharts';

import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import { Button, ButtonVariant } from 'components/Button';
import { SpendingLimitChallenge } from 'components/SpendingLimitChallenge';
import { Card } from 'components/ui/Card';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout } from 'components/ui/SubPageLayout';
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
import { useWalletStore } from 'lib/store';
import { ChartContainer } from 'lib/ui/charts';
import { goBack, navigate, useLocation } from 'lib/woozie';

import { EarnAmountUnit, EarnAssetMark, EarnHero, earnSubjectTitle } from './components';
import { placeholderVault } from './earn-mapping';
import { EarnVault } from './types';
import { useEarnPositions } from './useEarnPositions';

// Tokens, not literals: recharts takes SVG paint strings, so the custom properties go straight in
// and follow the theme.
const CHART_POSITIVE = 'var(--status-positive)';
const CHART_RULE = 'var(--ds-hairline)';

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

  // `Button` fires the tap haptic itself; calling it here too would buzz twice.
  const handleOpenPosition = async () => {
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
    <>
      {/* The shared pushed-page frame: the earn flow's header, the 16px page margin its two
          hand-rolled ones diverged from, and the CTA pinned under the body. */}
      <SubPageLayout
        data-testid="earn-deposit-review-page"
        title={earnSubjectTitle(vault)}
        onBack={goBack}
        headerActions={<EarnAssetMark asset={vault.asset} network={vault.network} />}
        footerLayout="stack"
        footer={
          <>
            {submitError && (
              <Notice tone="negative" role="alert" data-testid="earn-deposit-review-error">
                {submitError}
              </Notice>
            )}
            <Button
              data-testid="earn-deposit-review-confirm"
              title={t('earnOpenPosition')}
              variant={ButtonVariant.Primary}
              accent="earn"
              onClick={handleOpenPosition}
              disabled={isSubmitting || amountValue <= 0 || !vault.id}
              className="w-full max-w-none"
            />
          </>
        }
      >
        <EarnHero
          labelId="earn-deposit-review-amount"
          value={toAdaptiveFixed(amountValue)}
          unit={<EarnAmountUnit symbol={depositSymbol} />}
          label={t('earnDepositAmountTitle')}
        />

        <DepositProjection vault={vault} amount={amountValue} />
      </SubPageLayout>

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
    </>
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
    <div className="flex flex-col gap-4">
      <Card padding="tile">
        <div className="h-22">
          <ChartContainer config={{ projected: { color: CHART_POSITIVE } }} className="h-full w-full aspect-auto">
            <AreaChart data={chartData} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="earn-deposit-projection-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_POSITIVE} stopOpacity={0.32} />
                  <stop offset="95%" stopColor={CHART_POSITIVE} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" hide />
              <YAxis domain={[amount * 0.98, chartData[chartData.length - 1]!.value * 1.02]} hide />
              <ReferenceLine y={amount * 0.98} stroke={CHART_RULE} strokeDasharray="5 6" className="pt-0.5" />
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

        <div className="mt-4 border-t border-hairline pt-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            {projections.map(item => (
              <div key={item.label}>
                <div className="text-label text-muted">{item.label}</div>
                <div className="mt-1 text-value text-positive-tint-ink">
                  {t('earnProjectedRewardAmount', { amount: `$${toAdaptiveFixed(item.reward)}` })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* The shared detail card: one `fill` block of label/value rows, hairlines between them, as
          on every other review in the app. */}
      <DetailCard>
        <DetailRow label={t('earnCollateralLabel')}>{t('earnCollateralValue')}</DetailRow>
        <DetailRow label={t('route')}>
          {t('earnDepositRoute', { protocol: vault.protocol, network: vault.network })}
        </DetailRow>
        <DetailRow label={t('earnEstimatedTime')}>{t('earnEstimatedTimeValue')}</DetailRow>
        {/* The deposit is a fee-paying Miden transaction: `completeEarnDepositTransaction`
            records the charge and EarnSuccess renders it on the very next screen. */}
        {networkFee && <DetailRow label={t('networkFeeMax')}>{networkFee}</DetailRow>}
      </DetailCard>
    </div>
  );
};

export default EarnDepositReview;
