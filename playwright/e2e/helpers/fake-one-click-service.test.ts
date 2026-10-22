import { verifyOneClickQuoteSignature } from '../../../src/lib/one-click/signature';
import { FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY, signFakeOneClickQuote } from './fake-one-click-service';

describe('fake 1Click quote signatures', () => {
  it('signs a quote that the wallet verifies with the fake manager key', () => {
    const response = signFakeOneClickQuote({
      correlationId: 'fake-signature-test',
      timestamp: '2026-10-22T12:00:00.000Z',
      quoteRequest: {
        dry: true,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: 'eth:usdc',
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: 'miden:usdc',
        amount: '1000000',
        refundTo: '0x1111111111111111111111111111111111111111',
        refundType: 'ORIGIN_CHAIN',
        recipient: 'miden-account',
        recipientType: 'DESTINATION_CHAIN',
        deadline: '2026-10-22T12:15:00.000Z'
      },
      quote: {
        amountIn: '1000000',
        amountInFormatted: '1',
        amountInUsd: '1',
        minAmountIn: '1000000',
        amountOut: '999000',
        amountOutFormatted: '0.999',
        amountOutUsd: '0.999',
        minAmountOut: '998000',
        timeEstimate: 60
      }
    });

    expect(verifyOneClickQuoteSignature(response, FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY)).toBe(true);
  });
});
