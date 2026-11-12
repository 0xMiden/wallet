/** @jest-environment node */

import { assertOneClickQuoteBinding } from './client';
import type {
  NearIntentsConfig,
  OneClickAppFee,
  OneClickAsset,
  OneClickQuoteRequest,
  OneClickQuoteResponse
} from './types';
import {
  FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY,
  signFakeOneClickQuote
} from '../../../playwright/e2e/helpers/fake-one-click-service';

const usdcFaucet = `0x${'1'.repeat(30)}`;
const ethFaucet = `0x${'2'.repeat(30)}`;
const solanaMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const config: NearIntentsConfig = {
  // Under the hermetic E2E gate, the service must be a loopback host.
  serviceUrl: 'http://127.0.0.1:8550',
  chains: [
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [
        {
          symbol: 'USDC',
          assetId: 'nep141:eth-usdc.omft.near',
          decimals: 6,
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          miden: ['usdc']
        },
        { symbol: 'ETH', assetId: 'nep141:eth.omft.near', decimals: 18, miden: ['eth'] }
      ]
    },
    {
      id: 'sol',
      name: 'Solana',
      addressKind: 'solana',
      tokens: [
        {
          symbol: 'USDC',
          assetId: 'nep141:sol-usdc.omft.near',
          decimals: 6,
          contractAddress: solanaMint,
          miden: ['usdc']
        }
      ]
    }
  ],
  midenAssets: [
    { id: 'usdc', assetId: 'miden:usdc', faucetId: usdcFaucet, decimals: 6 },
    { id: 'eth', assetId: 'miden:eth', faucetId: ethFaucet, decimals: 18 }
  ]
};

const ethUsdc: OneClickAsset = {
  assetId: 'nep141:eth-usdc.omft.near',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
};
const solUsdc: OneClickAsset = {
  assetId: 'nep141:sol-usdc.omft.near',
  blockchain: 'sol',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: solanaMint
};
const midenUsdc: OneClickAsset = {
  assetId: 'miden:usdc',
  blockchain: 'miden',
  symbol: 'USDC',
  decimals: 6,
  faucetId: usdcFaucet
};
const midenEth: OneClickAsset = {
  assetId: 'miden:eth',
  blockchain: 'miden',
  symbol: 'ETH',
  decimals: 18,
  faucetId: ethFaucet
};

function signed(
  originAsset: OneClickAsset,
  destinationAsset: OneClickAsset,
  appFees?: OneClickAppFee[]
): { request: OneClickQuoteRequest; quote: OneClickQuoteResponse } {
  const deadline = new Date(Date.now() + 60 * 60_000).toISOString();
  const request: OneClickQuoteRequest = {
    amount: '1000000',
    originAsset,
    destinationAsset,
    refundTo: 'refund-address',
    recipient: 'miden-account',
    deadline,
    slippageTolerance: 100
  };
  const quote = signFakeOneClickQuote({
    correlationId: 'binding',
    timestamp: new Date().toISOString(),
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: originAsset.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: destinationAsset.assetId,
      amount: request.amount,
      refundTo: request.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: request.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline,
      ...(appFees === undefined ? {} : { appFees })
    },
    quote: {
      amountIn: request.amount,
      amountInFormatted: '1',
      amountInUsd: '1',
      minAmountIn: request.amount,
      amountOut: '990000',
      amountOutFormatted: '0.99',
      amountOutUsd: '0.99',
      minAmountOut: '980000',
      timeEstimate: 60,
      depositAddress: 'deposit-address',
      deadline
    }
  });
  return { request, quote };
}

const saved = {
  e2e: process.env.MIDEN_E2E_TEST,
  oneClick: process.env.MIDEN_E2E_ONE_CLICK_TESTNET,
  network: process.env.MIDEN_NETWORK,
  managerKey: process.env.MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('1Click quote binding to a configured NEAR Intents pair', () => {
  beforeAll(() => {
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
    process.env.MIDEN_NETWORK = 'localhost';
    process.env.MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY = FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY;
  });

  afterAll(() => {
    restore('MIDEN_E2E_TEST', saved.e2e);
    restore('MIDEN_E2E_ONE_CLICK_TESTNET', saved.oneClick);
    restore('MIDEN_NETWORK', saved.network);
    restore('MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY', saved.managerKey);
  });

  it('accepts a signed deposit quote for a configured pair, with an EVM contract address in any case', () => {
    const { request, quote } = signed(ethUsdc, midenUsdc);
    expect(() => assertOneClickQuoteBinding(request, quote, false, config)).not.toThrow();
  });

  it('accepts a configured Solana pair and a Miden asset without a faucet id', () => {
    const { faucetId: _faucetId, ...withoutFaucet } = midenUsdc;
    const { request, quote } = signed(solUsdc, withoutFaucet);
    expect(() => assertOneClickQuoteBinding(request, quote, false, config)).not.toThrow();
  });

  it('refuses a Miden token that the origin token does not list', () => {
    const { request, quote } = signed(ethUsdc, midenEth);
    expect(() => assertOneClickQuoteBinding(request, quote, false, config)).toThrow('configured NEAR Intents pair');
  });

  it('refuses a route between two chains', () => {
    const { request, quote } = signed(ethUsdc, solUsdc);
    expect(() => assertOneClickQuoteBinding(request, quote, false, config)).toThrow('configured NEAR Intents pair');
  });

  it.each([
    ['another chain', { blockchain: 'arb' }],
    ['other decimals', { decimals: 18 }],
    ['another contract address', { contractAddress: `0x${'b'.repeat(40)}` }],
    ['no contract address', { contractAddress: undefined }],
    ['an asset id that is not configured', { assetId: 'nep141:eth-other.omft.near' }]
  ])('refuses an origin token with %s', (_label, override) => {
    const { request, quote } = signed({ ...ethUsdc, ...override }, midenUsdc);
    expect(() => assertOneClickQuoteBinding(request, quote, false, config)).toThrow('trusted identity');
  });

  it('compares a non-EVM contract address exactly', () => {
    const { request, quote } = signed({ ...solUsdc, contractAddress: solanaMint.toLowerCase() }, midenUsdc);
    expect(() => assertOneClickQuoteBinding(request, quote, false, config)).toThrow('trusted identity');
  });

  it.each([
    ['another faucet', { faucetId: ethFaucet }],
    ['other decimals', { decimals: 8 }],
    ['an asset id that is not configured', { assetId: 'miden:other' }]
  ])('refuses a Miden destination with %s', (_label, override) => {
    const { request, quote } = signed(ethUsdc, { ...midenUsdc, ...override });
    expect(() => assertOneClickQuoteBinding(request, quote, false, config)).toThrow('trusted identity');
  });

  it('accepts the same pair in the Miden-to-chain direction of the older start path', () => {
    const { request, quote } = signed(midenUsdc, ethUsdc);
    expect(() => assertOneClickQuoteBinding(request, quote, false, config)).not.toThrow();
  });

  it('refuses every pair when the config has no chain', () => {
    const { request, quote } = signed(ethUsdc, midenUsdc);
    expect(() => assertOneClickQuoteBinding(request, quote, false, { ...config, chains: [] })).toThrow(
      'trusted identity'
    );
  });

  it('accepts the fees that 1Click attaches for the partner key', () => {
    const fees = [
      { recipient: 'wallet.near', fee: 20 },
      { recipient: 'partner.near', fee: 7 }
    ];
    const withFees = signed(ethUsdc, midenUsdc, fees);
    expect(() => assertOneClickQuoteBinding(withFees.request, withFees.quote, false, config)).not.toThrow();
  });

  it('refuses a deposit quote checked as a dry quote', () => {
    const { request, quote } = signed(ethUsdc, midenUsdc);
    expect(() => assertOneClickQuoteBinding(request, quote, true, config)).toThrow('requested route');
  });
});
