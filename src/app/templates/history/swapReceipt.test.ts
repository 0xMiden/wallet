import type { SwapOrderTracking, SwapSettlementNotes, SwapSettlementTransaction } from 'lib/miden/transaction/get';

import {
  deliveredRequestedToken,
  deriveSwapReceipt,
  filledRequestedAmount,
  locallySettledRequestedAmount,
  SwapReceiptInputs
} from './swapReceipt';

const REQUESTED_FAUCET = '0xfaucetrequested';
const OFFERED_FAUCET = '0xfaucetoffered';

const consume = (over: Partial<SwapSettlementTransaction> = {}): SwapSettlementTransaction => ({
  id: 'local-row-1',
  transactionId: '0xchain1',
  noteIds: ['0xnote1'],
  amount: 400n,
  faucetId: REQUESTED_FAUCET,
  completedAt: 1_700_000_100,
  ...over
});

const settlement = (over: Partial<SwapSettlementNotes> = {}): SwapSettlementNotes => ({
  settled: [],
  reclaimed: [],
  settledTransactions: [],
  reclaimedTransactions: [],
  ...over
});

const tracking = (over: Partial<SwapOrderTracking> = {}): SwapOrderTracking => ({
  orderId: '42',
  state: 'active',
  currentDepth: 0,
  remainingOffered: 1000n,
  remainingRequested: 1000n,
  ...over
});

const derive = (over: Partial<SwapReceiptInputs> = {}) =>
  deriveSwapReceipt({
    requestedAmount: 1000n,
    requestedFaucetId: REQUESTED_FAUCET,
    tracking: null,
    settlement: null,
    autoConsume: true,
    expiresAt: 1_700_000_120,
    ...over
  });

describe('deliveredRequestedToken', () => {
  it('answers "unrecorded", not "another token", for a half-written row', () => {
    // `settleSwapOrders` queues its consume rows with faucetId: '', and the
    // stuck-transaction reaper can complete one without ever stamping the real
    // faucet. Reading the blank as a present value made a settlement that DID
    // deliver funds subtract itself from the reported fill.
    expect(deliveredRequestedToken({ faucetId: '' }, REQUESTED_FAUCET)).toBeUndefined();
    expect(deliveredRequestedToken({ faucetId: undefined }, REQUESTED_FAUCET)).toBeUndefined();
    expect(deliveredRequestedToken({ faucetId: REQUESTED_FAUCET }, undefined)).toBeUndefined();
  });

  it('separates the two sides of the swap once both faucets are known', () => {
    expect(deliveredRequestedToken({ faucetId: REQUESTED_FAUCET }, REQUESTED_FAUCET)).toBe(true);
    expect(deliveredRequestedToken({ faucetId: OFFERED_FAUCET }, REQUESTED_FAUCET)).toBe(false);
  });
});

describe('locallySettledRequestedAmount', () => {
  it('sums only the consumes that delivered the requested token', () => {
    const total = locallySettledRequestedAmount(
      [consume({ amount: 300n }), consume({ amount: 900n, faucetId: OFFERED_FAUCET }), consume({ amount: 100n })],
      REQUESTED_FAUCET
    );

    expect(total).toBe(400n);
  });

  it('reports unknown, not a smaller sum, when one row cannot be attributed', () => {
    // Understating what arrived is as wrong as overstating it, so a single
    // unattributable row makes the whole total unknown rather than dropping it.
    expect(
      locallySettledRequestedAmount([consume({ amount: 300n }), consume({ faucetId: '' })], REQUESTED_FAUCET)
    ).toBe(undefined);
    // `amount` is an aggregate over the row's whole note list, so it stops
    // describing the row once part of that list belongs to an earlier consume.
    expect(
      locallySettledRequestedAmount([consume({ amount: 300n }), consume({ amount: undefined })], REQUESTED_FAUCET)
    ).toBeUndefined();
  });

  it('cannot attribute anything without a requested faucet to compare', () => {
    expect(locallySettledRequestedAmount([consume()], undefined)).toBeUndefined();
  });

  it('distinguishes no consumes at all from a fill of zero', () => {
    // 0n here means "nothing tagged", which callers must not read as evidence.
    expect(locallySettledRequestedAmount([], REQUESTED_FAUCET)).toBe(0n);
  });
});

describe('filledRequestedAmount', () => {
  it('keeps the larger of two lower bounds', () => {
    // Both inputs are lower bounds and either can be the stale one: the lineage
    // reads the order's tip (so it lags a fresh fill) and the local sum counts
    // only consumes this wallet tagged (so it misses fills claimed elsewhere).
    expect(filledRequestedAmount(600n, 400n, 1000n)).toBe(600n);
    expect(filledRequestedAmount(400n, 600n, 1000n)).toBe(600n);
  });

  it('does not let a lagging lineage assert zero over money already counted', () => {
    expect(filledRequestedAmount(0n, 400n, 1000n)).toBe(400n);
  });

  it('treats an empty local sum as no evidence rather than a zero fill', () => {
    expect(filledRequestedAmount(undefined, 0n, 1000n)).toBeUndefined();
    expect(filledRequestedAmount(0n, 0n, 1000n)).toBe(0n);
  });

  it('falls back to whichever side answered', () => {
    expect(filledRequestedAmount(undefined, 400n, 1000n)).toBe(400n);
    expect(filledRequestedAmount(600n, undefined, 1000n)).toBe(600n);
    expect(filledRequestedAmount(undefined, undefined, 1000n)).toBeUndefined();
  });

  it('discards a local sum that exceeds the whole request', () => {
    // Over the request is proof the sum swept in notes from outside this order,
    // so it is not a lower bound on anything. The lineage figure stands alone.
    expect(filledRequestedAmount(200n, 1800n, 1000n)).toBe(200n);
    // Clamping instead would report the full request as delivered here.
    expect(filledRequestedAmount(undefined, 1800n, 1000n)).toBeUndefined();
    // Exactly the request is a legitimate full fill.
    expect(filledRequestedAmount(undefined, 1000n, 1000n)).toBe(1000n);
    // With no request to compare against there is nothing to disprove.
    expect(filledRequestedAmount(undefined, 1800n, undefined)).toBe(1800n);
  });
});

describe('deriveSwapReceipt', () => {
  it('says nothing it cannot support when neither signal has answered', () => {
    expect(derive()).toEqual({
      orderState: null,
      filledAmount: undefined,
      isPartialFill: false,
      settlementFound: false,
      offerClaimRoute: false
    });
  });

  it('lets a terminal lineage outrank a settle-tagged consume', () => {
    // An expiry batch carrying any payback is tagged 'settle', so the local
    // stamp alone announced a 40%-filled expired order as "Filled".
    const view = derive({
      tracking: tracking({ state: 'reclaimed', remainingRequested: 600n }),
      settlement: settlement({ settled: ['0xnote1'], settledTransactions: [consume({ amount: 400n })] })
    });

    expect(view.orderState).toBe('reclaimed');
    expect(view.filledAmount).toBe(400n);
    expect(view.isPartialFill).toBe(true);
  });

  it('covers the lineage lag with the local stamp while the order reads active', () => {
    const view = derive({
      tracking: tracking({ remainingRequested: 1000n }),
      settlement: settlement({ settled: ['0xnote1'], settledTransactions: [consume({ amount: 1000n })] })
    });

    expect(view.orderState).toBe('filled');
    expect(view.filledAmount).toBe(1000n);
    expect(view.isPartialFill).toBe(false);
  });

  it('prefers a settle consume over a reclaim one for an order carrying both', () => {
    // Matches `repairSettlementStamp`: paybacks settled on one tick, the tip
    // reclaimed on another.
    const view = derive({
      settlement: settlement({
        settled: ['0xnote1'],
        reclaimed: ['0xnote2'],
        settledTransactions: [consume()],
        reclaimedTransactions: [consume({ faucetId: OFFERED_FAUCET })]
      })
    });

    expect(view.orderState).toBe('filled');
  });

  it('counts a consume row with no note ids as the settlement it is', () => {
    // The two are built together, but a consume recorded with no note ids yields
    // a row and no id — and a receipt that renders a fill row while reporting no
    // settlement found, which also defeated the bound on the lineage poll.
    const view = derive({ settlement: settlement({ settledTransactions: [consume({ noteIds: [] })] }) });

    expect(view.settlementFound).toBe(true);
    // A SETTLE row, so a fill. Reading the ids alone called this a reclaim, so
    // the receipt reported 400 arriving and the remainder going back at once.
    expect(view.orderState).toBe('filled');
    expect(view.filledAmount).toBe(400n);
  });

  it('reads a reclaim row as a reclaim', () => {
    const view = derive({
      settlement: settlement({ reclaimed: ['0xnote1'], reclaimedTransactions: [consume()] })
    });

    expect(view.orderState).toBe('reclaimed');
  });

  it('will not report more arriving than was ever requested', () => {
    // A "Claim All" tap can batch an unclassified payback in with unrelated
    // notes of the same token; settlement then tags that whole row, and the
    // row's aggregate amount covers all of them. Reported as-is, the receipt
    // announced "1800 of 1000" at 100%, labelled Filled, on an open order.
    const view = derive({
      tracking: tracking({ remainingRequested: 800n }),
      settlement: settlement({ settled: ['0xnote1'], settledTransactions: [consume({ amount: 1800n })] })
    });

    // The authoritative lineage figure stands, and the partial qualifier keeps
    // the label honest — the local settle stamp still covers the lineage's lag,
    // and 'active' and 'filled' both read "partially filled" once it does.
    expect(view.filledAmount).toBe(200n);
    expect(view.isPartialFill).toBe(true);
  });

  it('reports nothing filled, not a negative fill, when more is owed than was asked', () => {
    const view = derive({ tracking: tracking({ remainingRequested: 1500n }) });

    expect(view.filledAmount).toBe(0n);
    expect(view.isPartialFill).toBe(false);
  });

  it('will not call an unknown fill partial', () => {
    const view = derive({ requestedAmount: undefined, tracking: tracking({ remainingRequested: 600n }) });

    expect(view.filledAmount).toBeUndefined();
    expect(view.isPartialFill).toBe(false);
  });

  describe('claim route', () => {
    it('is withheld while the wallet will collect the notes itself', () => {
      expect(derive({ tracking: tracking() }).offerClaimRoute).toBe(false);
    });

    it('is offered when the user chose to claim manually', () => {
      expect(derive({ autoConsume: false, tracking: tracking() }).offerClaimRoute).toBe(true);
    });

    it('is offered for an order the wallet will never expire on its own', () => {
      // `reconcileSwapOrderNotes` declines an order that is still active and not
      // yet expired; without an `expiresAt` it is never deemed expired, so those
      // notes wait forever unless the user is pointed at them.
      expect(derive({ expiresAt: null, tracking: tracking() }).offerClaimRoute).toBe(true);
      // A terminal order needs no expiry — its paybacks are claimed either way.
      expect(derive({ expiresAt: null, tracking: tracking({ state: 'filled' }) }).offerClaimRoute).toBe(false);
    });

    it('survives the order reaching filled with its paybacks unconsumed', () => {
      expect(
        derive({ autoConsume: false, tracking: tracking({ state: 'filled', remainingRequested: 0n }) }).offerClaimRoute
      ).toBe(true);
    });

    it('is withdrawn once a settlement has actually been observed', () => {
      const view = derive({
        autoConsume: false,
        settlement: settlement({ settled: ['0xnote1'], settledTransactions: [consume()] })
      });

      expect(view.offerClaimRoute).toBe(false);
    });

    it('survives a reclaim that still matched something', () => {
      // A reclaim is a statement about the offered TIP; the paybacks carrying
      // whatever was matched are an independent P2ID chain, and Pending Notes
      // claims per group — so the tip can come back with paybacks left sitting.
      const view = derive({
        autoConsume: false,
        tracking: tracking({ state: 'reclaimed', remainingRequested: 600n })
      });

      expect(view.filledAmount).toBe(400n);
      expect(view.offerClaimRoute).toBe(true);
    });

    it('is withheld from a reclaim that is known to have matched nothing', () => {
      const view = derive({
        autoConsume: false,
        tracking: tracking({ state: 'reclaimed', remainingRequested: 1000n })
      });

      expect(view.filledAmount).toBe(0n);
      expect(view.offerClaimRoute).toBe(false);
    });

    it('is offered for an unresolvable lineage, because stranding funds is worse', () => {
      expect(derive({ autoConsume: false, tracking: null }).offerClaimRoute).toBe(true);
    });
  });
});
