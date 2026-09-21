import React from 'react';

import { useTranslation } from 'react-i18next';

import { Pill, PillSize, PillTone } from './Pill';

/**
 * Every status the app shows for a transaction or an operation. Closed on purpose: a new state
 * is added here, with its label and tone, rather than hand-drawn at the call site.
 */
export type Status =
  // Transactions
  | 'pending'
  | 'inProgress'
  | 'confirmed'
  | 'failed'
  | 'cancelled'
  | 'reclaimed'
  // A pending transfer the wallet has claimed
  | 'claimed'
  // A Smart Withdraw's phases
  | 'redeeming'
  | 'delivering'
  | 'received'
  // A swap order
  | 'open'
  | 'filled'
  | 'partiallyFilled'
  | 'partiallyFilledReclaimed'
  // Its own word, not `reclaimed`: several locales translate the order's state differently
  | 'orderReclaimed'
  | 'loading'
  | 'unavailable'
  // The guardian's connection
  | 'online'
  | 'offline'
  | 'needsAttention'
  | 'checking'
  | 'notConnected';

/** What a status says, independent of its words: good, in flight, bad, or neither. */
export type StatusTone = 'positive' | 'pending' | 'negative' | 'neutral';

/** `sm`: the 20px badge in dense rows. `md`: the 24px pill in a detail header. */
export type StatusBadgeSize = 'sm' | 'md';

export interface StatusBadgeProps {
  status: Status;
  size?: StatusBadgeSize;
  /**
   * The status changes while the user is looking at it (a detail page, the guardian screen):
   * renders `role="status"`, a polite live region. Leave it off in lists, where a live region
   * per row would talk over the reader.
   */
  live?: boolean;
  /** Layout only (margins, alignment). */
  className?: string;
  'data-testid'?: string;
}

/** The i18n key and tone of each status. The label is the badge's accessible name. */
export const STATUS_BADGE: Record<Status, { labelKey: string; tone: StatusTone }> = {
  pending: { labelKey: 'pending', tone: 'pending' },
  inProgress: { labelKey: 'inProgress', tone: 'pending' },
  confirmed: { labelKey: 'confirmed', tone: 'positive' },
  failed: { labelKey: 'failed', tone: 'negative' },
  cancelled: { labelKey: 'cancelled', tone: 'neutral' },
  reclaimed: { labelKey: 'reclaimed', tone: 'neutral' },
  claimed: { labelKey: 'activityTransferClaimed', tone: 'positive' },
  redeeming: { labelKey: 'earnWithdrawStatusRedeeming', tone: 'pending' },
  delivering: { labelKey: 'earnWithdrawStatusDelivering', tone: 'pending' },
  received: { labelKey: 'received', tone: 'positive' },
  open: { labelKey: 'orderStatusActive', tone: 'pending' },
  filled: { labelKey: 'orderStatusFilled', tone: 'positive' },
  // A partial fill is still an order in progress, or one that delivered only part of the request.
  partiallyFilled: { labelKey: 'orderStatusPartiallyFilled', tone: 'pending' },
  partiallyFilledReclaimed: { labelKey: 'orderStatusPartiallyFilledReclaimed', tone: 'neutral' },
  orderReclaimed: { labelKey: 'orderStatusReclaimed', tone: 'neutral' },
  loading: { labelKey: 'loading', tone: 'neutral' },
  unavailable: { labelKey: 'trackingUnavailable', tone: 'neutral' },
  online: { labelKey: 'online', tone: 'positive' },
  offline: { labelKey: 'guardianOfflineLabel', tone: 'negative' },
  needsAttention: { labelKey: 'guardianNeedsAttentionLabel', tone: 'negative' },
  checking: { labelKey: 'guardianCheckingLabel', tone: 'pending' },
  notConnected: { labelKey: 'guardianNotConnectedLabel', tone: 'neutral' }
};

const PILL_TONE: Record<StatusTone, PillTone> = {
  positive: 'positive',
  pending: 'warning',
  negative: 'negative',
  neutral: 'inactive'
};

const PILL_SIZE: Record<StatusBadgeSize, PillSize> = {
  sm: 'xs',
  md: 'sm'
};

/**
 * A transaction's or an operation's status: the word alone, no dot, on the status's own opaque
 * tint from the activity icon palette (sage, sand, clay, or the pressed fill), so it reads at
 * 4.5:1 or better on `page` and on a `fill` card in both themes. Built on `Pill`: `sm` is its
 * 20px `xs` size, `md` its 24px `sm` size.
 */
export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  size = 'sm',
  live,
  className,
  'data-testid': dataTestId
}) => {
  const { t } = useTranslation();
  // Restored rows render the lifecycle strings a backup recorded, by design (see repo.ts), and a
  // backup written by a newer version can carry a status this build does not know. The badge sits
  // inside list maps, so an unknown key destructuring undefined would take the whole page down
  // through its ErrorBoundary; it reads as "unavailable" instead. Every path into the table goes
  // through this one line, so this is the only guard needed - the union still types every call site,
  // so a typo in new code stays a compile error.
  const { labelKey, tone } = STATUS_BADGE[status] ?? STATUS_BADGE.unavailable;
  return (
    <Pill
      size={PILL_SIZE[size]}
      tone={PILL_TONE[tone]}
      role={live ? 'status' : undefined}
      className={className}
      data-testid={dataTestId}
    >
      {t(labelKey)}
    </Pill>
  );
};
