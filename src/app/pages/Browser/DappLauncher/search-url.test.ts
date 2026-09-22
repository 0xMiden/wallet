import { isSearchUrl, looksLikeUrl, normalizeUrl, urlForQuery } from './search-url';

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

  it('opens a URL as typed, else the first match, else a web search for the words', () => {
    expect(urlForQuery('miden.xyz', 'https://match.example')).toBe('https://miden.xyz');
    expect(urlForQuery('faucet', 'https://match.example')).toBe('https://match.example');
    // No match: a search, not a host. `https://faucet` was a dead page, and a multi-word query made
    // it a URL with a space in it, which the browser then saved as a recent dApp.
    expect(urlForQuery('faucet', undefined)).toBe('https://duckduckgo.com/?q=faucet');
    expect(urlForQuery('nft games', undefined)).toBe('https://duckduckgo.com/?q=nft%20games');
    expect(urlForQuery('   ', 'https://match.example')).toBeNull();
  });

  it('knows a search it produced from a dApp the user chose', () => {
    expect(isSearchUrl(urlForQuery('nft games', undefined)!)).toBe(true);
    expect(isSearchUrl('https://miden.xyz')).toBe(false);
  });
});
