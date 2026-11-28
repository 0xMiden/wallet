/**
 * The terms check of a relay deposit when its funds arrive. Epoch's and Circle's fees can move between the review and
 * the arrival, so the screen quotes again for the amount that is there. The bridge starts only when the user receives at
 * least the reviewed amount less `RELAY_ARRIVAL_TOLERANCE_BPS`; else nothing is signed and the pending deposit stays.
 */
import { parseUnits } from 'viem';

import type { PendingRelayDeposit } from 'lib/evm-relay/pending-deposit';

/**
 * How much less than the reviewed receive amount the arrival quote can give, in basis points of that amount (0.5 %).
 * The Fast review elsewhere holds its reviewed minimum exactly (`reviewedEpochMinimum`), because it signs the quote that
 * it showed. Here the quote is taken again minutes or hours after the review, so an exact floor would refuse most
 * deposits on a small move of the network fee. Half of the 1 % that the NEAR Intents route of this flow allows
 * (`NEAR_SLIPPAGE_BPS`) keeps the loss small and below what that route of the same flow accepts.
 */
export const RELAY_ARRIVAL_TOLERANCE_BPS = 50n;
const BPS = 10_000n;

/** True when `receiveUnits` is at least `reviewedUnits` less the tolerance. */
export function arrivalTermsHold(receiveUnits: bigint, reviewedUnits: bigint): boolean {
  return receiveUnits * BPS >= reviewedUnits * (BPS - RELAY_ARRIVAL_TOLERANCE_BPS);
}

/**
 * What a pending deposit receives as it was reviewed (`outputAmount`), in base units at `decimals`, or null when the
 * record has no reviewed amount or the amount does not parse at those decimals.
 */
export function reviewedReceiveUnits(
  deposit: Pick<PendingRelayDeposit, 'outputAmount'> | null,
  decimals: number
): bigint | null {
  const text = deposit?.outputAmount;
  if (text === undefined) return null;
  try {
    return parseUnits(text, decimals);
  } catch {
    return null;
  }
}
