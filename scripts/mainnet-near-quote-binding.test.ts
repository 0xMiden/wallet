/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertOneClickQuoteBinding,
  parseOneClickQuoteResponse,
  requestOneClickQuote
} from '../src/lib/one-click/client';
import { verifyOneClickQuoteSignature } from '../src/lib/one-click/signature';
import type { OneClickAsset, OneClickConfig, OneClickQuoteRequest } from '../src/lib/one-click/types';

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
const config: OneClickConfig = {
  serviceUrl: 'https://1click.chaindefuser.com',
  midenAssets: [{ assetId: originAsset.assetId, faucetId: nativeFaucet, decimals: 6 }],
  evmAssets: [
    {
      assetId: destinationAsset.assetId,
      blockchain: 'arb',
      chainId: 42161,
      contractAddress: evmToken,
      decimals: 6,
      symbol: 'USDC'
    }
  ],
  appFees: [{ recipient: feeRecipient, fee: 10 }]
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

const withPolicy: OneClickConfig = {
  ...config,
  feePolicy: { kind: 'partner', platformRecipient: feeRecipient, minimumPlatformFeeBps: 20 }
};

afterEach(() => jest.useRealTimers());
it('accepts only the explicitly pinned documented partner transformation', () => {
  expect(() => assertOneClickQuoteBinding(request, response, true, withPolicy)).not.toThrow();
});
it.each([
  [{ recipient: feeRecipient, fee: 5 }],
  [
    { recipient: feeRecipient, fee: 5 },
    { recipient: feeRecipient, fee: 21 }
  ],
  [
    { recipient: feeRecipient, fee: 5 },
    { recipient: 'other.near', fee: 20 }
  ],
  [
    { recipient: feeRecipient, fee: 5 },
    { recipient: feeRecipient, fee: 20 },
    { recipient: feeRecipient, fee: 1 }
  ]
])('still rejects an unsigned fee-list alteration under the pinned policy: %j', (...appFees) => {
  const changed = { ...response, quoteRequest: { ...response.quoteRequest, appFees } };
  expect(verifyOneClickQuoteSignature(changed)).toBe(true);
  expect(() => assertOneClickQuoteBinding(request, changed, true, withPolicy)).toThrow();
});
it('sends nominal app fees, not the transformed platform policy, through the actual request client', async () => {
  jest.useFakeTimers().setSystemTime(new Date(response.timestamp));
  let sent: unknown;
  const fetcher: typeof fetch = async (_url, init) => {
    sent = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify(raw), { status: 201 });
  };
  await expect(requestOneClickQuote(withPolicy, request, true, fetcher)).resolves.toEqual(response);
  expect(sent).toEqual(expect.objectContaining({ appFees: [{ recipient: feeRecipient, fee: 10 }] }));
  expect(sent).not.toHaveProperty('feePolicy');
});
it('verifies the actual read-only provider quote against the pinned manager key', () => {
  expect(verifyOneClickQuoteSignature(response)).toBe(true);
});
it('rejects the changed fee list even though the captured provider signature is valid', () => {
  expect(() => assertOneClickQuoteBinding(request, response, true, config)).toThrow('configured app fee');
});
it('does not mistake returned app-fee metadata for signed authorization', () => {
  const changed = { ...response, quoteRequest: { ...response.quoteRequest, appFees: config.appFees } };
  expect(verifyOneClickQuoteSignature(changed)).toBe(true);
  expect(() => assertOneClickQuoteBinding(request, changed, true, config)).not.toThrow();
});
it('exercises the actual request client: ten requested basis points cannot authorize five plus twenty', async () => {
  jest.useFakeTimers().setSystemTime(new Date(response.timestamp));
  let sent: unknown;
  const fetcher: typeof fetch = async (_url, init) => {
    sent = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify(raw), { status: 201 });
  };
  await expect(requestOneClickQuote(config, request, true, fetcher)).rejects.toThrow('configured app fee');
  expect(sent).toEqual(expect.objectContaining({ appFees: [{ recipient: feeRecipient, fee: 10 }] }));
});
