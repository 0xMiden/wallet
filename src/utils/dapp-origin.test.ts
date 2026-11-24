import { idnAsciiHost, splitDappOrigin } from './dapp-origin';

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

describe('idnAsciiHost', () => {
  const A = String.fromCharCode(0x430);

  it('gives the ASCII host for a non-ASCII host, port kept', () => {
    expect(idnAsciiHost(`https://${A}pple.example`)).toBe('xn--pple-43d.example');
    expect(idnAsciiHost(`https://${A}pple.example:8443`)).toBe('xn--pple-43d.example:8443');
  });

  it('gives nothing for an ASCII host, an xn-- host included', () => {
    expect(idnAsciiHost('https://apple.example')).toBeNull();
    expect(idnAsciiHost('https://xn--pple-43d.example')).toBeNull();
  });

  it('gives nothing when only a non-ASCII character outside the host differs', () => {
    const c = String.fromCharCode(0x430);
    expect(idnAsciiHost(`https://apple.example/${c}`)).toBeNull();
    expect(idnAsciiHost(`https://apple.example:8443/path?q=${c}`)).toBeNull();
  });

  it('gives nothing for a value the URL API cannot parse', () => {
    expect(idnAsciiHost(`not a url ${A}`)).toBeNull();
    expect(idnAsciiHost('')).toBeNull();
  });
});
