import type { Address } from 'viem';

import type { BatchCall } from './batch';
import type { RelayQuoteQuery } from './client';
import { RelayApiError, RelayMismatchError, RelayRefusedError, RelayUnavailableError } from './errors';
import { amountAfterRelayFee, quoteRelayFee, relayQuoteFee, type RelayFeeAsset } from './quote';
import { CHAIN, FEE_RECIPIENT, NATIVE, QUOTE_PROOF, RELAY_ADDRESS, USDC, USDC_VALUE, upperHex } from './testing';
import type { RelayQuote } from './types';

const mockGetRelayChain = jest.fn();
jest.mock('lib/remote-config/values', () => ({
  getRelayChain: (chainId: number) => mockGetRelayChain(chainId)
}));
const mockFetchRelayQuote = jest.fn();
jest.mock('./client', () => ({
  fetchRelayQuote: (query: RelayQuoteQuery) => mockFetchRelayQuote(query)
}));
const mockPriceMicroUsd = jest.fn();
jest.mock('./fee-price', () => ({
  relayFeeTokenPriceMicroUsd: (chainId: number, token: Address) => mockPriceMicroUsd(chainId, token)
}));

const TARGET: Address = '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582';
const USDC_ASSET: RelayFeeAsset = { address: USDC, decimals: USDC_VALUE.decimals };
const NATIVE_ASSET: RelayFeeAsset = { address: NATIVE, decimals: 18 };
const usdcPrice = async () => USDC_VALUE.priceMicroUsd;
const CALLS: BatchCall[] = [{ to: TARGET, value: 0n, data: '0xcafe0001' }];
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const QUOTE: RelayQuote = {
  chainId: CHAIN.chainId,
  token: USDC,
  recipient: FEE_RECIPIENT,
  fee: 1000n,
  gas: 210_000n,
  sequence: QUOTE_PROOF.sequence,
  validUntil: NOW_SECONDS + 120,
  signature: QUOTE_PROOF.signature
};

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRelayChain.mockImplementation((chainId: number) => (chainId === CHAIN.chainId ? CHAIN : null));
});

describe('quoteRelayFee', () => {
  it('asks for the quote of the calls from a relay source and gives the checked quote', async () => {
    const fetchQuote = jest.fn(async (_query: RelayQuoteQuery) => QUOTE);
    const priceMicroUsd = jest.fn(usdcPrice);
    const source = { accountPublicKey: 'miden-a', address: RELAY_ADDRESS };
    const feeToken = { ...USDC_ASSET, address: upperHex(USDC) };
    const quote = await quoteRelayFee(source, CHAIN.chainId, CALLS, feeToken, {
      fetchQuote,
      priceMicroUsd,
      now: () => NOW_MS
    });
    expect(quote).toEqual({ ...QUOTE, tokenValue: USDC_VALUE });
    expect(priceMicroUsd).toHaveBeenCalledWith(CHAIN.chainId, upperHex(USDC));
    expect(fetchQuote).toHaveBeenCalledWith({
      chainId: CHAIN.chainId,
      evmAddress: RELAY_ADDRESS,
      calls: CALLS,
      feeToken: upperHex(USDC)
    });
  });

  it('takes an address and the authorization flag, and uses the client, the price feed and the clock by default', async () => {
    mockFetchRelayQuote.mockResolvedValue({ ...QUOTE, validUntil: Math.floor(Date.now() / 1000) + 120 });
    mockPriceMicroUsd.mockResolvedValue(USDC_VALUE.priceMicroUsd);
    await quoteRelayFee(RELAY_ADDRESS, CHAIN.chainId, CALLS, USDC_ASSET, { authorization: true });
    expect(mockPriceMicroUsd).toHaveBeenCalledWith(CHAIN.chainId, USDC);
    expect(mockFetchRelayQuote).toHaveBeenCalledWith({
      chainId: CHAIN.chainId,
      evmAddress: RELAY_ADDRESS,
      calls: CALLS,
      feeToken: USDC,
      authorization: true
    });
  });

  it('refuses a chain that the config does not name, and asks nothing', async () => {
    const fetchQuote = jest.fn(async (_query: RelayQuoteQuery) => QUOTE);
    const priceMicroUsd = jest.fn(usdcPrice);
    const error = await failure(quoteRelayFee(RELAY_ADDRESS, 1, CALLS, USDC_ASSET, { fetchQuote, priceMicroUsd }));
    expect(error).toMatchObject({ name: 'RelayUnavailableError', reason: 'not_configured' });
    expect(error).toBeInstanceOf(RelayUnavailableError);
    expect(priceMicroUsd).not.toHaveBeenCalled();
    expect(fetchQuote).not.toHaveBeenCalled();
  });

  it('refuses a fee token with no fresh price, and does not ask the relay', async () => {
    const fetchQuote = jest.fn(async (_query: RelayQuoteQuery) => QUOTE);
    const error = await failure(
      quoteRelayFee(RELAY_ADDRESS, CHAIN.chainId, CALLS, USDC_ASSET, {
        fetchQuote,
        priceMicroUsd: async () => undefined
      })
    );
    expect(error).toBeInstanceOf(RelayRefusedError);
    expect(error).toMatchObject({ reason: 'fee-price-unavailable' });
    expect(fetchQuote).not.toHaveBeenCalled();
  });

  it('checks the USD value of the fee with the price of the wallet', async () => {
    // 40,000 base units of a 6-decimal token: 0.04 USD at 1 USD, and 0.06 USD at 1.50 USD. The limit is 0.05 USD.
    const answer = { ...QUOTE, fee: 40_000n };
    const options = { fetchQuote: async () => answer, now: () => NOW_MS };
    const accepted = await quoteRelayFee(RELAY_ADDRESS, CHAIN.chainId, CALLS, USDC_ASSET, {
      ...options,
      priceMicroUsd: usdcPrice
    });
    expect(accepted.tokenValue).toEqual(USDC_VALUE);
    const error = await failure(
      quoteRelayFee(RELAY_ADDRESS, CHAIN.chainId, CALLS, USDC_ASSET, {
        ...options,
        priceMicroUsd: async () => 1_500_000n
      })
    );
    expect(error).toMatchObject({ name: 'RelayRefusedError', reason: 'fee-not-accepted' });
  });

  it.each<[string, RelayQuote, RelayFeeAsset, new (...args: never[]) => Error]>([
    ['for another recipient', { ...QUOTE, recipient: TARGET }, USDC_ASSET, RelayMismatchError],
    ['for another token', QUOTE, NATIVE_ASSET, RelayMismatchError],
    ['above the fee limit', { ...QUOTE, fee: 50_001n }, USDC_ASSET, RelayRefusedError],
    ['that is no longer valid', { ...QUOTE, validUntil: NOW_SECONDS }, USDC_ASSET, RelayRefusedError]
  ])('refuses a quote %s', async (_name, answer, token, type) => {
    const error = await failure(
      quoteRelayFee(RELAY_ADDRESS, CHAIN.chainId, CALLS, token, {
        fetchQuote: async () => answer,
        priceMicroUsd: usdcPrice,
        now: () => NOW_MS
      })
    );
    expect(error).toBeInstanceOf(type);
  });

  it('passes on a refusal of the relay', async () => {
    const notNeeded = new RelayApiError('fee_not_needed', 400, 'sponsor');
    const error = await failure(
      quoteRelayFee(RELAY_ADDRESS, CHAIN.chainId, CALLS, USDC_ASSET, {
        fetchQuote: () => Promise.reject(notNeeded),
        priceMicroUsd: usdcPrice
      })
    );
    expect(error).toBe(notNeeded);
  });
});

describe('relayQuoteFee', () => {
  it('gives the token, the fee and the token value of the checked quote as the reviewed fee', () => {
    expect(relayQuoteFee({ ...QUOTE, tokenValue: USDC_VALUE })).toEqual({
      token: USDC,
      amount: 1000n,
      tokenValue: USDC_VALUE,
      quote: { ...QUOTE_PROOF, gas: QUOTE.gas }
    });
  });
});

describe('amountAfterRelayFee', () => {
  it.each<[bigint, bigint, bigint | null]>([
    [1_000_000n, 1000n, 999_000n],
    [1001n, 1000n, 1n],
    [1000n, 1000n, null],
    [999n, 1000n, null],
    [0n, 0n, null],
    [5n, 0n, 5n]
  ])('leaves %p less %p as %p', (amount, fee, left) => {
    expect(amountAfterRelayFee(amount, fee)).toBe(left);
  });

  it('refuses a negative fee', () => {
    expect(() => amountAfterRelayFee(10n, -1n)).toThrow(TypeError);
  });
});
