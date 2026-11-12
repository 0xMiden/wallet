import { request as httpRequest } from 'node:http';

import {
  bech32Segwit,
  FAKE_NEAR_INTENTS_ORIGIN_TOKENS,
  FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY,
  fakeDepositAddress,
  FakeOneClickService,
  signFakeOneClickQuote
} from './fake-one-click-service';
import { isValidNearIntentsAddress } from '../../../src/lib/one-click/address';
import { parseOneClickQuoteResponse } from '../../../src/lib/one-click/client';
import { verifyOneClickQuoteSignature } from '../../../src/lib/one-click/signature';
import type {
  NearIntentsAddressKind,
  OneClickAsset,
  OneClickSignedRequest
} from '../../../src/lib/one-click/types';

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

describe('fake 1Click deposit addresses', () => {
  it('encodes the BIP 173 witness version 0 test vector', () => {
    const program = Uint8Array.from(Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex'));
    expect(bech32Segwit('bc', 0, program)).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  });

  it.each<[string, NearIntentsAddressKind]>([
    ['sol', 'solana'],
    ['btc', 'bitcoin'],
    ['near', 'near'],
    ['eth', 'evm']
  ])('gives a %s deposit address in the format of that chain', (blockchain, kind) => {
    const first = fakeDepositAddress(blockchain, 1);
    expect(isValidNearIntentsAddress(kind, first)).toBe(true);
    expect(fakeDepositAddress(blockchain, 1)).toBe(first);
    expect(fakeDepositAddress(blockchain, 2)).not.toBe(first);
  });
});

describe('fake 1Click deposit flow without a deposit submission', () => {
  const midenAsset: OneClickAsset = { assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6 };
  const solAsset = FAKE_NEAR_INTENTS_ORIGIN_TOKENS.find(asset => asset.blockchain === 'sol');

  function wetRequest(originAsset: string): OneClickSignedRequest {
    return {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: midenAsset.assetId,
      amount: '1500000000',
      refundTo: fakeDepositAddress('sol', 99),
      refundType: 'ORIGIN_CHAIN',
      recipient: 'miden-account',
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 60 * 60_000).toISOString()
    };
  }

  it('lists the origin tokens that are not on an EVM chain', async () => {
    const service = new FakeOneClickService({ tokens: [...FAKE_NEAR_INTENTS_ORIGIN_TOKENS, midenAsset] });
    await service.start();
    try {
      const listed = await getJson(`${service.baseUrl}/v0/tokens`);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([...FAKE_NEAR_INTENTS_ORIGIN_TOKENS, midenAsset]);
      expect(FAKE_NEAR_INTENTS_ORIGIN_TOKENS.map(asset => asset.blockchain)).toEqual(['sol', 'btc', 'near']);
    } finally {
      await service.stop();
    }
  });

  it('moves one deposit through PENDING_DEPOSIT, PROCESSING and SUCCESS on status reads alone', async () => {
    if (!solAsset) throw new Error('The fake origin tokens must list SOL');
    const service = new FakeOneClickService({ tokens: [...FAKE_NEAR_INTENTS_ORIGIN_TOKENS, midenAsset] });
    await service.start();
    try {
      const quoted = await postJson(`${service.baseUrl}/v0/quote`, wetRequest(solAsset.assetId));
      const quote = parseOneClickQuoteResponse(quoted.body);
      const depositAddress = quote.quote.depositAddress;
      if (!depositAddress) throw new Error('The fake wet quote has no deposit address');
      expect(isValidNearIntentsAddress('solana', depositAddress)).toBe(true);
      expect(service.latestDeposit()).toEqual({ depositAddress, request: quote.quoteRequest });
      expect(quote.quote.amountOut).toBe('1500000');

      const statusUrl = `${service.baseUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`;
      const statusOf = async (): Promise<unknown> => {
        const response = await getJson(statusUrl);
        return isRecord(response.body) ? response.body.status : undefined;
      };
      expect(await statusOf()).toBe('PENDING_DEPOSIT');
      service.setDepositStatus(depositAddress, 'PROCESSING', { depositedAmount: '1500000000' });
      expect(await statusOf()).toBe('PROCESSING');
      service.setDepositStatus(depositAddress, 'SUCCESS', { amountOut: '1500000' });
      expect(await statusOf()).toBe('SUCCESS');
      expect(service.requests.some(entry => entry.path === '/v0/deposit/submit')).toBe(false);
    } finally {
      await service.stop();
    }
  });

  it('keeps the status of one deposit apart from another deposit', async () => {
    if (!solAsset) throw new Error('The fake origin tokens must list SOL');
    const service = new FakeOneClickService({ tokens: [...FAKE_NEAR_INTENTS_ORIGIN_TOKENS, midenAsset] });
    await service.start();
    try {
      const first = parseOneClickQuoteResponse(
        (await postJson(`${service.baseUrl}/v0/quote`, wetRequest(solAsset.assetId))).body
      );
      const second = parseOneClickQuoteResponse(
        (await postJson(`${service.baseUrl}/v0/quote`, wetRequest(solAsset.assetId))).body
      );
      const firstAddress = first.quote.depositAddress;
      const secondAddress = second.quote.depositAddress;
      if (!firstAddress || !secondAddress) throw new Error('The fake wet quotes have no deposit address');
      expect(firstAddress).not.toBe(secondAddress);

      service.setDepositStatus(firstAddress, 'SUCCESS');
      const secondStatus = await getJson(
        `${service.baseUrl}/v0/status?depositAddress=${encodeURIComponent(secondAddress)}`
      );
      expect(isRecord(secondStatus.body) ? secondStatus.body.status : undefined).toBe('PENDING_DEPOSIT');
      expect(() => service.setDepositStatus('unknown', 'SUCCESS')).toThrow();
    } finally {
      await service.stop();
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getJson(url: string): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, response => {
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
    req.end();
  });
}

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
