import { TOKEN_IBTC, TOKEN_IETH, TOKEN_IMIDEN, TOKEN_IUSDT } from 'lib/miden/swap/tokens';
import { getPriceMicro } from 'lib/prices/usd';

import { fetchTokenMetadata } from '../metadata';
import { SpendingLimitPriceUnavailableError } from './types';
import { resolveSpendsUsd, usdMicroFromAmount } from './valuation';

jest.mock('lib/prices/usd', () => ({
  ...jest.requireActual('lib/prices/usd'),
  getPriceMicro: jest.fn()
}));
jest.mock('../metadata', () => ({ fetchTokenMetadata: jest.fn() }));
// The dApp custom path emits a faucet's hex spelling; map one to IETH's bech32 id so the test
// can tell whether the canonical id or the raw one reaches the price-symbol lookup.
const IETH_HEX = '0x1eth00000000000000000000000000';
jest.mock('../sdk/helpers', () => {
  const actual = jest.requireActual('../sdk/helpers');
  return {
    ...actual,
    canonicalFaucetBech32Id: (id: string) =>
      id === IETH_HEX
        ? jest.requireActual('lib/miden/swap/tokens').TOKEN_IETH.faucetId
        : actual.canonicalFaucetBech32Id(id)
  };
});

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

  it('fails closed when metadata resolves to the unidentified placeholder instead of rejecting', async () => {
    // `fetchTokenMetadata` does not always throw on a faucet it cannot identify - three of its
    // paths RESOLVE the `Unknown` placeholder instead (and cache it on two of them). Identification
    // must run before coverage, or 'Unknown' reads as an ordinary uncovered symbol and is silently
    // counted as zero forever.
    mockedMetadata.mockResolvedValue(base('Unknown', 6, true));

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('values an empty spend list as nothing', async () => {
    await expect(resolveSpendsUsd([], 10)).resolves.toBe(0n);
    expect(mockedMetadata).not.toHaveBeenCalled();
  });

  it('values IETH and IBTC at the ETH and BTC price (#1133)', async () => {
    mockedMetadata.mockImplementation(async faucetId =>
      faucetId === TOKEN_IETH.faucetId ? base('IETH', 8) : base('IBTC', 8)
    );
    mockedPrice.mockImplementation(async symbol => (symbol === 'ETH' ? 4_000_000_000n : 100_000_000_000n));

    const total = await resolveSpendsUsd(
      [
        { faucetId: TOKEN_IETH.faucetId, amount: 50_000_000n },
        { faucetId: TOKEN_IBTC.faucetId, amount: 1_000_000n }
      ],
      10
    );

    // 0.5 ETH at $4000 + 0.01 BTC at $100000
    expect(total).toBe(3_000_000_000n);
    expect(mockedPrice.mock.calls.map(call => call[0]).sort()).toEqual(['BTC', 'ETH']);
  });

  it('values an IETH spend spelled as hex, as the dApp custom path emits it (#1133)', async () => {
    mockedMetadata.mockResolvedValue(base('IETH', 8));
    mockedPrice.mockResolvedValue(4_000_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: IETH_HEX, amount: 100_000_000n }], 10)).resolves.toBe(4_000_000_000n);
    expect(mockedPrice).toHaveBeenCalledWith('ETH', 10);
  });

  it('fails closed when IETH has no fresh ETH price (#1133)', async () => {
    mockedMetadata.mockResolvedValue(base('IETH', 8));
    mockedPrice.mockResolvedValue(undefined);

    await expect(resolveSpendsUsd([{ faucetId: TOKEN_IETH.faucetId, amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
  });

  it('still counts registry tokens without a price symbol as nothing (#1133)', async () => {
    mockedMetadata.mockImplementation(async faucetId =>
      faucetId === TOKEN_IUSDT.faucetId ? base('IUSDT', 8) : base('IMIDEN', 8)
    );

    await expect(
      resolveSpendsUsd(
        [
          { faucetId: TOKEN_IUSDT.faucetId, amount: 999_000_000n },
          { faucetId: TOKEN_IMIDEN.faucetId, amount: 999_000_000n }
        ],
        10
      )
    ).resolves.toBe(0n);
    expect(mockedPrice).not.toHaveBeenCalled();
  });
});
