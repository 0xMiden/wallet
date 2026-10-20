import type { JsonFetch, JsonResponse } from 'lib/remote-json';

import { HOLDINGS_MAX, isAboveDust, readErc20Holdings } from './token-holdings';

const API = 'https://eth-sepolia.blockscout.com/api/v2';
const HOLDER = '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A';

const answer = (body: unknown, ok = true): JsonResponse => ({ ok, status: ok ? 200 : 503, json: async () => body });
const fetching = (body: unknown, ok = true) =>
  jest.fn<ReturnType<JsonFetch>, Parameters<JsonFetch>>(async () => answer(body, ok));

// Two entries as Sepolia's Blockscout listed them on 2026-10-20 (`token.address_hash`), one in the older shape
// (`token.address`), one NFT, one with no symbol, and one dust balance.
const LISTED = [
  {
    token: {
      address_hash: '0x21472DF1B5d2b673F6444B41258C6460294a2C06',
      decimals: '8',
      symbol: 'WBTC',
      type: 'ERC-20'
    },
    value: '150000000'
  },
  {
    token: {
      address_hash: '0x22939b3A4dFD9Fc6211F99Cdc6bd9f6708ae2956',
      decimals: '18',
      symbol: 'BUG',
      type: 'ERC-20'
    },
    value: '1000000000000000000'
  },
  {
    token: { address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69', decimals: '18', symbol: 'USDC', type: 'ERC-20' },
    value: '2500000000000000000'
  },
  {
    token: {
      address_hash: '0x0000000000000000000000000000000000000a01',
      decimals: null,
      symbol: 'NFT',
      type: 'ERC-721'
    },
    value: '1'
  },
  {
    token: { address_hash: '0x0000000000000000000000000000000000000a02', decimals: '18', symbol: null, type: 'ERC-20' },
    value: '5'
  },
  {
    token: {
      address_hash: '0x0000000000000000000000000000000000000a03',
      decimals: '18',
      symbol: 'DUST',
      type: 'ERC-20'
    },
    value: '9999999999999'
  }
];

describe('isAboveDust', () => {
  it('keeps a balance of at least 1e-5 of a token and drops the rest', () => {
    expect(isAboveDust(10_000_000_000_000n, 18)).toBe(true);
    expect(isAboveDust(9_999_999_999_999n, 18)).toBe(false);
    expect(isAboveDust(10n, 6)).toBe(true);
    expect(isAboveDust(9n, 6)).toBe(false);
    expect(isAboveDust(1n, 0)).toBe(true);
    expect(isAboveDust(0n, 0)).toBe(false);
  });
});

describe('readErc20Holdings', () => {
  it('lists the fungible holdings above dust, largest first, keyed by lowercase address', async () => {
    const fetchFn = fetching(LISTED);
    await expect(readErc20Holdings(API, HOLDER, fetchFn)).resolves.toEqual([
      {
        contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
        symbol: 'USDC',
        decimals: 18,
        value: 2_500_000_000_000_000_000n
      },
      {
        contractAddress: '0x21472df1b5d2b673f6444b41258c6460294a2c06',
        symbol: 'WBTC',
        decimals: 8,
        value: 150_000_000n
      },
      {
        contractAddress: '0x22939b3a4dfd9fc6211f99cdc6bd9f6708ae2956',
        symbol: 'BUG',
        decimals: 18,
        value: 1_000_000_000_000_000_000n
      }
    ]);
    expect(fetchFn).toHaveBeenCalledWith(`${API}/addresses/${HOLDER}/token-balances`, expect.any(Object));
  });

  it('keeps one entry per contract and at most the cap', async () => {
    const many = Array.from({ length: HOLDINGS_MAX + 3 }, (_, index) => ({
      token: {
        address_hash: `0x${(index + 1).toString(16).padStart(40, '0')}`,
        decimals: '18',
        symbol: `T${index}`,
        type: 'ERC-20'
      },
      value: '1000000000000000000'
    }));
    const holdings = await readErc20Holdings(API, HOLDER, fetching([...many, many[0]]));
    expect(holdings).toHaveLength(HOLDINGS_MAX);
    expect(new Set(holdings.map(holding => holding.contractAddress)).size).toBe(HOLDINGS_MAX);
  });

  it('rejects an answer that is not a list, a failed request and an invalid address', async () => {
    await expect(readErc20Holdings(API, HOLDER, fetching({ items: [] }))).rejects.toThrow('not a list');
    await expect(readErc20Holdings(API, HOLDER, fetching(null, false))).rejects.toThrow('HTTP 503');
    await expect(readErc20Holdings(API, 'not-an-address', fetching([]))).rejects.toThrow('Invalid EVM address');
  });
});
