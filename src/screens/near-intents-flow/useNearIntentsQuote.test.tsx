import { act, renderHook } from '@testing-library/react';

import type { OneClickAsset, OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';

import { nearIntentsQuoteExpired, useNearIntentsQuote } from './useNearIntentsQuote';

const ethereum: OneClickAsset = {
  assetId: 'nep141:eth-usdc',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x123'
};
const solana: OneClickAsset = { assetId: 'nep141:sol', blockchain: 'sol', symbol: 'SOL', decimals: 9 };
const miden: OneClickAsset = {
  assetId: 'miden-usdcx',
  blockchain: 'miden',
  symbol: 'USDCx',
  decimals: 6,
  faucetId: 'faucet-usdcx'
};

const request = (amount: string, originAsset = ethereum): OneClickQuoteRequest => ({
  amount,
  originAsset,
  destinationAsset: miden,
  refundTo: '0xrefund',
  recipient: 'mm1recipient',
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
    originAsset: ethereum.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: miden.assetId,
    amount: '1000000',
    refundTo: '0xrefund',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'mm1recipient',
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

describe('useNearIntentsQuote', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('debounces the preview and ignores the answer for an older request', async () => {
    const pending: Array<(quote: OneClickQuoteResponse) => void> = [];
    const query = jest.fn(() => new Promise<OneClickQuoteResponse>(resolve => pending.push(resolve)));
    const { result, rerender } = renderHook(
      ({ value }: { value: OneClickQuoteRequest }) => useNearIntentsQuote(value, query),
      { initialProps: { value: request('1000000') } }
    );

    act(() => jest.advanceTimersByTime(350));
    expect(query).toHaveBeenCalledTimes(1);
    rerender({ value: request('2000000', solana) });
    const oldQuote = pending.shift();
    if (!oldQuote) throw new Error('The first preview did not start');
    await act(async () => oldQuote(response('old')));
    expect(result.current.quote).toBeUndefined();

    act(() => jest.advanceTimersByTime(350));
    expect(query).toHaveBeenCalledTimes(2);
    const newQuote = pending.shift();
    if (!newQuote) throw new Error('The updated preview did not start');
    await act(async () => newQuote(response('new')));
    expect(result.current.quote?.correlationId).toBe('new');
  });

  it('asks for no preview without a request, or while it is not active', () => {
    const query = jest.fn();
    renderHook(() => useNearIntentsQuote(undefined, query));
    renderHook(() => useNearIntentsQuote(request('1000000'), query, false));

    act(() => jest.advanceTimersByTime(30_350));
    expect(query).not.toHaveBeenCalled();
  });

  it('asks again every 30 seconds for the same request', async () => {
    let count = 0;
    const query = jest.fn(async () => response(`quote-${String(++count)}`));
    renderHook(() => useNearIntentsQuote(request('1000000'), query));

    await act(async () => {
      jest.advanceTimersByTime(350);
      await Promise.resolve();
    });
    expect(query).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps the last quote and reports the error when a refresh fails', async () => {
    const query = jest
      .fn<Promise<OneClickQuoteResponse>, [OneClickQuoteRequest]>()
      .mockResolvedValueOnce(response('first'))
      .mockRejectedValueOnce(new Error('refused'));
    const { result } = renderHook(() => useNearIntentsQuote(request('1000000'), query));

    await act(async () => {
      jest.advanceTimersByTime(350);
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(result.current.quote?.correlationId).toBe('first');
    expect(result.current.error?.message).toBe('refused');
  });
});

describe('nearIntentsQuoteExpired', () => {
  const now = Date.parse('2026-10-22T12:00:00.000Z');

  it('expires a dry quote at its signed request deadline', () => {
    const dryQuote = response('dry');
    const cutoff = Date.parse(dryQuote.quoteRequest.deadline);
    expect(nearIntentsQuoteExpired(dryQuote, cutoff - 1)).toBe(false);
    expect(nearIntentsQuoteExpired(dryQuote, cutoff)).toBe(true);
  });

  it('expires a wet quote at its deadline, and when the deadline is missing or malformed', () => {
    const wetQuote = response('fresh');
    wetQuote.quoteRequest.dry = false;
    expect(nearIntentsQuoteExpired(wetQuote, now)).toBe(false);
    const expiredQuote = response('expired', '2026-10-22T12:00:00.000Z');
    expiredQuote.quoteRequest.dry = false;
    expect(nearIntentsQuoteExpired(expiredQuote, now)).toBe(true);
    const noDeadline = response('missing');
    noDeadline.quoteRequest.dry = false;
    delete noDeadline.quote.deadline;
    expect(nearIntentsQuoteExpired(noDeadline, now)).toBe(true);
    const malformed = response('malformed', 'bad');
    malformed.quoteRequest.dry = false;
    expect(nearIntentsQuoteExpired(malformed, now)).toBe(true);
  });
});
