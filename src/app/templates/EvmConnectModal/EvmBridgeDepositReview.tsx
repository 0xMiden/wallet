import React from 'react';

import { useTranslation } from 'react-i18next';

import { ReviewLayout } from 'components/review';
import { TokenLogo } from 'components/TokenLogo';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { Pill } from 'components/ui/Pill';
import { Skeleton } from 'components/ui/Skeleton';
import { approxFiatAmount } from 'screens/send-flow/amount-format';
import { BridgeRoute } from 'screens/send-flow/types';

export interface EvmBridgeDepositReviewProps {
  /** Deposit input amount (human string). */
  amount: string;
  /** Token symbol shown in the hero / rows (e.g. USDC or ETH). */
  symbol: string;
  /** Optional ≈USD value under the hero amount. Omit when there's no reliable price (e.g. testnet ETH). */
  fiat?: number;
  /** Selected bridge route — drives the route label + arrival ETA. */
  route: BridgeRoute;
  /** Forward-quoted output the recipient receives on Miden (Fast route). undefined while quoting. */
  outputAmount?: string;
  /** Source network name (e.g. Sepolia). */
  networkName: string;
  /** Show a skeleton on the "You receive" row while the Fast quote is still loading. */
  youReceiveLoading?: boolean;
  /** Drives the confirm-button spinner while the bridge submit is in flight. */
  isSubmitting?: boolean;
  /** Whether Confirm can be pressed (quote ready / not already submitting or submitted). */
  canConfirm?: boolean;
  /** Primary-button label. Defaults to "Confirm Deposit"; pass "Retry" after a failed attempt. */
  confirmLabel?: string;
  /** Bridge submit error, shown above the CTAs. */
  error?: string;
  onConfirm: () => void;
  onBack: () => void;
}

/**
 * Review step for the Receive-from-EVM bridge deposit, shown after the route is
 * chosen. Reuses the shared `ReviewLayout` shell (same shell as the Send review)
 * with a `Hero` amount and `DetailCard` rows, and defers the actual submit to
 * `onConfirm`, which the manager wires to `executeEVMToMiden` (Fast) or the
 * Agglayer bridge (Slow).
 */
export const EvmBridgeDepositReview: React.FC<EvmBridgeDepositReviewProps> = ({
  amount,
  symbol,
  fiat,
  route,
  outputAmount,
  networkName,
  youReceiveLoading = false,
  isSubmitting = false,
  canConfirm = false,
  confirmLabel,
  error,
  onConfirm,
  onBack
}) => {
  const { t } = useTranslation();

  const routeLabel = route === 'agglayer' ? t('slow') : t('fast');
  const arrivalLabel = route === 'agglayer' ? t('slowArrival') : t('fastArrival');
  const youReceiveLabel = outputAmount != null ? `≈ ${outputAmount} ${symbol}`.trim() : symbol;

  return (
    <ReviewLayout
      hero={
        // The caption identifies what the hero amount is for — same shape as ReviewSwap's
        // You Send / You Receive pills, since Hero itself has no slot above its value.
        <div className="mt-3 flex w-full flex-col items-center">
          <Pill tone="neutral">{t('youAreDepositing')}</Pill>
          <Hero
            className="mt-2"
            visual={<TokenLogo symbol={symbol} size="2xl" />}
            value={`${amount} ${symbol}`}
            subtitle={fiat !== undefined ? t('approxFiatValue', { value: approxFiatAmount(fiat) }) : undefined}
          />
        </div>
      }
      heroDivider={false}
      // The rows now live inside one DetailCard (their own hairlines), so ReviewLayout's outer
      // divide-y around a single child would be a no-op — turned off for clarity.
      dividers={false}
      error={error}
      primary={{
        label: confirmLabel ?? t('confirmDeposit'),
        onPress: onConfirm,
        loading: isSubmitting,
        disabled: !canConfirm,
        'data-testid': 'bridge-deposit-review-confirm'
      }}
      secondary={{ label: t('back'), onPress: onBack, disabled: isSubmitting }}
    >
      <DetailCard>
        <DetailRow label={t('amount')}>{`${amount} ${symbol}`}</DetailRow>

        <DetailRow label={t('from')}>
          <span className="inline-flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-primary-500" />
            {networkName}
          </span>
        </DetailRow>

        <DetailRow label={t('route')}>{`${routeLabel} ${arrivalLabel}`}</DetailRow>

        <DetailRow label={t('youReceive')}>
          {youReceiveLoading ? <Skeleton className="h-6 w-28" /> : youReceiveLabel}
        </DetailRow>
      </DetailCard>
    </ReviewLayout>
  );
};
