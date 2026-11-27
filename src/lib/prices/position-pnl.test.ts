import type { TokenPriceInfo } from './binance';
import { fixedQuote } from './fixed';
import {
  EMPTY_POSITION,
  markIncomplete,
  openPosition,
  recordArrival,
  recordDeparture,
  type TrackedPosition,
  valuePosition
} from './position-pnl';

const NOW = 1_800_000_000_000;
const UNIT = 1_000_000n; // one whole token at 6 decimals
const USD = 1_000_000n;

const quote = (price: number, extra: Partial<TokenPriceInfo> = {}): TokenPriceInfo => ({
  price,
  change24h: 0,
  percentageChange24h: 0,
  kind: 'market',
  observedAt: NOW,
  ...extra
});

const arrive = (position: TrackedPosition, amount: bigint, price: number | undefined): TrackedPosition =>
  recordArrival(position, {
    amount,
    quote: price === undefined ? undefined : quote(price),
    decimals: 6,
    eventAt: NOW
  });

const value = (position: TrackedPosition, held: bigint, price = 2) =>
  valuePosition(position, { held, quote: quote(price), decimals: 6, now: NOW });

const incomplete = { status: 'unknown', reason: 'history-incomplete' };
const noValue = { status: 'unknown', reason: 'no-value' };

describe('since-arrival position profit and loss', () => {
  it('receive: a priced arrival gives a number and a deposit alone gives no profit', () => {
    const position = arrive(EMPTY_POSITION, 10n * UNIT, 2);
    expect(value(position, 10n * UNIT)).toEqual({
      status: 'known',
      valueMicro: 20n * USD,
      costMicro: 20n * USD,
      pnlMicro: 0n,
      pnlBps: 0n,
      averageCostMicro: 2n * USD
    });
    expect(value(position, 10n * UNIT, 3)).toMatchObject({ pnlMicro: 10n * USD, pnlBps: 5_000n });
    expect(value(position, 10n * UNIT, 1.5)).toMatchObject({ pnlMicro: -5n * USD, pnlBps: -2_500n });
  });

  it('receive: later arrivals average the cost', () => {
    const position = arrive(arrive(EMPTY_POSITION, UNIT, 1), 3n * UNIT, 5);
    expect(value(position, 4n * UNIT)).toMatchObject({ costMicro: 16n * USD, averageCostMicro: 4n * USD });
  });

  it('receive: an unpriced arrival makes the position unknown until it is spent to zero', () => {
    const position = arrive(arrive(EMPTY_POSITION, UNIT, 2), UNIT, undefined);
    expect(value(position, 2n * UNIT)).toEqual(incomplete);
    const partly = arrive(recordDeparture(position, UNIT), UNIT, 2);
    expect(value(partly, 2n * UNIT)).toEqual(incomplete);
    const sold = recordDeparture(partly, 2n * UNIT);
    expect(sold).toEqual(EMPTY_POSITION);
    expect(value(arrive(sold, UNIT, 2), UNIT)).toMatchObject({ status: 'known', costMicro: 2n * USD });
  });

  it('receive: only a quote retrieved in the 600 s up to the event prices it', () => {
    const at = (observedAt: number | undefined) =>
      recordArrival(EMPTY_POSITION, { amount: UNIT, quote: quote(2, { observedAt }), decimals: 6, eventAt: NOW })
        .costMicro;
    expect(at(NOW - 600_000)).toBe(2n * USD);
    expect(at(NOW - 600_001)).toBeUndefined();
    expect(at(NOW + 1)).toBeUndefined();
    expect(at(undefined)).toBeUndefined();
    expect(recordArrival(EMPTY_POSITION, { amount: UNIT, quote: quote(2), decimals: 6, eventAt: NaN }).costMicro).toBe(
      undefined
    );
    expect(
      recordArrival(EMPTY_POSITION, { amount: UNIT, quote: fixedQuote('USDCX'), decimals: 6, eventAt: NOW }).costMicro
    ).toBe(USD);
  });

  it('receive: values round half up once, at the event', () => {
    const half = recordArrival(EMPTY_POSITION, { amount: 5n, quote: quote(0.5), decimals: 1, eventAt: NOW });
    expect(half.costMicro).toBe(250_000n);
    expect(arrive(EMPTY_POSITION, 1n, 0.5).costMicro).toBe(1n);
    expect(arrive(EMPTY_POSITION, 1n, 0.499999).costMicro).toBe(0n);
  });

  it('keeps exact integers past the number precision limit', () => {
    const amount = 123_456_789_012_345_678_901_234_567n;
    const position = recordArrival(EMPTY_POSITION, { amount, quote: quote(1), decimals: 18, eventAt: NOW });
    expect(position).toEqual({ quantity: amount, costMicro: 123_456_789_012_346n });
    expect(recordDeparture(position, 1n)).toEqual({ quantity: amount - 1n, costMicro: 123_456_789_012_346n });
  });

  it('send and own-account transfer: cost leaves in proportion and the receiver books no profit', () => {
    const sender = recordDeparture(arrive(EMPTY_POSITION, 10n * UNIT, 2), 4n * UNIT);
    expect(value(sender, 6n * UNIT)).toMatchObject({ costMicro: 12n * USD, pnlMicro: 0n });
    const receiver = arrive(EMPTY_POSITION, 4n * UNIT, 3);
    expect(value(receiver, 4n * UNIT, 3)).toMatchObject({ pnlMicro: 0n });
  });

  it('departure: the removed cost is floored and the remainder stays', () => {
    const position = recordDeparture({ quantity: 3n, costMicro: 10n }, 1n);
    expect(position).toEqual({ quantity: 2n, costMicro: 7n });
    expect(recordDeparture(position, 2n)).toEqual(EMPTY_POSITION);
  });

  it('departure: more than is tracked leaves the position unknown and never negative', () => {
    const position = recordDeparture(arrive(EMPTY_POSITION, UNIT, 2), 2n * UNIT);
    expect(position).toEqual({ quantity: 0n, costMicro: undefined });
    expect(value(position, 0n)).toEqual(incomplete);
    expect(recordDeparture(position, 0n)).toEqual(position);
    expect(value(arrive(position, UNIT, 2), UNIT)).toEqual(incomplete);
  });

  it('network fee: it leaves the fee asset only and never joins the sent token cost', () => {
    const sent = recordDeparture(arrive(EMPTY_POSITION, 10n * UNIT, 2), 5n * UNIT);
    const feeAsset = recordDeparture(arrive(EMPTY_POSITION, 100n * UNIT, 1), UNIT);
    expect(sent.costMicro).toBe(10n * USD);
    expect(feeAsset).toEqual({ quantity: 99n * UNIT, costMicro: 99n * USD });
  });

  it('network fee: missing fee data makes the fee asset unknown', () => {
    const feeAsset = markIncomplete(arrive(EMPTY_POSITION, UNIT, 1));
    expect(feeAsset).toEqual({ quantity: UNIT, costMicro: undefined });
    expect(value(feeAsset, UNIT)).toEqual(incomplete);
  });

  it('fee taken from an incoming note: the arrival is the net credit', () => {
    const position = arrive(EMPTY_POSITION, 9n * UNIT, 2);
    expect(value(position, 9n * UNIT)).toMatchObject({ costMicro: 18n * USD, pnlMicro: 0n });
  });

  it('fee taken from an incoming note: an estimate-only claim is unknown', () => {
    expect(value(markIncomplete(arrive(EMPTY_POSITION, 9n * UNIT, 2)), 9n * UNIT)).toEqual(incomplete);
  });

  it('swap placement: the offered asset leaves at placement', () => {
    const offered = recordDeparture(arrive(EMPTY_POSITION, 10n * UNIT, 2), 10n * UNIT);
    expect(offered).toEqual(EMPTY_POSITION);
  });

  it('swap fill: the payback arrives at its claim-time price', () => {
    const filled = arrive(EMPTY_POSITION, 2n * UNIT, 7);
    expect(value(filled, 2n * UNIT, 7)).toMatchObject({ costMicro: 14n * USD, pnlMicro: 0n });
  });

  it('swap fill: a recovered or unresolved order is unknown', () => {
    expect(value(markIncomplete(arrive(EMPTY_POSITION, UNIT, 7)), UNIT)).toEqual(incomplete);
  });

  it('swap partial fill and reclaim: the reclaimed units cost the reclaim-time price', () => {
    const placed = recordDeparture(arrive(EMPTY_POSITION, 10n * UNIT, 2), 8n * UNIT);
    const reclaimed = arrive(placed, 5n * UNIT, 4);
    expect(value(reclaimed, 7n * UNIT, 4)).toMatchObject({ costMicro: 24n * USD, pnlMicro: 4n * USD });
  });

  it('Earn: the deposit departs and the return arrives at a fresh price', () => {
    const deposited = recordDeparture(arrive(EMPTY_POSITION, 10n * UNIT, 1), 10n * UNIT);
    expect(value(arrive(deposited, 11n * UNIT, 1), 11n * UNIT, 1)).toMatchObject({ pnlMicro: 0n });
  });

  it('bridge out and in: same as a send and a receive', () => {
    const out = recordDeparture(arrive(EMPTY_POSITION, 4n * UNIT, 2), 1n * UNIT);
    expect(arrive(out, UNIT, 6)).toEqual({ quantity: 4n * UNIT, costMicro: 12n * USD });
  });

  it('wrapped variants: two faucets sharing a price symbol keep separate positions', () => {
    const native = arrive(EMPTY_POSITION, UNIT, 2);
    const bridged = arrive(EMPTY_POSITION, UNIT, 5);
    expect(recordDeparture(native, UNIT)).toEqual(EMPTY_POSITION);
    expect(bridged).toEqual({ quantity: UNIT, costMicro: 5n * USD });
  });

  it.each(['basket', 'nominal'] as const)('%s price: neither an arrival nor the current value is a number', kind => {
    const arrival = recordArrival(EMPTY_POSITION, {
      amount: UNIT,
      quote: quote(1, { kind }),
      decimals: 6,
      eventAt: NOW
    });
    expect(arrival).toEqual({ quantity: UNIT, costMicro: undefined });
    expect(
      valuePosition(arrive(EMPTY_POSITION, UNIT, 1), {
        held: UNIT,
        quote: quote(1, { kind }),
        decimals: 6,
        now: NOW
      })
    ).toEqual(noValue);
  });

  it('rebasing or any unexplained balance change: unknown until the events explain the balance', () => {
    const position = arrive(EMPTY_POSITION, UNIT, 2);
    expect(value(position, UNIT + 1n)).toEqual(incomplete);
    expect(value(position, UNIT - 1n)).toEqual(incomplete);
    expect(value(position, UNIT)).toMatchObject({ status: 'known' });
  });

  it('holdings from before tracking, recovered, imported or wiped history: unknown until sold out', () => {
    const opened = openPosition(10n * UNIT);
    expect(opened).toEqual({ quantity: 10n * UNIT, costMicro: undefined });
    const mixed = arrive(opened, UNIT, 2);
    expect(value(mixed, 11n * UNIT)).toEqual(incomplete);
    const partly = recordDeparture(mixed, 10n * UNIT);
    expect(value(partly, UNIT)).toEqual(incomplete);
    const sold = recordDeparture(partly, UNIT);
    expect(value(arrive(sold, UNIT, 2), UNIT)).toMatchObject({ status: 'known', pnlMicro: 0n });
    expect(openPosition(0n)).toEqual(EMPTY_POSITION);
  });

  it.each([undefined, -1, 1.5, 37])('unknown decimals (%s): unpriced arrival and no current value', decimals => {
    expect(
      recordArrival(EMPTY_POSITION, { amount: UNIT, quote: quote(2), decimals, eventAt: NOW }).costMicro
    ).toBeUndefined();
    expect(valuePosition(arrive(EMPTY_POSITION, UNIT, 2), { held: UNIT, quote: quote(2), decimals, now: NOW })).toEqual(
      noValue
    );
  });

  it.each([
    ['missing', undefined],
    ['stale', quote(2, { observedAt: NOW - 600_001 })],
    ['zero', quote(0)],
    ['below one micro-dollar', quote(0.000_000_4)]
  ])('price %s now: no number', (_name, current) => {
    expect(
      valuePosition(arrive(EMPTY_POSITION, UNIT, 2), { held: UNIT, quote: current, decimals: 6, now: NOW })
    ).toEqual(noValue);
  });

  it('percent is unknown without cost and without a position, never zero or infinite', () => {
    const dust = arrive(EMPTY_POSITION, 1n, 0.4);
    expect(value(dust, 1n, 2)).toMatchObject({ costMicro: 0n, pnlMicro: 2n, pnlBps: undefined });
    expect(value(EMPTY_POSITION, 0n)).toEqual({
      status: 'known',
      valueMicro: 0n,
      costMicro: 0n,
      pnlMicro: 0n,
      pnlBps: undefined,
      averageCostMicro: undefined
    });
  });

  it('a zero amount changes nothing, even unpriced', () => {
    const position = arrive(EMPTY_POSITION, UNIT, 2);
    expect(arrive(position, 0n, undefined)).toBe(position);
    expect(recordDeparture(position, 0n)).toBe(position);
  });

  it('refuses negative quantities without putting them in the error', () => {
    const message = 'Position quantities cannot be negative';
    expect(() => arrive(EMPTY_POSITION, -1n, 2)).toThrow(message);
    expect(() => recordDeparture(EMPTY_POSITION, -1n)).toThrow(message);
    expect(() => openPosition(-1n)).toThrow(message);
    expect(() => value(EMPTY_POSITION, -1n)).toThrow(message);
  });
});
