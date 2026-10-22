import { act, renderHook } from '@testing-library/react';

import { OneClickAsset, OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';

import { oneClickQuoteExpired, useOneClickQuote } from './useOneClickQuote';

const miden: OneClickAsset = {
  assetId: 'miden-usdc',
  blockchain: 'miden',
  symbol: 'USDC',
  decimals: 6,
  faucetId: 'faucet-usdc'
};
const ethereum: OneClickAsset = {
  assetId: 'ethereum-usdc',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x123'
};

const request = (amount: string, originAsset = miden): OneClickQuoteRequest => ({
  amount,
  originAsset,
  destinationAsset: ethereum,
  refundTo: 'miden-refund',
  recipient: '0xrecipient',
  deadline: '2026-10-22T12:01:00.000Z',
  slippageTolerance: 100
});

const response = (correlationId: string, deadline = '2026-10-22T12:01:00.000Z'): OneClickQuoteResponse => ({
  correlationId,
  timestamp: '2026-10-22T12:00:00.000Z',
  signature: 'signed',
  quoteRequest: {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'miden-usdc',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'ethereum-usdc',
    amount: '1000000',
    refundTo: 'miden-refund',
    refundType: 'ORIGIN_CHAIN',
    recipient: '0xrecipient',
    recipientType: 'DESTINATION_CHAIN',
    deadline
  },
  quote: {
    amountIn: '1000000',
    amountInFormatted: '1',
    amountInUsd: '1',
    minAmountIn: '1000000',
    amountOut: '990000',
    amountOutFormatted: '0.99',
    amountOutUsd: '0.99',
    minAmountOut: '980000',
    deadline,
    timeEstimate: 60
  }
});

describe('useOneClickQuote', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('debounces dry previews and discards a response for an older amount and route', async () => {
    const pending: Array<(quote: OneClickQuoteResponse) => void> = [];
    const query = jest.fn(() => new Promise<OneClickQuoteResponse>(resolve => pending.push(resolve)));
    const { result, rerender } = renderHook(
      ({ value }: { value: OneClickQuoteRequest }) => useOneClickQuote(value, query, 300),
      { initialProps: { value: request('1000000') } }
    );

    act(() => jest.advanceTimersByTime(300));
    expect(query).toHaveBeenCalledTimes(1);
    rerender({ value: request('2000000', ethereum) });
    const oldQuote = pending.shift();
    if (!oldQuote) throw new Error('The first preview did not start');
    await act(async () => oldQuote(response('old')));
    expect(result.current.quote).toBeUndefined();

    act(() => jest.advanceTimersByTime(300));
    expect(query).toHaveBeenCalledTimes(2);
    const newQuote = pending.shift();
    if (!newQuote) throw new Error('The updated preview did not start');
    await act(async () => newQuote(response('new')));
    expect(result.current.quote?.correlationId).toBe('new');
  });

  it('does not request a preview when no complete route is available', () => {
    const query = jest.fn();
    renderHook(() => useOneClickQuote(undefined, query, 300));

    act(() => jest.advanceTimersByTime(300));
    expect(query).not.toHaveBeenCalled();
  });

  it('refreshes a visible amount preview every 30 seconds', async () => {
    let count = 0;
    const query = jest.fn(async () => response(`quote-${String(++count)}`));
    renderHook(() => useOneClickQuote(request('1000000'), query, 300));

    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(query).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('oneClickQuoteExpired', () => {
  it('treats the provider deadline as expired at the deadline and when missing', () => {
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    expect(oneClickQuoteExpired(response('fresh'), now)).toBe(false);
    expect(oneClickQuoteExpired(response('expired', '2026-10-22T12:00:00.000Z'), now)).toBe(true);
    const noDeadline = response('missing');
    delete noDeadline.quote.deadline;
    expect(oneClickQuoteExpired(noDeadline, now)).toBe(true);
    expect(oneClickQuoteExpired(response('malformed', 'bad'), now)).toBe(true);
  });
});
