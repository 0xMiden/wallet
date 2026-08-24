import React, { FC, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { DetailCard } from './DetailCard';

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
    <DetailCard title={isCancelled ? t('cancelled') : t('error')}>
      <p
        data-testid="history-failure-reason"
        className={clsx(
          'px-4 py-3 text-sm font-medium wrap-break-word select-text',
          isCancelled ? 'text-gray-500' : 'text-status-negative'
        )}
      >
        {errorMessage}
      </p>
      {rawErrorMessage && (
        <div className="px-4 pb-3">
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
    </DetailCard>
  );
};
