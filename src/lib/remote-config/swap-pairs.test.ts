import { TEST_SWAP_PAIRS_RESPONSE } from 'lib/miden/swap/testing/registry';

import { parseSwapPairs } from './swap-pairs';

const [imiden, ieth, iusdt, ibtc] = TEST_SWAP_PAIRS_RESPONSE.tokens;
const withTokens = (tokens: unknown) => ({ ...TEST_SWAP_PAIRS_RESPONSE, tokens });
const withPairs = (pairs: unknown) => ({ ...TEST_SWAP_PAIRS_RESPONSE, pairs });

describe('parseSwapPairs', () => {
  it('reads the tokens and pairs in order, keeping only the fields the wallet reads', () => {
    expect(parseSwapPairs(TEST_SWAP_PAIRS_RESPONSE)).toStrictEqual({
      tokens: [
        { faucetId: '0x750052a4af10cd51141f52c0ec2ada', ticker: 'IMIDEN', decimals: 8 },
        { faucetId: '0xe33498f1176661512b5ac4ded86ec7', ticker: 'IETH', decimals: 8, binanceAsset: 'ETH' },
        { faucetId: '0x094698fc4bc531d136db0866f38902', ticker: 'IUSDT', decimals: 8 },
        { faucetId: '0xaf8444c4a7c091114666adba25c5d0', ticker: 'IBTC', decimals: 8, binanceAsset: 'BTC' }
      ],
      pairs: [
        { faucetIds: ['0x750052a4af10cd51141f52c0ec2ada', '0xe33498f1176661512b5ac4ded86ec7'] },
        { faucetIds: ['0xe33498f1176661512b5ac4ded86ec7', '0x094698fc4bc531d136db0866f38902'] },
        { faucetIds: ['0xaf8444c4a7c091114666adba25c5d0', '0x094698fc4bc531d136db0866f38902'] }
      ]
    });
  });

  it('parses its own result to itself, as the stored copy needs', () => {
    const parsed = parseSwapPairs(TEST_SWAP_PAIRS_RESPONSE);
    expect(parseSwapPairs(parsed)).toStrictEqual(parsed);
  });

  it('lowercases faucet ids in tokens and pairs', () => {
    const upper = '0xE33498F1176661512B5AC4DED86EC7';
    const parsed = parseSwapPairs({
      tokens: [{ ...ieth, faucetId: upper }, iusdt],
      pairs: [{ faucetIds: [upper, iusdt!.faucetId] }]
    });
    expect(parsed?.tokens[0]?.faucetId).toBe(ieth!.faucetId);
    expect(parsed?.pairs).toStrictEqual([{ faucetIds: [ieth!.faucetId, iusdt!.faucetId] }]);
  });

  it('drops an asset the price feed does not quote, or a missing one, keeping the token unpriced', () => {
    const { binanceAsset: _asset, ...bare } = ieth!;
    const parsed = parseSwapPairs(
      withTokens([{ ...imiden, binanceAsset: 'SOL' }, bare, { ...ibtc, binanceAsset: null }])
    );
    expect(parsed?.tokens.map(token => token.binanceAsset)).toEqual([undefined, undefined, undefined]);
  });

  it('leaves out a token with no ticker, and every pair of that token', () => {
    const parsed = parseSwapPairs(withTokens([{ ...imiden, ticker: null }, ieth, iusdt, ibtc]));
    expect(parsed?.tokens.map(token => token.ticker)).toEqual(['IETH', 'IUSDT', 'IBTC']);
    expect(parsed?.pairs).toHaveLength(2);
  });

  it('leaves out a pair that names a faucet the solver does not list', () => {
    const parsed = parseSwapPairs(withPairs([{ faucetIds: [ieth!.faucetId, '0x0000000000000000000000000000ab'] }]));
    expect(parsed?.pairs).toEqual([]);
  });

  it('reads a ticker of up to 12 letters, the wallet symbol limit', () => {
    const parsed = parseSwapPairs(
      withTokens([
        { ...ieth, ticker: 'IPOLKADOT' },
        { ...iusdt, ticker: 'IUSDTETHEREU' }
      ])
    );
    expect(parsed?.tokens.map(token => token.ticker)).toEqual(['IPOLKADOT', 'IUSDTETHEREU']);
  });

  it('leaves out every malformed or ambiguous token and its pairs, keeping the others', () => {
    const iother = { faucetId: '0x0000000000000000000000000000cd', ticker: 'IPOLKADOT', decimals: 6 };
    const parsed = parseSwapPairs({
      tokens: [
        imiden,
        { ...ieth, decimals: 13 },
        iusdt,
        { ...iusdt, ticker: 'IUSDC' },
        ibtc,
        { ...ibtc, faucetId: '0x0000000000000000000000000000ab' },
        iother
      ],
      pairs: [...TEST_SWAP_PAIRS_RESPONSE.pairs, { faucetIds: [imiden!.faucetId, iother.faucetId] }]
    });
    expect(parsed).toStrictEqual({
      tokens: [
        { faucetId: imiden!.faucetId, ticker: 'IMIDEN', decimals: 8 },
        { faucetId: iother.faucetId, ticker: 'IPOLKADOT', decimals: 6 }
      ],
      pairs: [{ faucetIds: [imiden!.faucetId, iother.faucetId] }]
    });
  });

  it('leaves out both entries for one faucet in either order, even when one is itself malformed', () => {
    const malformed = { ...ieth, ticker: 'iEth' };
    expect(parseSwapPairs(withTokens([imiden, ieth, malformed]))?.tokens.map(token => token.ticker)).toEqual([
      'IMIDEN'
    ]);
    expect(parseSwapPairs(withTokens([malformed, ieth, imiden]))?.tokens.map(token => token.ticker)).toEqual([
      'IMIDEN'
    ]);
  });

  it.each([
    ['a token that is not an object', 'IETH'],
    ['a lower-case ticker', { ...ieth, ticker: 'iEth' }],
    ['a thirteen-letter ticker', { ...ieth, ticker: 'IETHEREUMWRAP' }],
    ['a ticker that is not a string', { ...ieth, ticker: 7 }],
    ['a bech32 faucet id', { ...ieth, faucetId: 'mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h' }],
    ['a missing faucet id', { ticker: 'IETH', decimals: 8 }],
    ['missing decimals', { faucetId: ieth!.faucetId, ticker: 'IETH' }],
    ['fractional decimals', { ...ieth, decimals: 8.5 }],
    ['decimals above 12', { ...ieth, decimals: 13 }],
    ['negative decimals', { ...ieth, decimals: -1 }],
    ['an asset that is not a string', { ...ieth, binanceAsset: 1 }]
  ])('leaves out a token over %s, keeping the others', (_name, token) => {
    const parsed = parseSwapPairs(withTokens([token, iusdt, ibtc]));
    expect(parsed?.tokens.map(entry => entry.ticker)).toEqual(['IUSDT', 'IBTC']);
    expect(parsed?.pairs).toStrictEqual([{ faucetIds: [ibtc!.faucetId, iusdt!.faucetId] }]);
  });

  it.each([
    ['a pair that is not an object', 'IETH-IUSDT'],
    ['a pair with no faucet list', { name: 'IETH-IUSDT' }],
    ['a pair of one faucet', { faucetIds: [ieth!.faucetId] }],
    ['a pair of three faucets', { faucetIds: [ieth!.faucetId, iusdt!.faucetId, ibtc!.faucetId] }],
    ['a pair of a faucet with itself', { faucetIds: [ieth!.faucetId, ieth!.faucetId] }],
    ['a pair with a malformed faucet id', { faucetIds: [ieth!.faucetId, 'IUSDT'] }]
  ])('leaves out %s, keeping the other pairs', (_name, pair) => {
    const kept = { faucetIds: [ibtc!.faucetId, iusdt!.faucetId] };
    expect(parseSwapPairs(withPairs([pair, kept]))?.pairs).toStrictEqual([kept]);
  });

  it.each([
    ['a body that is not an object', ['IETH']],
    ['a token list that is not an array', withTokens({ IETH: ieth })],
    ['a pair list that is not an array', withPairs({})],
    ['a missing pair list', { tokens: TEST_SWAP_PAIRS_RESPONSE.tokens }]
  ])('refuses the response over %s', (_name, body) => {
    expect(parseSwapPairs(body)).toBeNull();
  });
});
