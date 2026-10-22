/** @jest-environment node */

import { parseOneClickQuoteResponse } from './client';
import { verifyOneClickQuoteSignature } from './signature';
import type { OneClickAsset, OneClickDestinationReceipt, OneClickSignedRequest } from './types';
import {
  FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY,
  FakeOneClickService,
  signFakeOneClickQuote
} from '../../../playwright/e2e/helpers/fake-one-click-service';

const faucetId = `0x${'12'.repeat(15)}`;
const assets: OneClickAsset[] = [
  {
    assetId: 'nep141:eth-0x1111111111111111111111111111111111111111.omft.near',
    blockchain: 'eth',
    symbol: 'USDC',
    decimals: 6,
    contractAddress: '0x1111111111111111111111111111111111111111',
    chainId: 1
  },
  { assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6, faucetId }
];

function quoteRequest(dry: boolean): OneClickSignedRequest {
  return {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: assets[0]?.assetId ?? '',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: assets[1]?.assetId ?? '',
    amount: '1000000',
    refundTo: '0x2222222222222222222222222222222222222222',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'miden-account',
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 60 * 60_000).toISOString()
  };
}

function requestBody(request: OneClickSignedRequest): Record<string, unknown> {
  return { ...request };
}

describe('fake 1Click test service', () => {
  let service: FakeOneClickService;

  beforeEach(async () => {
    service = new FakeOneClickService({ tokens: assets });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
  });

  it('signs exact-input quote responses with its exported deterministic manager key', async () => {
    const request = quoteRequest(true);
    const firstResponse = await fetch(`${service.baseUrl}/v0/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(request))
    });
    const first = parseOneClickQuoteResponse(await firstResponse.json());
    const second = signFakeOneClickQuote({
      correlationId: first.correlationId,
      timestamp: first.timestamp,
      quoteRequest: first.quoteRequest,
      quote: first.quote
    });
    expect(first.signature).toBe(second.signature);
    expect(verifyOneClickQuoteSignature(first, FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY)).toBe(true);
    expect(first.quoteRequest).toMatchObject({ dry: true, originAsset: request.originAsset, amount: request.amount });
    expect(first.quote.depositAddress).toBeUndefined();
  });

  it('rejects malformed fee entries instead of signing a filtered request', async () => {
    const response = await fetch(`${service.baseUrl}/v0/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...requestBody(quoteRequest(true)), appFees: [{ recipient: 'miden', fee: '10' }] })
    });
    expect(response.status).toBe(400);
  });

  it('uses the fake signing key only in the explicitly targeted testnet E2E build', async () => {
    const request = quoteRequest(true);
    const response = await fetch(`${service.baseUrl}/v0/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(request))
    });
    const quote = parseOneClickQuoteResponse(await response.json());
    const saved = {
      e2e: process.env.MIDEN_E2E_TEST,
      oneClickE2e: process.env.MIDEN_E2E_ONE_CLICK_TESTNET,
      network: process.env.MIDEN_NETWORK,
      publicKey: process.env.MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY
    };
    try {
      delete process.env.MIDEN_E2E_TEST;
      delete process.env.MIDEN_E2E_ONE_CLICK_TESTNET;
      process.env.MIDEN_NETWORK = 'localhost';
      process.env.MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY = FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY;
      expect(verifyOneClickQuoteSignature(quote)).toBe(false);

      process.env.MIDEN_E2E_TEST = 'true';
      process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
      expect(verifyOneClickQuoteSignature(quote)).toBe(true);
    } finally {
      restore('MIDEN_E2E_TEST', saved.e2e);
      restore('MIDEN_E2E_ONE_CLICK_TESTNET', saved.oneClickE2e);
      restore('MIDEN_NETWORK', saved.network);
      restore('MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY', saved.publicKey);
    }
  });

  it('serves a token catalog and programmable wet quote over the expected routes', async () => {
    service.setQuoteBuilder((_request, defaults) => ({
      ...defaults,
      amountOut: '900000',
      minAmountOut: '890000',
      amountOutFormatted: '0.9',
      amountOutUsd: '0.9',
      refundFee: '10'
    }));
    const listedResponse = await fetch(`${service.baseUrl}/v0/tokens`);
    const listed: unknown = await listedResponse.json();
    expect(listed).toEqual(assets);

    const request = quoteRequest(false);
    const quoteResponse = await fetch(`${service.baseUrl}/v0/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(request))
    });
    const quote = parseOneClickQuoteResponse(await quoteResponse.json());
    expect(verifyOneClickQuoteSignature(quote, FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY)).toBe(true);
    expect(quote.quote).toMatchObject({ amountOut: '900000', minAmountOut: '890000', refundFee: '10' });
    expect(quote.quote.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(service.requests.map(entry => entry.path)).toEqual(['/v0/tokens', '/v0/quote']);
  });

  it('programs signed status changes, deposit submission, and exact receipt mappings', async () => {
    const request = quoteRequest(false);
    const quoteResponse = await fetch(`${service.baseUrl}/v0/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(request))
    });
    const quote = parseOneClickQuoteResponse(await quoteResponse.json());
    const depositAddress = quote.quote.depositAddress;
    if (!depositAddress) throw new Error('The fake wet quote has no deposit address');

    const txHash = `0x${'aa'.repeat(32)}`;
    const receipts: OneClickDestinationReceipt[] = [{ transactionHash: txHash, noteIds: ['note-1', 'note-2'] }];
    service.setReceipts(receipts);
    service.setStatus('PROCESSING', {
      depositedAmount: request.amount,
      originChainTxHashes: [{ hash: txHash, explorerUrl: 'https://explorer.example/tx' }]
    });
    const submissionResponse = await fetch(`${service.baseUrl}/v0/deposit/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAddress, txHash })
    });
    const submission: unknown = await submissionResponse.json();
    if (!isRecord(submission) || !isRecord(submission.swapDetails)) throw new Error('Invalid fake submit response');
    expect(submission.status).toBe('PROCESSING');
    expect(verifyOneClickQuoteSignature(parseOneClickQuoteResponse(submission.quoteResponse), FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY)).toBe(true);
    expect(submission.swapDetails.depositedAmount).toBe(request.amount);

    const statusResponse = await fetch(`${service.baseUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
    const status: unknown = await statusResponse.json();
    if (!isRecord(status)) throw new Error('Invalid fake status response');
    expect(status.status).toBe('PROCESSING');

    const resolvedResponse = await fetch(`${service.baseUrl}/v1/receipts/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionHashes: [txHash] })
    });
    const resolved: unknown = await resolvedResponse.json();
    expect(resolved).toEqual(receipts);
    expect(service.requests.map(entry => entry.path)).toEqual([
      '/v0/quote', '/v0/deposit/submit', '/v0/status', '/v1/receipts/resolve'
    ]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
