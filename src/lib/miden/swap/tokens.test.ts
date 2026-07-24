import {
  deriveRequestAmount,
  getSwapTokenByFaucetId,
  getSwapTokens,
  getSwapTokenBySymbol,
  TOKEN_IMIDEN,
  _setSwapTokensForTest,
  SWAP_TOKEN_DECIMALS
} from './tokens';

// The root `__mocks__/lib/i18n/numbers.ts` manual mock is auto-applied (the
// mapped `lib/…` specifier reads as a package name to jest), and it only stubs
// the three format helpers — `toFixedRoundedDown` would be undefined.
// `deriveRequestAmount` rounds with it, so opt this suite back into the real
// module to test the real truncation.
jest.unmock('lib/i18n/numbers');

describe('swap token registry accessor', () => {
  afterEach(() => _setSwapTokensForTest(undefined)); // reset to default

  it('defaults to the built-in registry', () => {
    expect(getSwapTokens().length).toBeGreaterThanOrEqual(4);
    expect(getSwapTokenBySymbol('IMIDEN')).toBeDefined();
  });

  it('override replaces the registry for all readers', () => {
    const t = { symbol: 'SWPA', faucetId: 'mtst1local', decimals: SWAP_TOKEN_DECIMALS, logoSymbol: 'MIDEN' };
    _setSwapTokensForTest([t]);
    expect(getSwapTokens()).toEqual([t]);
    expect(getSwapTokenBySymbol('SWPA')).toEqual(t);
    expect(getSwapTokenBySymbol('IMIDEN')).toBeUndefined();
  });
});

describe('getSwapTokenByFaucetId', () => {
  afterEach(() => _setSwapTokensForTest(undefined));

  it('resolves a registry token by faucet id', () => {
    expect(getSwapTokenByFaucetId(TOKEN_IMIDEN.faucetId)).toEqual(TOKEN_IMIDEN);
  });

  it('returns undefined for an unknown faucet id', () => {
    expect(getSwapTokenByFaucetId('mtst1unknown')).toBeUndefined();
  });

  it('returns undefined when no faucet id is supplied', () => {
    expect(getSwapTokenByFaucetId(undefined)).toBeUndefined();
    expect(getSwapTokenByFaucetId('')).toBeUndefined();
  });

  it('reads through the overridden registry', () => {
    const token = { symbol: 'SWPA', faucetId: 'mtst1local', decimals: SWAP_TOKEN_DECIMALS, logoSymbol: 'MIDEN' };
    _setSwapTokensForTest([token]);
    expect(getSwapTokenByFaucetId('mtst1local')).toEqual(token);
    expect(getSwapTokenByFaucetId(TOKEN_IMIDEN.faucetId)).toBeUndefined();
  });
});

describe('deriveRequestAmount', () => {
  it('discounts the fair quote by the solver margin', () => {
    // 10 offered * 2 per offered = 20 fair, less 5% => 19.
    expect(deriveRequestAmount('10', '2', SWAP_TOKEN_DECIMALS)).toBe('19');
  });

  it('rounds down to the requested token precision', () => {
    // 1 * 1 * 0.95 = 0.95, truncated to 1 decimal => 0.9.
    expect(deriveRequestAmount('1', '1', 1)).toBe('0.9');
  });

  it('returns empty for a missing or unusable offered amount', () => {
    expect(deriveRequestAmount('', '2', SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('0', '2', SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('abc', '2', SWAP_TOKEN_DECIMALS)).toBe('');
  });

  it('returns empty for a missing or non-finite rate', () => {
    expect(deriveRequestAmount('10', undefined, SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('10', '0', SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('10', 'not-a-rate', SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('10', 'Infinity', SWAP_TOKEN_DECIMALS)).toBe('');
  });

  it('returns empty when the quote rounds away to zero at the token precision', () => {
    expect(deriveRequestAmount('0.0001', '0.0001', 2)).toBe('');
  });
});
