import React, { FC, memo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ITransactionStatus } from 'lib/miden/db/types';

/** History section with the compact rounded label used by the transaction detail design. */
export const DetailCard: FC<{ title?: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="font-heading">
    {title && (
      <div className="inline-flex rounded-full bg-[#F1F1F1] px-2.5 py-1 text-sm font-bold leading-4 text-gray dark:bg-surface-interactive">
        {title}
      </div>
    )}
    <div className={classNames(title && 'mt-2')}>{children}</div>
  </section>
);

/** Simple key/value row separated from its sibling by a subtle rule. */
export const DetailRow: FC<{
  label: string;
  value?: string;
  badge?: string;
  icon?: React.ReactNode;
  isLast?: boolean;
  children?: React.ReactNode;
  /**
   * Optional E2E hook on the row root. Scoping to the ROW (not the value) is what
   * makes the full, untrimmed hash reachable: `HashChip` renders a trimmed
   * `<button>` next to a sibling `sr-only` `<input>` holding the whole value
   * (CopyButton), so only a container testid can address both.
   */
  testId?: string;
}> = ({ label, value, badge, icon, isLast, children, testId }) => (
  <div
    data-testid={testId}
    className={classNames(
      'flex min-h-14 items-center justify-between gap-4 px-2 py-5',
      !isLast && 'border-b border-border-light'
    )}
  >
    <div className="flex shrink-0 items-center gap-3">
      {icon}
      <span className="text-sm font-semibold text-heading-gray">{label}</span>
    </div>
    {children ? (
      <div className="flex min-w-0 items-center justify-end text-right">{children}</div>
    ) : badge ? (
      <span className="rounded-full bg-[#FFF3EB] px-3 py-1 text-sm font-medium text-[#CC5200]">{badge}</span>
    ) : (
      <span className="min-w-0 text-right text-sm font-medium text-heading-gray">{value}</span>
    )}
  </div>
);

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
export const StatusPill: FC<{ status?: ITransactionStatus; isCancelled?: boolean; testId?: string }> = memo(
  ({ status, isCancelled, testId }) => {
    const { t } = useTranslation();
    const isCompleted = status === ITransactionStatus.Completed;
    const isFailed = status === ITransactionStatus.Failed;

    const bgColor = isCancelled
      ? 'bg-gray-400'
      : isCompleted
        ? 'bg-[#99AC94]'
        : isFailed
          ? 'bg-status-negative'
          : 'bg-[#91ACC1]';
    const label = isCancelled
      ? t('cancelled')
      : isCompleted
        ? t('confirmed')
        : isFailed
          ? t('failed')
          : t('inProgress');

    return (
      <div data-testid={testId} className={classNames('flex items-center gap-1.5 px-3.5 py-1 rounded-full', bgColor)}>
        {isCompleted ? (
          <Icon name={IconName.Checkmark} size="xs" fill="white" />
        ) : isFailed ? (
          <Icon name={IconName.Close} size="xs" fill="white" />
        ) : (
          <div className="w-2 h-2 rounded-full bg-pure-white" />
        )}
        <span className="text-xs font-semibold text-pure-white">{label}</span>
      </div>
    );
  }
);
