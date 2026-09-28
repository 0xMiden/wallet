import { parseTokenList } from './parse';

// Normalization is its own unit (swap/tokens.test.ts); a visible transform proves it is applied.
jest.mock('lib/miden/swap/tokens', () => ({ normalizedFaucetId: (id: string) => `norm:${id}` }));

const token = (overrides: Record<string, unknown> = {}) => ({
  network: 'testnet',
  faucetId: 'mtst1aaa',
  symbol: 'AAA',
  name: 'Token A',
  decimals: 8,
  ...overrides
});
const list = (tokens: unknown[], overrides: Record<string, unknown> = {}) => ({
  name: 'Miden Testnet Verified Tokens',
  timestamp: '2026-09-28T00:00:00.000Z',
  version: { major: 1, minor: 0, patch: 0 },
  tokens,
  ...overrides
});

it('returns the normalized faucet ids of the requested network', () => {
  const doc = list([
    token(),
    token({ faucetId: 'mtst1bbb', symbol: 'BBB' }),
    token({ network: 'devnet', faucetId: 'mdev1ccc' })
  ]);
  expect(parseTokenList(doc, 'testnet')).toEqual(new Set(['norm:mtst1aaa', 'norm:mtst1bbb']));
});

it('returns an empty set, not null, when no token is for the requested network', () => {
  expect(parseTokenList(list([token({ network: 'devnet' })]), 'testnet')).toEqual(new Set());
});

it.each([
  ['not an object', 'x'],
  ['null', null],
  ['no name', list([token()], { name: undefined })],
  ['no version', list([token()], { version: undefined })],
  ['a version part that is not an integer', list([token()], { version: { major: 1, minor: '0', patch: 0 } })],
  ['tokens not an array', list([token()], { tokens: {} })]
])('rejects a document with %s', (_label, doc) => {
  expect(parseTokenList(doc, 'testnet')).toBeNull();
});

it.each([
  ['no faucetId', token({ faucetId: undefined })],
  ['an empty faucetId', token({ faucetId: '' })],
  ['no symbol', token({ symbol: undefined })],
  ['no name', token({ name: undefined })],
  ['no network', token({ network: undefined })],
  ['fractional decimals', token({ decimals: 6.5 })],
  ['negative decimals', token({ decimals: -1 })],
  ['decimals above 18', token({ decimals: 19 })]
])('rejects the whole document when one token has %s', (_label, bad) => {
  // A partial list would mark the dropped token's holders Unverified.
  expect(parseTokenList(list([token(), bad]), 'testnet')).toBeNull();
});
