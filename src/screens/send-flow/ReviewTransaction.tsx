import React, { useState } from 'react';

import { format, formatDistanceToNow } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { ReviewAmount, ReviewLayout, ReviewRow } from 'components/review';
import { truncateAddress } from 'utils/string';

import { RecallCalendarDrawer } from './RecallCalendarDrawer';
import { SendFlowAction, UIToken } from './types';

export interface ReviewTransactionProps {
  amount: string;
  token?: UIToken;
  recipientAddress?: string;
  recallDate?: Date;
  recallTime: string;
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
  fiatValue,
  recipientAddress,
  recallDate,
  recallTime,
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

  return (
    <>
      <ReviewLayout
        title={t('reviewDetails')}
        date={today}
        onBack={onGoBack}
        backLabel={t('back')}
        hero={<ReviewAmount symbol={token?.name ?? ''} amount={amount} fiat={fiatValue} />}
        primary={{ label: t('sendPayment'), onPress: onSubmit, type: 'submit' }}
        secondary={{ label: t('back'), onPress: onGoBack }}
      >
        <ReviewRow label={t('to')} value={truncateAddress(recipientAddress || '')} />

        <ReviewRow label={t('network')}>
          <span className="flex items-center gap-2 text-base text-black font-medium">
            <span className="w-2 h-2 rounded-full bg-primary-500" />
            {t('miden')}
          </span>
        </ReviewRow>

        <ReviewRow label={t('expirationDate')} onEdit={() => setShowCalendar(true)} editLabel={t('edit')}>
          <span className="text-base text-black font-semibold">{expirationLabel}</span>
        </ReviewRow>
      </ReviewLayout>

      <RecallCalendarDrawer
        open={showCalendar}
        onOpenChange={setShowCalendar}
        recallDate={recallDate}
        recallTime={recallTime}
        onAction={onAction}
        onRecallDateChange={onRecallDateChange}
        onRecallTimeChange={onRecallTimeChange}
      />
    </>
  );
};
