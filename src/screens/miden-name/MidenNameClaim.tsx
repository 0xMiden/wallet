import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { FlowLayout } from 'components/flow/FlowLayout';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { SpendingLimitChallenge, type SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Spinner } from 'components/ui/Spinner';
import { TextField } from 'components/ui/TextField';
import type { IConsumedAssetTotal } from 'lib/miden/db/types';
import { FEE_RESERVE_MULTIPLE } from 'lib/miden/fees/spendable';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useMidenContext } from 'lib/miden/front/client';
import { MIDEN_METADATA } from 'lib/miden/metadata/defaults';
import { formatMidenName, type MidenLabelError, MIDEN_NAME_SUFFIX } from 'lib/miden/name/encoding';
import { assertRegistrationPreconditions } from 'lib/miden/name/guard';
import { buildRegisterNameRequest, registerNameRowAccounts, type RegisterNameRequest } from 'lib/miden/name/note';
import {
  isSpendingLimitPriceUnavailable,
  type SpendingLimitAuthorization,
  spendingLimitAssessmentFromError
} from 'lib/miden/spending-limits/types';
import { initiateRegisterNameTransaction } from 'lib/miden/transaction/initiate';
import { hapticMedium } from 'lib/mobile/haptics';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';
import { HistoryAction, navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

import { startMidenNameProcessing } from './processing';
import { type MidenNameQuoteState, useMidenNameQuote } from './useMidenNameQuote';

/** A built register request and the quote that it pays. One per tap on the CTA. */
interface PendingRegistration {
  accountId: string;
  label: string;
  priceBaseUnits: bigint;
  networkFeeBaseUnits: bigint;
  request: RegisterNameRequest;
  spends: IConsumedAssetTotal[];
}

type ChallengeState = Pick<SpendingLimitChallengeProps, 'assessment' | 'spends' | 'unpriced'>;

/** Longest name length that has its own price. Longer names pay the 5+ price. */
const PRICE_TIER_CAP = 5;

function formatMiden(amount: bigint): string {
  return `${formatAmount(amount, MIDEN_METADATA.decimals)} ${MIDEN_METADATA.symbol}`;
}

function invalidKeyOf(reason: MidenLabelError): string {
  switch (reason) {
    case 'empty':
      return 'midenNameInvalidEmpty';
    case 'too-long':
      return 'midenNameInvalidTooLong';
    case 'invalid-chars':
      return 'midenNameInvalidChars';
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/**
 * The claim form of a Miden Name: the user types a label, the screen reads its
 * price and availability, and the CTA queues a `register-name` transaction.
 * On success the status page REPLACES this form in the history.
 */
export const MidenNameClaim: FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const { signTransaction } = useMidenContext();
  const goBack = useBackWithFallback('/receive');

  const [input, setInput] = useState('');
  const quoteState = useMidenNameQuote(input);
  const { label, quote } = quoteState;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [challenge, setChallenge] = useState<ChallengeState>();
  // The request of the last tap. A spending-limit re-submit uses this SAME
  // object: its serial number and fee salt are random and must not change.
  const pendingRef = useRef<PendingRegistration | null>(null);

  const assessSpendingLimit = useWalletStore(state => state.assessSpendingLimit);
  const readSpendingLimit = useWalletStore(state => state.readSpendingLimit);

  const nativeFaucetId = useMidenFaucetId();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balances, isLoading: balancesLoading } = useAllBalances(account.publicKey, allTokensBaseMetadata);
  const baseFee = useVerificationBaseFee();
  const txFeeLabel = useNetworkFeeEstimate();

  const nativeBalance = useMemo(() => {
    const native = balances?.find(balance => balance.tokenId === nativeFaucetId);
    // The placeholder zero row before the first read is not a known balance.
    if (!native || (balancesLoading && native.balance === 0)) return undefined;
    return BigInt(Math.round(native.balance * 10 ** MIDEN_METADATA.decimals));
  }, [balances, balancesLoading, nativeFaucetId]);

  const feeReserve = baseFee !== null && baseFee > 0 ? BigInt(Math.round(baseFee * FEE_RESERVE_MULTIPLE)) : 0n;
  const quoteForLabel = quote && quote.label === label ? quote : undefined;
  const shownQuote = quoteState.status === 'available' || quoteState.status === 'checking' ? quote : undefined;
  const total = shownQuote ? shownQuote.priceBaseUnits + shownQuote.networkFeeBaseUnits + feeReserve : undefined;
  const insufficient = total !== undefined && nativeBalance !== undefined && nativeBalance < total;
  const canClaim = quoteState.status === 'available' && quoteForLabel !== undefined && !insufficient;

  // Close the challenge when the account changes while it is open. The backend
  // checks the authorization again when it redeems it.
  useEffect(() => {
    if (challenge === undefined) return;
    const accountId = challenge.assessment?.accountId ?? challenge.unpriced?.accountId;
    if (accountId !== account.publicKey) setChallenge(undefined);
  }, [account.publicKey, challenge]);

  const openUnpricedChallenge = useCallback(
    async (pending: PendingRegistration): Promise<boolean> => {
      const configuration = await readSpendingLimit(pending.accountId);
      if (configuration === undefined) return false;
      setChallenge({
        unpriced: { accountId: pending.accountId, spends: [...pending.spends], revision: configuration.revision }
      });
      return true;
    },
    [readSpendingLimit]
  );

  /** Show the error of a failed submit. Returns when the screen shows it. */
  const showSubmitError = useCallback(
    async (error: unknown, pending: PendingRegistration | null) => {
      const assessment = spendingLimitAssessmentFromError(error);
      if (assessment !== undefined && pending) {
        if (assessment.accountId === pending.accountId) setChallenge({ assessment, spends: pending.spends });
        return;
      }
      if (pending && isSpendingLimitPriceUnavailable(error)) {
        try {
          if (await openUnpricedChallenge(pending)) return;
        } catch (challengeError) {
          console.error(challengeError);
        }
      }
      switch (errorName(error)) {
        case 'MidenNameTakenError':
          quoteState.recheck();
          setSubmitError(t('midenNameTaken', { name: formatMidenName(label) }));
          return;
        case 'MidenNamePriceChangedError':
          quoteState.recheck();
          setSubmitError(t('midenNamePriceChanged'));
          return;
        case 'MidenNameScriptNotAllowedError':
          setSubmitError(t('midenNameRegistryUnavailable'));
          return;
        default:
          console.error('[miden-name] claim failed', error);
          setSubmitError(error instanceof Error ? error.message : String(error));
      }
    },
    [label, openUnpricedChallenge, quoteState, t]
  );

  const queueRegistration = useCallback(
    async (pending: PendingRegistration, authorization?: SpendingLimitAuthorization) => {
      const txId = await initiateRegisterNameTransaction({
        accountId: pending.accountId,
        label: pending.label,
        priceBaseUnits: pending.priceBaseUnits,
        networkFeeBaseUnits: pending.networkFeeBaseUnits,
        request: pending.request,
        delegateTransaction: isDelegateProofEnabled(),
        spendingLimitAuthorization: authorization
      });
      startMidenNameProcessing(signTransaction);
      navigate(`/miden-name/status/${encodeURIComponent(txId)}`, HistoryAction.Replace);
    },
    [signTransaction]
  );

  const handleClaim = async () => {
    hapticMedium();
    if (isSubmitting || !canClaim || !quoteForLabel) return;
    setIsSubmitting(true);
    setSubmitError(undefined);
    pendingRef.current = null;
    try {
      const fresh = await assertRegistrationPreconditions(label, quoteForLabel.priceBaseUnits);
      const request = await buildRegisterNameRequest({
        senderAccountId: account.publicKey,
        label,
        priceBaseUnits: fresh.priceBaseUnits
      });
      const pending: PendingRegistration = {
        accountId: account.publicKey,
        label,
        priceBaseUnits: fresh.priceBaseUnits,
        networkFeeBaseUnits: fresh.networkFeeBaseUnits,
        request,
        spends: [{ faucetId: registerNameRowAccounts().paymentFaucetId, amount: fresh.priceBaseUnits }]
      };
      pendingRef.current = pending;
      // Same pre-check as the earn deposit: a breach opens the challenge before the queue refuses.
      const assessment = await assessSpendingLimit(pending.accountId, pending.spends);
      if (assessment?.breach !== undefined) {
        if (assessment.accountId === pending.accountId) setChallenge({ assessment, spends: pending.spends });
        return;
      }
      await queueRegistration(pending);
    } catch (error) {
      await showSubmitError(error, pendingRef.current);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChallengeResult = async (authorization: SpendingLimitAuthorization | undefined) => {
    setChallenge(undefined);
    const pending = pendingRef.current;
    if (authorization === undefined || !pending) return;
    if (authorization.accountId !== pending.accountId) return;
    setIsSubmitting(true);
    setSubmitError(undefined);
    try {
      await queueRegistration(pending, authorization);
    } catch (error) {
      await showSubmitError(error, pending);
    } finally {
      setIsSubmitting(false);
    }
  };

  const ctaTitle =
    canClaim && quoteForLabel
      ? t('midenNameClaimName', { name: formatMidenName(label), price: formatMiden(quoteForLabel.priceBaseUnits) })
      : t('midenNameClaimCta');

  const fieldError = (() => {
    switch (true) {
      case input.trim().length > 0 && label.length === 0:
        return t('midenNameInvalidEmpty');
      case quoteState.status === 'invalid' && quoteState.reason !== undefined:
        return t(invalidKeyOf(quoteState.reason ?? 'empty'));
      default:
        return undefined;
    }
  })();

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-app-bg" data-testid="miden-name-claim-page">
      <NetworkModeBanner />
      <FlowLayout
        title={t('midenNameClaimTitle')}
        onBack={goBack}
        footer={
          <div className="flex w-full flex-col gap-2">
            {insufficient && total !== undefined && (
              <p className="text-center text-caption text-negative-ink" data-testid="miden-name-insufficient">
                {t('midenNameInsufficientBalance', { amount: formatMiden(total) })}
              </p>
            )}
            {submitError && (
              <p role="alert" className="text-center text-caption text-negative-ink" data-testid="miden-name-error">
                {submitError}
              </p>
            )}
            <Button
              data-testid="miden-name-claim-cta"
              title={ctaTitle}
              variant={ButtonVariant.Primary}
              onClick={handleClaim}
              isLoading={isSubmitting}
              disabled={isSubmitting || !canClaim}
              className="w-full max-w-none"
            />
          </div>
        }
      >
        <div className="flex flex-col gap-4 pb-4">
          <TextField
            value={input}
            onChange={event => setInput(event.target.value)}
            placeholder={t('midenNameSearchPlaceholder')}
            aria-label={t('midenNameClaimTitle')}
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            hint={t('midenNameRules')}
            error={fieldError}
            trailing={<span className="text-body text-muted">{MIDEN_NAME_SUFFIX}</span>}
            data-testid="miden-name-input"
            errorTestId="miden-name-input-error"
          />

          <AvailabilityLine state={quoteState} />

          {shownQuote && total !== undefined && (
            <DetailCard>
              <DetailRow
                label={t('midenNamePrice', {
                  length:
                    shownQuote.label.length >= PRICE_TIER_CAP ? `${PRICE_TIER_CAP}+` : String(shownQuote.label.length)
                })}
                data-testid="miden-name-price"
              >
                {formatMiden(shownQuote.priceBaseUnits)}
              </DetailRow>
              <DetailRow label={t('midenNameNetworkFee')} data-testid="miden-name-network-fee">
                {formatMiden(shownQuote.networkFeeBaseUnits)}
              </DetailRow>
              {txFeeLabel && (
                <DetailRow label={t('midenNameTxFee')} data-testid="miden-name-tx-fee">
                  {txFeeLabel}
                </DetailRow>
              )}
              <DetailRow label={t('midenNameTotal')} data-testid="miden-name-total">
                {formatMiden(total)}
              </DetailRow>
              <DetailRow
                label={t('midenNameGoesTo')}
                sub={truncateAddress(account.publicKey, false, 10, 6)}
                data-testid="miden-name-goes-to"
              >
                {account.name}
              </DetailRow>
              {nativeBalance !== undefined && nativeBalance >= total && (
                <DetailRow label={t('midenNameBalanceAfter')} data-testid="miden-name-balance-after">
                  {formatMiden(nativeBalance - total)}
                </DetailRow>
              )}
            </DetailCard>
          )}

          <p className="text-body-sm text-muted">{t('midenNamePermanentNote')}</p>
        </div>
      </FlowLayout>
      {challenge !== undefined && (
        <SpendingLimitChallenge
          assessment={challenge.assessment}
          spends={challenge.spends}
          unpriced={challenge.unpriced}
          onResult={handleChallengeResult}
        />
      )}
    </div>
  );
};

const AvailabilityLine: FC<{ state: MidenNameQuoteState }> = ({ state }) => {
  const { t } = useTranslation();
  const name = formatMidenName(state.label);

  const content = (() => {
    switch (state.status) {
      case 'checking':
        return (
          <span className="flex items-center gap-2 text-muted">
            <Spinner size="sm" />
            {t('midenNameChecking')}
          </span>
        );
      case 'available':
        return (
          <span className="flex items-center gap-2 text-positive-ink">
            <Icon name={IconName.CheckboxCircleFill} size="xs" fill="currentColor" />
            {t('midenNameAvailable', { name })}
          </span>
        );
      case 'taken':
        return <span className="text-negative-ink">{t('midenNameTaken', { name })}</span>;
      case 'unsupported':
        return <span className="text-negative-ink">{t('midenNameRegistryUnavailable')}</span>;
      case 'error':
        return <span className="text-negative-ink">{t('midenNameServiceUnavailable')}</span>;
      default:
        return null;
    }
  })();

  return (
    <div role="status" aria-live="polite" className="min-h-5 text-body-sm" data-testid="miden-name-availability">
      {content}
    </div>
  );
};

export default MidenNameClaim;
