import { act, renderHook } from '@testing-library/react';

import { useSwapQuote, UseSwapQuoteOpts } from './useSwapQuote';

const mockQuoteSwap = jest.fn();

jest.mock('lib/miden/swap/quote', () => ({
  ...jest.requireActual('lib/miden/swap/quote'),
  quoteSwap: (...args: unknown[]) => mockQuoteSwap(...args)
}));

jest.mock('lib/i18n/numbers', () => ({
  stringToBigInt: (value: string, decimals: number) => {
    if (value === '' || Number.isNaN(Number(value))) throw new RangeError(value);
    return BigInt(Math.round(Number(value) * 10 ** decimals));
  }
}));

const USDC = { symbol: 'USDC', faucetId: 'faucet-usdc', decimals: 6, logoSymbol: 'USDC' };
const ETH = { symbol: 'ETH', faucetId: 'faucet-eth', decimals: 6, logoSymbol: 'ETH' };

/** A quote stand-in: only the fields the hook reads, tagged by the price so a test can tell them apart. */
const quoteWith = (fillPrice: string, fetchedAt = 0) => ({
  price: { fillPrice },
  requestedAmount: 1n,
  eta: {},
  fetchedAt
});

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// Each quoteSwap call returns a promise the test settles by hand, in call order.
let pending: Deferred[];

const opts = (overrides: Partial<UseSwapQuoteOpts> = {}): UseSwapQuoteOpts => ({
  offerToken: USDC,
  requestToken: ETH,
  offerAmount: '100',
  requestAmount: '0.03',
  requestEdited: false,
  slippageBps: 20,
  enabled: true,
  active: true,
  ...overrides
});

const flipped = opts({ offerToken: ETH, requestToken: USDC, offerAmount: '0.03', requestAmount: '100' });

const pastDebounce = () => act(() => jest.advanceTimersByTime(500));

const settle = async (index: number, how: 'resolve' | 'reject', value: unknown) => {
  await act(async () => {
    pending[index]![how](value);
  });
};

const lastCall = () => mockQuoteSwap.mock.calls[mockQuoteSwap.mock.calls.length - 1];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  pending = [];
  mockQuoteSwap.mockReset();
  mockQuoteSwap.mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useSwapQuote', () => {
  it('quotes the debounced inputs: a wallet-built ask carries no requested amount, only the slippage', async () => {
    const { result } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), { initialProps: opts() });
    pastDebounce();
    expect(mockQuoteSwap).toHaveBeenCalledTimes(1);
    expect(lastCall()).toEqual([USDC, 100000000n, ETH, { slippageBps: 20 }]);
    const quote = quoteWith('0.0003');
    await settle(0, 'resolve', quote);
    expect(result.current).toMatchObject({ loading: false, quote });
  });

  it('quotes the user own ask once they edit the receive field', async () => {
    renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), { initialProps: opts({ requestEdited: true }) });
    pastDebounce();
    expect(lastCall()).toEqual([USDC, 100000000n, ETH, { slippageBps: 20, requestedAmount: 30000n }]);
  });

  it('does not quote an edited receive field that is empty, since the service refuses a zero ask', () => {
    renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), {
      initialProps: opts({ requestEdited: true, requestAmount: '' })
    });
    pastDebounce();
    expect(mockQuoteSwap).not.toHaveBeenCalled();
  });

  it.each(['.', '', '0'])(
    'hides the last quote at once when the edited receive field becomes %s, and quotes nothing for it',
    async input => {
      const { result, rerender } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), {
        initialProps: opts({ requestEdited: true })
      });
      pastDebounce();
      await settle(0, 'resolve', quoteWith('0.0003'));
      expect(result.current.quote).toEqual(quoteWith('0.0003'));

      rerender(opts({ requestEdited: true, requestAmount: input }));
      expect(result.current.loading).toBe(false);
      expect(result.current.quote).toBeUndefined();
      pastDebounce();
      expect(mockQuoteSwap).toHaveBeenCalledTimes(1);
    }
  );

  it('does not re-quote when the wallet-built receive field is written back, only when the slippage changes', async () => {
    const { rerender } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), { initialProps: opts() });
    pastDebounce();
    await settle(0, 'resolve', quoteWith('0.0003'));
    rerender(opts({ requestAmount: '0.0299' }));
    pastDebounce();
    expect(mockQuoteSwap).toHaveBeenCalledTimes(1);
    rerender(opts({ requestAmount: '0.0299', slippageBps: 50 }));
    pastDebounce();
    expect(mockQuoteSwap).toHaveBeenCalledTimes(2);
    expect(lastCall()).toEqual([USDC, 100000000n, ETH, { slippageBps: 50 }]);
  });

  it('drops the old pair quote the moment the pair flips, until the new pair quote lands', async () => {
    const { result, rerender } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), {
      initialProps: opts()
    });
    pastDebounce();
    await settle(0, 'resolve', quoteWith('0.0003'));
    expect(result.current).toMatchObject({ loading: false, quote: quoteWith('0.0003') });

    rerender(flipped);
    expect(result.current.quote).toBeUndefined();
    expect(result.current.loading).toBe(true);

    act(() => jest.advanceTimersByTime(250));
    expect(result.current.quote).toBeUndefined();

    pastDebounce();
    expect(mockQuoteSwap).toHaveBeenCalledTimes(2);
    expect(lastCall()).toEqual([ETH, 30000n, USDC, { slippageBps: 20 }]);
    expect(result.current.quote).toBeUndefined();
    expect(result.current.loading).toBe(true);

    await settle(1, 'resolve', quoteWith('3300'));
    expect(result.current).toMatchObject({ loading: false, quote: quoteWith('3300') });
  });

  it('never exposes an old pair error to the new pair while its quote is pending', async () => {
    const { result, rerender } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), {
      initialProps: opts()
    });
    pastDebounce();
    await settle(0, 'reject', new Error('old pair boom'));
    expect(result.current.error).toBe('old pair boom');
    expect(result.current.errorCode).toBe('unknown');

    rerender(flipped);
    expect(result.current.error).toBeUndefined();
    expect(result.current.loading).toBe(true);

    pastDebounce();
    expect(result.current.error).toBeUndefined();
    expect(result.current.loading).toBe(true);
  });

  it('exposes the new pair own rejection, with the service code', async () => {
    const { SwapQuoteError } = jest.requireActual('lib/miden/swap/quote');
    const { result, rerender } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), {
      initialProps: opts()
    });
    pastDebounce();
    await settle(0, 'resolve', quoteWith('0.0003'));

    rerender(flipped);
    pastDebounce();
    await settle(1, 'reject', new SwapQuoteError('no_market', 'not traded', 503));
    expect(result.current).toMatchObject({ loading: false, error: 'not traded', errorCode: 'no_market' });
  });

  it('keeps the previous quote while a same-pair amount change reloads', async () => {
    const { result, rerender } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), {
      initialProps: opts()
    });
    pastDebounce();
    await settle(0, 'resolve', quoteWith('0.0003'));

    rerender(opts({ offerAmount: '200' }));
    expect(result.current.quote).toEqual(quoteWith('0.0003'));

    pastDebounce();
    expect(mockQuoteSwap).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ loading: true, quote: quoteWith('0.0003') });

    await settle(1, 'resolve', quoteWith('0.00031'));
    expect(result.current).toMatchObject({ loading: false, quote: quoteWith('0.00031') });
  });

  describe('refresh', () => {
    it('re-quotes 30 s after a quote lands while the page is active, and not while it is not', async () => {
      const { result, rerender } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), {
        initialProps: opts()
      });
      pastDebounce();
      const first = quoteWith('0.0003', Date.now());
      await settle(0, 'resolve', first);

      act(() => jest.advanceTimersByTime(29_999));
      expect(mockQuoteSwap).toHaveBeenCalledTimes(1);
      act(() => jest.advanceTimersByTime(1));
      expect(mockQuoteSwap).toHaveBeenCalledTimes(2);
      // The old quote stays on screen while the refresh is in flight.
      expect(result.current).toMatchObject({ loading: true, quote: first });
      await settle(1, 'resolve', quoteWith('0.00031', Date.now()));

      rerender(opts({ active: false }));
      act(() => jest.advanceTimersByTime(60_000));
      expect(mockQuoteSwap).toHaveBeenCalledTimes(2);
    });

    it('re-quotes at once when the page comes back with a stale quote', async () => {
      const { rerender } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), {
        initialProps: opts({ active: false })
      });
      pastDebounce();
      await settle(0, 'resolve', quoteWith('0.0003', Date.now()));
      act(() => jest.advanceTimersByTime(45_000));
      expect(mockQuoteSwap).toHaveBeenCalledTimes(1);

      rerender(opts({ active: true }));
      act(() => jest.advanceTimersByTime(0));
      expect(mockQuoteSwap).toHaveBeenCalledTimes(2);
    });
  });

  describe('quoteNow', () => {
    it('quotes the live inputs at once, skipping the debounce, and lands the answer in the state', async () => {
      // A fresh key is quoted on mount; a later input change waits for the debounce, quoteNow does not.
      const { result, rerender } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), {
        initialProps: opts()
      });
      await settle(0, 'resolve', quoteWith('0.0003'));
      rerender(opts({ offerAmount: '200' }));
      expect(mockQuoteSwap).toHaveBeenCalledTimes(1);
      let promise: Promise<unknown> | undefined;
      act(() => {
        promise = result.current.quoteNow();
      });
      expect(mockQuoteSwap).toHaveBeenCalledTimes(2);
      expect(lastCall()).toEqual([USDC, 200000000n, ETH, { slippageBps: 20 }]);
      expect(result.current.loading).toBe(true);
      const quote = quoteWith('0.00031');
      await settle(1, 'resolve', quote);
      await expect(promise).resolves.toBe(quote);
      expect(result.current).toMatchObject({ loading: false, quote });
    });

    it('checks the ask it is given rather than building one', () => {
      const { result } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), { initialProps: opts() });
      act(() => {
        result.current.quoteNow(29_000n).catch(() => undefined);
      });
      expect(lastCall()).toEqual([USDC, 100000000n, ETH, { slippageBps: 20, requestedAmount: 29000n }]);
    });

    it('supersedes a debounced request in flight', async () => {
      const { result } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), { initialProps: opts() });
      pastDebounce();
      act(() => {
        result.current.quoteNow().catch(() => undefined);
      });
      expect(mockQuoteSwap).toHaveBeenCalledTimes(2);
      await settle(0, 'resolve', quoteWith('stale'));
      expect(result.current.quote).toBeUndefined();
      await settle(1, 'resolve', quoteWith('fresh'));
      expect(result.current.quote).toEqual(quoteWith('fresh'));
    });

    it('rejects, and rejects the caller, when there is nothing to quote', async () => {
      const { result } = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), {
        initialProps: opts({ offerAmount: '' })
      });
      await expect(result.current.quoteNow()).rejects.toThrow('Nothing to quote');
      expect(mockQuoteSwap).not.toHaveBeenCalled();
    });
  });

  describe('when the debounce fires in the same render as a flip', () => {
    const doubled = opts({ offerAmount: '200' });
    const answerByPair = () =>
      mockQuoteSwap.mock.calls.forEach(([offer, , request], i) =>
        pending[i]!.resolve(quoteWith(`${offer.symbol}->${request.symbol}`))
      );
    const mountThenFlipAsDebounceFires = async () => {
      const hook = renderHook((props: UseSwapQuoteOpts) => useSwapQuote(props), { initialProps: opts() });
      pastDebounce();
      await settle(0, 'resolve', quoteWith('USDC->ETH'));
      hook.rerender(doubled);
      act(() => {
        jest.advanceTimersByTime(500);
        hook.rerender(flipped);
      });
      return hook;
    };

    it('never requests a quote from tokens other than the debounced pair', async () => {
      await mountThenFlipAsDebounceFires();
      expect(mockQuoteSwap.mock.calls).toEqual([[USDC, 100000000n, ETH, { slippageBps: 20 }]]);
    });

    it('never exposes the flipped pair quote as the original pair quote after flipping back', async () => {
      const { result, rerender } = await mountThenFlipAsDebounceFires();
      await act(async () => answerByPair());
      rerender(doubled);
      expect(result.current.quote?.price.fillPrice ?? 'USDC->ETH').toBe('USDC->ETH');
      pastDebounce();
      await act(async () => answerByPair());
      expect(result.current.quote?.price.fillPrice ?? 'USDC->ETH').toBe('USDC->ETH');
    });

    it('still quotes the debounced pair once the flip is undone inside the debounce window', async () => {
      const { result, rerender } = await mountThenFlipAsDebounceFires();
      rerender(doubled);
      pastDebounce();
      expect(lastCall()).toEqual([USDC, 200000000n, ETH, { slippageBps: 20 }]);
      await act(async () => answerByPair());
      expect(result.current).toMatchObject({ loading: false, quote: quoteWith('USDC->ETH') });
    });
  });
});
