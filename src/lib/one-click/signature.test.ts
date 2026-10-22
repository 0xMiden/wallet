import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';

import { assertOneClickQuoteBinding, parseOneClickQuoteResponse } from './client';
import { hashOneClickQuote, verifyOneClickQuoteSignature } from './signature';
import dryFixture from './test-fixtures-dry.json';
import wetFixture from './test-fixtures-wet.json';
import type { OneClickQuoteRequest, OneClickQuoteResponse } from './types';

const secretKey = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(secretKey);
function signedResponse(dry: boolean): OneClickQuoteResponse {
  const response: OneClickQuoteResponse = {
    correlationId: 'trace-1',
    timestamp: '2026-10-22T10:00:00.000Z',
    signature: '',
    quoteRequest: {
      dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'eth:0xnative',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'miden:usdc',
      amount: '100',
      refundTo: '0xrefund',
      refundType: 'ORIGIN_CHAIN',
      recipient: 'miden-account',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-10-22T11:00:00.000Z',
      appFees: [{ recipient: 'partner.near', fee: 20 }]
    },
    quote: {
      amountIn: '100',
      amountInFormatted: '1',
      amountInUsd: '1',
      minAmountIn: '100',
      amountOut: '99',
      amountOutFormatted: '0.99',
      amountOutUsd: '0.99',
      minAmountOut: '98',
      timeEstimate: 60,
      ...(dry ? {} : { depositAddress: 'deposit-address', deadline: '2026-10-22T10:45:00.000Z' })
    }
  };
  response.signature = `ed25519:${bs58.encode(ed25519.sign(new TextEncoder().encode(hashOneClickQuote(response)), secretKey))}`;
  return response;
}

describe('OneClick quote signature', () => {
  it.each([dryFixture, wetFixture])('accepts a quote signed by the pinned production signer', fixture => {
    const response = parseOneClickQuoteResponse(fixture);
    expect(verifyOneClickQuoteSignature(response)).toBe(true);
  });

  it.each([true, false])('verifies the official %s quote payload', dry => {
    const response = signedResponse(dry);
    expect(verifyOneClickQuoteSignature(response, `ed25519:${bs58.encode(publicKey)}`)).toBe(true);
  });

  it('rejects a wet quote when the signed deposit address is changed', () => {
    const response = signedResponse(false);
    response.quote.depositAddress = 'attacker-address';
    expect(verifyOneClickQuoteSignature(response, `ed25519:${bs58.encode(publicKey)}`)).toBe(false);
  });

  it('rejects a wet quote when its signed deadline is changed', () => {
    const response = parseOneClickQuoteResponse(wetFixture);
    response.quote.deadline = '2026-10-26T12:15:00.000Z';
    expect(verifyOneClickQuoteSignature(response)).toBe(false);
  });

  it('does not let a valid quote signature authorize a different request', () => {
    const response = parseOneClickQuoteResponse(dryFixture);
    const request = {
      amount: '1000000',
      originAsset: {
        assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
        blockchain: 'eth',
        symbol: 'USDC',
        decimals: 6
      },
      destinationAsset: { assetId: 'nep141:base.omft.near', blockchain: 'base', symbol: 'ETH', decimals: 18 },
      refundTo: '0x1111111111111111111111111111111111111111',
      recipient: '0x2222222222222222222222222222222222222222',
      deadline: '2026-10-22T12:15:00.000Z',
      slippageTolerance: 100
    };
    expect(() =>
      assertOneClickQuoteBinding(request, response, true, { serviceUrl: 'https://proxy.example', midenAssets: [] })
    ).not.toThrow();
    expect(() =>
      assertOneClickQuoteBinding(
        { ...request, recipient: '0x3333333333333333333333333333333333333333' },
        response,
        true,
        { serviceUrl: 'https://proxy.example', midenAssets: [] }
      )
    ).toThrow('requested route');
  });

  it('leaves unsigned app fee edits outside the signed quote payload', () => {
    const response = signedResponse(false);
    const signedHash = hashOneClickQuote(response);
    response.quoteRequest.appFees = [{ recipient: 'attacker.near', fee: 999 }];
    expect(hashOneClickQuote(response)).toBe(signedHash);
    expect(verifyOneClickQuoteSignature(response, `ed25519:${bs58.encode(publicKey)}`)).toBe(true);
  });

  it('binds the unchanged wet fixture before the signed request cutoff even when provider expiry is later', () => {
    const response = parseOneClickQuoteResponse(wetFixture);
    const request: OneClickQuoteRequest = {
      amount: '1000000',
      originAsset: {
        assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
        blockchain: 'eth',
        symbol: 'USDC',
        decimals: 6
      },
      destinationAsset: { assetId: 'nep141:base.omft.near', blockchain: 'base', symbol: 'ETH', decimals: 18 },
      refundTo: '0x1111111111111111111111111111111111111111',
      recipient: '0x2222222222222222222222222222222222222222',
      deadline: '2026-10-22T12:15:00.000Z',
      slippageTolerance: 100
    };
    const config = {
      serviceUrl: 'https://proxy.example',
      midenAssets: [],
      appFees: [{ recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 20 }]
    };
    const requestPayload = JSON.stringify(response.quoteRequest);
    const quotePayload = JSON.stringify(response.quote);
    const signedHash = hashOneClickQuote(response);
    const signedSignature = response.signature;

    jest.useFakeTimers().setSystemTime(new Date('2026-10-22T11:15:08.000Z'));
    try {
      expect(() => assertOneClickQuoteBinding(request, response, false, config)).not.toThrow();
      expect(JSON.stringify(response.quoteRequest)).toBe(requestPayload);
      expect(JSON.stringify(response.quote)).toBe(quotePayload);
      expect(hashOneClickQuote(response)).toBe(signedHash);
      expect(response.signature).toBe(signedSignature);
      expect(verifyOneClickQuoteSignature(response)).toBe(true);

      jest.setSystemTime(new Date(request.deadline));
      expect(() => assertOneClickQuoteBinding(request, response, false, config)).toThrow(/expired|incomplete/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects invalid and oversized Base58 keys', () => {
    const response = signedResponse(false);
    expect(verifyOneClickQuoteSignature(response, 'ed25519:0OIl')).toBe(false);
    expect(verifyOneClickQuoteSignature(response, `ed25519:${'1'.repeat(129)}`)).toBe(false);
  });
});
