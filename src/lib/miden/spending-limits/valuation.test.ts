import { getPriceMicro } from 'lib/prices/usd';

import { fetchTokenMetadata } from '../metadata';
import { SpendingLimitPriceUnavailableError } from './types';
import { resolveSpendsUsd, usdMicroFromAmount } from './valuation';

jest.mock('lib/prices/usd', () => ({
  ...jest.requireActual('lib/prices/usd'),
  getPriceMicro: jest.fn()
}));
jest.mock('../metadata', () => ({ fetchTokenMetadata: jest.fn() }));

const mockedPrice = jest.mocked(getPriceMicro);
const mockedMetadata = jest.mocked(fetchTokenMetadata);

const base = (symbol: string, decimals: number, scaleIsUnknown?: boolean) => ({
  base: { symbol, decimals, name: symbol, ...(scaleIsUnknown !== undefined && { scaleIsUnknown }) },
  detailed: { symbol, decimals, name: symbol }
});

beforeEach(() => jest.clearAllMocks());

describe('usdMicroFromAmount', () => {
  it('converts whole units at the quoted price', () => {
    // 2 ETH at $4000 = $8000
    expect(usdMicroFromAmount(2_000_000_000_000_000_000n, 18, 4_000_000_000n)).toBe(8_000_000_000n);
  });

  it('rounds up so a charge is never understated', () => {
    // 1 base unit of an 18-decimal asset at $4000 is a vanishing fraction of a micro-dollar.
    expect(usdMicroFromAmount(1n, 18, 4_000_000_000n)).toBe(1n);
  });

  it('is exact when the division has no remainder', () => {
    expect(usdMicroFromAmount(1_000_000n, 6, 1_000_000n)).toBe(1_000_000n);
  });

  it('values nothing as nothing', () => {
    expect(usdMicroFromAmount(0n, 6, 1_000_000n)).toBe(0n);
  });

  it('rejects impossible inputs rather than producing a number', () => {
    expect(() => usdMicroFromAmount(-1n, 6, 1n)).toThrow(RangeError);
    expect(() => usdMicroFromAmount(1n, -1, 1n)).toThrow(RangeError);
    expect(() => usdMicroFromAmount(1n, 6, -1n)).toThrow(RangeError);
  });
});

describe('resolveSpendsUsd', () => {
  it('values a covered asset', async () => {
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockResolvedValue(1_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 25_000_000n }], 10)).resolves.toBe(25_000_000n);
  });

  it('counts an uncovered asset as nothing and never asks for its price', async () => {
    mockedMetadata.mockResolvedValue(base('MIDEN', 6));

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 999_000_000n }], 10)).resolves.toBe(0n);
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('sums across several assets', async () => {
    mockedMetadata.mockImplementation(async faucetId =>
      faucetId === 'eth' ? base('ETH', 18) : faucetId === 'usdc' ? base('USDC', 6) : base('MIDEN', 6)
    );
    mockedPrice.mockImplementation(async symbol => (symbol === 'ETH' ? 4_000_000_000n : 1_000_000n));

    const total = await resolveSpendsUsd(
      [
        { faucetId: 'eth', amount: 1_000_000_000_000_000_000n },
        { faucetId: 'usdc', amount: 10_000_000n },
        { faucetId: 'miden', amount: 500_000_000n }
      ],
      10
    );

    expect(total).toBe(4_010_000_000n);
  });

  it('fails closed when a covered asset has no fresh price', async () => {
    mockedMetadata.mockResolvedValue(base('ETH', 18));
    mockedPrice.mockResolvedValue(undefined);

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
  });

  it('fails closed when a covered asset has untrustworthy decimals', async () => {
    mockedMetadata.mockResolvedValue(base('USDC', 6, true));
    mockedPrice.mockResolvedValue(1_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
  });

  it('fails closed when the asset cannot be identified at all', async () => {
    mockedMetadata.mockRejectedValue(new Error('rpc down'));

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
  });

  it('values an empty spend list as nothing', async () => {
    await expect(resolveSpendsUsd([], 10)).resolves.toBe(0n);
    expect(mockedMetadata).not.toHaveBeenCalled();
  });
});

describe('binance default price guard', () => {
  it('never reaches the one-dollar default', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const enforcementPath = [
      'src/lib/miden/spending-limits/valuation.ts',
      'src/lib/miden/spending-limits/queue.ts',
      'src/lib/miden/spending-limits/policy.ts',
      'src/lib/prices/usd.ts'
    ];

    for (const file of enforcementPath) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).not.toContain('getTokenPrice');
      expect(source).not.toContain('DEFAULT_PRICE');
    }
  });
});
