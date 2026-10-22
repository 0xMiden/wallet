import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { NetworkLogo } from 'components/NetworkChip';
import { ReviewLayout } from 'components/review';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { formatBigInt } from 'lib/i18n/numbers';
import { OneClickAsset, OneClickQuoteResponse } from 'lib/one-click/types';
import { UserErrorId } from 'lib/telemetry/user-visible-error';

import { oneClickLogoNetwork } from './OneClickPickers';
import { oneClickQuoteExpired } from './useOneClickQuote';

export interface OneClickReviewProps {
  quote: OneClickQuoteResponse;
  originAsset: OneClickAsset;
  destinationAsset: OneClickAsset;
  originNetworkName?: string;
  destinationNetworkName?: string;
  recipient: string;
  refundTo: string;
  fees: readonly { label: string; value: string }[];
  nativeFee?: string;
  submitting?: boolean;
  confirmDisabled?: boolean;
  fundingError?:
    | 'oneClickBalanceChecking'
    | 'oneClickBalanceUnavailable'
    | 'oneClickInsufficientTokenBalance'
    | 'oneClickInsufficientGasBalance';
  fundingSymbol?: string;
  refreshing?: boolean;
  recoveryNotice?: boolean;
  error?: string;
  errorId?: UserErrorId | null;
  now?: number;
  onBack: () => void;
  onRefresh: () => void;
  onConfirm: () => void;
}

export const OneClickReview: React.FC<OneClickReviewProps> = ({
  quote,
  originAsset,
  destinationAsset,
  originNetworkName = originAsset.blockchain,
  destinationNetworkName = destinationAsset.blockchain,
  recipient,
  refundTo,
  fees,
  nativeFee,
  submitting = false,
  confirmDisabled = false,
  fundingError,
  fundingSymbol,
  refreshing = false,
  recoveryNotice = false,
  error,
  errorId,
  now,
  onBack,
  onRefresh,
  onConfirm
}) => {
  const { t } = useTranslation();
  const expired = oneClickQuoteExpired(quote, now);
  const arrival = t('oneClickArrivalEstimate', { minutes: Math.ceil(quote.quote.timeEstimate / 60) });

  return (
    <ReviewLayout
      accent="swap"
      dividers={false}
      hero={
        <div className="mb-6 flex flex-col gap-3" data-testid="one-click-review-hero">
          <Hero
            visual={
              <NetworkLogo
                kind={originAsset.blockchain === 'miden' ? 'miden' : 'ethereum'}
                network={oneClickLogoNetwork(originAsset.blockchain)}
                size="md"
              />
            }
            value={`${quote.quote.amountInFormatted} ${originAsset.symbol}`}
            subtitle={t('oneClickYouPayFrom', { network: originNetworkName })}
          />
          <span className="text-center text-body-sm text-muted" aria-hidden="true">
            ↓
          </span>
          <Hero
            visual={
              <NetworkLogo
                kind={destinationAsset.blockchain === 'miden' ? 'miden' : 'ethereum'}
                network={oneClickLogoNetwork(destinationAsset.blockchain)}
                size="md"
              />
            }
            value={`${quote.quote.amountOutFormatted} ${destinationAsset.symbol}`}
            subtitle={t('oneClickYouReceiveOn', { network: destinationNetworkName })}
          />
        </div>
      }
      primary={{
        label: expired ? t('oneClickRefreshQuote') : t('confirmSwap'),
        onPress: expired ? onRefresh : onConfirm,
        disabled: submitting || confirmDisabled,
        loading: refreshing || submitting,
        'data-testid': expired ? 'one-click-refresh-quote' : 'one-click-confirm'
      }}
      secondary={{ label: t('back'), onPress: onBack, disabled: submitting || refreshing }}
      error={error ? t(error) : undefined}
      errorId={error ? errorId : null}
    >
      {recoveryNotice && (
        <Notice tone="neutral" title={t('oneClickQuoteRefreshed')} className="mb-4">
          {t('oneClickExpiredRefreshNotice')}
        </Notice>
      )}
      {fundingError && (
        <Notice tone="warning" title={t(fundingError)} className="mb-4" data-testid="one-click-review-funding-error">
          {fundingError === 'oneClickInsufficientGasBalance'
            ? t('oneClickInsufficientGasBalanceBody', { symbol: fundingSymbol })
            : t(
                fundingError === 'oneClickInsufficientTokenBalance'
                  ? 'oneClickInsufficientTokenBalanceBody'
                  : fundingError === 'oneClickBalanceChecking'
                    ? 'oneClickBalanceCheckingBody'
                    : 'oneClickBalanceUnavailableBody'
              )}
        </Notice>
      )}
      <DetailCard surface="fill">
        <DetailRow label={t('oneClickMinimumReceived')} data-testid="one-click-minimum-row">
          {formatBigInt(BigInt(quote.quote.minAmountOut), destinationAsset.decimals)} {destinationAsset.symbol}
        </DetailRow>
        {fees.map(fee => (
          <DetailRow key={fee.label} label={t(fee.label)}>
            {fee.value}
          </DetailRow>
        ))}
        {nativeFee && <DetailRow label={t('oneClickNativeFee')}>{nativeFee}</DetailRow>}
        <DetailRow label={t('oneClickArrival')}>{arrival}</DetailRow>
        <DetailRow label={t('oneClickQuoteExpiresAt')}>
          {quote.quote.deadline && Number.isFinite(Date.parse(quote.quote.deadline))
            ? new Date(quote.quote.deadline).toLocaleString()
            : t('oneClickQuoteExpired')}
        </DetailRow>
        <DetailRow label={t('oneClickRecipient')} stacked data-testid="one-click-recipient-row">
          {recipient}
        </DetailRow>
        <DetailRow label={t('oneClickRefundAccount')} stacked data-testid="one-click-refund-row">
          {refundTo}
        </DetailRow>
        <DetailRow label={t('oneClickRoute')}>
          <span className="flex items-center gap-2">
            <Pill size="sm" tone="neutral">
              {originNetworkName}
            </Pill>
            <Icon name={IconName.ArrowRight} size="xs" aria-hidden="true" className="text-muted" />
            <Pill size="sm" tone="neutral">
              {destinationNetworkName}
            </Pill>
          </span>
        </DetailRow>
      </DetailCard>
    </ReviewLayout>
  );
};
