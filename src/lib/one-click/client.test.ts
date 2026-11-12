/** @jest-environment node */

import { fetchNearIntentsCatalog } from './catalog';
import { fetchOneClickStatus, parseOneClickQuoteResponse, requestOneClickQuote, submitOneClickDeposit } from './client';
import { hashOneClickQuote, verifyOneClickQuoteSignature } from './signature';
import dryFixture from './test-fixtures-dry.json';
import wetFixture from './test-fixtures-wet.json';
import type { NearIntentsConfig, OneClickAppFee, OneClickQuoteRequest, OneClickQuoteResponse } from './types';

const config: NearIntentsConfig = {
  serviceUrl: 'https://proxy.example',
  chains: [
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [{ symbol: 'ETH', assetId: 'nep141:eth.omft.near', decimals: 18, miden: ['usdc'] }]
    }
  ],
  midenAssets: [{ id: 'usdc', assetId: 'miden:usdc', faucetId: '0x123456789012345678901234567890', decimals: 6 }]
};

const input: OneClickQuoteRequest = {
  amount: '1000000',
  originAsset: {
    assetId: 'nep141:eth.omft.near',
    blockchain: 'eth',
    symbol: 'ETH',
    decimals: 18,
    contractAddress: 'native'
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

// The pinned production fixtures are a chain-to-chain route (Ethereum USDC to Base ETH), so a fixture quote passes
// every other check and stops only at the pair check.
function fixtureConfig(): NearIntentsConfig {
  return { serviceUrl: 'https://proxy.example', midenAssets: [], chains: [] };
}

function quoteWithFees(quote: OneClickQuoteResponse, appFees: OneClickAppFee[]): OneClickQuoteResponse {
  return { ...quote, quoteRequest: { ...quote.quoteRequest, appFees } };
}

function requestForFixture(quote: OneClickQuoteResponse): OneClickQuoteRequest {
  const signed = quote.quoteRequest;
  return {
    amount: signed.amount,
    originAsset: {
      assetId: signed.originAsset,
      blockchain: 'eth',
      symbol: 'USDC',
      decimals: 6,
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    },
    destinationAsset: {
      assetId: signed.destinationAsset,
      blockchain: 'base',
      symbol: 'ETH',
      decimals: 18,
      contractAddress: 'native'
    },
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
  config: NearIntentsConfig,
  quote: OneClickQuoteResponse,
  expectedQuote?: OneClickQuoteResponse
) {
  fetchMock.mockResolvedValue(Response.json(statusResponse(quote)));
  if (expectedQuote) return fetchOneClickStatus(config, wetDepositAddress, undefined, expectedQuote);
  return fetchOneClickStatus(config, wetDepositAddress);
}

async function callSubmitBoundary(
  config: NearIntentsConfig,
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

  it('allows a localhost proxy in development and rejects HTTP in production or outside loopback', async () => {
    const env = jest.replaceProperty(process, 'env', {
      ...process.env,
      MODE_ENV: 'development',
      MIDEN_E2E_TEST: 'false'
    });
    try {
      fetchMock.mockImplementation(async () => Response.json([]));
      const loopbackConfig = { ...config, serviceUrl: 'http://localhost:8787' };
      await expect(
        fetchNearIntentsCatalog(loopbackConfig, async () => ({ decimals: 6, symbol: 'USDC' }))
      ).resolves.toEqual({ chains: [] });
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/v0/tokens', expect.anything());
      const lanConfig = { ...config, serviceUrl: 'http://192.168.29.144:8787' };
      await expect(fetchNearIntentsCatalog(lanConfig, async () => ({ decimals: 6, symbol: 'USDC' }))).resolves.toEqual({
        chains: []
      });
      expect(fetchMock).toHaveBeenCalledWith('http://192.168.29.144:8787/v0/tokens', expect.anything());
      await expect(
        fetchNearIntentsCatalog({ ...config, serviceUrl: 'http://example.com' }, async () => ({ decimals: 6 }))
      ).rejects.toThrow('Invalid 1Click service URL');
      process.env.MODE_ENV = 'production';
      await expect(fetchNearIntentsCatalog(lanConfig, async () => ({ decimals: 6 }))).rejects.toThrow(
        'Invalid 1Click service URL'
      );
      await expect(fetchNearIntentsCatalog(loopbackConfig, async () => ({ decimals: 6 }))).rejects.toThrow(
        'Invalid 1Click service URL'
      );
    } finally {
      env.restore();
    }
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
      await expect(
        fetchNearIntentsCatalog(loopbackConfig, async () => ({ decimals: 6, symbol: 'USDC' }))
      ).rejects.toThrow('Invalid 1Click service URL');

      process.env.MIDEN_E2E_TEST = 'true';
      process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
      fetchMock.mockResolvedValue(Response.json([]));
      await expect(
        fetchNearIntentsCatalog(loopbackConfig, async () => ({ decimals: 6, symbol: 'USDC' }))
      ).resolves.toEqual({ chains: [] });
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

  it.each([
    { name: 'no fee', fees: [] },
    { name: "the partner key's fee", fees: [fixtureFee] },
    { name: 'two fees', fees: [fixtureFee, secondFixtureFee] }
  ])('quote boundary passes a quote with $name on to the pair check', async ({ fees }) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-22T11:15:08.000Z'));
    // NEAR sets the fees up on the partner key. They are unsigned fields, and the signed amounts include them.
    const response = quoteWithFees(pinnedDryQuote, fees);
    expect(verifyOneClickQuoteSignature(response)).toBe(true);
    expect(hashOneClickQuote(response)).toBe(hashOneClickQuote(pinnedDryQuote));
    fetchMock.mockResolvedValue(Response.json(response));

    await expect(requestOneClickQuote(fixtureConfig(), requestForFixture(pinnedDryQuote))).rejects.toThrow(
      'configured NEAR Intents pair'
    );
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(sent).not.toHaveProperty('appFees');
  });

  it.each([
    { boundary: 'quote', shape: 'null', appFees: null },
    { boundary: 'quote', shape: 'a string', appFees: 'not-an-array' },
    { boundary: 'quote', shape: 'a number', appFees: 25 },
    { boundary: 'quote', shape: 'an object', appFees: { recipient: fixtureFee.recipient, fee: fixtureFee.fee } },
    { boundary: 'status', shape: 'null', appFees: null },
    { boundary: 'status', shape: 'a string', appFees: 'not-an-array' },
    { boundary: 'status', shape: 'a number', appFees: 25 },
    { boundary: 'status', shape: 'an object', appFees: { recipient: fixtureFee.recipient, fee: fixtureFee.fee } },
    { boundary: 'submit', shape: 'null', appFees: null },
    { boundary: 'submit', shape: 'a string', appFees: 'not-an-array' },
    { boundary: 'submit', shape: 'a number', appFees: 25 },
    { boundary: 'submit', shape: 'an object', appFees: { recipient: fixtureFee.recipient, fee: fixtureFee.fee } }
  ])(
    '$boundary boundary rejects appFees supplied as $shape while preserving the signed wet quote',
    async ({ boundary, appFees }) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-22T11:15:08.000Z'));
      const source = pinnedWetQuote;
      const response = { ...source, quoteRequest: { ...source.quoteRequest, appFees } as any };
      expect(verifyOneClickQuoteSignature(response)).toBe(true);
      expect(hashOneClickQuote(response)).toBe(hashOneClickQuote(source));
      fetchMock.mockResolvedValue(Response.json(response));

      const outcome =
        boundary === 'quote'
          ? requestOneClickQuote(fixtureConfig(), requestForFixture(pinnedWetQuote), false)
          : boundary === 'status'
            ? callStatusBoundary(fixtureConfig(), response)
            : callSubmitBoundary(fixtureConfig(), response);
      await expect(outcome).rejects.toThrow('Invalid 1Click quote response');
    }
  );

  it.each([
    { boundary: 'status', call: callStatusBoundary },
    { boundary: 'submit', call: callSubmitBoundary }
  ])('$boundary boundary accepts the fees 1Click attaches, with and without an expected quote', async ({ call }) => {
    for (const fees of [[], [fixtureFee], [secondFixtureFee, fixtureFee]]) {
      const response = quoteWithFees(pinnedWetQuote, fees);
      expect(hashOneClickQuote(response)).toBe(hashOneClickQuote(pinnedWetQuote));

      await expect(call(fixtureConfig(), response, pinnedWetQuote)).resolves.toMatchObject({
        quoteResponse: response
      });
      await expect(call(fixtureConfig(), response)).resolves.toMatchObject({ quoteResponse: response });
    }
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

  it.each([
    ['no_liquidity', 'no_liquidity'],
    ['invalid_recipient', 'invalid_recipient'],
    ['upstream_request_failed', undefined]
  ])('reads the proxy reason code %s of a refused request', async (error, code) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error }), { status: 400 }));
    await expect(requestOneClickQuote(config, input)).rejects.toMatchObject({
      name: 'OneClickHttpError',
      status: 400,
      code
    });
  });

  it('rejects invalid config mappings before any request', async () => {
    const midenAsset = config.midenAssets[0]!;
    await expect(
      requestOneClickQuote(
        { ...config, midenAssets: [{ ...midenAsset, decimals: Number.MAX_SAFE_INTEGER + 1 }] },
        input
      )
    ).rejects.toThrow('asset configuration');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a token output that names no Miden token', { tokens: [{ ...config.chains[0]!.tokens[0]!, miden: ['other'] }] }],
    ['a token with no output', { tokens: [{ ...config.chains[0]!.tokens[0]!, miden: [] }] }],
    ['a chain named miden', { id: 'miden' }],
    ['a chain with no token', { tokens: [] }],
    [
      'a token asset id that is also a Miden asset id',
      { tokens: [{ ...config.chains[0]!.tokens[0]!, assetId: 'miden:usdc' }] }
    ]
  ])('rejects %s before any request', async (_label, override) => {
    await expect(
      requestOneClickQuote({ ...config, chains: [{ ...config.chains[0]!, ...override }] }, input)
    ).rejects.toThrow('configuration');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a status answer whose quote has no correlation id of its own, as the live API sends it', async () => {
    const response = quoteWithFees(pinnedWetQuote, []);
    const { correlationId, ...quoteWithoutId } = response;
    fetchMock.mockResolvedValue(Response.json({ ...statusResponse(response), quoteResponse: quoteWithoutId }));

    const status = await fetchOneClickStatus(fixtureConfig(), wetDepositAddress, undefined, pinnedWetQuote);

    expect(status.status).toBe('PROCESSING');
    expect(status.quoteResponse.correlationId).toBe(correlationId);
    expect(hashOneClickQuote(status.quoteResponse)).toBe(hashOneClickQuote(pinnedWetQuote));
  });

  it('caps response bodies by UTF-8 byte length rather than decoded string length', async () => {
    fetchMock.mockResolvedValue(new Response('€'.repeat(400_000)));
    await expect(fetchOneClickStatus(config, wetDepositAddress)).rejects.toThrow('too large');
  });
});
