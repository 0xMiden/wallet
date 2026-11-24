/** @jest-environment node */

import type { SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';

import { OneClickHttpError } from './client';
import {
  NEAR_INTENTS_SEND_QUOTE_LIFETIME_MS,
  NearIntentsSendQuoteChangedError,
  buildNearIntentsSendRequest,
  findNearIntentsSendPairs,
  nearIntentsEvmChainId,
  nearIntentsSendChains,
  requestNearIntentsSendPreview,
  startNearIntentsSend,
  type NearIntentsSendPair,
  type StartNearIntentsSendInput
} from './send';
import type {
  NearIntentsCatalog,
  NearIntentsConfig,
  OneClickAsset,
  OneClickQuoteRequest,
  OneClickQuoteResponse
} from './types';

const requestQuote = jest.fn();
const initiateDeposit = jest.fn();

const FAUCET_HEX = '0x0123456789abcdef0123456789abcd';
const FAUCET_BECH32 = 'mm1faucetusdcx';
const OTHER_FAUCET = '0xffffffffffffffffffffffffffffff';

jest.mock('lib/miden/swap/faucet-ids', () => ({
  normalizedFaucetId: (id: string) => (id.toLowerCase() === '0x0123456789abcdef0123456789abcd' ? 'mm1faucetusdcx' : id)
}));
jest.mock('./client', () => ({
  OneClickHttpError: jest.requireActual<typeof import('./client')>('./client').OneClickHttpError,
  requestOneClickQuote: (...args: unknown[]) => requestQuote(...args)
}));
jest.mock('./tracking', () => ({
  initiateOneClickMidenDeposit: (...args: unknown[]) => initiateDeposit(...args)
}));

const usdcx: OneClickAsset = {
  assetId: 'nep141:miden-usdcx.omft.near',
  blockchain: 'miden',
  symbol: 'USDCx',
  decimals: 6,
  faucetId: FAUCET_HEX
};
const otherMiden: OneClickAsset = {
  assetId: 'nep141:miden-other.omft.near',
  blockchain: 'miden',
  symbol: 'OTH',
  decimals: 6,
  faucetId: OTHER_FAUCET
};
const ethUsdc: OneClickAsset = {
  assetId: 'nep141:eth-usdc.omft.near',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
};
const ethNative: OneClickAsset = { assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH', decimals: 18 };
const solUsdc: OneClickAsset = { assetId: 'nep141:sol-usdc.omft.near', blockchain: 'sol', symbol: 'USDC', decimals: 6 };

const config: NearIntentsConfig = {
  serviceUrl: 'https://proxy.example',
  midenAssets: [
    { id: 'usdcx', assetId: usdcx.assetId, faucetId: FAUCET_HEX, decimals: 6 },
    { id: 'other', assetId: otherMiden.assetId, faucetId: OTHER_FAUCET, decimals: 6 }
  ],
  chains: [
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [
        { symbol: 'USDC', assetId: ethUsdc.assetId, decimals: 6, miden: ['usdcx', 'other'] },
        { symbol: 'ETH', assetId: ethNative.assetId, decimals: 18, miden: ['usdcx'] }
      ]
    },
    {
      id: 'sol',
      name: 'Solana',
      addressKind: 'solana',
      tokens: [{ symbol: 'USDC', assetId: solUsdc.assetId, decimals: 6, miden: ['usdcx'] }]
    },
    {
      id: 'mystery',
      name: 'Mystery EVM',
      addressKind: 'evm',
      tokens: [{ symbol: 'USDC', assetId: 'nep141:mystery.omft.near', decimals: 6, miden: ['usdcx'] }]
    }
  ]
};

const catalog: NearIntentsCatalog = {
  chains: [
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [
        { symbol: 'USDC', asset: ethUsdc, outputs: [usdcx, otherMiden] },
        { symbol: 'ETH', asset: ethNative, outputs: [usdcx] }
      ]
    },
    {
      id: 'sol',
      name: 'Solana',
      addressKind: 'solana',
      tokens: [{ symbol: 'USDC', asset: solUsdc, outputs: [usdcx] }]
    }
  ]
};

const ethChain = catalog.chains[0]!;
const solChain = catalog.chains[1]!;
const WALLET_ADDRESS = 'mm1aqwalletaddress_qr7qqq9wr6w';
const EVM_RECIPIENT = '0xde709f2102306220921060314715629080e2fb77';
const SOLANA_RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const DEPOSIT_ADDRESS = 'mm1arwrrznxhwfzky2feqrnvalc9qvzc7f6_qr7qqq9wr6w';

const ethPair: NearIntentsSendPair = { chain: ethChain, origin: usdcx, destination: ethUsdc };
const solPair: NearIntentsSendPair = { chain: solChain, origin: usdcx, destination: solUsdc };

function quoteFor(request: OneClickQuoteRequest, minAmountOut = '990000', depositAddress = DEPOSIT_ADDRESS) {
  const response: OneClickQuoteResponse = {
    correlationId: 'correlation',
    timestamp: '2026-11-11T12:00:00Z',
    signature: 'ed25519:signature',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: request.slippageTolerance,
      originAsset: request.originAsset.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: request.destinationAsset.assetId,
      amount: request.amount,
      refundTo: request.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: request.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: request.deadline
    },
    quote: {
      amountIn: request.amount,
      amountInFormatted: '1',
      amountInUsd: '1',
      minAmountIn: request.amount,
      amountOut: '1000000',
      amountOutFormatted: '1',
      amountOutUsd: '1',
      minAmountOut,
      timeEstimate: 20,
      depositAddress,
      deadline: request.deadline
    }
  };
  return response;
}

const startInput = (overrides: Partial<StartNearIntentsSendInput> = {}): StartNearIntentsSendInput => ({
  pair: solPair,
  amount: 1_000_000n,
  recipient: SOLANA_RECIPIENT,
  refundTo: WALLET_ADDRESS,
  config,
  network: 'mainnet',
  accountId: WALLET_ADDRESS,
  accountAddress: WALLET_ADDRESS,
  ...overrides
});

beforeEach(() => {
  jest.clearAllMocks();
  requestQuote.mockImplementation(async (_config: NearIntentsConfig, request: OneClickQuoteRequest) =>
    quoteFor(request)
  );
  initiateDeposit.mockResolvedValue('send-row-id');
});

describe('nearIntentsEvmChainId', () => {
  it.each([
    ['eth', 1],
    ['base', 8453],
    ['arb', 42161],
    ['op', 10],
    ['sol', undefined],
    ['btc', undefined],
    ['unknown', undefined]
  ])('maps %s to %s', (chainId, expected) => {
    expect(nearIntentsEvmChainId(chainId)).toBe(expected);
  });
});

describe('nearIntentsSendChains', () => {
  it('lists the chains of the config in its order, with an EVM chain id only for a known EVM chain', () => {
    expect(nearIntentsSendChains(config)).toEqual([
      { id: 'eth', name: 'Ethereum', addressKind: 'evm', evmChainId: 1 },
      { id: 'sol', name: 'Solana', addressKind: 'solana' },
      { id: 'mystery', name: 'Mystery EVM', addressKind: 'evm' }
    ]);
  });

  it('gives no chain without a config', () => {
    expect(nearIntentsSendChains(null)).toEqual([]);
  });
});

describe('findNearIntentsSendPairs', () => {
  it('finds every token of the chain that the faucet can become, in catalog order', () => {
    expect(findNearIntentsSendPairs(catalog, FAUCET_HEX, 'eth')).toEqual([
      { chain: ethChain, origin: usdcx, destination: ethUsdc },
      { chain: ethChain, origin: usdcx, destination: ethNative }
    ]);
    expect(findNearIntentsSendPairs(catalog, OTHER_FAUCET, 'eth')).toEqual([
      { chain: ethChain, origin: otherMiden, destination: ethUsdc }
    ]);
  });

  it('compares faucet ids in their canonical form', () => {
    expect(findNearIntentsSendPairs(catalog, FAUCET_HEX.toUpperCase().replace('0X', '0x'), 'sol')).toEqual([solPair]);
    expect(findNearIntentsSendPairs(catalog, FAUCET_BECH32, 'sol')).toEqual([solPair]);
  });

  it('gives no pair for an unknown chain or faucet', () => {
    expect(findNearIntentsSendPairs(catalog, FAUCET_HEX, 'btc')).toEqual([]);
    expect(findNearIntentsSendPairs(catalog, '0x99999999999999999999999999999a', 'eth')).toEqual([]);
    expect(findNearIntentsSendPairs(catalog, '', 'eth')).toEqual([]);
  });
});

describe('buildNearIntentsSendRequest', () => {
  it('builds an exact-input request with 1% slippage and a 5 minute deadline', () => {
    const now = Date.parse('2026-11-11T12:00:00.000Z');
    expect(
      buildNearIntentsSendRequest(
        { pair: ethPair, amount: 2_500_000n, recipient: EVM_RECIPIENT, refundTo: WALLET_ADDRESS },
        now
      )
    ).toEqual({
      amount: '2500000',
      originAsset: usdcx,
      destinationAsset: ethUsdc,
      refundTo: WALLET_ADDRESS,
      recipient: EVM_RECIPIENT,
      deadline: new Date(now + NEAR_INTENTS_SEND_QUOTE_LIFETIME_MS).toISOString(),
      slippageTolerance: 100
    });
  });
});

describe('requestNearIntentsSendPreview', () => {
  it('asks for a dry quote of the request', async () => {
    const preview = await requestNearIntentsSendPreview(config, {
      pair: solPair,
      amount: 1_000_000n,
      recipient: SOLANA_RECIPIENT,
      refundTo: WALLET_ADDRESS
    });
    expect(requestQuote).toHaveBeenCalledWith(config, preview.request, true);
    expect(preview.request).toMatchObject({ recipient: SOLANA_RECIPIENT, refundTo: WALLET_ADDRESS, amount: '1000000' });
    expect(preview.quote.quote.amountIn).toBe('1000000');
  });

  it('passes on the reason code of a refused request', async () => {
    requestQuote.mockRejectedValue(new OneClickHttpError(400, 'invalid_recipient'));
    await expect(
      requestNearIntentsSendPreview(config, {
        pair: solPair,
        amount: 1_000_000n,
        recipient: SOLANA_RECIPIENT,
        refundTo: WALLET_ADDRESS
      })
    ).rejects.toMatchObject({ name: 'OneClickHttpError', status: 400, code: 'invalid_recipient' });
  });

  it('refuses a recipient that is not valid on the destination chain before any request', async () => {
    await expect(
      requestNearIntentsSendPreview(config, {
        pair: solPair,
        amount: 1_000_000n,
        recipient: EVM_RECIPIENT,
        refundTo: WALLET_ADDRESS
      })
    ).rejects.toThrow('not a valid address');
    expect(requestQuote).not.toHaveBeenCalled();
  });
});

describe('startNearIntentsSend', () => {
  it('asks for a deposit quote and queues the Miden send to its deposit address', async () => {
    const authorization: SpendingLimitAuthorization = {
      kind: 'unpriced',
      id: 'authorization-id',
      accountId: WALLET_ADDRESS,
      spendsDigest: 'digest',
      revision: '1',
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER
    };
    const rowId = await startNearIntentsSend(startInput({ authorization, reviewedMinAmountOut: 990_000n }));

    expect(rowId).toBe('send-row-id');
    expect(requestQuote).toHaveBeenCalledTimes(1);
    const [, request, dry] = requestQuote.mock.calls[0]!;
    expect(dry).toBe(false);
    expect(initiateDeposit).toHaveBeenCalledWith(
      {
        request,
        quote: quoteFor(request),
        config,
        network: 'mainnet',
        accountId: WALLET_ADDRESS,
        accountAddress: WALLET_ADDRESS,
        originAsset: usdcx,
        destinationAsset: solUsdc,
        faucetId: FAUCET_HEX
      },
      authorization
    );
  });

  it('uses the faucet id as the config writes it', async () => {
    await startNearIntentsSend(startInput({ pair: { ...solPair, origin: { ...usdcx, faucetId: FAUCET_BECH32 } } }));
    expect(initiateDeposit.mock.calls[0]?.[0]).toMatchObject({ faucetId: FAUCET_HEX });
  });

  it('refuses a deposit quote below the reviewed minimum output', async () => {
    requestQuote.mockImplementation(async (_config: NearIntentsConfig, request: OneClickQuoteRequest) =>
      quoteFor(request, '980000')
    );
    const failure = startNearIntentsSend(startInput({ reviewedMinAmountOut: 990_000n }));
    await expect(failure).rejects.toBeInstanceOf(NearIntentsSendQuoteChangedError);
    await expect(failure).rejects.toMatchObject({ reviewedMinAmountOut: 990_000n, quotedMinAmountOut: 980_000n });
    expect(initiateDeposit).not.toHaveBeenCalled();
  });

  it('refuses a preview placeholder recipient before any request', async () => {
    await expect(
      startNearIntentsSend(startInput({ recipient: 'ES452S7HwooFCN93gENCAzQ8oSywVFpjNHFGRv4kUgtx' }))
    ).rejects.toThrow('placeholder');
    expect(requestQuote).not.toHaveBeenCalled();
  });

  it('refuses a quote with a placeholder or missing deposit address', async () => {
    requestQuote.mockImplementation(async (_config: NearIntentsConfig, request: OneClickQuoteRequest) =>
      quoteFor(request, '990000', '0x15da65977522e0f70204b5795c3f90eee9ae6812')
    );
    await expect(startNearIntentsSend(startInput())).rejects.toThrow('deposit address');
    requestQuote.mockImplementation(async (_config: NearIntentsConfig, request: OneClickQuoteRequest) => {
      const response = quoteFor(request);
      return { ...response, quote: { ...response.quote, depositAddress: undefined } };
    });
    await expect(startNearIntentsSend(startInput())).rejects.toThrow('deposit address');
    expect(initiateDeposit).not.toHaveBeenCalled();
  });

  it('refuses a pair that does not start on Miden', async () => {
    const reversed: NearIntentsSendPair = { chain: solChain, origin: solUsdc, destination: usdcx };
    await expect(startNearIntentsSend(startInput({ pair: reversed }))).rejects.toThrow('from Miden');
    expect(requestQuote).not.toHaveBeenCalled();
  });

  it('refuses a hex refund address', async () => {
    await expect(startNearIntentsSend(startInput({ refundTo: FAUCET_HEX }))).rejects.toThrow('bech32');
    expect(requestQuote).not.toHaveBeenCalled();
  });

  it('refuses a Miden asset that the config does not name', async () => {
    const unknown = { ...usdcx, assetId: 'nep141:miden-unknown.omft.near' };
    await expect(startNearIntentsSend(startInput({ pair: { ...solPair, origin: unknown } }))).rejects.toThrow(
      'not in the configuration'
    );
    expect(requestQuote).not.toHaveBeenCalled();
  });
});
