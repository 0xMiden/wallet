import { parseTokenList, parseTokenLogos } from './parse';

// A visible transform would show if the parser normalized: the hook does, under the network active at render.
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

it('returns the faucet ids of the requested network as the list spells them', () => {
  const doc = list([
    token(),
    token({ faucetId: 'mtst1bbb', symbol: 'BBB' }),
    token({ network: 'devnet', faucetId: 'mdev1ccc' })
  ]);
  expect(parseTokenList(doc, 'testnet')).toEqual(new Set(['mtst1aaa', 'mtst1bbb']));
});

it('reads only the network and faucet id, so a token without the fields nothing reads still counts', () => {
  const bare = { network: 'testnet', faucetId: 'mtst1bbb' };
  expect(parseTokenList(list([token(), bare]), 'testnet')).toEqual(new Set(['mtst1aaa', 'mtst1bbb']));
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

const logo = (faucetId: string, ext = 'svg') =>
  `https://raw.githubusercontent.com/0xMiden/token-list/main/logos/${faucetId}/logo.${ext}`;

it('keeps the logo of each listed token on the requested network, svg or png', () => {
  const doc = list([
    token({ logoURI: logo('mtst1aaa') }),
    token({ faucetId: 'mtst1bbb', logoURI: logo('mtst1bbb', 'png') }),
    token({ network: 'devnet', faucetId: 'mdev1ccc', logoURI: logo('mdev1ccc') })
  ]);
  expect(parseTokenLogos(doc, 'testnet')).toEqual(
    new Map([
      ['mtst1aaa', logo('mtst1aaa')],
      ['mtst1bbb', logo('mtst1bbb', 'png')]
    ])
  );
});

it.each([
  ['another host', 'https://example.com/0xMiden/token-list/main/logos/mtst1aaa/logo.svg'],
  ['another token', logo('mtst1bbb')],
  ['another path', 'https://raw.githubusercontent.com/0xMiden/token-list/main/logos/mtst1aaa/x.svg'],
  ['an encoded segment', 'https://raw.githubusercontent.com/0xMiden/token-list/main/logos/mtst1aaa%2F/logo.svg'],
  ['another extension', logo('mtst1aaa', 'gif')],
  ['plain http', logo('mtst1aaa').replace('https:', 'http:')],
  ['a non-string', 42]
])('drops a logoURI on %s and keeps the token verified', (_case, logoURI) => {
  const doc = list([token({ logoURI }), token({ faucetId: 'mtst1bbb', logoURI: logo('mtst1bbb') })]);
  expect(parseTokenLogos(doc, 'testnet')).toEqual(new Map([['mtst1bbb', logo('mtst1bbb')]]));
  expect(parseTokenList(doc, 'testnet')).toEqual(new Set(['mtst1aaa', 'mtst1bbb']));
});

it('reads no logos from a document parseTokenList rejects', () => {
  expect(parseTokenLogos({ tokens: 'nope' }, 'testnet')).toEqual(new Map());
});
