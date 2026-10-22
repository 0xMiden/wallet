/** @jest-environment node */

import {
  fetchOneClickAssets,
  fetchOneClickStatus,
  isSameOneClickUnderlyingAsset,
  parseOneClickQuoteResponse,
  requestOneClickQuote,
  submitOneClickDeposit
} from './client';
import { hashOneClickQuote, verifyOneClickQuoteSignature } from './signature';
import dryFixture from './test-fixtures-dry.json';
import wetFixture from './test-fixtures-wet.json';
import type { OneClickAppFee, OneClickConfig, OneClickQuoteRequest, OneClickQuoteResponse } from './types';

const config: OneClickConfig = {
  serviceUrl: 'https://proxy.example',
  midenAssets: [{ assetId: 'miden:usdc', faucetId: '0x123456789012345678901234567890', decimals: 6 }]
};

const input: OneClickQuoteRequest = {
  amount: '1000000',
  originAsset: {
    assetId: 'eth:native',
    blockchain: 'eth',
    symbol: 'ETH',
    decimals: 18,
    contractAddress: 'native',
    chainId: 1
  },
  destinationAsset: {
    assetId: 'miden:usdc',
    blockchain: 'miden',
    symbol: 'USDC',
    decimals: 6,
    faucetId: '0x123456789012345678901234567890'
  },
  refundTo: '0x1111111111111111111111111111111111111111',
  recipient: 'miden-account',
  deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
  slippageTolerance: 100
};

const originalFetch = globalThis.fetch;
const fetchMock = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}));

const pinnedDryQuote = parseOneClickQuoteResponse(dryFixture);
const pinnedWetQuote = parseOneClickQuoteResponse(wetFixture);
const fixtureFee: OneClickAppFee = {
  recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd',
  fee: 20
};
const secondFixtureFee: OneClickAppFee = { recipient: 'partner-two.near', fee: 7 };
const wetDepositAddress = '0xe5E9d98Ee5e8E8d379fa7bEb302f33E94261f21B';
const submitTransactionHash = `0x${'1'.repeat(64)}`;

function configWithFees(appFees: OneClickAppFee[] = []): OneClickConfig {
  return { serviceUrl: 'https://proxy.example', midenAssets: [], appFees };
}

function quoteWithFees(quote: OneClickQuoteResponse, appFees: OneClickAppFee[]): OneClickQuoteResponse {
  return { ...quote, quoteRequest: { ...quote.quoteRequest, appFees } };
}

function requestForFixture(quote: OneClickQuoteResponse): OneClickQuoteRequest {
  const signed = quote.quoteRequest;
  return {
    amount: signed.amount,
    originAsset: { assetId: signed.originAsset, blockchain: 'eth', symbol: 'USDC', decimals: 6 },
    destinationAsset: { assetId: signed.destinationAsset, blockchain: 'base', symbol: 'ETH', decimals: 18 },
    refundTo: signed.refundTo,
    recipient: signed.recipient,
    deadline: signed.deadline,
    slippageTolerance: signed.slippageTolerance
  };
}

function statusResponse(quoteResponse: OneClickQuoteResponse) {
  return {
    correlationId: quoteResponse.correlationId,
    quoteResponse,
    status: 'PROCESSING',
    updatedAt: '2026-10-22T11:15:08.000Z',
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: []
    }
  };
}

async function callStatusBoundary(
  config: OneClickConfig,
  quote: OneClickQuoteResponse,
  expectedQuote?: OneClickQuoteResponse
) {
  fetchMock.mockResolvedValue(Response.json(statusResponse(quote)));
  if (expectedQuote) return fetchOneClickStatus(config, wetDepositAddress, undefined, expectedQuote);
  return fetchOneClickStatus(config, wetDepositAddress);
}

async function callSubmitBoundary(
  config: OneClickConfig,
  quote: OneClickQuoteResponse,
  expectedQuote?: OneClickQuoteResponse
) {
  fetchMock.mockResolvedValue(Response.json(statusResponse(quote)));
  if (expectedQuote)
    return submitOneClickDeposit(config, wetDepositAddress, submitTransactionHash, undefined, expectedQuote);
  return submitOneClickDeposit(config, wetDepositAddress, submitTransactionHash);
}

describe('1Click client', () => {
  beforeEach(() => {
    globalThis.fetch = fetchMock;
  });
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
      await expect(fetchOneClickAssets(loopbackConfig, async () => ({ decimals: 6, symbol: 'USDC' }))).rejects.toThrow(
        'Invalid 1Click service URL'
      );

      process.env.MIDEN_E2E_TEST = 'true';
      process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
      fetchMock.mockResolvedValue(Response.json([]));
      await expect(fetchOneClickAssets(loopbackConfig, async () => ({ decimals: 6, symbol: 'USDC' }))).resolves.toEqual(
        []
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:8550\/v0\/tokens$/),
        expect.anything()
      );
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
    fetchMock.mockResolvedValue(
      Response.json([
        { assetId: 'eth:native', blockchain: 'eth', symbol: 'ETH', decimals: 18 },
        { assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH', decimals: 18 },
        { assetId: 'eth:unverified-native', blockchain: 'eth', symbol: 'ETH', decimals: 18, contractAddress: 'native' },
        {
          assetId: 'sol:token',
          blockchain: 'sol',
          symbol: 'TOKEN',
          decimals: 9,
          contractAddress: 'So11111111111111111111111111111111111111112'
        }
      ])
    );
    const resolver = jest.fn(async () => ({ decimals: 6, symbol: 'USDC' }));
    const assets = await fetchOneClickAssets(config, resolver);
    expect(assets.map(asset => asset.assetId)).toEqual(['eth:native', 'nep141:eth.omft.near', 'sol:token']);
    expect(assets.find(asset => asset.assetId === 'eth:native')?.contractAddress).toBeUndefined();
    expect(assets.find(asset => asset.assetId === 'nep141:eth.omft.near')?.contractAddress).toBe('native');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('requires both provider and on-chain Miden decimals to match the configured mapping', async () => {
    fetchMock.mockResolvedValue(
      Response.json([{ assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6 }])
    );
    const assets = await fetchOneClickAssets(config, async () => ({ decimals: 9, symbol: 'USDC' }));
    expect(assets).toEqual([]);
  });

  it('keeps independently verified mappings when another Miden metadata lookup fails or mismatches', async () => {
    const metadataConfig: OneClickConfig = {
      serviceUrl: 'https://proxy.example',
      midenAssets: [
        { assetId: 'miden:verified', faucetId: `0x${'1'.repeat(30)}`, decimals: 6 },
        { assetId: 'miden:unavailable', faucetId: `0x${'2'.repeat(30)}`, decimals: 6 },
        { assetId: 'miden:mismatched', faucetId: `0x${'3'.repeat(30)}`, decimals: 6 },
        { assetId: 'miden:invalid', faucetId: `0x${'4'.repeat(30)}`, decimals: 6 }
      ]
    };
    fetchMock.mockResolvedValue(
      Response.json([
        {
          assetId: 'eth:token',
          blockchain: 'eth',
          symbol: 'TOKEN',
          decimals: 18,
          contractAddress: `0x${'a'.repeat(40)}`
        },
        ...metadataConfig.midenAssets.map(asset => ({
          assetId: asset.assetId,
          blockchain: 'miden',
          symbol: 'USD Coin',
          decimals: asset.decimals
        }))
      ])
    );
    const resolver = jest.fn(async (asset: { faucetId?: string }) => {
      if (asset.faucetId === metadataConfig.midenAssets[1]?.faucetId) throw new Error('metadata unavailable');
      if (asset.faucetId === metadataConfig.midenAssets[2]?.faucetId) return { decimals: 9, symbol: 'USDC' };
      if (asset.faucetId === metadataConfig.midenAssets[3]?.faucetId) return { decimals: 6, symbol: '  ' };
      return { decimals: 6, symbol: 'USDC' };
    });

    const assets = await fetchOneClickAssets(metadataConfig, resolver);

    expect(assets.map(asset => asset.assetId)).toEqual(['eth:token', 'miden:verified']);
    expect(resolver).toHaveBeenCalledTimes(4);
  });

  it('limits Miden metadata reads to four concurrent lookups', async () => {
    const metadataConfig: OneClickConfig = {
      serviceUrl: 'https://proxy.example',
      midenAssets: Array.from({ length: 6 }, (_, index) => ({
        assetId: `miden:asset-${index}`,
        faucetId: `0x${String(index + 1).repeat(30)}`,
        decimals: 6
      }))
    };
    fetchMock.mockResolvedValue(
      Response.json(
        metadataConfig.midenAssets.map(asset => ({
          assetId: asset.assetId,
          blockchain: 'miden',
          symbol: 'USDC',
          decimals: asset.decimals
        }))
      )
    );
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const resolver = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return { decimals: 6, symbol: 'USDC' };
    });
    const pending = fetchOneClickAssets(metadataConfig, resolver);
    let startedBeforeRelease = 0;

    try {
      for (let attempt = 0; attempt < 25 && resolver.mock.calls.length < 4; attempt += 1) await Promise.resolve();
      startedBeforeRelease = resolver.mock.calls.length;
      release?.();
      const assets = await pending;
      expect(assets).toHaveLength(6);
    } finally {
      release?.();
      await pending;
    }

    expect(startedBeforeRelease).toBe(4);
    expect(peak).toBe(4);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('fails closed when the provider token response has an invalid top-level shape', async () => {
    fetchMock.mockResolvedValue(Response.json({ tokens: [] }));
    await expect(fetchOneClickAssets(config, async () => ({ decimals: 6, symbol: 'USDC' }))).rejects.toThrow(
      'Invalid 1Click token response'
    );
  });

  it('preserves canonical IDs from the provider catalog and matches underlying assets without symbols', async () => {
    fetchMock.mockResolvedValue(
      Response.json([
        { assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USD Coin', decimals: 6, coingeckoId: 'usd-coin' },
        { assetId: 'nep141:usdc', blockchain: 'eth', symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
        { assetId: 'nep141:other', blockchain: 'eth', symbol: 'USDC', decimals: 6 }
      ])
    );
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
    fetchMock.mockResolvedValue(
      Response.json({
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
          amountIn: '1000000',
          amountInFormatted: '1',
          amountInUsd: '1',
          minAmountIn: '1000000',
          amountOut: '1000000',
          amountOutFormatted: '1',
          amountOutUsd: '1',
          minAmountOut: '999000',
          timeEstimate: 10
        }
      })
    );
    await expect(requestOneClickQuote(config, input)).rejects.toThrow('signature');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://proxy.example/v0/quote',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
      expect.not.objectContaining({ Authorization: expect.anything() })
    );
  });

  it('quote boundary rejects unsigned pinned-fixture fee edits while preserving signature and hash', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-22T11:15:08.000Z'));
    const request = requestForFixture(pinnedDryQuote);
    const matchingConfig = configWithFees([fixtureFee]);
    const matchingQuote = quoteWithFees(pinnedDryQuote, [fixtureFee]);
    fetchMock.mockResolvedValue(Response.json(matchingQuote));

    await expect(requestOneClickQuote(matchingConfig, request)).resolves.toEqual(matchingQuote);

    const editedQuote = quoteWithFees(pinnedDryQuote, [{ ...fixtureFee, recipient: 'attacker.near' }]);
    expect(verifyOneClickQuoteSignature(editedQuote)).toBe(true);
    expect(hashOneClickQuote(editedQuote)).toBe(hashOneClickQuote(pinnedDryQuote));
    fetchMock.mockResolvedValue(Response.json(editedQuote));
    await expect(requestOneClickQuote(matchingConfig, request)).rejects.toThrow(
      '1Click quote is missing a configured app fee'
    );
  });

  it.each([
    { name: 'unconfigured provider fee', configured: [], actual: [fixtureFee] },
    { name: 'configured fee plus an extra fee', configured: [fixtureFee], actual: [fixtureFee, secondFixtureFee] },
    { name: 'missing configured fee', configured: [fixtureFee], actual: [] },
    { name: 'altered configured fee amount', configured: [fixtureFee], actual: [{ ...fixtureFee, fee: 21 }] },
    { name: 'duplicate fee multiplicity', configured: [fixtureFee, fixtureFee], actual: [fixtureFee] }
  ])('quote boundary rejects $name', async ({ configured, actual }) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-22T11:15:08.000Z'));
    const response = quoteWithFees(pinnedDryQuote, actual);
    expect(verifyOneClickQuoteSignature(response)).toBe(true);
    expect(hashOneClickQuote(response)).toBe(hashOneClickQuote(pinnedDryQuote));
    fetchMock.mockResolvedValue(Response.json(response));

    await expect(requestOneClickQuote(configWithFees(configured), requestForFixture(pinnedDryQuote))).rejects.toThrow(
      '1Click quote is missing a configured app fee'
    );
  });

  it('quote boundary accepts an order-insensitive configured fee match', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-22T11:15:08.000Z'));
    const configured = [fixtureFee, secondFixtureFee];
    const response = quoteWithFees(pinnedDryQuote, [secondFixtureFee, fixtureFee]);
    expect(verifyOneClickQuoteSignature(response)).toBe(true);
    expect(hashOneClickQuote(response)).toBe(hashOneClickQuote(pinnedDryQuote));
    fetchMock.mockResolvedValue(Response.json(response));

    await expect(requestOneClickQuote(configWithFees(configured), requestForFixture(pinnedDryQuote))).resolves.toEqual(
      response
    );
  });

  it.each([
    {
      boundary: 'status',
      name: 'unsigned extra fee against empty configuration',
      configured: [],
      actual: [fixtureFee]
    },
    {
      boundary: 'submit',
      name: 'unsigned extra fee against empty configuration',
      configured: [],
      actual: [fixtureFee]
    },
    {
      boundary: 'status',
      name: 'altered configured fee recipient',
      configured: [fixtureFee],
      actual: [{ ...fixtureFee, recipient: 'attacker.near' }]
    },
    {
      boundary: 'submit',
      name: 'altered configured fee recipient',
      configured: [fixtureFee],
      actual: [{ ...fixtureFee, recipient: 'attacker.near' }]
    },
    {
      boundary: 'status',
      name: 'altered configured fee amount',
      configured: [fixtureFee],
      actual: [{ ...fixtureFee, fee: 21 }]
    },
    {
      boundary: 'submit',
      name: 'altered configured fee amount',
      configured: [fixtureFee],
      actual: [{ ...fixtureFee, fee: 21 }]
    }
  ])('$boundary boundary rejects $name without an expected quote', async ({ boundary, configured, actual }) => {
    const response = quoteWithFees(pinnedWetQuote, actual);
    expect(verifyOneClickQuoteSignature(response)).toBe(true);
    expect(hashOneClickQuote(response)).toBe(hashOneClickQuote(pinnedWetQuote));
    const request =
      boundary === 'status'
        ? callStatusBoundary(configWithFees(configured), response)
        : callSubmitBoundary(configWithFees(configured), response);

    await expect(request).rejects.toThrow('1Click quote is missing a configured app fee');
  });

  it.each([
    { boundary: 'status', name: 'missing configured fees', configured: [fixtureFee], actual: [] },
    { boundary: 'submit', name: 'missing configured fees', configured: [fixtureFee], actual: [] },
    {
      boundary: 'status',
      name: 'duplicate fee multiplicity',
      configured: [fixtureFee, fixtureFee],
      actual: [fixtureFee]
    },
    {
      boundary: 'submit',
      name: 'duplicate fee multiplicity',
      configured: [fixtureFee, fixtureFee],
      actual: [fixtureFee]
    }
  ])('$boundary boundary rejects $name without an expected quote', async ({ boundary, configured, actual }) => {
    const response = quoteWithFees(pinnedWetQuote, actual);
    expect(verifyOneClickQuoteSignature(response)).toBe(true);
    expect(hashOneClickQuote(response)).toBe(hashOneClickQuote(pinnedWetQuote));
    const request =
      boundary === 'status'
        ? callStatusBoundary(configWithFees(configured), response)
        : callSubmitBoundary(configWithFees(configured), response);

    await expect(request).rejects.toThrow('1Click quote is missing a configured app fee');
  });

  it.each([
    { boundary: 'status', call: callStatusBoundary },
    { boundary: 'submit', call: callSubmitBoundary }
  ])('$boundary boundary rejects an unsigned fee addition with an expected quote hash unchanged', async ({ call }) => {
    const response = quoteWithFees(pinnedWetQuote, [fixtureFee, secondFixtureFee]);
    expect(verifyOneClickQuoteSignature(response)).toBe(true);
    expect(hashOneClickQuote(response)).toBe(hashOneClickQuote(pinnedWetQuote));

    await expect(call(configWithFees([fixtureFee]), response, pinnedWetQuote)).rejects.toThrow(
      '1Click quote is missing a configured app fee'
    );
  });

  it.each([
    { boundary: 'status', call: callStatusBoundary },
    { boundary: 'submit', call: callSubmitBoundary }
  ])('$boundary boundary accepts matching fees with and without an expected quote', async ({ call }) => {
    const response = quoteWithFees(pinnedWetQuote, [fixtureFee]);

    await expect(call(configWithFees([fixtureFee]), response, pinnedWetQuote)).resolves.toMatchObject({
      quoteResponse: response
    });
    await expect(call(configWithFees([fixtureFee]), response)).resolves.toMatchObject({ quoteResponse: response });
  });

  it.each([
    { boundary: 'status', call: callStatusBoundary },
    { boundary: 'submit', call: callSubmitBoundary }
  ])('$boundary boundary accepts reordered fees with and without an expected quote', async ({ call }) => {
    const configured = [fixtureFee, secondFixtureFee];
    const response = quoteWithFees(pinnedWetQuote, [secondFixtureFee, fixtureFee]);

    await expect(call(configWithFees(configured), response, pinnedWetQuote)).resolves.toMatchObject({
      quoteResponse: response
    });
    await expect(call(configWithFees(configured), response)).resolves.toMatchObject({ quoteResponse: response });
  });

  it('exposes only the HTTP status for quote-unavailable dry probes', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Failed to get quote', token: 'do-not-expose' }), { status: 400 })
    );
    await expect(requestOneClickQuote(config, input)).rejects.toMatchObject({
      name: 'OneClickHttpError',
      status: 400,
      message: '1Click request failed (400)'
    });
  });

  it('rejects invalid config mappings and fees before any request', async () => {
    await expect(
      fetchOneClickAssets(
        { ...config, midenAssets: [{ ...config.midenAssets[0]!, decimals: Number.MAX_SAFE_INTEGER + 1 }] },
        async () => ({ decimals: 6 })
      )
    ).rejects.toThrow('asset configuration');
    await expect(
      requestOneClickQuote({ ...config, appFees: [{ recipient: 'wallet.near', fee: 1001 }] }, input)
    ).rejects.toThrow('fee configuration');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps response bodies by UTF-8 byte length rather than decoded string length', async () => {
    fetchMock.mockResolvedValue(new Response('€'.repeat(400_000)));
    await expect(fetchOneClickAssets(config, async () => ({ decimals: 6 }))).rejects.toThrow('too large');
  });
});
