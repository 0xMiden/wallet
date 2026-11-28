import { act, renderHook } from '@testing-library/react';

import { requestOneClickQuote } from 'lib/one-click/client';
import type { NearIntentsConfig, OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';
import type { ResolvedNearIntentsSelection } from 'screens/near-intents-flow/chains';
import { PREVIEW_DEBOUNCE_MS } from 'screens/near-intents-flow/usePolledPreview';

import {
  nearAmountUnits,
  type NearDepositQuoteInput,
  nearDryQuoteQuery,
  useNearDepositQuote
} from './useNearDepositQuote';

jest.mock('lib/one-click/client', () => ({ requestOneClickQuote: jest.fn() }));

const CONFIG: NearIntentsConfig = { serviceUrl: 'https://one-click.test', chains: [], midenAssets: [] };
const ROUTE: ResolvedNearIntentsSelection = {
  chain: { id: 'sol', name: 'Solana', addressKind: 'solana', tokens: [] },
  token: {
    symbol: 'SOL',
    asset: { assetId: 'sol:SOL', blockchain: 'sol', symbol: 'SOL', decimals: 9 },
    outputs: []
  },
  output: { assetId: 'miden:wsol', blockchain: 'miden', symbol: 'wSOL', decimals: 8, faucetId: 'wsol' }
};
const QUOTE: OneClickQuoteResponse = {
  correlationId: 'c',
  timestamp: '2026-11-27T00:00:00.000Z',
  signature: 's',
  quoteRequest: {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'sol:SOL',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'miden:wsol',
    amount: '2000000000',
    refundTo: 'r',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'miden-account',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-27T00:05:00.000Z'
  },
  quote: {
    amountIn: '2000000000',
    amountInFormatted: '2',
    amountInUsd: '360',
    minAmountIn: '2000000000',
    amountOut: '197000000',
    amountOutFormatted: '1.97',
    amountOutUsd: '354.6',
    minAmountOut: '195000000',
    timeEstimate: 120
  }
};

const QUOTE_REQUEST: OneClickQuoteRequest = {
  amount: '2000000000',
  originAsset: ROUTE.token.asset,
  destinationAsset: ROUTE.output,
  refundTo: 'r',
  recipient: 'miden-account',
  deadline: '2026-11-27T00:05:00.000Z',
  slippageTolerance: 100
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(requestOneClickQuote).mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('nearAmountUnits', () => {
  it('reads a typed amount in base units, and nothing for an empty, zero or too precise amount', () => {
    expect(nearAmountUnits('1.5', 6)).toBe(1_500_000n);
    expect(nearAmountUnits('', 6)).toBeUndefined();
    expect(nearAmountUnits('0', 6)).toBeUndefined();
    expect(nearAmountUnits('1.1234567', 6)).toBeUndefined();
  });
});

describe('nearDryQuoteQuery', () => {
  it('asks 1Click for a dry quote with the config', async () => {
    jest.mocked(requestOneClickQuote).mockResolvedValue(QUOTE);
    const signal = new AbortController().signal;
    await expect(nearDryQuoteQuery(CONFIG)(QUOTE_REQUEST, signal)).resolves.toBe(QUOTE);
    expect(requestOneClickQuote).toHaveBeenCalledWith(CONFIG, QUOTE_REQUEST, true, undefined, signal);
  });

  it('fails every query with no config', async () => {
    await expect(nearDryQuoteQuery(null)(QUOTE_REQUEST, new AbortController().signal)).rejects.toThrow(
      'NEAR Intents is off'
    );
    expect(requestOneClickQuote).not.toHaveBeenCalled();
  });
});

describe('useNearDepositQuote', () => {
  const input: NearDepositQuoteInput = {
    config: CONFIG,
    route: ROUTE,
    amount: '2',
    refundTo: undefined,
    recipient: 'miden-account',
    active: true
  };

  it('asks for nothing while the inputs are not complete', () => {
    const { result } = renderHook(() => useNearDepositQuote({ ...input, config: null }));
    expect(result.current).toEqual({ loading: false, amountUnits: 2_000_000_000n });
    const noRoute = renderHook(() => useNearDepositQuote({ ...input, route: undefined }));
    expect(noRoute.result.current.amountUnits).toBeUndefined();
    const noRecipient = renderHook(() => useNearDepositQuote({ ...input, recipient: undefined }));
    expect(noRecipient.result.current.request).toBeUndefined();
  });

  it('quotes the dry request with the preview refund address until a usable one is given', async () => {
    jest.mocked(requestOneClickQuote).mockResolvedValue(QUOTE);
    const { result, rerender } = renderHook(props => useNearDepositQuote(props), { initialProps: input });

    expect(result.current.request).toMatchObject({
      amount: '2000000000',
      refundTo: 'ES452S7HwooFCN93gENCAzQ8oSywVFpjNHFGRv4kUgtx',
      recipient: 'miden-account',
      slippageTolerance: 100
    });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    });
    expect(requestOneClickQuote).toHaveBeenCalledWith(
      CONFIG,
      result.current.request,
      true,
      undefined,
      expect.anything()
    );
    expect(result.current.quote).toBe(QUOTE);

    rerender({ ...input, refundTo: 'MyRefund' });
    expect(result.current.request?.refundTo).toBe('MyRefund');
    // A new request clears the quote until its own answer.
    expect(result.current.quote).toBeUndefined();
  });

  it('moves the deadline forward while it polls', async () => {
    const { result } = renderHook(() => useNearDepositQuote(input));
    const first = result.current.request?.deadline;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(240_000);
    });
    expect(result.current.request?.deadline).not.toBe(first);
  });

  it('reports a failed quote', async () => {
    jest.mocked(requestOneClickQuote).mockRejectedValue(new Error('refused'));
    const { result } = renderHook(() => useNearDepositQuote(input));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    });
    expect(result.current.error?.message).toBe('refused');
    expect(result.current.loading).toBe(false);
  });
});
