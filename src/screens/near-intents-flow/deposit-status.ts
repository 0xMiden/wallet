import type { IOneClickTrackingData, ITransaction } from 'lib/miden/db/types';

/** What the deposit page tells the user about one tracking row. */
export type NearIntentsDepositStatus =
  | 'waiting'
  | 'incomplete'
  | 'processing'
  | 'arriving'
  | 'received'
  | 'refunded'
  | 'failed'
  | 'expired';

export type NearIntentsDepositTone = 'warning' | 'positive' | 'negative' | 'inactive';

/** The tracking data of a NEAR Intents row, or undefined for a row that has none (or no deposit address). */
export function nearIntentsTrackingOf(row: ITransaction | undefined): IOneClickTrackingData | undefined {
  const inputs: { oneClick?: IOneClickTrackingData } | undefined = row?.extraInputs;
  const tracking = inputs?.oneClick;
  if (!tracking || !tracking.depositAddress) return undefined;
  return tracking;
}

/**
 * The last time at which a deposit can arrive: the funding deadline that the wallet checked when
 * it saved the row, else the deadline of the quote, else the deadline of the request. NaN when no
 * deadline is a valid date.
 */
export function depositDeadlineMs(tracking: IOneClickTrackingData): number {
  const deadline = tracking.fundingDeadline ?? tracking.quote.quote.deadline ?? tracking.request.deadline;
  return Date.parse(deadline);
}

/**
 * Maps the tracking phase to the status on the page. A row that still waits for its deposit after
 * the deadline is expired: 1Click refunds a late deposit, so the page must stop showing the address.
 */
export function nearIntentsDepositStatus(
  phase: IOneClickTrackingData['phase'],
  deadlinePassed: boolean
): NearIntentsDepositStatus {
  switch (phase) {
    case 'depositing':
    case 'pending-deposit':
      return deadlinePassed ? 'expired' : 'waiting';
    case 'incomplete-deposit':
      return 'incomplete';
    case 'known-deposit-tx':
    case 'processing':
      return 'processing';
    case 'arriving':
      return 'arriving';
    case 'delivered':
      return 'received';
    case 'refunded':
      return 'refunded';
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
  }
}

/** True while the user can still send to the deposit address, so the page shows the code and the address. */
export function acceptsDeposit(status: NearIntentsDepositStatus): boolean {
  switch (status) {
    case 'waiting':
    case 'incomplete':
      return true;
    case 'processing':
    case 'arriving':
    case 'received':
    case 'refunded':
    case 'failed':
    case 'expired':
      return false;
  }
}

/** The i18n key and the pill tone of each status. */
/**
 * `hintKey` is the line under the pill for a status after the deposit: it tells the user what occurs next. A
 * status with no hint shows the general caption about the deposit.
 */
export const DEPOSIT_STATUS_DISPLAY: Record<
  NearIntentsDepositStatus,
  { labelKey: string; tone: NearIntentsDepositTone; hintKey?: string }
> = {
  waiting: { labelKey: 'nearIntentsStatusWaiting', tone: 'warning' },
  incomplete: { labelKey: 'nearIntentsStatusIncomplete', tone: 'warning' },
  processing: { labelKey: 'nearIntentsStatusProcessing', tone: 'warning', hintKey: 'nearIntentsHintProcessing' },
  arriving: { labelKey: 'nearIntentsStatusArriving', tone: 'positive', hintKey: 'nearIntentsHintArriving' },
  received: { labelKey: 'nearIntentsStatusReceived', tone: 'positive', hintKey: 'nearIntentsHintReceived' },
  refunded: { labelKey: 'nearIntentsStatusRefunded', tone: 'inactive' },
  failed: { labelKey: 'nearIntentsStatusFailed', tone: 'negative' },
  expired: { labelKey: 'nearIntentsStatusExpired', tone: 'negative' }
};
