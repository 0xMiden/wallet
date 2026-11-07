import { parseTokenList } from './parse';

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
  expect(parseTokenList(doc, 'testnet')?.ids).toEqual(new Set(['mtst1aaa', 'mtst1bbb']));
});

it('reads only the network and faucet id, so a token without the fields nothing reads still counts', () => {
  const bare = { network: 'testnet', faucetId: 'mtst1bbb' };
  expect(parseTokenList(list([token(), bare]), 'testnet')?.ids).toEqual(new Set(['mtst1aaa', 'mtst1bbb']));
});

it('returns an empty set, not null, when no token is for the requested network', () => {
  expect(parseTokenList(list([token({ network: 'devnet' })]), 'testnet')?.ids).toEqual(new Set());
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

const logo = (faucetId: string, ext = 'png') =>
  `https://raw.githubusercontent.com/0xMiden/token-list/main/logos/${faucetId}/logo.${ext}`;

it('keeps the logo of each listed token on the requested network', () => {
  const doc = list([
    token({ logoURI: logo('mtst1aaa') }),
    token({ faucetId: 'mtst1bbb', logoURI: logo('mtst1bbb') }),
    token({ network: 'devnet', faucetId: 'mdev1ccc', logoURI: logo('mdev1ccc') })
  ]);
  expect(parseTokenList(doc, 'testnet')?.logos).toEqual(
    new Map([
      ['mtst1aaa', logo('mtst1aaa')],
      ['mtst1bbb', logo('mtst1bbb')]
    ])
  );
});

it.each([
  ['another host', 'https://example.com/0xMiden/token-list/main/logos/mtst1aaa/logo.png'],
  ['another token', logo('mtst1bbb')],
  ['another path', 'https://raw.githubusercontent.com/0xMiden/token-list/main/logos/mtst1aaa/x.png'],
  ['an encoded segment', 'https://raw.githubusercontent.com/0xMiden/token-list/main/logos/mtst1aaa%2F/logo.png'],
  ['another extension', logo('mtst1aaa', 'gif')],
  ['its own svg', logo('mtst1aaa', 'svg')],
  ['plain http', logo('mtst1aaa').replace('https:', 'http:')],
  ['a non-string', 42]
])('drops a logoURI on %s and keeps the token verified', (_case, logoURI) => {
  const doc = list([token({ logoURI }), token({ faucetId: 'mtst1bbb', logoURI: logo('mtst1bbb') })]);
  const parsed = parseTokenList(doc, 'testnet');
  expect(parsed?.logos).toEqual(new Map([['mtst1bbb', logo('mtst1bbb')]]));
  expect(parsed?.ids).toEqual(new Set(['mtst1aaa', 'mtst1bbb']));
});

it('yields no logos from a document one bad token rejects', () => {
  // The listed logo comes first, so a walk that collected it before meeting the bad token must still drop it.
  const doc = list([token({ faucetId: 'mtst1bbb', logoURI: logo('mtst1bbb') }), token({ network: undefined })]);
  expect(parseTokenList(doc, 'testnet')).toBeNull();
});

it('uses the full listed symbol and an explicit price asset override', () => {
  const doc = list([
    token({ symbol: 'IETH' }),
    token({ faucetId: 'mtst1bbb', symbol: 'IBTC', binanceAsset: 'BTC' }),
    token({ network: 'devnet', faucetId: 'mdev1ccc', symbol: 'ETH' })
  ]);
  expect(parseTokenList(doc, 'testnet')?.priceAssets).toEqual(
    new Map([
      ['mtst1aaa', 'IETH'],
      ['mtst1bbb', 'BTC']
    ])
  );
});

it.each(['', 'eth', ' ETH', 'ETH ', 'ETH/USDT', 'A'.repeat(21), 42, null])(
  'drops an invalid price override %p and keeps verification',
  binanceAsset => {
    const parsed = parseTokenList(list([token({ binanceAsset })]), 'testnet');
    expect(parsed?.priceAssets.size).toBe(0);
    expect(parsed?.ids).toEqual(new Set(['mtst1aaa']));
  }
);

it.each(['', 'eth', 'ETH/USDT', 42, null, undefined])('drops invalid symbol %p', symbol => {
  expect(parseTokenList(list([token({ symbol })]), 'testnet')?.priceAssets.size).toBe(0);
});

const PRICE_URL = 'https://issuer.example/api/price/AAA';

it('keeps the issuer price URL of a token that has a price asset', () => {
  const doc = list([
    token({ priceUrl: PRICE_URL }),
    token({ faucetId: 'mtst1bbb', symbol: 'BBB' }),
    token({ network: 'devnet', faucetId: 'mdev1ccc', priceUrl: PRICE_URL })
  ]);
  expect(parseTokenList(doc, 'testnet')?.priceUrls).toEqual(new Map([['mtst1aaa', PRICE_URL]]));
});

it('drops the price URL of a token without a price asset', () => {
  expect(parseTokenList(list([token({ symbol: 'aaa', priceUrl: PRICE_URL })]), 'testnet')?.priceUrls.size).toBe(0);
});

it.each([
  ['plain http', PRICE_URL.replace('https:', 'http:')],
  ['another scheme', 'ftp://issuer.example/price'],
  ['credentials', 'https://user:pass@issuer.example/api/price/AAA'],
  ['a fragment', `${PRICE_URL}#x`],
  ['a spelling the URL parser rewrites', 'https://ISSUER.example/api/price/AAA'],
  ['no URL', 'issuer.example/api/price/AAA'],
  ['an overlong URL', `${PRICE_URL}?${'x'.repeat(512)}`],
  ['a non-string', 42],
  ['null', null]
])('drops a priceUrl with %s and keeps the token verified and its price asset', (_case, priceUrl) => {
  const parsed = parseTokenList(list([token({ priceUrl })]), 'testnet');
  expect(parsed?.priceUrls.size).toBe(0);
  expect(parsed?.priceAssets).toEqual(new Map([['mtst1aaa', 'AAA']]));
  expect(parsed?.ids).toEqual(new Set(['mtst1aaa']));
});
