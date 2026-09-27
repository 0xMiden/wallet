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
    // A mixed-case origin is shown whole: the split must match the origin exactly.
    ['https://Login.EXAMPLE.co.uk', '', 'https://Login.EXAMPLE.co.uk'],
    ['foo://Login.EXAMPLE.com', '', 'foo://Login.EXAMPLE.com'],
    ['ionic://App.Example.com', '', 'ionic://App.Example.com']
  ])('splits %s into %j and %j', (origin, lead, domain) => {
    expect(splitDappOrigin(origin)).toEqual({ lead, domain });
  });

  // ms.show became a public suffix after tldts 6.1.86's snapshot of the public suffix list;
  // on a stale list the party asking is misread as ms.show instead of evil.ms.show.
  it('reads a domain under a public suffix the list only recognises once current', () => {
    expect(splitDappOrigin('https://a.b.evil.ms.show')).toEqual({ lead: 'https://a.b.', domain: 'evil.ms.show' });
  });

  it.each(['app.miden.io', 'null', 'file:///tmp/x', 'https://example.com/path', ''])(
    'shows %j whole in the part that is never elided when it is not an origin it can split',
    origin => {
      expect(splitDappOrigin(origin)).toEqual({ lead: '', domain: origin });
    }
  );
});
