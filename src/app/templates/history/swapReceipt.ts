import { compareAccountIds } from 'lib/miden/activity/utils';
import { swapOrderExpired } from 'lib/miden/swap/expiry';
import { swapFillReached } from 'lib/miden/swap/fill-target';
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
 * exceed the truth, so the larger of the two is the honest answer — unless the
 * local sum exceeds the whole request, which no honest fill can do. See below.
 */
export const filledRequestedAmount = (
  fromLineage: bigint | undefined,
  fromLocalConsumes: bigint | undefined,
  requestedAmount: bigint | undefined
): bigint | undefined => {
  // A local sum of zero is no evidence at all: it is what an order with no
  // tagged consumes looks like, which is not the same as a fill of zero.
  const positive = fromLocalConsumes !== undefined && fromLocalConsumes > 0n ? fromLocalConsumes : undefined;
  // The request is a hard ceiling on what an order can deliver, so a local sum
  // above it is proof that the sum counts notes from outside this order: a
  // consume's `amount` aggregates every asset sharing the row's faucet, and a
  // "Claim All" tap can batch an unclassified payback in with unrelated notes of
  // the same token, after which settlement tags that whole row. Such a sum is
  // not a lower bound at all, so it is discarded rather than clamped — clamping
  // would report the full request as delivered on an order the lineage still
  // says is mostly outstanding.
  const local =
    requestedAmount !== undefined && positive !== undefined && positive > requestedAmount ? undefined : positive;
  if (fromLineage === undefined) return local;
  if (local === undefined) return fromLineage;
  return fromLineage > local ? fromLineage : local;
};

/**
 * A fill that arrived in part and short of the order's target (`swapFillReached`). An order that
 * received `requested × (1 − slippage)` is filled, whatever remainder is still out or came back.
 * The receipt and the status line under its progress bar both read this, so they cannot disagree.
 */
export const isPartialSwapFill = (
  requestedAmount: bigint | undefined,
  filledAmount: bigint | undefined,
  slippageBps?: number
): boolean =>
  requestedAmount !== undefined &&
  filledAmount !== undefined &&
  filledAmount > 0n &&
  filledAmount < requestedAmount &&
  !swapFillReached(requestedAmount, filledAmount, slippageBps);

export interface SwapReceiptInputs {
  /** Original PSWAP output; reclaiming that same note proves no fill advanced it. */
  originalOutputNoteIds?: string[];
  /** Undefined for rows persisted without one — unknown, not zero. */
  requestedAmount?: bigint;
  requestedFaucetId?: string;
  /** The order's on-chain lineage; null while unresolved or unresolvable. */
  tracking: SwapOrderTracking | null;
  /** This wallet's own settlement consumes; null before the first read. */
  settlement: SwapSettlementNotes | null;
  autoConsume: boolean;
  /**
   * An open Guardian-recovered order. Recovery writes `autoConsume` false on it, and the one thing the wallet does for
   * it is return it on Cancel, from the order note its lineage (the node's answer) is read from (#1487).
   */
  recovered?: boolean;
  /** The slippage the ask was built with; absent means only a full fill counts as filled. */
  slippageBps?: number;
  /** Absent on orders placed before expiry stamping; those never auto-settle. */
  expiresAt: number | null;
  /** Injectable so the expiry boundary can be tested without a clock. */
  nowSeconds?: number;
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
  /**
   * Whether "Cancel swap" can succeed: the order is still open, the wallet is
   * the one that will reclaim it, and its expiry has not already lapsed. See
   * `cancelSwapOrder` for why those three are exactly the conditions under which
   * bringing the expiry forward reclaims anything.
   */
  offerCancel: boolean;
  /**
   * The expiry has passed and the tip has not come back yet - so a reclaim is
   * owed, whether the user asked for it or the order simply timed out. This is
   * the state a successful Cancel lands in, which is why the two are derived
   * together. The receipt's status and reclaim notice do not read it: they
   * follow the settlement stamp, as the Activity list does.
   */
  reclaimPending: boolean;
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
  originalOutputNoteIds,
  requestedAmount,
  requestedFaucetId,
  tracking,
  settlement,
  autoConsume,
  recovered = false,
  slippageBps,
  expiresAt,
  nowSeconds = Math.floor(Date.now() / 1000)
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
  // matching `repairSettlementStamp`, for an order carrying both kinds. Reads
  // rows as well as ids for the same reason as above: keying this on ids alone
  // called a settle-tagged consume that recorded none a RECLAIM, so the receipt
  // reported funds arriving and the remainder going back in the same breath.
  const settledOrderState: SwapOrderState | null = settlementFound
    ? settlement && (settlement.settled.length > 0 || settledTransactions.length > 0)
      ? 'filled'
      : 'reclaimed'
    : null;
  // A terminal lineage is the authority on how the ORDER ended; the local stamp
  // only covers the lag while the lineage still says 'active'. Getting this
  // backwards mislabels the protocol's most common partial-fill path: an expiry
  // batch carrying any payback is tagged 'settle' (see `reconcileSwapOrderNotes`),
  // so a 40%-filled order that expired — lineage 'reclaimed' — read as "Filled".
  const reportedState: SwapOrderState | null =
    tracking && tracking.state !== 'active' ? tracking.state : (settledOrderState ?? tracking?.state ?? null);

  // A reclaimed tip can have both remaining amounts cleared by the SDK. That
  // means the offer is gone, not that the counter-asset arrived. Depth zero is
  // positive evidence of no fills; a cleared partial lineage needs payback
  // evidence instead of manufacturing 100% from the terminal zero.
  const fromLineage =
    requestedAmount !== undefined && tracking
      ? tracking.state === 'reclaimed' && tracking.remainingRequested === 0n
        ? tracking.currentDepth === 0
          ? 0n
          : undefined
        : tracking.remainingRequested > requestedAmount
          ? 0n
          : requestedAmount - tracking.remainingRequested
      : undefined;
  // A full or partial fill consumes the original PSWAP and creates a different
  // remainder. A completed reclaim of the original output is durable zero-fill
  // evidence even after the SDK's tracking cache is unavailable on restart.
  const reclaimedOriginal = originalOutputNoteIds?.some(noteId => settlement?.reclaimed.includes(noteId)) === true;
  const filledAmount = reclaimedOriginal
    ? 0n
    : filledRequestedAmount(
        fromLineage,
        locallySettledRequestedAmount(settledTransactions, requestedFaucetId),
        requestedAmount
      );
  // An order that received `requested × (1 − slippage)` reads as filled, whether its remainder is
  // still on the tip or settlement has reclaimed it at expiry. Only the label follows the target.
  const fillReached =
    requestedAmount !== undefined &&
    filledAmount !== undefined &&
    swapFillReached(requestedAmount, filledAmount, slippageBps);
  const orderState: SwapOrderState | null = fillReached ? 'filled' : reportedState;
  const isPartialFill = isPartialSwapFill(requestedAmount, filledAmount, slippageBps);

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

  // Only a lineage that still says 'active' has a tip left to take back, and only
  // an auto-consuming order has anything that will act on the stamp - the manual
  // one is skipped by `reconcileSwapOrderNotes` before expiry is even read, and
  // already gets the claim route above. `null` is deliberately not offered: an
  // unresolvable lineage cannot tell an open order from one that settled while
  // the wallet was away, and a Cancel on the latter reclaims nothing while
  // reading as though it undid something.
  //
  // An order carrying NO expiry (persisted before the stamp existed) is the one
  // most in need of this, not the least: nothing will ever deem it expired, so it
  // waits forever, and the stamp this writes is the only thing that can end it.
  const cancellableState = orderState === 'active' && (autoConsume || recovered);
  const expiryLapsed = swapOrderExpired(expiresAt, nowSeconds);

  return {
    orderState,
    filledAmount,
    isPartialFill,
    settlementFound,
    offerClaimRoute: !walletWillClaim && !settlementFound && !nothingWasMatched,
    offerCancel: cancellableState && !expiryLapsed,
    reclaimPending: cancellableState && expiryLapsed
  };
};
