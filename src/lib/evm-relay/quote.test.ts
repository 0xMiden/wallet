import type { Address } from 'viem';

import type { BatchCall } from './batch';
import type { RelayQuoteQuery } from './client';
import { RelayApiError, RelayMismatchError, RelayRefusedError, RelayUnavailableError } from './errors';
import { amountAfterRelayFee, quoteRelayFee, relayQuoteFee } from './quote';
import { CHAIN, FEE_RECIPIENT, NATIVE, RELAY_ADDRESS, USDC, upperHex } from './testing';
import type { RelayQuote } from './types';

const mockGetRelayChain = jest.fn();
jest.mock('lib/remote-config/values', () => ({
  getRelayChain: (chainId: number) => mockGetRelayChain(chainId)
}));
const mockFetchRelayQuote = jest.fn();
jest.mock('./client', () => ({
  fetchRelayQuote: (query: RelayQuoteQuery) => mockFetchRelayQuote(query)
}));

const TARGET: Address = '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582';
const CALLS: BatchCall[] = [{ to: TARGET, value: 0n, data: '0xcafe0001' }];
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const QUOTE: RelayQuote = {
  chainId: CHAIN.chainId,
  token: USDC,
  recipient: FEE_RECIPIENT,
  fee: 1000n,
  gas: 210_000n,
  validUntil: NOW_SECONDS + 120
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
    const source = { accountPublicKey: 'miden-a', address: RELAY_ADDRESS };
    const quote = await quoteRelayFee(source, CHAIN.chainId, CALLS, upperHex(USDC), {
      fetchQuote,
      now: () => NOW_MS
    });
    expect(quote).toBe(QUOTE);
    expect(fetchQuote).toHaveBeenCalledWith({
      chainId: CHAIN.chainId,
      evmAddress: RELAY_ADDRESS,
      calls: CALLS,
      feeToken: upperHex(USDC)
    });
  });

  it('takes an address and the authorization flag, and uses the client and the clock by default', async () => {
    mockFetchRelayQuote.mockResolvedValue({ ...QUOTE, validUntil: Math.floor(Date.now() / 1000) + 120 });
    await quoteRelayFee(RELAY_ADDRESS, CHAIN.chainId, CALLS, USDC, { authorization: true });
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
    const error = await failure(quoteRelayFee(RELAY_ADDRESS, 1, CALLS, USDC, { fetchQuote }));
    expect(error).toMatchObject({ name: 'RelayUnavailableError', reason: 'not_configured' });
    expect(error).toBeInstanceOf(RelayUnavailableError);
    expect(fetchQuote).not.toHaveBeenCalled();
  });

  it.each<[string, RelayQuote, Address, new (...args: never[]) => Error]>([
    ['for another recipient', { ...QUOTE, recipient: TARGET }, USDC, RelayMismatchError],
    ['for another token', QUOTE, NATIVE, RelayMismatchError],
    ['above the config cap', { ...QUOTE, fee: 50_001n }, USDC, RelayRefusedError],
    ['that is no longer valid', { ...QUOTE, validUntil: NOW_SECONDS }, USDC, RelayRefusedError]
  ])('refuses a quote %s', async (_name, answer, token, type) => {
    const error = await failure(
      quoteRelayFee(RELAY_ADDRESS, CHAIN.chainId, CALLS, token, {
        fetchQuote: async () => answer,
        now: () => NOW_MS
      })
    );
    expect(error).toBeInstanceOf(type);
  });

  it('passes on a refusal of the relay', async () => {
    const notNeeded = new RelayApiError('fee_not_needed', 400, 'sponsor');
    const error = await failure(
      quoteRelayFee(RELAY_ADDRESS, CHAIN.chainId, CALLS, USDC, { fetchQuote: () => Promise.reject(notNeeded) })
    );
    expect(error).toBe(notNeeded);
  });
});

describe('relayQuoteFee', () => {
  it('gives the token and the fee of the quote as the reviewed fee', () => {
    expect(relayQuoteFee(QUOTE)).toEqual({ token: USDC, amount: 1000n });
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
