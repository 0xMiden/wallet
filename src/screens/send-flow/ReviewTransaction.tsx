import React, { useState } from 'react';

import { formatDistanceToNow } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { ReviewAmount, ReviewLayout, ReviewRow } from 'components/review';

import { BridgeNetwork } from './bridge-networks';
import { RecallCalendarDrawer } from './RecallCalendarDrawer';
import { SendFlowAction, BridgeRoute, UIToken } from './types';
import { EpochQuoteState } from './useEpochQuote';

export interface ReviewTransactionProps {
  amount: string;
  token?: UIToken;
  recipientAddress?: string;
  recallDate?: Date;
  recallTime: string;
  /** Cross-chain (0x recipient) send — shows bridge details instead of the Miden expiration row. */
  isBridge?: boolean;
  network?: BridgeNetwork;
  route?: BridgeRoute;
  /** Forward-quote of the USDC output (Fast route). */
  quote?: EpochQuoteState;
  outputSymbol?: string;
  /** True while the tx is being initiated (e.g. an Epoch bridge quote/solve) — drives the confirm-button loader. */
  isSubmitting?: boolean;
  onAction: (action: SendFlowAction) => void;
  onGoBack: () => void;
  onClose: () => void;
  onSubmit: () => void;
  onRecallDateChange: (date: Date | undefined) => void;
  onRecallTimeChange: (time: string) => void;
}

export const ReviewTransaction: React.FC<ReviewTransactionProps> = ({
  amount,
  token,
  recipientAddress,
  recallDate,
  recallTime,
  isBridge = false,
  network,
  route,
  quote,
  outputSymbol,
  isSubmitting = false,
  onAction,
  onGoBack,
  onSubmit,
  onRecallDateChange,
  onRecallTimeChange
}) => {
  const { t } = useTranslation();
  const [showCalendar, setShowCalendar] = useState(false);

  const parsedAmount = Number.parseFloat(amount || '0');
  const fiatValue = token && Number.isFinite(parsedAmount) ? parsedAmount * token.fiatPrice : undefined;
  const expirationLabel = recallDate
    ? (() => {
        const rel = formatDistanceToNow(recallDate, { addSuffix: true });
        return rel.charAt(0).toUpperCase() + rel.slice(1);
      })()
    : t('none');

  // Agglayer carries the bridgeable token 1:1; the Fast route forward-quotes the
  // USDC output. Show a skeleton only while the Fast quote is still loading.
  const youReceiveLoading = isBridge && route !== 'agglayer' && !!quote?.loading;
  const youReceiveAmount = route === 'agglayer' ? amount : quote?.amount;
  const arrivalLabel = route === 'agglayer' ? t('slowArrival') : t('fastArrival');
  const routeLabel = route === 'agglayer' ? t('slow') : t('fast');
  const youReceiveLabel =
    youReceiveAmount != null ? `≈ ${youReceiveAmount} ${outputSymbol ?? ''}`.trim() : (outputSymbol ?? '');

  return (
    <>
      <ReviewLayout
        hero={<ReviewAmount symbol={token?.name ?? ''} amount={amount} fiat={fiatValue} label={t('youAreSending')} />}
        primary={{
          label: t('sendPayment'),
          onPress: onSubmit,
          type: 'submit',
          loading: isSubmitting,
          'data-testid': 'send-review-submit'
        }}
        secondary={{ label: t('back'), onPress: onGoBack, disabled: isSubmitting }}
      >
        <ReviewRow label={t('to')} value={recipientAddress || ''} />

        <ReviewRow label={t('network')}>
          <span className="inline-flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-primary-500" />
            {isBridge ? (network?.name ?? t('ethereum')) : t('miden')}
          </span>
        </ReviewRow>

        {isBridge ? (
          <>
            <ReviewRow label={t('route')} value={`${routeLabel} ${arrivalLabel}`} />
            <ReviewRow label={t('youReceive')}>
              {youReceiveLoading ? (
                <div className="h-7 w-32 animate-pulse rounded bg-heading-gray/10" />
              ) : (
                youReceiveLabel
              )}
            </ReviewRow>
          </>
        ) : (
          <ReviewRow
            label={t('expirationDate')}
            onEdit={() => setShowCalendar(true)}
            editLabel={t('edit')}
            note={recallDate ? t('recallReturnsNote', { amount: `${amount} ${token?.name ?? ''}` }) : undefined}
          >
            {expirationLabel}
          </ReviewRow>
        )}
      </ReviewLayout>

      {!isBridge && (
        <RecallCalendarDrawer
          open={showCalendar}
          onOpenChange={setShowCalendar}
          recallDate={recallDate}
          recallTime={recallTime}
          onAction={onAction}
          onRecallDateChange={onRecallDateChange}
          onRecallTimeChange={onRecallTimeChange}
        />
      )}
    </>
  );
};
