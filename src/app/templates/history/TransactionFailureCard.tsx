import React, { FC } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ErrorDetails } from 'components/ui/ErrorDetails';
import type { NotConfirmedHintKey } from 'lib/miden/transaction/verdict-rules';

import { DetailSection } from './DetailSection';

/**
 * Failure reason persisted on `tx.error`, with the untouched thrown `rawError`
 * revealed on demand. Shared by the generic detail body and the swap receipt so
 * a failed or cancelled swap explains itself the way every other type does.
 *
 * `isUnconfirmed` (`isOutcomeUnconfirmed`) wins over `isCancelled`: the row's outcome is
 * unknown rather than a completed failure, so it is titled like the not-confirmed status and
 * its body is the hint that the wallet cannot yet rule the transfer out. The row's reason is
 * not shown there, since classifier copy can claim a failure ("No funds moved"); its own text
 * stays behind the disclosure instead, as `describeRotationFailure` does for the rotation gate.
 * The hint follows `notConfirmedHintKey` (#1081).
 */
export const TransactionFailureCard: FC<{
  errorMessage: string;
  rawErrorMessage?: string;
  isCancelled?: boolean;
  isUnconfirmed?: boolean;
  hintKey?: NotConfirmedHintKey;
}> = ({ errorMessage, rawErrorMessage, isCancelled, isUnconfirmed, hintKey = 'transactionNotConfirmedHint' }) => {
  const { t } = useTranslation();

  return (
    <DetailSection title={isUnconfirmed ? t('notConfirmed') : isCancelled ? t('cancelled') : t('error')}>
      {/* One child, not two: `DetailCard` draws a hairline between every child it's given
          (`divide-y`), and the message + the disclosure toggle are one body, not two rows. */}
      <div className="px-4 py-3">
        {isUnconfirmed ? (
          <p data-testid="history-unconfirmed-hint" className="text-sm text-gray-500 wrap-break-word">
            {t(hintKey)}
          </p>
        ) : (
          <p
            data-testid="history-failure-reason"
            className={clsx(
              'text-sm font-medium wrap-break-word select-text',
              isCancelled ? 'text-gray-500' : 'text-status-negative'
            )}
          >
            {errorMessage}
          </p>
        )}
        <ErrorDetails details={isUnconfirmed ? (rawErrorMessage ?? errorMessage) : rawErrorMessage} className="mt-1" />
      </div>
    </DetailSection>
  );
};
