import { act, renderHook, waitFor } from '@testing-library/react';

import type { SwapEta, SwapToken } from 'lib/miden/swap/tokens';

import { useSwapEta } from './useSwapEta';

// The hook's only collaborator is the DEX quote fetch; mock it so we can drive
// every branch (idle / loading / resolved / error / superseded) without network.
const mockGetSwapEta = jest.fn();
jest.mock('lib/miden/swap/tokens', () => ({
  getSwapEta: (...args: unknown[]) => mockGetSwapEta(...args)
}));

// `lib/i18n/numbers` pulls in i18next + the metadata barrel; stub the one
// helper the hook uses so the test stays a pure hook test.
jest.mock('lib/i18n/numbers', () => ({
  stringToBigInt: (str: string, decimals: number) => BigInt(Math.round(Number(str) * 10 ** decimals))
}));

const OFFER: SwapToken = { symbol: 'iETH', faucetId: 'offer-faucet', decimals: 8, logoSymbol: 'ETH' };
const REQUEST: SwapToken = { symbol: 'iUSDT', faucetId: 'request-faucet', decimals: 8, logoSymbol: 'USDT' };

const ETA: SwapEta = {
  canFill: true,
  estimatedSeconds: 12,
  offMarket: false,
  marketPrice: '2500',
  median24hSeconds: 30
};

/** Push past the hook's 500ms input debounce. */
const flushDebounce = () => act(() => void jest.advanceTimersByTime(600));

describe('useSwapEta', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockGetSwapEta.mockResolvedValue(ETA);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stays idle and never fetches while disabled', () => {
    const { result } = renderHook(() =>
      useSwapEta({ offerToken: OFFER, requestToken: REQUEST, offerAmount: '1', requestAmount: '', enabled: false })
    );

    flushDebounce();

    expect(result.current).toEqual({ loading: false });
    expect(mockGetSwapEta).not.toHaveBeenCalled();
  });

  it('stays idle when the offered amount is zero/empty', () => {
    const { result } = renderHook(() =>
      useSwapEta({ offerToken: OFFER, requestToken: REQUEST, offerAmount: '', requestAmount: '', enabled: true })
    );

    flushDebounce();

    expect(result.current.loading).toBe(false);
    expect(mockGetSwapEta).not.toHaveBeenCalled();
  });

  it('stays idle when both sides are the same faucet', () => {
    const { result } = renderHook(() =>
      useSwapEta({ offerToken: OFFER, requestToken: OFFER, offerAmount: '1', requestAmount: '2', enabled: true })
    );

    flushDebounce();

    expect(result.current.loading).toBe(false);
    expect(mockGetSwapEta).not.toHaveBeenCalled();
  });

  it('bootstraps the requested amount with the offered amount when the receive field is empty', async () => {
    const { result } = renderHook(() =>
      useSwapEta({ offerToken: OFFER, requestToken: REQUEST, offerAmount: '1', requestAmount: '', enabled: true })
    );

    flushDebounce();

    await waitFor(() => expect(result.current.eta).toEqual(ETA));
    expect(result.current.loading).toBe(false);
    // 1 whole token at 8 decimals, mirrored onto the requested side.
    expect(mockGetSwapEta).toHaveBeenCalledWith(OFFER, 100000000n, REQUEST, 100000000n);
  });

  it('sends the real requested amount once the receive field is seeded', async () => {
    const { result } = renderHook(() =>
      useSwapEta({ offerToken: OFFER, requestToken: REQUEST, offerAmount: '1', requestAmount: '2', enabled: true })
    );

    flushDebounce();

    await waitFor(() => expect(result.current.eta).toEqual(ETA));
    expect(mockGetSwapEta).toHaveBeenCalledWith(OFFER, 100000000n, REQUEST, 200000000n);
  });

  it('surfaces the fetch error message and clears loading', async () => {
    mockGetSwapEta.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() =>
      useSwapEta({ offerToken: OFFER, requestToken: REQUEST, offerAmount: '1', requestAmount: '', enabled: true })
    );

    flushDebounce();

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.loading).toBe(false);
  });

  it('falls back to a generic message for a non-Error rejection', async () => {
    mockGetSwapEta.mockRejectedValue('nope');

    const { result } = renderHook(() =>
      useSwapEta({ offerToken: OFFER, requestToken: REQUEST, offerAmount: '1', requestAmount: '', enabled: true })
    );

    flushDebounce();

    await waitFor(() => expect(result.current.error).toBe('Quote failed'));
  });

  it('keeps the previous eta while a new quote is in flight', async () => {
    const { result, rerender } = renderHook(props => useSwapEta(props), {
      initialProps: {
        offerToken: OFFER,
        requestToken: REQUEST,
        offerAmount: '1',
        requestAmount: '',
        enabled: true
      }
    });

    flushDebounce();
    await waitFor(() => expect(result.current.eta).toEqual(ETA));

    let resolveSecond: (eta: SwapEta) => void = () => undefined;
    mockGetSwapEta.mockReturnValue(new Promise<SwapEta>(resolve => (resolveSecond = resolve)));

    rerender({ offerToken: OFFER, requestToken: REQUEST, offerAmount: '2', requestAmount: '', enabled: true });
    flushDebounce();

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.eta).toEqual(ETA);

    const next: SwapEta = { ...ETA, marketPrice: '2600' };
    await act(async () => {
      resolveSecond(next);
    });
    expect(result.current.eta).toEqual(next);
  });

  it('ignores a stale in-flight quote that resolves after a newer one', async () => {
    let resolveFirst: (eta: SwapEta) => void = () => undefined;
    mockGetSwapEta.mockReturnValueOnce(new Promise<SwapEta>(resolve => (resolveFirst = resolve)));

    const { result, rerender } = renderHook(props => useSwapEta(props), {
      initialProps: {
        offerToken: OFFER,
        requestToken: REQUEST,
        offerAmount: '1',
        requestAmount: '',
        enabled: true
      }
    });

    flushDebounce();
    await waitFor(() => expect(result.current.loading).toBe(true));

    const fresh: SwapEta = { ...ETA, marketPrice: '9999' };
    mockGetSwapEta.mockResolvedValue(fresh);
    rerender({ offerToken: OFFER, requestToken: REQUEST, offerAmount: '3', requestAmount: '', enabled: true });
    flushDebounce();
    await waitFor(() => expect(result.current.eta).toEqual(fresh));

    // The superseded request lands late and must not clobber the newer quote.
    await act(async () => {
      resolveFirst({ ...ETA, marketPrice: '1' });
    });
    expect(result.current.eta).toEqual(fresh);
  });

  it('drops back to idle and supersedes the in-flight quote when it becomes disabled', async () => {
    const { result, rerender } = renderHook(props => useSwapEta(props), {
      initialProps: {
        offerToken: OFFER,
        requestToken: REQUEST,
        offerAmount: '1',
        requestAmount: '',
        enabled: true
      }
    });

    flushDebounce();
    await waitFor(() => expect(result.current.eta).toEqual(ETA));

    rerender({ offerToken: OFFER, requestToken: REQUEST, offerAmount: '1', requestAmount: '', enabled: false });
    flushDebounce();

    await waitFor(() => expect(result.current).toEqual({ loading: false }));
  });
});
