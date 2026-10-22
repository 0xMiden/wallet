import { request as httpRequest } from 'node:http';

import {
  FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY,
  FakeOneClickService,
  signFakeOneClickQuote
} from './fake-one-click-service';
import { parseOneClickQuoteResponse } from '../../../src/lib/one-click/client';
import { verifyOneClickQuoteSignature } from '../../../src/lib/one-click/signature';
import type { OneClickAsset, OneClickSignedRequest } from '../../../src/lib/one-click/types';

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

describe('fake 1Click default quote amounts', () => {
  it('formats amounts from configured token decimals', async () => {
    const ethAsset: OneClickAsset = {
      assetId: 'nep141:eth.omft.near',
      blockchain: 'eth',
      symbol: 'ETH',
      decimals: 18,
      chainId: 1
    };
    const usdcAsset: OneClickAsset = { assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6 };
    const service = new FakeOneClickService({ tokens: [ethAsset, usdcAsset] });
    await service.start();
    try {
      const request: OneClickSignedRequest = {
        dry: true,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: ethAsset.assetId,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: usdcAsset.assetId,
        amount: '1250000000000000000',
        refundTo: '0x1111111111111111111111111111111111111111',
        refundType: 'ORIGIN_CHAIN',
        recipient: 'miden-account',
        recipientType: 'DESTINATION_CHAIN',
        deadline: '2026-10-22T12:15:00.000Z'
      };
      const response = await postJson(`${service.baseUrl}/v0/quote`, request);
      expect(response.status).toBe(200);
      const quote = parseOneClickQuoteResponse(response.body);

      expect(quote.quote.amountInFormatted).toBe('1.25');
      expect(quote.quote.amountOut).toBe('1250000');
      expect(quote.quote.minAmountOut).toBe('1250000');
      expect(quote.quote.amountOutFormatted).toBe('1.25');
    } finally {
      await service.stop();
    }
  });
});

function postJson(url: string, body: unknown): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        raw += chunk;
      });
      response.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(raw);
          resolve({ status: response.statusCode, body: parsed });
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
