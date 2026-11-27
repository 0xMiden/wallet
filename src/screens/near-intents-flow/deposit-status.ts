import type { IOneClickPhase, IOneClickTrackingData, ITransaction } from 'lib/miden/db/types';

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

/** True while 1Click has not seen a deposit: the address can still take one (until its deadline). */
export function waitsForDeposit(phase: IOneClickPhase): boolean {
  switch (phase) {
    case 'depositing':
    case 'pending-deposit':
    case 'incomplete-deposit':
      return true;
    case 'known-deposit-tx':
    case 'processing':
    case 'arriving':
    case 'delivered':
    case 'refunded':
    case 'failed':
    case 'expired':
      return false;
  }
}

/**
 * The screen of the deposit page for one tracking row:
 * - `address`: the deposit address screen. `waiting`: nothing arrived. `incomplete`: less than the quoted amount
 *   arrived, and the address takes the rest. `expired`: the address takes no deposit any more.
 * - `processing`: the processing steps, with `step` in progress (0 detected, 1 bridging, 2 arrived).
 * - `failed`: the processing screen with the failure. `refunded`: 1Click sent the deposit back.
 * - `success`: the funds are in the wallet.
 */
export type NearIntentsDepositScreen =
  | { kind: 'address'; state: 'waiting' | 'incomplete' | 'expired' }
  | { kind: 'processing'; step: 0 | 1 | 2 }
  | { kind: 'failed'; reason: 'refunded' | 'failed' }
  | { kind: 'success' };

/**
 * Maps the tracking phase to the screen. A row that still waits for its deposit after the deadline is expired: 1Click
 * refunds a late deposit, so the page must stop showing the address. 1Click knows the deposit transaction
 * (`known-deposit-tx`): the deposit is detected and not yet confirmed. It processes the deposit (`processing`): the
 * bridge is in progress. It delivered on Miden (`arriving`): the note arrives with the next sync. The wallet holds the
 * funds (`delivered`): success.
 */
export function nearIntentsDepositScreenOf(phase: IOneClickPhase, deadlinePassed: boolean): NearIntentsDepositScreen {
  switch (phase) {
    case 'depositing':
    case 'pending-deposit':
      return { kind: 'address', state: deadlinePassed ? 'expired' : 'waiting' };
    case 'incomplete-deposit':
      return { kind: 'address', state: 'incomplete' };
    case 'expired':
      return { kind: 'address', state: 'expired' };
    case 'known-deposit-tx':
      return { kind: 'processing', step: 0 };
    case 'processing':
      return { kind: 'processing', step: 1 };
    case 'arriving':
      return { kind: 'processing', step: 2 };
    case 'delivered':
      return { kind: 'success' };
    case 'refunded':
      return { kind: 'failed', reason: 'refunded' };
    case 'failed':
      return { kind: 'failed', reason: 'failed' };
  }
}
