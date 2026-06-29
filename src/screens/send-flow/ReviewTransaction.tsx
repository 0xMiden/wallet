import React, { useState } from 'react';

import { format, formatDistanceToNow } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { ReviewAmount, ReviewLayout, ReviewRow } from 'components/review';
import { truncateAddress } from 'utils/string';

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

  const fiatValue = token ? parseFloat(amount || '0') * token.fiatPrice : 0;
  const today = format(new Date(), 'dd.MM.yy');

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

  return (
    <>
      <ReviewLayout
        title={t('reviewDetails')}
        date={today}
        onBack={onGoBack}
        backLabel={t('back')}
        hero={<ReviewAmount symbol={token?.name ?? ''} amount={amount} fiat={fiatValue} />}
        primary={{
          label: t('sendPayment'),
          onPress: onSubmit,
          type: 'submit',
          loading: isSubmitting,
          'data-testid': 'send-review-submit'
        }}
        secondary={{ label: t('back'), onPress: onGoBack, disabled: isSubmitting }}
      >
        <ReviewRow label={t('to')} value={truncateAddress(recipientAddress || '')} />

        <ReviewRow label={t('network')}>
          <span className="flex items-center gap-2 text-base text-black font-medium">
            <span className="w-2 h-2 rounded-full bg-primary-500" />
            {isBridge ? (network?.name ?? t('ethereum')) : t('miden')}
          </span>
        </ReviewRow>

        {isBridge ? (
          <>
            <ReviewRow label={t('route')}>
              <span className="flex items-center gap-2 text-base text-black font-semibold">
                {route === 'agglayer' ? t('slow') : t('fast')}
                <span className="text-heading-gray/50 font-medium">{arrivalLabel}</span>
              </span>
            </ReviewRow>
            <ReviewRow label={t('youReceive')}>
              {youReceiveLoading ? (
                <div className="h-4 w-20 animate-pulse rounded bg-heading-gray/10" />
              ) : (
                <span className="text-base text-black font-semibold">
                  {youReceiveAmount != null ? `≈ ${youReceiveAmount} ${outputSymbol}` : outputSymbol}
                </span>
              )}
            </ReviewRow>
          </>
        ) : (
          <ReviewRow label={t('expirationDate')} onEdit={() => setShowCalendar(true)} editLabel={t('edit')}>
            <span className="text-base text-black font-semibold">{expirationLabel}</span>
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
