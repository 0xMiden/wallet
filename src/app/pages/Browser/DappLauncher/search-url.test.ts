import { looksLikeUrl, normalizeUrl, urlForQuery } from './search-url';

describe('search-url', () => {
  it('adds https:// to input without a scheme', () => {
    expect(normalizeUrl(' miden.xyz ')).toBe('https://miden.xyz');
    expect(normalizeUrl('http://a.example')).toBe('http://a.example');
    expect(normalizeUrl('  ')).toBe('');
  });

  it('tells a URL from a name', () => {
    ['https://a.example', 'miden.xyz', 'app.zoroswap.com/swap', 'localhost:3000', '10.0.2.2:8080/x'].forEach(v =>
      expect(looksLikeUrl(v)).toBe(true)
    );
    ['faucet', 'forkchoice faucet', 'miden .xyz', ''].forEach(v => expect(looksLikeUrl(v)).toBe(false));
  });

  it('opens a URL as typed, else the first match, else the input as a host', () => {
    expect(urlForQuery('miden.xyz', 'https://match.example')).toBe('https://miden.xyz');
    expect(urlForQuery('faucet', 'https://match.example')).toBe('https://match.example');
    expect(urlForQuery('faucet', undefined)).toBe('https://faucet');
    expect(urlForQuery('   ', 'https://match.example')).toBeNull();
  });
});
