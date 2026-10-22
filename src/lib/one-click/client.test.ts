/** @jest-environment node */

import { fetchOneClickAssets, isSameOneClickUnderlyingAsset, requestOneClickQuote } from './client';
import type { OneClickConfig, OneClickQuoteRequest } from './types';

const config: OneClickConfig = {
  serviceUrl: 'https://proxy.example',
  midenAssets: [{ assetId: 'miden:usdc', faucetId: '0x123456789012345678901234567890', decimals: 6 }]
};

const input: OneClickQuoteRequest = {
  amount: '1000000',
  originAsset: { assetId: 'eth:native', blockchain: 'eth', symbol: 'ETH', decimals: 18, contractAddress: 'native', chainId: 1 },
  destinationAsset: { assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6, faucetId: '0x123456789012345678901234567890' },
  refundTo: '0x1111111111111111111111111111111111111111',
  recipient: 'miden-account',
  deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
  slippageTolerance: 100
};

const originalFetch = globalThis.fetch;
const fetchMock = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}));

describe('1Click client', () => {
  beforeEach(() => { globalThis.fetch = fetchMock; });
  afterEach(() => {
    fetchMock.mockReset();
    jest.useRealTimers();
    if (originalFetch) globalThis.fetch = originalFetch;
    else Reflect.deleteProperty(globalThis, 'fetch');
  });

  it('allows loopback HTTP only in the explicitly targeted testnet E2E build', async () => {
    const loopbackConfig = { ...config, serviceUrl: 'http://127.0.0.1:8550' };
    const saved = {
      e2e: process.env.MIDEN_E2E_TEST,
      oneClick: process.env.MIDEN_E2E_ONE_CLICK_TESTNET,
      network: process.env.MIDEN_NETWORK
    };
    try {
      delete process.env.MIDEN_E2E_TEST;
      delete process.env.MIDEN_E2E_ONE_CLICK_TESTNET;
      process.env.MIDEN_NETWORK = 'localhost';
      await expect(fetchOneClickAssets(loopbackConfig, async () => ({ decimals: 6, symbol: 'USDC' }))).rejects.toThrow('Invalid 1Click service URL');

      process.env.MIDEN_E2E_TEST = 'true';
      process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
      fetchMock.mockResolvedValue(Response.json([]));
      await expect(fetchOneClickAssets(loopbackConfig, async () => ({ decimals: 6, symbol: 'USDC' }))).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:8550\/v0\/tokens$/), expect.anything());
    } finally {
      if (saved.e2e === undefined) delete process.env.MIDEN_E2E_TEST;
      else process.env.MIDEN_E2E_TEST = saved.e2e;
      if (saved.oneClick === undefined) delete process.env.MIDEN_E2E_ONE_CLICK_TESTNET;
      else process.env.MIDEN_E2E_ONE_CLICK_TESTNET = saved.oneClick;
      if (saved.network === undefined) delete process.env.MIDEN_NETWORK;
      else process.env.MIDEN_NETWORK = saved.network;
    }
  });

  it('does not invent a Miden asset absent from the live provider catalog', async () => {
    fetchMock.mockResolvedValue(Response.json([
      { assetId: 'eth:native', blockchain: 'eth', symbol: 'ETH', decimals: 18 },
      { assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH', decimals: 18 },
      { assetId: 'eth:unverified-native', blockchain: 'eth', symbol: 'ETH', decimals: 18, contractAddress: 'native' },
      { assetId: 'sol:token', blockchain: 'sol', symbol: 'TOKEN', decimals: 9, contractAddress: 'So11111111111111111111111111111111111111112' }
    ]));
    const resolver = jest.fn(async () => ({ decimals: 6, symbol: 'USDC' }));
    const assets = await fetchOneClickAssets(config, resolver);
    expect(assets.map(asset => asset.assetId)).toEqual(['eth:native', 'nep141:eth.omft.near', 'sol:token']);
    expect(assets.find(asset => asset.assetId === 'eth:native')?.contractAddress).toBeUndefined();
    expect(assets.find(asset => asset.assetId === 'nep141:eth.omft.near')?.contractAddress).toBe('native');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('requires both provider and on-chain Miden decimals to match the configured mapping', async () => {
    fetchMock.mockResolvedValue(Response.json([
      { assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6 }
    ]));
    const assets = await fetchOneClickAssets(config, async () => ({ decimals: 9, symbol: 'USDC' }));
    expect(assets).toEqual([]);
  });

  it('preserves canonical IDs from the provider catalog and matches underlying assets without symbols', async () => {
    fetchMock.mockResolvedValue(Response.json([
      { assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USD Coin', decimals: 6, coingeckoId: 'usd-coin' },
      { assetId: 'nep141:usdc', blockchain: 'eth', symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
      { assetId: 'nep141:other', blockchain: 'eth', symbol: 'USDC', decimals: 6 }
    ]));
    const assets = await fetchOneClickAssets(config, async () => ({ decimals: 6, symbol: 'USDC' }));
    const miden = assets.find(asset => asset.blockchain === 'miden');
    const evm = assets.find(asset => asset.assetId === 'nep141:usdc');
    const other = assets.find(asset => asset.assetId === 'nep141:other');
    expect(miden?.coingeckoId).toBe('usd-coin');
    expect(miden && evm && isSameOneClickUnderlyingAsset(miden, evm)).toBe(true);
    expect(evm && other && isSameOneClickUnderlyingAsset(evm, other)).toBe(false);
    expect(evm && isSameOneClickUnderlyingAsset({ ...evm, assetId: 'same' }, { ...evm, assetId: 'same' })).toBe(true);
  });

  it('keeps the 1Click signer credential off the client and rejects an unsigned quote before returning it', async () => {
    fetchMock.mockResolvedValue(Response.json({
      correlationId: 'trace',
      timestamp: '2026-10-22T10:00:00.000Z',
      signature: 'ed25519:invalid',
      quoteRequest: {
        dry: true,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: 'eth:native',
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: 'miden:usdc',
        amount: '1000000',
        refundTo: input.refundTo,
        refundType: 'ORIGIN_CHAIN',
        recipient: input.recipient,
        recipientType: 'DESTINATION_CHAIN',
        deadline: input.deadline
      },
      quote: {
        amountIn: '1000000', amountInFormatted: '1', amountInUsd: '1', minAmountIn: '1000000',
        amountOut: '1000000', amountOutFormatted: '1', amountOutUsd: '1', minAmountOut: '999000', timeEstimate: 10
      }
    }));
    await expect(requestOneClickQuote(config, input)).rejects.toThrow('signature');
    expect(fetchMock).toHaveBeenCalledWith('https://proxy.example/v0/quote', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(expect.not.objectContaining({ Authorization: expect.anything() }));
  });

  it('exposes only the HTTP status for quote-unavailable dry probes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'Failed to get quote', token: 'do-not-expose' }), { status: 400 }));
    await expect(requestOneClickQuote(config, input)).rejects.toMatchObject({
      name: 'OneClickHttpError',
      status: 400,
      message: '1Click request failed (400)'
    });
  });

  it('rejects invalid config mappings and fees before any request', async () => {
    await expect(fetchOneClickAssets({ ...config, midenAssets: [{ ...config.midenAssets[0]!, decimals: Number.MAX_SAFE_INTEGER + 1 }] }, async () => ({ decimals: 6 })))
      .rejects.toThrow('asset configuration');
    await expect(requestOneClickQuote({ ...config, appFees: [{ recipient: 'wallet.near', fee: 1001 }] }, input))
      .rejects.toThrow('fee configuration');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps response bodies by UTF-8 byte length rather than decoded string length', async () => {
    fetchMock.mockResolvedValue(new Response('€'.repeat(400_000)));
    await expect(fetchOneClickAssets(config, async () => ({ decimals: 6 }))).rejects.toThrow('too large');
  });
});
