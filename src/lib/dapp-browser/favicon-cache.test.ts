import { buildFaviconUrl, getFaviconUrl, getFallbackColor, getFallbackLetter } from './favicon-cache';

describe('buildFaviconUrl', () => {
  it('targets the Google S2 service', () => {
    const url = buildFaviconUrl('https://miden.xyz');
    expect(url).toContain('google.com/s2/favicons');
  });

  it('URL-encodes the origin query parameter', () => {
    const url = buildFaviconUrl('https://app.example.com:8080');
    expect(url).toContain('domain=https%3A%2F%2Fapp.example.com%3A8080');
  });

  it('requests size 64', () => {
    expect(buildFaviconUrl('https://miden.xyz')).toContain('sz=64');
  });
});

describe('getFaviconUrl', () => {
  it('returns a URL for a fresh origin', () => {
    const url = getFaviconUrl('https://fresh-origin-' + Date.now() + '.test');
    expect(url).toContain('google.com/s2/favicons');
  });

  it('returns a stable string across multiple calls (caching)', () => {
    const origin = 'https://stable-' + Date.now() + '.test';
    const a = getFaviconUrl(origin);
    const b = getFaviconUrl(origin);
    expect(a).toBe(b);
  });
});

describe('getFallbackColor', () => {
  it('returns a stable color for the same origin', () => {
    const origin = 'https://miden.xyz';
    expect(getFallbackColor(origin)).toBe(getFallbackColor(origin));
  });

  it('returns a value from the 10-color palette', () => {
    const palette = [
      '#F87171',
      '#FB923C',
      '#FBBF24',
      '#A3E635',
      '#34D399',
      '#22D3EE',
      '#60A5FA',
      '#818CF8',
      '#A78BFA',
      '#F472B6'
    ];
    for (const origin of ['a', 'b', 'miden.xyz', 'uniswap.org', 'faucet.miden.xyz']) {
      expect(palette).toContain(getFallbackColor(origin));
    }
  });

  it('handles empty string without crashing', () => {
    const color = getFallbackColor('');
    expect(color).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe('getFallbackLetter', () => {
  it('returns the first letter of the hostname uppercased', () => {
    expect(getFallbackLetter('https://miden.xyz')).toBe('M');
  });

  it('strips www. before taking the first letter', () => {
    expect(getFallbackLetter('https://www.uniswap.org')).toBe('U');
  });

  it('handles malformed URL by taking first char of the string', () => {
    expect(getFallbackLetter('abc')).toBe('A');
  });

  it('returns ? for empty input', () => {
    expect(getFallbackLetter('')).toBe('?');
  });

  it('returns ? for URL with empty hostname', () => {
    // file: URLs have empty hostname
    const result = getFallbackLetter('file:///path');
    expect(result).toBe('?');
  });
});
