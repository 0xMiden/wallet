import type { IOneClickPhase, IOneClickTrackingData } from 'lib/miden/db/types';

import { effectiveOneClickFundingDeadline } from './deadline';

/** A deposit row stays open for this time after its funding deadline before it can expire. */
export const NEAR_INTENTS_DEPOSIT_EXPIRY_GRACE_MS = 10 * 60_000;

const TERMINAL_PHASES: ReadonlySet<IOneClickPhase> = new Set(['delivered', 'refunded', 'failed', 'expired']);

export const isOneClickTerminalPhase = (phase: IOneClickPhase): boolean => TERMINAL_PHASES.has(phase);

function fundingDeadlineMs(tracking: IOneClickTrackingData): number | undefined {
  if (tracking.fundingDeadline !== undefined) {
    const stored = Date.parse(tracking.fundingDeadline);
    return Number.isFinite(stored) ? stored : undefined;
  }
  try {
    return Date.parse(effectiveOneClickFundingDeadline(tracking.request.deadline, tracking.quote.quote.deadline));
  } catch {
    return undefined;
  }
}

/**
 * Tell if a deposit into Miden expired: 1Click still waits for the deposit (`PENDING_DEPOSIT`, or no status read
 * yet) and the funding deadline plus the grace time is in the past. A row with a known origin transaction, or with
 * any other provider status, never expires this way.
 */
export function isNearIntentsDepositExpired(tracking: IOneClickTrackingData, now = Date.now()): boolean {
  if (
    tracking.direction !== 'evm-to-miden' ||
    tracking.originTransactionHash ||
    isOneClickTerminalPhase(tracking.phase)
  )
    return false;
  if (tracking.providerStatus !== undefined && tracking.providerStatus !== 'PENDING_DEPOSIT') return false;
  const deadline = fundingDeadlineMs(tracking);
  return deadline !== undefined && now > deadline + NEAR_INTENTS_DEPOSIT_EXPIRY_GRACE_MS;
}

/**
 * Tell if the history shows a deposit into Miden as expired: the reconciler recorded the expiry, or the row meets
 * the expiry rule now and the next reconciliation round did not record it yet. The second case keeps an unpaid
 * deposit from reading Pending until the next status read lands.
 */
export function isNearIntentsDepositShownExpired(tracking: IOneClickTrackingData, now = Date.now()): boolean {
  if (tracking.direction !== 'evm-to-miden') return false;
  return tracking.phase === 'expired' || isNearIntentsDepositExpired(tracking, now);
}
