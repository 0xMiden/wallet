import { act, renderHook } from '@testing-library/react';

import { useSwapEta, UseSwapEtaOpts } from './useSwapEta';

const mockGetSwapEta = jest.fn();
let mockEtaUrl: string | undefined;

jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({ config: { swap: { etaUrl: mockEtaUrl } } })
}));

jest.mock('lib/miden/swap/tokens', () => ({
  getSwapEta: (...args: unknown[]) => mockGetSwapEta(...args)
}));

jest.unmock('lib/i18n/numbers');

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
  mockEtaUrl = 'https://quotes.first';
  jest.useFakeTimers();
  pending = [];
  mockGetSwapEta.mockReset();
  mockGetSwapEta.mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useSwapEta', () => {
  it.each(['.', '۱', '١', '1,5', '1.2.3', 'abc'])(
    'leaves invalid offer amount %s idle and recovers on a canonical amount',
    offerAmount => {
      const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), {
        initialProps: opts({ offerAmount })
      });
      expect(result.current).toEqual({ loading: false });
      pastDebounce();
      expect(mockGetSwapEta).not.toHaveBeenCalled();

      rerender(opts({ offerAmount: '100.5' }));
      pastDebounce();
      expect(mockGetSwapEta).toHaveBeenCalledTimes(1);
      expect(mockGetSwapEta).toHaveBeenLastCalledWith(USDC, 100500000n, ETH, 30000n);
      expect(result.current.loading).toBe(true);
    }
  );

  it.each(['.', '۱', '١', '1,5', '1.2.3', 'abc'])(
    'leaves invalid request amount %s idle instead of bootstrapping a quote',
    requestAmount => {
      const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), {
        initialProps: opts({ requestAmount })
      });
      expect(result.current).toEqual({ loading: false });
      pastDebounce();
      expect(mockGetSwapEta).not.toHaveBeenCalled();

      rerender(opts({ requestAmount: '0.000001' }));
      pastDebounce();
      expect(mockGetSwapEta).toHaveBeenLastCalledWith(USDC, 100000000n, ETH, 1n);
    }
  );

  it('hides a cached quote immediately when the offered amount is cleared', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    await settle(0, 'resolve', etaWith('2'));
    rerender(opts({ offerAmount: '' }));
    expect(result.current).toEqual({ loading: false });
    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenCalledTimes(1);
  });

  it('hides a cached quote immediately when either amount becomes incomplete', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    await settle(0, 'resolve', etaWith('2'));
    rerender(opts({ requestAmount: '.' }));
    expect(result.current).toEqual({ loading: false });
    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenCalledTimes(1);
  });

  it('does not restore an in-flight quote while the amount is invalid', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    rerender(opts({ offerAmount: '.' }));
    await settle(0, 'resolve', etaWith('2'));
    expect(result.current).toEqual({ loading: false });
    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenCalledTimes(1);
    rerender(opts());
    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenCalledTimes(2);
    await settle(1, 'resolve', etaWith('3'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('3') });
  });

  it.each(['', '0'])('leaves edited request amount %s idle without an automatic bootstrap', requestAmount => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), {
      initialProps: opts({ requestAmount, allowRequestBootstrap: false })
    });
    expect(result.current).toEqual({ loading: false });
    pastDebounce();
    expect(mockGetSwapEta).not.toHaveBeenCalled();

    rerender(opts({ requestAmount: '0.000001', allowRequestBootstrap: false }));
    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenLastCalledWith(USDC, 100000000n, ETH, 1n);
  });

  it('supersedes an automatic bootstrap when the empty receive field becomes user-edited', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), {
      initialProps: opts({ requestAmount: '' })
    });
    rerender(opts({ requestAmount: '', allowRequestBootstrap: false }));
    await settle(0, 'resolve', etaWith('old'));
    expect(result.current).toEqual({ loading: false });
    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenCalledTimes(1);

    rerender(opts({ requestAmount: '0.03', allowRequestBootstrap: false }));
    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenCalledTimes(2);
    await settle(1, 'resolve', etaWith('new'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('new') });
  });

  it('waits the full debounce when valid input returns after an incomplete amount', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    await settle(0, 'resolve', etaWith('initial'));
    rerender(opts({ offerAmount: '.' }));
    rerender(opts());
    expect(mockGetSwapEta).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(499));
    expect(mockGetSwapEta).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1));
    expect(mockGetSwapEta).toHaveBeenCalledTimes(2);
    await settle(1, 'resolve', etaWith('recovered'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('recovered') });
  });

  it('still bootstraps an empty receive field with the positive offered amount', () => {
    renderHook(() => useSwapEta(opts({ requestAmount: '' })));
    expect(mockGetSwapEta).toHaveBeenCalledWith(USDC, 100000000n, ETH, 100000000n);
  });

  it('drops a cached quote and refetches when only the configured service changes', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    await settle(0, 'resolve', etaWith('2'));
    mockEtaUrl = 'https://quotes.second';
    rerender(opts());
    expect(result.current).toEqual({ loading: true });
    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenCalledTimes(2);
    await settle(1, 'resolve', etaWith('3'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('3') });
  });

  it('supersedes an old service response before the new debounce expires', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    mockEtaUrl = 'https://quotes.second';
    rerender(opts());
    await settle(0, 'resolve', etaWith('2'));
    expect(result.current).toEqual({ loading: true });
    pastDebounce();
    expect(mockGetSwapEta).toHaveBeenCalledTimes(2);
    await settle(1, 'resolve', etaWith('3'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('3') });
  });

  it('ignores an old service rejection after the configured URL changes', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    mockEtaUrl = 'https://quotes.second';
    rerender(opts());
    await settle(0, 'reject', new Error('old service failed'));
    expect(result.current).toEqual({ loading: true });
    pastDebounce();
    await settle(1, 'resolve', etaWith('3'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('3') });
  });

  it('invalidates a removed service and recovers when a service is configured again', async () => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    await settle(0, 'resolve', etaWith('2'));
    mockEtaUrl = undefined;
    rerender(opts());
    expect(result.current).toEqual({ loading: true });
    pastDebounce();
    await settle(1, 'reject', new Error('No quote service'));
    expect(result.current).toEqual({ loading: false, error: 'No quote service' });
    mockEtaUrl = 'https://quotes.second';
    rerender(opts());
    expect(result.current).toEqual({ loading: true });
    pastDebounce();
    await settle(2, 'resolve', etaWith('3'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('3') });
  });

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

  it.each([
    { field: 'offer', first: '200', second: '300', offerRaw: 200000000n, requestRaw: 30000n },
    { field: 'request', first: '0.02', second: '0.01', offerRaw: 100000000n, requestRaw: 20000n }
  ])('quotes a skipped $field amount after returning to it and waiting the full debounce', async scenario => {
    const { result, rerender } = renderHook((props: UseSwapEtaOpts) => useSwapEta(props), { initialProps: opts() });
    const withAmount = (amount: string) =>
      opts(scenario.field === 'offer' ? { offerAmount: amount } : { requestAmount: amount });
    await settle(0, 'resolve', etaWith('initial'));

    rerender(withAmount(scenario.first));
    act(() => {
      jest.advanceTimersByTime(500);
      rerender(withAmount(scenario.second));
    });
    expect(mockGetSwapEta).toHaveBeenCalledTimes(1);

    rerender(withAmount(scenario.first));
    expect(mockGetSwapEta).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(499));
    expect(mockGetSwapEta).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1));
    expect(mockGetSwapEta).toHaveBeenCalledTimes(2);
    expect(mockGetSwapEta).toHaveBeenLastCalledWith(USDC, scenario.offerRaw, ETH, scenario.requestRaw);
    await settle(1, 'resolve', etaWith('updated'));
    expect(result.current).toEqual({ loading: false, eta: etaWith('updated') });
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
