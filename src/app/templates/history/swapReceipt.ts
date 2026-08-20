import { compareAccountIds } from 'lib/miden/activity/utils';
import type { SwapOrderState, SwapOrderTracking, SwapSettlementNotes } from 'lib/miden/transaction/get';

type SwapSettlementTransaction = SwapSettlementNotes['settledTransactions'][number];

/**
 * Whether a settlement consume delivered the requested token, as a tri-state.
 *
 * `false` is "another token, contributes nothing"; `undefined` is "no faucet
 * recorded, so it may well have been the requested one" — emphatically not the
 * same answer. A blank string counts as unrecorded: `settleSwapOrders` queues
 * its consume rows with `faucetId: ''`, and both the stuck-transaction reaper
 * and the killed-consume path can mark such a row Completed without ever
 * stamping the real faucet. `compareAccountIds('', x)` is false, so reading the
 * field as present made a settlement that DID deliver funds subtract itself from
 * the reported fill.
 *
 * Shared by the aggregate below and by the per-row amount in `SwapDetail`, which
 * answered the same question separately and disagreed about exactly this case.
 */
export const deliveredRequestedToken = (
  consume: Pick<SwapSettlementTransaction, 'faucetId'>,
  requestedFaucetId: string | undefined
): boolean | undefined => {
  if (!consume.faucetId || !requestedFaucetId) return undefined;
  return compareAccountIds(consume.faucetId, requestedFaucetId);
};

/**
 * How much of the requested token this wallet can prove it received from the
 * settlement consumes alone — the only fill evidence left when the order's
 * lineage is unresolvable (a restored wallet, or a poll that gave up).
 *
 * Returns undefined for "cannot tell", which is deliberately distinct from 0n.
 * A partial accounting is not a smaller fill, and understating what arrived is
 * as wrong as overstating it, so one unattributable consume makes the whole
 * total unknown. That happens when a row records no faucet to compare, or no
 * usable amount: `amount` is an aggregate over the row's whole note list, so it
 * stops describing the row once part of that list belongs to an earlier consume.
 */
export const locallySettledRequestedAmount = (
  settledTransactions: SwapSettlementNotes['settledTransactions'],
  requestedFaucetId: string | undefined
): bigint | undefined => {
  if (requestedFaucetId === undefined) return undefined;

  let total = 0n;
  for (const consume of settledTransactions) {
    const delivered = deliveredRequestedToken(consume, requestedFaucetId);
    if (delivered === false) continue;
    if (delivered === undefined || consume.amount === undefined) return undefined;
    total += consume.amount;
  }

  return total;
};

/**
 * How much of the requested token has arrived, as the tightest figure the
 * receipt can stand behind.
 *
 * Both inputs are lower bounds, and either one can be the stale one. The
 * lineage's remainder is read off the order's current tip, so a lineage that has
 * not yet synced the fill still reports the whole request outstanding — the same
 * lag that used to leave the STATUS on "Active" after settlement (#486). Taking
 * the lineage first therefore let it assert a confident ZERO over a payback this
 * wallet had already consumed and was listing three rows further down, and the
 * false zero then stripped the "partially filled" qualifier too, upgrading a
 * partial fill to a full one. The local sum, for its part, counts only consumes
 * this wallet tagged, so it misses anything claimed elsewhere. Neither can
 * exceed the truth, so the larger of the two is the honest answer.
 */
export const filledRequestedAmount = (
  fromLineage: bigint | undefined,
  fromLocalConsumes: bigint | undefined
): bigint | undefined => {
  // A local sum of zero is no evidence at all: it is what an order with no
  // tagged consumes looks like, which is not the same as a fill of zero.
  const local = fromLocalConsumes !== undefined && fromLocalConsumes > 0n ? fromLocalConsumes : undefined;
  if (fromLineage === undefined) return local;
  if (local === undefined) return fromLineage;
  return fromLineage > local ? fromLineage : local;
};

export interface SwapReceiptInputs {
  /** Undefined for rows persisted without one — unknown, not zero. */
  requestedAmount?: bigint;
  requestedFaucetId?: string;
  /** The order's on-chain lineage; null while unresolved or unresolvable. */
  tracking: SwapOrderTracking | null;
  /** This wallet's own settlement consumes; null before the first read. */
  settlement: SwapSettlementNotes | null;
  autoConsume: boolean;
  /** Absent on orders placed before expiry stamping; those never auto-settle. */
  expiresAt: number | null;
}

export interface SwapReceiptView {
  /** How the order stands, reconciling the lineage with what this wallet saw. */
  orderState: SwapOrderState | null;
  /** Undefined = unknown, which is not the same statement as zero. */
  filledAmount?: bigint;
  /** Qualifies every state: an open OR a terminal order can be part-filled. */
  isPartialFill: boolean;
  /** Whether any settlement consume for this order has been observed locally. */
  settlementFound: boolean;
  /** Whether to route the user to the notes only they can claim. */
  offerClaimRoute: boolean;
}

/**
 * Everything the receipt says about a swap order, derived in one place.
 *
 * These answers used to be a chain of a dozen interdependent consts in the
 * component body, and four separate bugs came from two of them disagreeing —
 * a status that outranked its own amount, a fill the pill contradicted, a claim
 * route keyed off how the order ended rather than what was matched. One function
 * with one output makes those disagreements impossible to express, and lets the
 * arithmetic be tested without mounting a page.
 *
 * Deliberately NOT included: the hero pill's settlement state. That reads the
 * persisted `settledAt`/`reclaimedAt` stamp instead, because it is the only
 * signal the history list can also see, and the two must not disagree about one
 * order. The receipt keeps them converged by re-reading the row.
 */
export const deriveSwapReceipt = ({
  requestedAmount,
  requestedFaucetId,
  tracking,
  settlement,
  autoConsume,
  expiresAt
}: SwapReceiptInputs): SwapReceiptView => {
  const settledTransactions = settlement?.settledTransactions ?? [];
  const reclaimedTransactions = settlement?.reclaimedTransactions ?? [];
  // Counts consume ROWS as well as note ids: a consume recorded with no note ids
  // still settled something, and deriving from the ids alone let the receipt
  // render a fill row while reporting no settlement found.
  const settlementFound = Boolean(
    settlement &&
    (settlement.settled.length ||
      settlement.reclaimed.length ||
      settledTransactions.length ||
      reclaimedTransactions.length)
  );

  // What this wallet's own consumes suggest, used only to cover the lag while
  // the lineage still says 'active'. A settle consume outranks a reclaim one,
  // matching `repairSettlementStamp`, for an order carrying both kinds.
  const settledOrderState: SwapOrderState | null = settlementFound
    ? settlement && settlement.settled.length > 0
      ? 'filled'
      : 'reclaimed'
    : null;
  // A terminal lineage is the authority on how the ORDER ended; the local stamp
  // only covers the lag while the lineage still says 'active'. Getting this
  // backwards mislabels the protocol's most common partial-fill path: an expiry
  // batch carrying any payback is tagged 'settle' (see `reconcileSwapOrderNotes`),
  // so a 40%-filled order that expired — lineage 'reclaimed' — read as "Filled".
  const orderState: SwapOrderState | null =
    tracking && tracking.state !== 'active' ? tracking.state : (settledOrderState ?? tracking?.state ?? null);

  const fromLineage =
    requestedAmount !== undefined && tracking
      ? tracking.remainingRequested > requestedAmount
        ? 0n
        : requestedAmount - tracking.remainingRequested
      : undefined;
  const filledAmount = filledRequestedAmount(
    fromLineage,
    locallySettledRequestedAmount(settledTransactions, requestedFaucetId)
  );
  const isPartialFill =
    requestedAmount !== undefined && filledAmount !== undefined && filledAmount > 0n && filledAmount < requestedAmount;

  // `reconcileSwapOrderNotes` declines an order in exactly two situations: the
  // user chose manual consume, or it is still 'active' and not yet expired. Only
  // the second becomes permanent without an `expiresAt` — an order persisted
  // before expiry stamping is never deemed expired, so it waits forever. A
  // terminal order needs no expiry; its paybacks are claimed on the next tick
  // either way. An unresolvable lineage counts as possibly-open, because
  // stranding funds is worse than offering a route to none.
  const mayStillBeOpen = orderState === 'active' || orderState === null;
  const walletWillClaim = autoConsume && !(mayStillBeOpen && expiresAt == null);
  // A reclaim is a statement about the offered TIP being taken back; the payback
  // notes carrying whatever was matched are an independent P2ID chain, and
  // Pending Notes claims per group. So only a reclaim with a known-zero fill
  // leaves nothing to collect.
  const nothingWasMatched = orderState === 'reclaimed' && filledAmount === 0n;

  return {
    orderState,
    filledAmount,
    isPartialFill,
    settlementFound,
    offerClaimRoute: !walletWillClaim && !settlementFound && !nothingWasMatched
  };
};
