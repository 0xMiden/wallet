import React, { FC, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { DetailSection } from './DetailSection';

/**
 * Failure reason persisted on `tx.error`, with the untouched thrown `rawError`
 * revealed on demand. Shared by the generic detail body and the swap receipt so
 * a failed or cancelled swap explains itself the way every other type does.
 */
export const TransactionFailureCard: FC<{
  errorMessage: string;
  rawErrorMessage?: string;
  isCancelled?: boolean;
}> = ({ errorMessage, rawErrorMessage, isCancelled }) => {
  const { t } = useTranslation();
  const [showFullError, setShowFullError] = useState(false);

  return (
    <DetailSection title={isCancelled ? t('cancelled') : t('error')}>
      {/* One child, not two: `DetailCard` draws a hairline between every child it's given
          (`divide-y`), and the message + the disclosure toggle are one body, not two rows. */}
      <div className="px-4 py-3">
        <p
          data-testid="history-failure-reason"
          className={clsx(
            'text-sm font-medium wrap-break-word select-text',
            isCancelled ? 'text-gray-500' : 'text-status-negative'
          )}
        >
          {errorMessage}
        </p>
        {rawErrorMessage && (
          <div className="mt-3">
            <button
              type="button"
              className="text-sm font-medium text-text-muted underline"
              onClick={() => setShowFullError(v => !v)}
            >
              {showFullError ? t('hideFullError') : t('showFullError')}
            </button>
            {showFullError && (
              <p className="mt-2 text-xs font-medium text-text-muted wrap-break-word select-text">{rawErrorMessage}</p>
            )}
          </div>
        )}
      </div>
    </DetailSection>
  );
};
