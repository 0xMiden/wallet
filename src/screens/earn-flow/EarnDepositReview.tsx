import React, { FC, useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { Area, AreaChart, ReferenceLine, XAxis, YAxis } from 'recharts';

import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import { Button, ButtonVariant } from 'components/Button';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { SpendingLimitChallenge, type SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
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
  isSpendingLimitPriceUnavailable,
  type SpendingLimitAuthorization,
  spendingLimitAssessmentFromError
} from 'lib/miden/spending-limits/types';
import { useWalletStore } from 'lib/store';
import { classifyError } from 'lib/telemetry';
import { enterRouteFlow, reportRouteFlowStep, settleRouteFlow } from 'lib/telemetry/route-flow';
import { CHART_POSITIVE, CHART_RULE, ChartContainer } from 'lib/ui/charts';
import { goBack, navigate, useLocation } from 'lib/woozie';

import { EarnAmountUnit, EarnAssetMark, EarnHero, earnSubjectTitle } from './components';
import { placeholderVault } from './earn-mapping';
import { EarnLoadError } from './EarnLoadError';
import { EarnVault } from './types';
import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

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
  const [spendingLimitChallenge, setSpendingLimitChallenge] =
    useState<Pick<SpendingLimitChallengeProps, 'assessment' | 'spends' | 'unpriced'>>();
  const assessSpendingLimit = useWalletStore(state => state.assessSpendingLimit);
  const readSpendingLimit = useWalletStore(state => state.readSpendingLimit);
  const amountBaseUnits = useMemo(() => {
    try {
      return stringToBigInt(amount.replace(/,/g, ''), MIDEN_USDC_DECIMALS);
    } catch {
      return undefined;
    }
  }, [amount]);
  const faucetId = getEarnCollateralFaucetId();

  // Reaching review, and owning the terminal outcome. The amount screen began
  // this flow and deliberately does not settle it on handoff, so every exit from
  // here settles: leaving is abandonment at review, and the submit below reports
  // its own outcome and clears the handle first.
  useEffect(() => {
    enterRouteFlow('earn');
    reportRouteFlowStep('earn', 'review');
    return () => settleRouteFlow('earn', flow => flow.cancel());
  }, []);

  // The account's spending-limit revision never crosses the intercom port - `serializeInternalError`
  // / `deserializeInternalError` (`lib/intercom/helpers.ts`) carry only `code` and, for this error, `symbol`
  // - so the unpriced challenge reads the account's current revision fresh, the same value
  // `authorizationMatches` re-reads server-side at redemption.
  const openUnpricedChallenge = async (depositAmount: bigint): Promise<boolean> => {
    const configuration = await readSpendingLimit(account.publicKey);
    if (configuration === undefined) return false;
    setSpendingLimitChallenge({
      unpriced: {
        accountId: account.publicKey,
        spends: [{ faucetId, amount: depositAmount }],
        revision: configuration.revision
      }
    });
    return true;
  };

  const runOpenPosition = async (authorization?: SpendingLimitAuthorization) => {
    if (amountBaseUnits === undefined) return;
    if (authorization !== undefined && authorization.accountId !== account.publicKey) {
      setSpendingLimitChallenge(undefined);
      return;
    }
    if (!account.evmAddress) {
      setSubmitError(t('earnNoEvmAddress'));
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    // A previous attempt that failed settled its flow errored and the user is
    // still on this screen, so a retry needs a flow of its own. Otherwise the
    // second attempt reports nothing at all and a deposit that failed once and
    // then succeeded is recorded only as the failure. Same contract as
    // `enterSendFlow` and the swap retry path.
    enterRouteFlow('earn');
    reportRouteFlowStep('earn', 'submitting');
    try {
      await openEarnPosition({
        amount: amountBaseUnits,
        evmAddress: account.evmAddress,
        senderPublicKey: account.publicKey,
        deps: { signTransaction, guardianProvider: zustandProvider },
        onRowCreated: txId => {
          // A position row exists, which is what "the user deposited" means
          // here. Settled before navigating, since that unmounts this screen.
          settleRouteFlow('earn', flow => flow.complete());
          navigate(`/generating-transaction-full/${encodeURIComponent(txId)}`);
        },
        spendingLimitAuthorization: authorization
      });
    } catch (e) {
      const assessment = spendingLimitAssessmentFromError(e);
      if (assessment !== undefined) {
        // An assessment for another account can never authorize this deposit. Opening it and
        // letting the effect below close it paints the drawer for one commit.
        if (assessment.accountId === account.publicKey) {
          setSpendingLimitChallenge({ assessment, spends: [{ faucetId, amount: amountBaseUnits }] });
        }
        return;
      }
      // `openUnpricedChallenge` reads spending-limit config and can itself throw. The outer
      // `finally` already releases `isSubmitting` either way, but without this it does so
      // silently, with no error shown for what actually failed.
      try {
        if (isSpendingLimitPriceUnavailable(e) && (await openUnpricedChallenge(amountBaseUnits))) {
          return;
        }
      } catch (challengeError) {
        console.error(challengeError);
      }
      settleRouteFlow('earn', flow => flow.fail(classifyError(e)));
      setSubmitError(e instanceof Error ? e.message : t('earnFailedToOpenPosition'));
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
      const spends = [{ faucetId, amount: amountBaseUnits }];
      const assessment = await assessSpendingLimit(account.publicKey, spends);
      if (assessment !== undefined && assessment.breach !== undefined) {
        // Same as the submit catch: a mismatched assessment is not this deposit's challenge.
        if (assessment.accountId === account.publicKey) {
          setSpendingLimitChallenge({ assessment, spends });
        }
        setIsSubmitting(false);
        return;
      }
      await runOpenPosition();
    } catch (error) {
      // See `runOpenPosition`: guard against `openUnpricedChallenge` itself throwing, or a
      // storage read failure here leaves the CTA disabled forever with no visible error.
      let opened = false;
      try {
        opened = isSpendingLimitPriceUnavailable(error) && (await openUnpricedChallenge(amountBaseUnits));
      } catch (challengeError) {
        console.error(challengeError);
      }
      if (opened) {
        setIsSubmitting(false);
        return;
      }
      setSubmitError(error instanceof Error ? error.message : t('earnFailedToOpenPosition'));
      setIsSubmitting(false);
    }
  };

  // The account is the only identity both the `assessment` and `unpriced` challenge shapes carry
  // (usd/spends amounts don't survive as comparable fields on the domain types any more), so this
  // guard closes the drawer if the active account changes while it's open; a stale credential for
  // any other reason is still caught by the backend's own authorization re-check at redemption.
  useEffect(() => {
    if (spendingLimitChallenge === undefined) return;
    const accountId = spendingLimitChallenge.assessment?.accountId ?? spendingLimitChallenge.unpriced?.accountId;
    if (accountId !== account.publicKey) {
      setSpendingLimitChallenge(undefined);
    }
  }, [account.publicKey, spendingLimitChallenge]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg">
      <NetworkModeBanner />
      {/* The shared pushed-page frame: the earn flow's header, the 16px page margin its two
          hand-rolled ones diverged from, and the CTA pinned under the body. Until the vault is
          found the header names the route, and the CTA waits with the body. */}
      <SubPageLayout
        data-testid="earn-deposit-review-page"
        title={found ? earnSubjectTitle(found) : t('earnDeposit')}
        onBack={goBack}
        headerActions={found && <EarnAssetMark asset={found.asset} network={found.network} />}
        footerLayout="stack"
        footer={
          (loadFailed && !found) || pending ? undefined : (
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
          )
        }
      >
        {loadFailed && !found ? (
          <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="mt-10" />
        ) : pending ? null : (
          <>
            {loadFailed && <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} />}
            <EarnHero
              labelId="earn-deposit-review-amount"
              value={toAdaptiveFixed(amountValue)}
              unit={<EarnAmountUnit symbol={depositSymbol} />}
              label={t('earnDepositAmountTitle')}
            />

            <DepositProjection vault={vault} amount={amountValue} />
          </>
        )}
      </SubPageLayout>

      {spendingLimitChallenge !== undefined && (
        <SpendingLimitChallenge
          assessment={spendingLimitChallenge.assessment}
          spends={spendingLimitChallenge.spends}
          unpriced={spendingLimitChallenge.unpriced}
          onResult={authorization => {
            setSpendingLimitChallenge(undefined);
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
  // `aprPercent` is the number `apy` is formatted from; reading it directly (rather than parsing
  // the display string back out) keeps this in step with a target `apy` can drift from, such as a
  // number still travelling in an AnimatedNumber elsewhere on the page.
  const apyFraction = (vault.aprPercent ?? 0) / 100;
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
