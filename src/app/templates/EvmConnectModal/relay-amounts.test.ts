import {
  amountValueText,
  amountValueUsd,
  epochReceiveOf,
  type RelayAmountsInput,
  relayRouteRows,
  relayRouteView,
  unitsValue
} from './relay-amounts';
import type { RelayRoute } from './relay-deposit-record';

jest.mock('lib/usdcx/constant', () => ({
  usdcxArrivalKey: (chainId: number) => (chainId === 5042002 ? 'usdcxArrivalArc' : 'usdcxArrival')
}));

/** 1 POL typed, at 18 decimals. */
const ONE = 10n ** 18n;

const input = (overrides: Partial<RelayAmountsInput> = {}): RelayAmountsInput => ({
  typedUnits: ONE,
  typedText: '1',
  sourceDecimals: 18,
  circleExecutor: false,
  circleFee: undefined,
  circleQuoteFailed: false,
  epochReceive: null,
  epochSend: null,
  loadingText: 'loading',
  ...overrides
});

describe('relayRouteView: the typed amount is what the user sends', () => {
  it('sends and receives the typed amount on Agglayer, with no fee', () => {
    expect(relayRouteView('agglayer', input())).toEqual({
      sendUnits: ONE,
      received: { amount: ONE, decimals: 18 },
      fee: { kind: 'none' },
      feeShare: 0,
      noFit: false
    });
  });

  it('sends and receives the typed amount on a direct xReserve deposit (1:1)', () => {
    const view = relayRouteView('usdcx', input({ typedUnits: 1_500_000n, typedText: '1.5', sourceDecimals: 6 }));

    expect(view.sendUnits).toBe(1_500_000n);
    expect(view.received).toEqual({ amount: 1_500_000n, decimals: 6 });
    expect(view.fee).toEqual({ kind: 'none' });
  });

  it("takes Circle's executor fee out of the amount sent", () => {
    const view = relayRouteView(
      'usdcx',
      input({ typedUnits: 1_500_000n, typedText: '1.5', sourceDecimals: 6, circleExecutor: true, circleFee: 20_000n })
    );

    expect(view.sendUnits).toBe(1_500_000n);
    expect(view.received).toEqual({ amount: 1_480_000n, decimals: 6 });
    expect(view.fee).toEqual({ kind: 'amount', value: { amount: 20_000n, decimals: 6 } });
    expect(view.feeShare).toBeCloseTo(20_000 / 1_500_000);
  });

  it('waits for the Circle fee, and says so', () => {
    const view = relayRouteView('usdcx', input({ sourceDecimals: 6, typedUnits: 1_500_000n, circleExecutor: true }));

    expect(view.sendUnits).toBeNull();
    expect(view.received).toBeUndefined();
    expect(view.fee).toEqual({ kind: 'rate', text: 'loading' });
  });

  it('shows no fee and no wait when Circle refused the quote', () => {
    const view = relayRouteView(
      'usdcx',
      input({ sourceDecimals: 6, typedUnits: 1_500_000n, circleExecutor: true, circleQuoteFailed: true })
    );

    expect(view.fee).toEqual({ kind: 'rate', text: '–' });
  });

  it('has no fit when the Circle fee takes the whole amount', () => {
    const view = relayRouteView(
      'usdcx',
      input({ sourceDecimals: 6, typedUnits: 10_000n, typedText: '0.01', circleExecutor: true, circleFee: 20_000n })
    );

    expect(view).toMatchObject({ sendUnits: null, received: undefined, noFit: true, fee: { kind: 'rate', text: '–' } });
  });

  it('receives the Epoch search result and takes the rest of the amount as the fee', () => {
    // 1 POL sent; 0.99949 POL arrives: the fee is 0.00051 POL.
    const receive = ONE - 510_000_000_000_000n;
    const view = relayRouteView('epoch', input({ epochReceive: { units: receive, decimals: 18 } }));

    expect(view.sendUnits).toBe(ONE);
    expect(view.received).toEqual({ amount: receive, decimals: 18 });
    expect(view.fee).toEqual({ kind: 'amount', value: { amount: 510_000_000_000_000n, decimals: 18 } });
  });

  it('takes the Epoch fee in the source token when the Miden token has fewer decimals', () => {
    // 1.505 USDC at 18 decimals; 1.5 arrives at 6 decimals.
    const view = relayRouteView(
      'epoch',
      input({
        typedUnits: 1_505_000_000_000_000_000n,
        typedText: '1.505',
        epochReceive: { units: 1_500_000n, decimals: 6 }
      })
    );

    expect(view.received).toEqual({ amount: 1_500_000n, decimals: 6 });
    expect(view.fee).toEqual({ kind: 'amount', value: { amount: 5_000_000_000_000_000n, decimals: 18 } });
  });

  it('waits for the Epoch search', () => {
    expect(relayRouteView('epoch', input())).toMatchObject({ sendUnits: null, fee: { kind: 'rate', text: 'loading' } });
  });

  it('has no fit when no Epoch quote fits the typed amount', () => {
    const view = relayRouteView('epoch', input({ epochSend: { send: '1', receiveUnits: null } }));

    expect(view).toMatchObject({ sendUnits: null, noFit: true, fee: { kind: 'rate', text: '–' } });
  });

  it('reads no "no fit" of another amount', () => {
    expect(relayRouteView('epoch', input({ epochSend: { send: '2', receiveUnits: null } })).noFit).toBe(false);
  });

  it('has no numbers and no wait with no typed amount, and the rate of a 1:1 route', () => {
    expect(relayRouteView('agglayer', input({ typedUnits: null, typedText: '' }))).toEqual({
      sendUnits: null,
      received: undefined,
      fee: { kind: 'none' },
      feeShare: undefined,
      noFit: false
    });
    expect(relayRouteView('usdcx', input({ typedUnits: null, typedText: '' })).fee).toEqual({ kind: 'none' });
    expect(relayRouteView('epoch', input({ typedUnits: null, typedText: '' })).fee).toEqual({
      kind: 'rate',
      text: '–'
    });
    expect(relayRouteView('usdcx', input({ typedUnits: null, typedText: '', circleExecutor: true })).fee).toEqual({
      kind: 'rate',
      text: '–'
    });
  });
});

describe('epochReceiveOf', () => {
  const send = { send: '1', receiveUnits: 999n };

  it('gives the search while Epoch is chosen and its quote is ready', () => {
    expect(epochReceiveOf('epoch', true, send, 18)).toEqual({ units: 999n, decimals: 18 });
  });

  it.each<[string, RelayRoute, boolean, typeof send | null, number | undefined]>([
    ['another route', 'agglayer', true, send, 18],
    ['a quote that is not ready', 'epoch', false, send, 18],
    ['no search', 'epoch', true, null, 18],
    ['no Miden token', 'epoch', true, send, undefined]
  ])('gives null for %s', (_name, route, ready, search, decimals) => {
    expect(epochReceiveOf(route, ready, search, decimals)).toBeNull();
  });

  it('gives null for a search with no fit', () => {
    expect(epochReceiveOf('epoch', true, { send: '1', receiveUnits: null }, 18)).toBeNull();
  });
});

describe('relayRouteRows', () => {
  const nameOf = (route: RelayRoute) => route;
  const arrivesInOf = (route: RelayRoute) => `${route}-time`;

  it('tags the route that receives most and the fastest by the real numbers', () => {
    const rows = relayRouteRows({
      routes: ['agglayer', 'epoch'],
      selected: 'epoch',
      chainId: 1,
      amounts: input({ epochReceive: { units: ONE - 10n ** 15n, decimals: 18 } }),
      nameOf,
      arrivesInOf
    });

    expect(rows.map(row => [row.id, row.best, row.fastest, row.selected])).toEqual([
      ['agglayer', true, false, false],
      ['epoch', false, true, true]
    ]);
    expect(rows[1]?.less).toEqual({ amount: '0.001' });
    expect(rows[1]?.fee).toEqual({ kind: 'amount', value: { amount: 10n ** 15n, decimals: 18 } });
  });

  it('shows no amount and no fee for an Epoch route that is not chosen', () => {
    const rows = relayRouteRows({
      routes: ['agglayer', 'epoch'],
      selected: 'agglayer',
      chainId: 1,
      amounts: input(),
      nameOf,
      arrivesInOf
    });

    const epoch = rows.find(row => row.id === 'epoch');
    expect(epoch?.received).toBeUndefined();
    expect(epoch?.fee).toBeUndefined();
    expect(rows[0]).toMatchObject({ id: 'agglayer', best: true, fee: { kind: 'none' } });
  });

  it('ranks Circle executor and Epoch by what each receives', () => {
    const rows = relayRouteRows({
      routes: ['usdcx', 'epoch'],
      selected: 'epoch',
      chainId: 1,
      amounts: input({
        typedUnits: 1_500_000n,
        typedText: '1.5',
        sourceDecimals: 6,
        circleExecutor: true,
        circleFee: 20_000n,
        epochReceive: { units: 1_495_000n, decimals: 6 }
      }),
      nameOf,
      arrivesInOf
    });

    expect(rows.map(row => row.id)).toEqual(['epoch', 'usdcx']);
    expect(rows[0]?.best).toBe(true);
  });
});

describe('amount helpers', () => {
  it('writes an amount value as exact text', () => {
    expect(amountValueText({ amount: 1_480_000n, decimals: 6 })).toBe('1.48');
    expect(amountValueText({ amount: '1.5' })).toBe('1.5');
  });

  it('values an amount in USD, or nothing with no amount or no price', () => {
    expect(amountValueUsd({ amount: 1_500_000n, decimals: 6 }, 2)).toBe(3);
    expect(amountValueUsd(undefined, 2)).toBeUndefined();
    expect(amountValueUsd({ amount: '1' }, undefined)).toBeUndefined();
  });

  it('gives base units with their decimals', () => {
    expect(unitsValue(5n, 6)).toEqual({ amount: 5n, decimals: 6 });
    expect(unitsValue(null, 6)).toBeUndefined();
  });
});
