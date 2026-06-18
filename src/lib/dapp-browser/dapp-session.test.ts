import { createDappSession, parseOrigin, getDappHostname, getDappDisplayName } from './dapp-session';

describe('parseOrigin', () => {
  it('extracts scheme + host from a well-formed URL', () => {
    expect(parseOrigin('https://miden.xyz/path?q=1')).toBe('https://miden.xyz');
  });

  it('preserves non-default ports', () => {
    expect(parseOrigin('http://localhost:3000/x')).toBe('http://localhost:3000');
  });

  it('handles URLs without path', () => {
    expect(parseOrigin('https://example.com')).toBe('https://example.com');
  });

  it('returns the input unchanged when parsing fails', () => {
    expect(parseOrigin('not a url')).toBe('not a url');
  });

  it('returns the input unchanged for empty string', () => {
    expect(parseOrigin('')).toBe('');
  });
});

describe('getDappHostname', () => {
  it('returns the hostname without scheme', () => {
    expect(getDappHostname('https://miden.xyz/path')).toBe('miden.xyz');
  });

  it('strips the www. prefix', () => {
    expect(getDappHostname('https://www.miden.xyz')).toBe('miden.xyz');
  });

  it('does not strip other subdomains like app.', () => {
    // Intentional: app.uniswap.org and uniswap.org are semantically
    // different origins; merging them would break session dedup.
    expect(getDappHostname('https://app.uniswap.org')).toBe('app.uniswap.org');
  });

  it('preserves localhost with port', () => {
    expect(getDappHostname('http://localhost:3000/')).toBe('localhost');
  });

  it('returns the input unchanged when parsing fails', () => {
    expect(getDappHostname('not a url')).toBe('not a url');
  });
});

describe('getDappDisplayName', () => {
  it('prefers a non-URL title when present', () => {
    expect(getDappDisplayName({ title: 'Uniswap', url: 'https://app.uniswap.org' })).toBe('Uniswap');
  });

  it('falls back to hostname when title is empty', () => {
    expect(getDappDisplayName({ title: '', url: 'https://miden.xyz' })).toBe('miden.xyz');
  });

  it('falls back to hostname when title is whitespace-only', () => {
    expect(getDappDisplayName({ title: '   ', url: 'https://miden.xyz' })).toBe('miden.xyz');
  });

  it('falls back to hostname when title is the raw URL', () => {
    // Before browserPageLoaded fires the capsule stores session.title
    // = origin (e.g. "https://miden.xyz"). Without this fallback the
    // letter avatar would collapse to "H" for every dApp.
    expect(getDappDisplayName({ title: 'https://miden.xyz', url: 'https://miden.xyz' })).toBe('miden.xyz');
  });

  it('treats any http-prefixed title as a raw URL and prefers hostname', () => {
    expect(getDappDisplayName({ title: 'http://any-url', url: 'https://miden.xyz' })).toBe('miden.xyz');
  });

  it('handles missing title field', () => {
    expect(getDappDisplayName({ url: 'https://miden.xyz' })).toBe('miden.xyz');
  });
});

describe('createDappSession', () => {
  it('initializes all required fields', () => {
    const s = createDappSession('https://miden.xyz/swap?from=eth');
    expect(s.url).toBe('https://miden.xyz/swap?from=eth');
    expect(s.origin).toBe('https://miden.xyz');
    expect(s.title).toBe('https://miden.xyz');
    expect(s.favicon).toBeNull();
    expect(s.status).toBe('opening');
    expect(typeof s.openedAt).toBe('number');
    expect(s.openedAt).toBeGreaterThan(0);
  });

  it('assigns a unique id prefixed with dapp-', () => {
    const a = createDappSession('https://miden.xyz');
    const b = createDappSession('https://miden.xyz');
    expect(a.id).toMatch(/^dapp-/);
    expect(b.id).toMatch(/^dapp-/);
    expect(a.id).not.toBe(b.id);
  });

  it('id contains only alphanumerics and dashes (safe for JS/CSS interpolation)', () => {
    const s = createDappSession('https://miden.xyz');
    expect(s.id).toMatch(/^[a-z0-9-]+$/);
  });

  it('falls back to the raw url when origin parsing fails', () => {
    const s = createDappSession('garbage');
    expect(s.origin).toBe('garbage');
    expect(s.title).toBe('garbage');
  });
});
