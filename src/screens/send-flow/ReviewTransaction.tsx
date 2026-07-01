import React, { useState } from 'react';

import { formatDistanceToNow } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { ReviewAmount, ReviewLayout, ReviewRow } from 'components/review';

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
  onAction,
  onSubmit,
  onRecallDateChange,
  onRecallTimeChange
}) => {
  const { t } = useTranslation();
  const [showCalendar, setShowCalendar] = useState(false);

  const expirationLabel = recallDate
    ? (() => {
        const rel = formatDistanceToNow(recallDate, { addSuffix: true });
        return rel.charAt(0).toUpperCase() + rel.slice(1);
      })()
    : t('none');

  return (
    <>
      <ReviewLayout
        hero={<ReviewAmount symbol={token?.name ?? ''} amount={amount} label={t('youAreSending')} />}
        primary={{ label: t('sendPayment'), onPress: onSubmit, type: 'submit', 'data-testid': 'send-review-submit' }}
      >
        <ReviewRow label={t('to')} value={recipientAddress || ''} />

        <ReviewRow label={t('network')}>
          <span className="inline-flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-primary-500" />
            {t('miden')}
          </span>
        </ReviewRow>

        <ReviewRow
          label={t('expirationDate')}
          onEdit={() => setShowCalendar(true)}
          editLabel={t('edit')}
          note={recallDate ? t('recallReturnsNote', { amount: `${amount} ${token?.name ?? ''}` }) : undefined}
        >
          {expirationLabel}
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
