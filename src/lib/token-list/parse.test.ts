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

it('reads only the network and faucet id, so a token without the fields nothing reads still counts', () => {
  const bare = { network: 'testnet', faucetId: 'mtst1bbb' };
  expect(parseTokenList(list([token(), bare]), 'testnet')).toEqual(new Set(['norm:mtst1aaa', 'norm:mtst1bbb']));
});

it('returns an empty set, not null, when no token is for the requested network', () => {
  expect(parseTokenList(list([token({ network: 'devnet' })]), 'testnet')).toEqual(new Set());
});

it.each([
  ['not an object', 'x'],
  ['null', null],
  ['tokens not an array', list([token()], { tokens: {} })]
])('rejects a document with %s', (_label, doc) => {
  expect(parseTokenList(doc, 'testnet')).toBeNull();
});

it.each([
  ['no faucetId', token({ faucetId: undefined })],
  ['an empty faucetId', token({ faucetId: '' })],
  ['no network', token({ network: undefined })]
])('rejects the whole document when one token has %s', (_label, bad) => {
  // A partial list would mark the dropped token's holders Unverified.
  expect(parseTokenList(list([token(), bad]), 'testnet')).toBeNull();
});
