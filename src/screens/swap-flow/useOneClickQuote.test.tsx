import { act, renderHook } from '@testing-library/react';

import { OneClickAsset, OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';
import { parseOneClickQuoteResponse } from 'lib/one-click/client';
import dryFixture from 'lib/one-click/test-fixtures-dry.json';

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
      ({ value }: { value: OneClickQuoteRequest }) => useOneClickQuote(value, query),
      { initialProps: { value: request('1000000') } }
    );

    act(() => jest.advanceTimersByTime(350));
    expect(query).toHaveBeenCalledTimes(1);
    rerender({ value: request('2000000', ethereum) });
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

  it('does not request a preview when no complete route is available', () => {
    const query = jest.fn();
    renderHook(() => useOneClickQuote(undefined, query));

    act(() => jest.advanceTimersByTime(350));
    expect(query).not.toHaveBeenCalled();
  });

  it('waits 350 ms before requesting the default preview', async () => {
    const query = jest.fn(async () => response('default-delay'));
    renderHook(() => useOneClickQuote(request('1000000'), query));

    act(() => jest.advanceTimersByTime(349));
    expect(query).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refreshes a visible amount preview every 30 seconds', async () => {
    let count = 0;
    const query = jest.fn(async () => response(`quote-${String(++count)}`));
    renderHook(() => useOneClickQuote(request('1000000'), query));

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

  it('uses the signed request cutoff for dry quotes without a provider expiry', () => {
    const dryQuote = parseOneClickQuoteResponse(dryFixture);
    const cutoff = Date.parse(dryQuote.quoteRequest.deadline);

    expect(dryQuote.quote.deadline).toBeUndefined();
    expect(oneClickQuoteExpired(dryQuote, cutoff - 1)).toBe(false);
    expect(oneClickQuoteExpired(dryQuote, cutoff)).toBe(true);
    expect(oneClickQuoteExpired(dryQuote, cutoff + 1)).toBe(true);
  });

  it('keeps wet quotes unusable when the provider expiry is missing', () => {
    const wetQuote = response('wet', '2026-10-22T12:01:00.000Z');
    wetQuote.quoteRequest.dry = false;
    delete wetQuote.quote.deadline;

    expect(oneClickQuoteExpired(wetQuote, Date.parse('2026-10-22T12:00:00.000Z'))).toBe(true);
  });

  it('expires a wet quote at the earlier signed request cutoff', () => {
    const wetQuote = response('wet', '2026-10-22T12:10:00.000Z');
    wetQuote.quoteRequest.dry = false;
    wetQuote.quoteRequest.deadline = '2026-10-22T12:05:00.000Z';
    const requestCutoff = Date.parse(wetQuote.quoteRequest.deadline);

    expect(oneClickQuoteExpired(wetQuote, requestCutoff - 1)).toBe(false);
    expect(oneClickQuoteExpired(wetQuote, requestCutoff)).toBe(true);
  });
});
