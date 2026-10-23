/** @jest-environment node */

import type { EIP1193Provider } from 'viem';

import { assertOneClickQuoteBinding } from './client';
import { submitEvmOneClickDeposit } from './evm';
import { verifyOneClickQuoteSignature } from './signature';
import type { OneClickAsset, OneClickConfig, OneClickQuoteRequest } from './types';
import {
  FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY,
  signFakeOneClickQuote
} from '../../../playwright/e2e/helpers/fake-one-click-service';

const mockAssertFunded = jest.fn();

jest.mock('./evm-balance', () => ({
  assertOneClickEvmDepositFunded: (...args: unknown[]) => mockAssertFunded(...args)
}));

const account = '0x3333333333333333333333333333333333333333';
const depositAddress = '0x2222222222222222222222222222222222222222';
const transactionHash = `0x${'a'.repeat(64)}`;
const mockRequest = jest.fn();
const trustedAsset: OneClickAsset = {
  assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  blockchain: 'base',
  chainId: 8453,
  contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  decimals: 6,
  symbol: 'USDC'
};
const configuredAsset = {
  assetId: trustedAsset.assetId,
  blockchain: trustedAsset.blockchain,
  chainId: trustedAsset.chainId,
  contractAddress: trustedAsset.contractAddress,
  decimals: trustedAsset.decimals,
  symbol: trustedAsset.symbol
};
const destinationAsset: OneClickAsset = {
  assetId: 'nep141:eth-0x7777777777777777777777777777777777777777.omft.near',
  blockchain: 'eth',
  chainId: 1,
  contractAddress: '0x7777777777777777777777777777777777777777',
  decimals: 6,
  symbol: 'TOKEN'
};
const destinationMapping = {
  assetId: destinationAsset.assetId,
  blockchain: destinationAsset.blockchain,
  chainId: destinationAsset.chainId,
  contractAddress: destinationAsset.contractAddress,
  decimals: destinationAsset.decimals,
  symbol: destinationAsset.symbol
};

function signedDeposit(originAsset: OneClickAsset = trustedAsset, mappings = [configuredAsset]) {
  const deadline = new Date(Date.now() + 60 * 60_000).toISOString();
  const request: OneClickQuoteRequest = {
    amount: '1234567',
    originAsset,
    destinationAsset: { assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6 },
    refundTo: account,
    recipient: 'miden-account',
    deadline,
    slippageTolerance: 100
  };
  const quote = signFakeOneClickQuote({
    correlationId: 'identity-binding',
    timestamp: new Date().toISOString(),
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: originAsset.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: request.destinationAsset.assetId,
      amount: request.amount,
      refundTo: request.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: request.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline
    },
    quote: {
      amountIn: request.amount,
      amountInFormatted: '1.234567',
      amountInUsd: '1.23',
      minAmountIn: request.amount,
      amountOut: '1000000',
      amountOutFormatted: '1',
      amountOutUsd: '1',
      minAmountOut: '990000',
      timeEstimate: 60,
      depositAddress,
      deadline
    }
  });
  const trustedConfig = Object.assign(
    { serviceUrl: 'https://proxy.example', midenAssets: [] },
    { evmAssets: mappings }
  ) as OneClickConfig;
  const calls: string[] = [];
  const chainHex = `0x${originAsset.chainId?.toString(16)}`;
  let sendCount = 0;
  const provider = providerWith(method => {
    calls.push(method);
    if (method === 'eth_chainId') return chainHex;
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_sendTransaction') {
      sendCount += 1;
      return transactionHash;
    }
    return null;
  });
  return {
    request,
    quote,
    trustedConfig,
    calls,
    provider,
    get sendCount() {
      return sendCount;
    }
  };
}

describe('EVM 1Click trusted asset identity', () => {
  const saved = {
    e2e: process.env.MIDEN_E2E_TEST,
    oneClick: process.env.MIDEN_E2E_ONE_CLICK_TESTNET,
    network: process.env.MIDEN_NETWORK,
    managerKey: process.env.MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY
  };

  beforeEach(() => {
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
    process.env.MIDEN_NETWORK = 'localhost';
    process.env.MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY = FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY;
    mockAssertFunded.mockReset().mockResolvedValue({});
  });

  afterAll(() => {
    restore('MIDEN_E2E_TEST', saved.e2e);
    restore('MIDEN_E2E_ONE_CLICK_TESTNET', saved.oneClick);
    restore('MIDEN_NETWORK', saved.network);
    restore('MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY', saved.managerKey);
  });

  it('submits a correctly signed quote for the exact configured EVM origin tuple', async () => {
    const input = signedDeposit();

    await expect(
      submitEvmOneClickDeposit({
        provider: input.provider,
        account,
        request: input.request,
        quote: input.quote,
        config: input.trustedConfig
      })
    ).resolves.toBe(transactionHash);

    expect(input.sendCount).toBe(1);
    expect(mockAssertFunded).toHaveBeenCalledTimes(1);
  });

  it('accepts a correctly signed route with trusted EVM identity on both sides', () => {
    const input = signedDeposit();
    const request = { ...input.request, destinationAsset };
    const quote = signFakeOneClickQuote({
      correlationId: input.quote.correlationId,
      timestamp: input.quote.timestamp,
      quoteRequest: { ...input.quote.quoteRequest, destinationAsset: destinationAsset.assetId },
      quote: input.quote.quote
    });
    const trustedConfig = Object.assign(input.trustedConfig, { evmAssets: [configuredAsset, destinationMapping] });

    expect(verifyOneClickQuoteSignature(quote)).toBe(true);
    expect(() => assertOneClickQuoteBinding(request, quote, false, trustedConfig)).not.toThrow();
  });

  it('rejects a correctly signed route when destination EVM metadata differs from its trusted identity', () => {
    const input = signedDeposit();
    const request = {
      ...input.request,
      destinationAsset: { ...destinationAsset, contractAddress: '0x8888888888888888888888888888888888888888' }
    };
    const quote = signFakeOneClickQuote({
      correlationId: input.quote.correlationId,
      timestamp: input.quote.timestamp,
      quoteRequest: { ...input.quote.quoteRequest, destinationAsset: destinationAsset.assetId },
      quote: input.quote.quote
    });
    const trustedConfig = Object.assign(input.trustedConfig, { evmAssets: [configuredAsset, destinationMapping] });

    expect(verifyOneClickQuoteSignature(quote)).toBe(true);
    expect(() => assertOneClickQuoteBinding(request, quote, false, trustedConfig)).toThrow('trusted identity');
  });

  it('rejects a correctly signed quote before funding when EVM asset has no trusted configuration', async () => {
    const input = signedDeposit(trustedAsset, []);

    await expect(
      submitEvmOneClickDeposit({
        provider: input.provider,
        account,
        request: input.request,
        quote: input.quote,
        config: input.trustedConfig
      })
    ).rejects.toThrow('trusted');

    expect(input.calls).toEqual([]);
    expect(input.sendCount).toBe(0);
    expect(mockAssertFunded).not.toHaveBeenCalled();
  });

  it.each([
    ['contract differs from trusted identity', { contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
    ['decimals differ from trusted identity', { decimals: 18 }],
    ['display symbol differs from trusted identity', { symbol: 'USD Coin' }],
    ['chain differs from trusted identity', { blockchain: 'arb', chainId: 42161 }]
  ])('rejects a correctly signed quote before funding when execution %s', async (_label, override) => {
    const input = signedDeposit({ ...trustedAsset, ...override });

    await expect(
      submitEvmOneClickDeposit({
        provider: input.provider,
        account,
        request: input.request,
        quote: input.quote,
        config: input.trustedConfig
      })
    ).rejects.toThrow('trusted');

    expect(input.calls).toEqual([]);
    expect(input.sendCount).toBe(0);
    expect(mockAssertFunded).not.toHaveBeenCalled();
  });
});

function providerWith(answer: (method: string) => unknown | Promise<unknown>): EIP1193Provider {
  mockRequest.mockReset();
  mockRequest.mockImplementation(async ({ method }: { method: string }) => answer(method));
  return { request: mockRequest, on: jest.fn(), removeListener: jest.fn() };
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
