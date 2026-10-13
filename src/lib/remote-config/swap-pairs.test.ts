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

  it.each([
    ['a body that is not an object', ['IETH']],
    ['a token list that is not an array', withTokens({ IETH: ieth })],
    ['a pair list that is not an array', withPairs({})],
    ['a missing pair list', { tokens: TEST_SWAP_PAIRS_RESPONSE.tokens }],
    ['a token that is not an object', withTokens(['IETH'])],
    ['a lower-case ticker', withTokens([{ ...ieth, ticker: 'iEth' }])],
    ['a seven-letter ticker', withTokens([{ ...ieth, ticker: 'IBITCON' }])],
    ['a bech32 faucet id', withTokens([{ ...ieth, faucetId: 'mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h' }])],
    ['a missing faucet id', withTokens([{ ticker: 'IETH', decimals: 8 }])],
    ['fractional decimals', withTokens([{ ...ieth, decimals: 8.5 }])],
    ['decimals above 12', withTokens([{ ...ieth, decimals: 13 }])],
    ['negative decimals', withTokens([{ ...ieth, decimals: -1 }])],
    ['an asset that is not a string', withTokens([{ ...ieth, binanceAsset: 1 }])],
    ['two tokens for one faucet', withTokens([ieth, { ...ieth, ticker: 'IBTC' }])],
    ['two tokens for one ticker', withTokens([ieth, { ...ieth, faucetId: ibtc!.faucetId }])],
    ['a pair that is not an object', withPairs(['IETH-IUSDT'])],
    ['a pair of one faucet', withPairs([{ faucetIds: [ieth!.faucetId] }])],
    ['a pair of three faucets', withPairs([{ faucetIds: [ieth!.faucetId, iusdt!.faucetId, ibtc!.faucetId] }])],
    ['a pair of a faucet with itself', withPairs([{ faucetIds: [ieth!.faucetId, ieth!.faucetId] }])],
    ['a pair with a malformed faucet id', withPairs([{ faucetIds: [ieth!.faucetId, 'IUSDT'] }])]
  ])('refuses the response over %s', (_name, body) => {
    expect(parseSwapPairs(body)).toBeNull();
  });
});
