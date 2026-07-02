import React, { FC, memo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ITransactionStatus } from 'lib/miden/db/types';

export { DetailCard, DetailRow } from 'lib/ui/DetailCard';

export const ExternalLinkValue: FC<{
  displayValue: React.ReactNode;
  href: string;
}> = ({ displayValue, href }) => (
  <div className="flex items-center gap-1 text-sm text-heading-gray font-medium">
    {displayValue}
    <a href={href} target="_blank" rel="noreferrer">
      <Icon name={IconName.ArrowRightUp} size="xs" fill="#9E9E9E" />
    </a>
  </div>
);

/**
 * Confirmed / Failed / In Progress pill, driven by the transaction's actual
 * `status` (message-string sniffing broke for types whose completion message
 * wasn't in the known list — e.g. a completed swap's "Swapped").
 */
export const StatusPill: FC<{ status?: ITransactionStatus }> = memo(({ status }) => {
  const { t } = useTranslation();
  const isCompleted = status === ITransactionStatus.Completed;
  const isFailed = status === ITransactionStatus.Failed;

  const dotColor = isCompleted ? 'bg-[#1A9C52]' : isFailed ? 'bg-status-negative' : 'bg-blue-500';
  const textColor = isCompleted ? 'text-[#1A9C52]' : isFailed ? 'text-status-negative' : 'text-blue-500';
  const label = isCompleted ? t('confirmed') : isFailed ? t('failed') : t('inProgress');

  return (
    <div className="flex items-center gap-1 px-4 py-2 rounded-5 bg-white">
      <div className={classNames('w-2 h-2 rounded-full', dotColor)} />
      <span className={classNames('text-[10px] font-medium text-heading-gray', textColor)}>{label}</span>
    </div>
  );
});
