import type { DepositRouteOption } from 'screens/deposit-flow/DepositRouteSheet';

import {
  arrivalKeyOf,
  mergeRouteOptions,
  NEAR_ROUTE_ID,
  rankRouteOptions,
  relayRouteNameKey,
  relayRouteOfId
} from './deposit-routes';

const ARC = 5042002;

jest.mock('lib/usdcx/constant', () => ({
  usdcxArrivalKey: (chainId: number) => (chainId === 5042002 ? 'usdcxArrivalArc' : 'usdcxArrival')
}));

function row(id: string, overrides: Partial<DepositRouteOption> = {}): DepositRouteOption {
  return { id, name: id, arrivesIn: '', best: false, fastest: false, selected: false, ...overrides };
}

describe('deposit routes', () => {
  it('names the arrival time and the name of each relay route', () => {
    expect(arrivalKeyOf('agglayer', 1)).toBe('depositFlowArrivesAgglayer');
    expect(arrivalKeyOf('epoch', 1)).toBe('depositFlowArrivesEpoch');
    expect(arrivalKeyOf('usdcx', 1)).toBe('usdcxArrival');
    expect(arrivalKeyOf('usdcx', ARC)).toBe('usdcxArrivalArc');
    expect(relayRouteNameKey('agglayer')).toBe('depositFlowRouteAgglayer');
    expect(relayRouteNameKey('epoch')).toBe('depositFlowRouteEpoch');
    expect(relayRouteNameKey('usdcx')).toBe('depositFlowRouteCircle');
  });

  it('reads a relay route from a sheet id, and nothing from another id', () => {
    expect(relayRouteOfId('epoch')).toBe('epoch');
    expect(relayRouteOfId(NEAR_ROUTE_ID)).toBeUndefined();
  });

  it('returns the relay rows as they are when no other route serves the pair', () => {
    const rows = [row('agglayer', { best: true })];
    expect(mergeRouteOptions(rows, undefined, 1)).toBe(rows);
    expect(mergeRouteOptions(rows, [], 1)).toBe(rows);
  });

  it('puts NEAR Intents after the relay routes when it receives less, with how much less', () => {
    const merged = mergeRouteOptions(
      [row('agglayer', { received: { amount: '10' } }), row('epoch', { received: { amount: '10' } })],
      [row(NEAR_ROUTE_ID, { received: { amount: 9_800_000n, decimals: 6 } })],
      1
    );
    expect(merged.map(option => option.id)).toEqual(['agglayer', 'epoch', NEAR_ROUTE_ID]);
    expect(merged.map(option => option.best)).toEqual([true, false, false]);
    // Epoch states 2 minutes, NEAR Intents 2 to 3, Agglayer 30.
    expect(merged.map(option => option.fastest)).toEqual([false, true, false]);
    expect(merged[1]?.less).toBeUndefined();
    expect(merged[2]?.less).toEqual({ amount: '0.2' });
  });

  it('makes NEAR Intents the most received route when it receives more', () => {
    const merged = rankRouteOptions(
      [row('agglayer', { received: { amount: '10' } }), row(NEAR_ROUTE_ID, { received: { amount: '10.5' } })],
      1
    );
    expect(merged.map(option => [option.id, option.best, option.fastest])).toEqual([
      [NEAR_ROUTE_ID, true, true],
      ['agglayer', false, false]
    ]);
    expect(merged[1]?.less).toEqual({ amount: '0.5' });
  });

  it('keeps a route with no known amount after the routes with one, and an unknown id slowest', () => {
    const merged = rankRouteOptions([row('other'), row('agglayer', { received: { amount: '1' } })], 1);
    expect(merged.map(option => option.id)).toEqual(['agglayer', 'other']);
    expect(merged.find(option => option.fastest)?.id).toBe('agglayer');
    expect(merged[1]?.less).toBeUndefined();
  });

  it('keeps the given order with no amount at all, and breaks a tie of time by the mock-up rank', () => {
    const merged = rankRouteOptions([row('usdcx'), row('epoch'), row(NEAR_ROUTE_ID)], 1);
    expect(merged.map(option => option.id)).toEqual(['usdcx', 'epoch', NEAR_ROUTE_ID]);
    expect(merged[0]?.best).toBe(true);
    // Circle and Epoch both state 2 minutes: Epoch ranks first.
    expect(merged.find(option => option.fastest)?.id).toBe('epoch');
    // Circle from Arc states 1 minute.
    expect(rankRouteOptions([row('epoch'), row('usdcx')], ARC).find(option => option.fastest)?.id).toBe('usdcx');
  });
});
