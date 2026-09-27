import { splitDappOrigin } from './dapp-origin';

describe('splitDappOrigin', () => {
  it.each([
    [
      'https://login.secure.account-verify.wallet.example.co.uk',
      'https://login.secure.account-verify.wallet.',
      'example.co.uk'
    ],
    ['https://app.uniswap.org', 'https://app.', 'uniswap.org'],
    ['https://example.com', 'https://', 'example.com'],
    ['https://a.b.example.com:8443', 'https://a.b.', 'example.com:8443'],
    // A private suffix: the party is the label under github.io, so it is part of the identity.
    ['https://evil.github.io', 'https://', 'evil.github.io'],
    ['https://docs.evil.github.io', 'https://docs.', 'evil.github.io'],
    // tldts drops a trailing dot; the kept part still ends the host exactly as the origin does.
    ['https://login.bank.com.evil.example.com.', 'https://login.bank.com.evil.', 'example.com.'],
    // No registrable domain: the whole host and port stay.
    ['http://localhost:3000', 'http://', 'localhost:3000'],
    ['http://192.168.1.1:8080', 'http://', '192.168.1.1:8080'],
    ['http://[::1]:3000', 'http://', '[::1]:3000'],
    ['chrome-extension://abcdefghijklmnop', 'chrome-extension://', 'abcdefghijklmnop'],
    // The origin's own spelling is kept; only the match ignores case.
    ['https://Login.EXAMPLE.co.uk', 'https://Login.', 'EXAMPLE.co.uk']
  ])('splits %s into %j and %j', (origin, lead, domain) => {
    expect(splitDappOrigin(origin)).toEqual({ lead, domain });
  });

  it.each(['app.miden.io', 'null', 'file:///tmp/x', 'https://example.com/path', ''])(
    'shows %j whole in the part that is never elided when it is not an origin it can split',
    origin => {
      expect(splitDappOrigin(origin)).toEqual({ lead: '', domain: origin });
    }
  );
});
