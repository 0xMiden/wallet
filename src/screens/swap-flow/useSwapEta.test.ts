import { act, renderHook } from '@testing-library/react';

import { useSwapEta, UseSwapEtaOpts } from './useSwapEta';

const mockGetSwapEta = jest.fn();

jest.mock('lib/miden/swap/tokens', () => ({
  getSwapEta: (...args: unknown[]) => mockGetSwapEta(...args)
}));

jest.mock('lib/i18n/numbers', () => ({
  stringToBigInt: (value: string, decimals: number) => BigInt(Math.round(Number(value) * 10 ** decimals))
}));

const USDC = { symbol: 'USDC', faucetId: 'faucet-usdc', decimals: 6, logoSymbol: 'USDC' };
const ETH = { symbol: 'ETH', faucetId: 'faucet-eth', decimals: 6, logoSymbol: 'ETH' };

const etaWith = (marketPrice: string) => ({
  canFill: true,
  estimatedSeconds: 30,
  offMarket: false,
  marketPrice,
  median24hSeconds: null
});

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// Each getSwapEta call returns a promise the test settles by hand, in call order.
let pending: Deferred[];

const opts = (overrides: Partial<UseSwapEtaOpts> = {}): UseSwapEtaOpts => ({
  offerToken: USDC,
  requestToken: ETH,
  offerAmount: '100',
  requestAmount: '0.03',
  enabled: true,
  ...overrides
});

const flipped = opts({ offerToken: ETH, requestToken: USDC, offerAmount: '0.03', requestAmount: '100' });

const pastDebounce = () => act(() => jest.advanceTimersByTime(500));

const settle = async (index: number, how: 'resolve' | 'reject', value: unknown) => {
  await act(async () => {
    pending[index]![how](value);
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  pending = [];
  mockGetSwapEta.mockReset();
  mockGetSwapEta.mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useSwapEta', () => {
  it('drops the old pair quote the moment the pair flips, until the new pair quote lands', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    pastDebounce();
    await settle(0, 'resolve', etaWith('0.0003'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('0.0003') });

    rerender(flipped);
    expect(result.current.eta).toBeUndefined();
    expect(result.current.loading).toBe(true);

    act(() => jest.advanceTimersByTime(250));
    expect(result.current.eta).toBeUndefined();

    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenCalledTimes(2);
    expect(mockGetSwapEta).toHaveBeenLastCalledWith(ETH, 30000n, USDC, 100000000n);
    expect(result.current.eta).toBeUndefined();
    expect(result.current.loading).toBe(true);

    await settle(1, 'resolve', etaWith('3300'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('3300') });
  });

  it('never exposes an old pair error to the new pair while its quote is pending', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    pastDebounce();
    await settle(0, 'reject', new Error('old pair boom'));
    expect(result.current.error).toBe('old pair boom');

    rerender(flipped);
    expect(result.current.error).toBeUndefined();
    expect(result.current.loading).toBe(true);

    pastDebounce();
    expect(result.current.error).toBeUndefined();
    expect(result.current.loading).toBe(true);
  });

  it('exposes the new pair own rejection', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    pastDebounce();
    await settle(0, 'resolve', etaWith('0.0003'));

    rerender(flipped);
    pastDebounce();
    await settle(1, 'reject', new Error('new pair boom'));
    expect(result.current).toEqual({ loading: false, error: 'new pair boom' });
  });

  it('keeps the previous quote while a same-pair amount change reloads', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    pastDebounce();
    await settle(0, 'resolve', etaWith('0.0003'));

    rerender(opts({ offerAmount: '200' }));
    expect(result.current.eta).toEqual(etaWith('0.0003'));

    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ loading: true, eta: etaWith('0.0003') });

    await settle(1, 'resolve', etaWith('0.00031'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('0.00031') });
  });

  describe('when the debounce fires in the same render as a flip', () => {
    const doubled = opts({ offerAmount: '200' });
    const answerByPair = () =>
      mockGetSwapEta.mock.calls.forEach(([offer, , request], i) =>
        pending[i]!.resolve(etaWith(`${offer.symbol}->${request.symbol}`))
      );
    const mountThenFlipAsDebounceFires = async () => {
      const hook = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
      await settle(0, 'resolve', etaWith('USDC->ETH'));
      hook.rerender(doubled);
      act(() => {
        jest.advanceTimersByTime(500);
        hook.rerender(flipped);
      });
      return hook;
    };

    it('never requests a quote from tokens other than the debounced pair', async () => {
      await mountThenFlipAsDebounceFires();
      expect(mockGetSwapEta.mock.calls).toEqual([[USDC, 100000000n, ETH, 30000n]]);
    });

    it('never exposes the flipped pair quote as the original pair eta after flipping back', async () => {
      const { result, rerender } = await mountThenFlipAsDebounceFires();
      await act(async () => answerByPair());
      rerender(doubled);
      expect(result.current.eta?.marketPrice ?? 'USDC->ETH').toBe('USDC->ETH');
      pastDebounce();
      await act(async () => answerByPair());
      expect(result.current.eta?.marketPrice ?? 'USDC->ETH').toBe('USDC->ETH');
    });

    it('still quotes the debounced pair once the flip is undone inside the debounce window', async () => {
      const { result, rerender } = await mountThenFlipAsDebounceFires();
      rerender(doubled);
      pastDebounce();
      expect(mockGetSwapEta).toHaveBeenLastCalledWith(USDC, 200000000n, ETH, 30000n);
      await act(async () => answerByPair());
      expect(result.current).toEqual({ loading: false, eta: etaWith('USDC->ETH') });
    });
  });
});
