import React, { FC, memo } from 'react';

import { Icon, IconName } from 'app/icons/v2';
import { Status, StatusBadge } from 'components/ui/StatusBadge';
import { ITransactionStatus } from 'lib/miden/db/types';

export const ExternalLinkValue: FC<{
  displayValue: React.ReactNode;
  // Undefined when no explorer is configured for the effective network (e.g. a
  // custom dev-settings override with a blank explorer URL) — render the value
  // without a dead arrow link rather than linking nowhere.
  href?: string;
}> = ({ displayValue, href }) => (
  // `min-w-0`: a flex item defaults to its content's natural (max-content) width, which would
  // stop `displayValue` (a HashChip/AddressChip — a Pill whose own `truncate` needs a bounded
  // width to have anything to ellipsis against) from ever actually shrinking below that, no
  // matter how narrow the row around it is. `max-w-full` caps the row itself at its parent's
  // width, so a long value (e.g. a "You (account name)" chip) truncates against that cap instead
  // of pushing the row wider than the space actually available for it.
  <div className="flex min-w-0 max-w-full items-center gap-1 text-sm text-ink font-medium">
    {displayValue}
    {href && (
      <a href={href} target="_blank" rel="noreferrer" className="shrink-0">
        <Icon name={IconName.ArrowRightUp} size="xs" fill="#9E9E9E" />
      </a>
    )}
  </div>
);

/**
 * The status a transaction row reports, driven by its actual `status`
 * (message-string sniffing broke for types whose completion message wasn't in
 * the known list — e.g. a completed swap's "Swapped").
 *
 * `swapSettlement` overrides it for a swap, because a swap row is Completed the
 * moment the order note is created: the place-order transaction confirmed, the
 * swap did not. The history list already draws that distinction, so without this
 * the same order reads "Pending" in the list and "Confirmed" on its own receipt.
 */
export const transactionStatusOf = ({
  status,
  isCancelled,
  swapSettlement: reportedSettlement
}: {
  status?: ITransactionStatus;
  isCancelled?: boolean;
  swapSettlement?: 'pending' | 'reclaimed';
}): Status => {
  // A user cancellation is recorded as a failure (`cancel.ts`), so it is checked first.
  if (isCancelled) return 'cancelled';
  // A swap that failed never placed its order, so it has no settlement to
  // report; taking the caller's word for one produced a pill labelled "Pending"
  // in failure red, which names two different outcomes at once. Failure is the
  // stronger and more actionable fact, so it wins.
  if (status === ITransactionStatus.Failed) return 'failed';
  // A reclaimed order ended without delivering what was asked for, so it gets
  // the same neutral treatment as a cancellation — the history list already
  // tones it that way.
  if (reportedSettlement !== undefined) return reportedSettlement;
  return status === ITransactionStatus.Completed ? 'confirmed' : 'inProgress';
};

/** The detail header's status: `transactionStatusOf` as a live `md` `StatusBadge`. */
export const StatusPill: FC<{
  status?: ITransactionStatus;
  isCancelled?: boolean;
  swapSettlement?: 'pending' | 'reclaimed';
  testId?: string;
}> = memo(({ status, isCancelled, swapSettlement, testId }) => (
  <StatusBadge
    size="md"
    live
    status={transactionStatusOf({ status, isCancelled, swapSettlement })}
    data-testid={testId}
  />
));
