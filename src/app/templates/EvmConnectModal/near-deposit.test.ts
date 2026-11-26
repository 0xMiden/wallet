import type { OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';

import { NEAR_ROUTE_ID } from './deposit-routes';
import {
  isNearNoLiquidity,
  isUsableRefundAddress,
  NEAR_QUOTE_LIFETIME_MS,
  nearCapInput,
  nearFeeOf,
  nearQuoteDeadline,
  nearQuoteFee,
  nearQuoteReceived,
  nearQuoteRouteKey,
  nearRefundAddressOf,
  nearRouteOption,
  NO_FEE_YET,
  quoteUsdOf
} from './near-deposit';

const RELAY = '0x1111111111111111111111111111111111111111';
const EVM = '0x2222222222222222222222222222222222222222';
const EVM_PLACEHOLDER = '0x15da65977522e0f70204b5795c3f90eee9ae6812';

function quote(fields: Partial<OneClickQuoteResponse['quote']> = {}): OneClickQuoteResponse {
  return {
    correlationId: 'c',
    timestamp: '2026-11-27T00:00:00.000Z',
    signature: 's',
    quoteRequest: {
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'o',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'd',
      amount: '10000000',
      refundTo: RELAY,
      refundType: 'ORIGIN_CHAIN',
      recipient: 'r',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-11-27T00:05:00.000Z'
    },
    quote: {
      amountIn: '10000000',
      amountInFormatted: '10',
      amountInUsd: '10.00',
      minAmountIn: '10000000',
      amountOut: '9800000',
      amountOutFormatted: '9.8',
      amountOutUsd: '9.80',
      minAmountOut: '9700000',
      timeEstimate: 120,
      ...fields
    }
  };
}

const REQUEST: OneClickQuoteRequest = {
  amount: '1',
  originAsset: { assetId: 'o', blockchain: 'sol', symbol: 'SOL', decimals: 9 },
  destinationAsset: { assetId: 'd', blockchain: 'miden', symbol: 'SOL', decimals: 8 },
  refundTo: 'refund',
  recipient: 'r',
  deadline: '2026-11-27T00:05:00.000Z',
  slippageTolerance: 100
};

describe('near deposit helpers', () => {
  it('asks for a deadline five minutes from now', () => {
    const before = Date.now();
    const deadline = Date.parse(nearQuoteDeadline());
    expect(deadline - before).toBeGreaterThanOrEqual(NEAR_QUOTE_LIFETIME_MS - 1000);
    expect(deadline - before).toBeLessThanOrEqual(NEAR_QUOTE_LIFETIME_MS + 1000);
  });

  it('keys a route by everything but the deadline', () => {
    expect(nearQuoteRouteKey(REQUEST)).toBe(nearQuoteRouteKey({ ...REQUEST, deadline: '2030-01-01T00:00:00.000Z' }));
    expect(nearQuoteRouteKey(REQUEST)).not.toBe(nearQuoteRouteKey({ ...REQUEST, amount: '2' }));
  });

  it('tells a no-liquidity refusal from another failure', () => {
    expect(isNearNoLiquidity(Object.assign(new Error('x'), { code: 'no_liquidity' }))).toBe(true);
    expect(isNearNoLiquidity(new Error('x'))).toBe(false);
    expect(isNearNoLiquidity(undefined)).toBe(false);
  });

  it('takes a refund address only when it is valid for the chain kind and is no preview placeholder', () => {
    expect(isUsableRefundAddress('evm', ` ${EVM} `)).toBe(true);
    expect(isUsableRefundAddress('evm', 'nope')).toBe(false);
    expect(isUsableRefundAddress('evm', '')).toBe(false);
    expect(isUsableRefundAddress('evm', EVM_PLACEHOLDER)).toBe(false);
  });

  it('refunds an EVM deposit to the relay address, else the EVM address, and has none for another chain', () => {
    expect(nearRefundAddressOf({ relayEvmAddress: RELAY, evmAddress: EVM }, 'evm')).toBe(RELAY);
    expect(nearRefundAddressOf({ evmAddress: EVM }, 'evm')).toBe(EVM);
    expect(nearRefundAddressOf({ relayEvmAddress: 'bad', evmAddress: EVM }, 'evm')).toBe(EVM);
    expect(nearRefundAddressOf({}, 'evm')).toBeUndefined();
    expect(nearRefundAddressOf({ relayEvmAddress: RELAY, evmAddress: EVM }, 'solana')).toBeUndefined();
  });

  it('reads a USD text as a number', () => {
    expect(quoteUsdOf(undefined)).toBeUndefined();
    expect(quoteUsdOf(' ')).toBeUndefined();
    expect(quoteUsdOf('abc')).toBeUndefined();
    expect(quoteUsdOf('1.5')).toBe(1.5);
  });

  it('reads what the quote delivers in base units', () => {
    expect(nearQuoteReceived(quote(), 6)).toEqual({ amount: 9_800_000n, decimals: 6 });
    expect(nearQuoteReceived(quote({ amountOut: '9.8' }), 6)).toBeUndefined();
  });

  it('takes the fee as the share of the input value that does not arrive', () => {
    expect(nearQuoteFee(quote(), 6)).toEqual({
      fee: { kind: 'amount', value: { amount: 200_000n, decimals: 6 } },
      share: expect.closeTo(0.02, 10)
    });
    expect(nearQuoteFee(quote({ amountOutUsd: '10.00' }), 6)).toEqual({ fee: { kind: 'none' }, share: 0 });
    expect(nearQuoteFee(quote({ amountOutUsd: '' }), 6)).toBeUndefined();
    expect(nearQuoteFee(quote({ amountInUsd: '0' }), 6)).toBeUndefined();
    expect(nearQuoteFee(quote({ amountIn: 'x' }), 6)).toBeUndefined();
  });

  it('shows the fee of a quote, loading while it is on its way, and a dash else', () => {
    expect(nearFeeOf(quote(), 6, false, 'loading')).toEqual({
      kind: 'amount',
      value: { amount: 200_000n, decimals: 6 }
    });
    expect(nearFeeOf(quote({ amountInUsd: '' }), 6, false, 'loading')).toEqual({ kind: 'rate', text: NO_FEE_YET });
    expect(nearFeeOf(undefined, 6, true, 'loading')).toEqual({ kind: 'rate', text: 'loading' });
    expect(nearFeeOf(undefined, 6, false, 'loading')).toEqual({ kind: 'rate', text: NO_FEE_YET });
  });

  it('weighs a deposit against the cap by the USD value that arrives', () => {
    expect(nearCapInput(undefined)).toEqual({ depositAmount: null, depositPriceUsd: undefined });
    expect(nearCapInput(quote())).toEqual({ depositAmount: 9.8, depositPriceUsd: 1 });
    expect(nearCapInput(quote({ amountOutUsd: 'x' }))).toEqual({ depositAmount: 1, depositPriceUsd: undefined });
    expect(nearCapInput(quote({ amountOutUsd: '-1' }))).toEqual({ depositAmount: 1, depositPriceUsd: undefined });
  });

  it('builds the NEAR Intents row of the route sheet from its quote', () => {
    const base = {
      name: 'NEAR Intents',
      arrivesIn: '2 to 3 minutes',
      loadingText: 'loading',
      waiting: false,
      sourceDecimals: 6,
      outputDecimals: 6,
      selected: false
    };
    expect(nearRouteOption({ ...base, quote: quote() })).toEqual({
      id: NEAR_ROUTE_ID,
      name: 'NEAR Intents',
      arrivesIn: '2 to 3 minutes',
      received: { amount: 9_800_000n, decimals: 6 },
      fee: { kind: 'amount', value: { amount: 200_000n, decimals: 6 } },
      best: false,
      fastest: false,
      selected: false
    });
    expect(nearRouteOption({ ...base, quote: undefined, waiting: true })).toMatchObject({
      received: undefined,
      fee: { kind: 'rate', text: 'loading' }
    });
  });
});
