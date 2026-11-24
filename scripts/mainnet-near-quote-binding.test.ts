/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertOneClickQuoteBinding,
  parseOneClickQuoteResponse,
  requestOneClickQuote
} from '../src/lib/one-click/client';
import { verifyOneClickQuoteSignature } from '../src/lib/one-click/signature';
import type { NearIntentsConfig, OneClickAsset, OneClickQuoteRequest } from '../src/lib/one-click/types';

const raw: unknown = JSON.parse(readFileSync(join(__dirname, 'fixtures/mainnet-near-fee10.json'), 'utf8'));
const response = parseOneClickQuoteResponse(raw);
const nativeFaucet = '0xe69e6ca6e39df1b10c1e5399399feb';
const evmToken = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const originAsset: OneClickAsset = {
  assetId: response.quoteRequest.originAsset,
  blockchain: 'miden',
  symbol: 'USDCX',
  decimals: 6,
  faucetId: nativeFaucet
};
const destinationAsset: OneClickAsset = {
  assetId: response.quoteRequest.destinationAsset,
  blockchain: 'arb',
  symbol: 'USDC',
  decimals: 6,
  chainId: 42161,
  contractAddress: evmToken
};
const feeRecipient = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';
const config: NearIntentsConfig = {
  serviceUrl: 'https://1click.chaindefuser.com',
  midenAssets: [{ id: 'usdcx', assetId: originAsset.assetId, faucetId: nativeFaucet, decimals: 6 }],
  chains: [
    {
      id: 'arb',
      name: 'Arbitrum',
      addressKind: 'evm',
      tokens: [
        {
          symbol: 'USDC',
          assetId: destinationAsset.assetId,
          decimals: 6,
          contractAddress: evmToken,
          miden: ['usdcx']
        }
      ]
    }
  ]
};
const request: OneClickQuoteRequest = {
  originAsset,
  destinationAsset,
  amount: response.quoteRequest.amount,
  refundTo: response.quoteRequest.refundTo,
  recipient: response.quoteRequest.recipient,
  deadline: response.quoteRequest.deadline,
  slippageTolerance: response.quoteRequest.slippageTolerance
};

const fetchesRaw =
  (onBody: (body: unknown) => void): typeof fetch =>
  async (_url, init) => {
    onBody(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
    return new Response(JSON.stringify(raw), { status: 201 });
  };

afterEach(() => jest.useRealTimers());
it('verifies the actual read-only provider quote against the pinned manager key', () => {
  expect(verifyOneClickQuoteSignature(response)).toBe(true);
});
it('binds the forward Miden-to-Arbitrum quote through the configured NEAR Intents pair', () => {
  expect(() => assertOneClickQuoteBinding(request, response, true, config)).not.toThrow();
});
it('does not mistake returned app-fee metadata for signed authorization or a configured fee', () => {
  const changed = {
    ...response,
    quoteRequest: { ...response.quoteRequest, appFees: [{ recipient: feeRecipient, fee: 10 }] }
  };
  expect(verifyOneClickQuoteSignature(changed)).toBe(true);
  expect(() => assertOneClickQuoteBinding(request, changed, true, config)).not.toThrow();
});
it('refuses the quote when its pair is not a configured NEAR Intents route', () => {
  const unpaired: NearIntentsConfig = {
    ...config,
    chains: config.chains.map(chain => ({
      ...chain,
      tokens: chain.tokens.map(token => ({ ...token, assetId: 'nep141:arb-other.omft.near' }))
    }))
  };
  expect(() => assertOneClickQuoteBinding(request, response, true, unpaired)).toThrow();
});
it('sends no app fees through the actual request client', async () => {
  jest.useFakeTimers().setSystemTime(new Date(response.timestamp));
  let sent: unknown;
  await expect(
    requestOneClickQuote(
      config,
      request,
      true,
      fetchesRaw(body => (sent = body))
    )
  ).resolves.toEqual(response);
  expect(sent).not.toHaveProperty('appFees');
  expect(sent).not.toHaveProperty('feePolicy');
});
