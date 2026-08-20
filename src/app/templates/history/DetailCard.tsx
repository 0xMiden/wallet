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
 *
 * `swapSettlement` overrides it for a swap, because a swap row is Completed the
 * moment the order note is created: the place-order transaction confirmed, the
 * swap did not. The history list already draws that distinction, so without this
 * the same order reads "Pending" in the list and "Confirmed" on its own receipt.
 */
export const StatusPill: FC<{
  status?: ITransactionStatus;
  isCancelled?: boolean;
  swapSettlement?: 'pending' | 'reclaimed';
  testId?: string;
}> = memo(({ status, isCancelled, swapSettlement, testId }) => {
  const { t } = useTranslation();
  const isCompleted = status === ITransactionStatus.Completed && swapSettlement === undefined;
  const isFailed = status === ITransactionStatus.Failed;
  // A reclaimed order ended without delivering what was asked for, so it gets
  // the same muted treatment as a cancellation — the history list already tones
  // it that way.
  const isMuted = isCancelled || swapSettlement === 'reclaimed';

  const dotColor = isMuted
    ? 'bg-gray-400'
    : isCompleted
      ? 'bg-[#1A9C52]'
      : isFailed
        ? 'bg-status-negative'
        : 'bg-blue-500';
  const textColor = isMuted
    ? 'text-gray-500'
    : isCompleted
      ? 'text-[#1A9C52]'
      : isFailed
        ? 'text-status-negative'
        : 'text-blue-500';
  const label = isCancelled
    ? t('cancelled')
    : swapSettlement === 'reclaimed'
      ? t('reclaimed')
      : swapSettlement === 'pending'
        ? t('pending')
        : isCompleted
          ? t('confirmed')
          : isFailed
            ? t('failed')
            : t('inProgress');

  return (
    <div
      data-testid={testId}
      className={classNames(
        'flex items-center gap-1 px-4 py-0.5 rounded-full',
        isMuted ? 'bg-gray-100' : 'bg-green-600/20'
      )}
    >
      <div className={classNames('w-2 h-2 rounded-full', dotColor)} />
      <span className={classNames('text-[10px] font-medium text-heading-gray', textColor)}>{label}</span>
    </div>
  );
});
