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
}> = memo(({ status, isCancelled, swapSettlement: reportedSettlement, testId }) => {
  const { t } = useTranslation();
  const isFailed = status === ITransactionStatus.Failed;
  // A swap that failed or was cancelled never placed its order, so it has no
  // settlement to report; taking the caller's word for one produced a pill
  // labelled "Pending" in failure red, which names two different outcomes at
  // once. Failure is the stronger and more actionable fact, so it wins.
  const swapSettlement = isFailed || isCancelled ? undefined : reportedSettlement;
  const isCompleted = status === ITransactionStatus.Completed && swapSettlement === undefined;
  // A reclaimed order ended without delivering what was asked for, so it gets
  // the same muted treatment as a cancellation — the history list already tones
  // it that way.
  const isMuted = isCancelled || swapSettlement === 'reclaimed';

  // Muted rather than just cancelled, so a reclaimed order is toned the same way
  // here as it is in the history list.
  const bgColor = isMuted
    ? 'bg-gray-400'
    : isCompleted
      ? 'bg-tx-received'
      : isFailed
        ? 'bg-status-negative'
        : 'bg-tx-sent';
  // Ink is picked per fill, in the same order as `bgColor`, because no single ink
  // clears AA on all four — each fill is mid-tone in a different direction, and a
  // user cancellation is BOTH Failed and cancelled (`cancel.ts` records a cancel
  // as a failure), so any mismatch in the ordering pairs an ink with the wrong
  // fill. Ratios for 12px semibold text, which AA scores at 4.5:1:
  //   grey #737373        → white 4.74 (black would be 4.43, under)
  //   tx-received #99ac94 → black 8.68 (white 2.42)
  //   tx-sent #91acc1     → black 8.88 (white 2.37)
  //   status-negative     → the one fill that flips with the theme: black on the
  //                         light #ff5500 is 6.55, white on the deep dark #c51a0a
  //                         is 5.96. Fixed-palette tokens, so `dark:` is allowed.
  const fgColor = isMuted
    ? 'text-pure-white'
    : isCompleted
      ? 'text-pure-black'
      : isFailed
        ? 'text-pure-black dark:text-pure-white'
        : 'text-pure-black';
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
      className={classNames('flex items-center gap-1.5 px-3.5 py-1 rounded-full', bgColor, fgColor)}
    >
      {/* Muted first for the same reason as the colours: a cancellation reads
          Failed, and a grey "Cancelled" pill wearing the failure ✕ names two
          outcomes at once. */}
      {isMuted ? (
        <div className="w-2 h-2 rounded-full bg-current" />
      ) : isCompleted ? (
        <Icon name={IconName.Checkmark} size="xs" fill="currentColor" />
      ) : isFailed ? (
        <Icon name={IconName.Close} size="xs" fill="currentColor" />
      ) : (
        <div className="w-2 h-2 rounded-full bg-current" />
      )}
      <span className="text-xs font-semibold">{label}</span>
    </div>
  );
});
