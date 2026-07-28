import React from 'react';

import { useTranslation } from 'react-i18next';

import { ReviewAmount, ReviewLayout, ReviewRow } from 'components/review';
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
 * chosen. Reuses the shared `ReviewLayout`/`ReviewRow`/`ReviewAmount` shell (same
 * design as the Send review) and defers the actual submit to `onConfirm`, which
 * the manager wires to `executeEVMToMiden` (Fast) or the Agglayer bridge (Slow).
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
      hero={<ReviewAmount symbol={symbol} amount={amount} fiat={fiat} label={t('youAreDepositing')} />}
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
      <ReviewRow label={t('amount')} value={`${amount} ${symbol}`} />

      <ReviewRow label={t('from')}>
        <span className="inline-flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-primary-500" />
          {networkName}
        </span>
      </ReviewRow>

      <ReviewRow label={t('route')} value={`${routeLabel} ${arrivalLabel}`} />

      <ReviewRow label={t('youReceive')}>
        {youReceiveLoading ? <div className="h-7 w-32 animate-pulse rounded bg-heading-gray/10" /> : youReceiveLabel}
      </ReviewRow>
    </ReviewLayout>
  );
};
