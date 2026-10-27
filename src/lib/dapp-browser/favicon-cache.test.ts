import {
  __getFaviconCacheUsageForTests,
  buildFaviconUrl,
  getFaviconUrl,
  getFallbackColor,
  getFallbackLetter
} from './favicon-cache';

describe('buildFaviconUrl', () => {
  // Not S2's own address: its redirect has no Cross-Origin-Resource-Policy, which the extension's COEP refuses.
  it("asks S2's favicon host directly", () => {
    const url = buildFaviconUrl('https://miden.xyz');
    expect(url.startsWith('https://t0.gstatic.com/faviconV2?')).toBe(true);
  });

  it('URL-encodes the origin query parameter', () => {
    const url = buildFaviconUrl('https://app.example.com:8080');
    expect(url).toContain('url=https%3A%2F%2Fapp.example.com%3A8080');
  });

  it('requests size 64', () => {
    expect(buildFaviconUrl('https://miden.xyz')).toContain('size=64');
  });
});

describe('getFaviconUrl', () => {
  it('returns a URL for a fresh origin', () => {
    const url = getFaviconUrl('https://fresh-origin-' + Date.now() + '.test');
    expect(url).toContain('gstatic.com/faviconV2');
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

describe('Task5 cache favicon memory', () => {
  it('bounds cached origin and URL entries while rebuilding misses without altering navigation inputs', () => {
    for (let index = 0; index < 129; index++) getFaviconUrl(`https://favicon-${index}.invalid`);
    expect(__getFaviconCacheUsageForTests().entries).toBeLessThanOrEqual(128);
    const origin = 'https://favicon-0.invalid';
    expect(getFaviconUrl(origin)).toBe(buildFaviconUrl(origin));
  });

  it('bounds full UTF-8 cache bytes without truncating the origin passed to the favicon service', () => {
    for (let index = 0; index < 128; index++) getFaviconUrl(`https://${'界'.repeat(300)}-${index}.invalid`);
    expect(__getFaviconCacheUsageForTests().bytes).toBeLessThanOrEqual(65_536);
    const origin = `https://${'界'.repeat(300)}-127.invalid`;
    expect(getFaviconUrl(origin)).toBe(buildFaviconUrl(origin));
  });
});
