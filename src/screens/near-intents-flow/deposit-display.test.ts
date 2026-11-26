import {
  nearIntentsBridgeFee,
  nearIntentsChainName,
  nearIntentsDepositedValue,
  nearIntentsReceivedValue,
  nearIntentsSentValue,
  quoteAmountValue
} from './deposit-display';
import { nearTrackingFixture } from './testing';

const withQuote = (patch: Partial<ReturnType<typeof nearTrackingFixture>['quote']['quote']>) => {
  const tracking = nearTrackingFixture();
  tracking.quote = { ...tracking.quote, quote: { ...tracking.quote.quote, ...patch } };
  return tracking;
};

describe('quoteAmountValue', () => {
  it('takes valid base units with their decimals, else the formatted text', () => {
    expect(quoteAmountValue('46000000', 6, '46')).toEqual({ amount: 46000000n, decimals: 6 });
    expect(quoteAmountValue('4.6', 6, '4.6')).toEqual({ amount: '4.6' });
    expect(quoteAmountValue(undefined, 6, '46')).toEqual({ amount: '46' });
    expect(quoteAmountValue('46', 39, '46')).toEqual({ amount: '46' });
    expect(quoteAmountValue('46', -1, '46')).toEqual({ amount: '46' });
    expect(quoteAmountValue('46', 1.5, '46')).toEqual({ amount: '46' });
  });
});

describe('NEAR Intents deposit values', () => {
  it('reads what is sent and what arrives from the quote and the row', () => {
    const tracking = nearTrackingFixture({ amount: '45950000' });
    expect(nearIntentsSentValue(tracking)).toEqual({ amount: 46000000n, decimals: 6 });
    expect(nearIntentsReceivedValue(tracking)).toEqual({ amount: 45950000n, decimals: 6 });
  });

  it('reads the deposited amount of an incomplete deposit when 1Click reports it', () => {
    const tracking = nearTrackingFixture();
    expect(nearIntentsDepositedValue(tracking)).toBeUndefined();
    tracking.statusResponse = {
      correlationId: 'c',
      quoteResponse: tracking.quote,
      status: 'INCOMPLETE_DEPOSIT',
      updatedAt: '2026-11-10T14:27:00Z',
      swapDetails: {
        intentHashes: [],
        nearTxHashes: [],
        originChainTxHashes: [],
        destinationChainTxHashes: [],
        depositedAmount: '20000000'
      }
    };
    expect(nearIntentsDepositedValue(tracking)).toEqual({ amount: 20000000n, decimals: 6 });
    tracking.statusResponse.swapDetails.depositedAmount = 'twenty';
    expect(nearIntentsDepositedValue(tracking)).toBeUndefined();
  });

  it('gives the fee as the USD difference, never below zero, and nothing without USD values', () => {
    expect(nearIntentsBridgeFee(nearTrackingFixture())).toEqual({ kind: 'rate', text: '$0.08' });
    expect(nearIntentsBridgeFee(withQuote({ amountOutUsd: '46.10' }))).toEqual({ kind: 'rate', text: '$0.00' });
    expect(nearIntentsBridgeFee(withQuote({ amountInUsd: '' }))).toBeUndefined();
    expect(nearIntentsBridgeFee(withQuote({ amountOutUsd: 'n/a' }))).toBeUndefined();
  });

  it('names the chain from the saved config, else by its 1Click id', () => {
    expect(nearIntentsChainName(nearTrackingFixture())).toBe('Ethereum');
    const tracking = nearTrackingFixture();
    tracking.config = { ...tracking.config, chains: [] };
    expect(nearIntentsChainName(tracking)).toBe('eth');
  });
});
