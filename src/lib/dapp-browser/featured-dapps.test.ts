import {
  FEATURED_DAPPS,
  CAROUSEL_DAPPS,
  EXPLORE_GRID_DAPPS,
  type FeaturedDapp,
  type FeaturedDappBadge,
  type FeaturedDappCategory
} from './featured-dapps';

const VALID_CATEGORIES: FeaturedDappCategory[] = ['defi', 'nft', 'tools', 'social'];
const VALID_BADGES: FeaturedDappBadge[] = ['featured', 'new', 'verified'];

describe('FEATURED_DAPPS', () => {
  it('exposes the curated launcher list', () => {
    expect(Array.isArray(FEATURED_DAPPS)).toBe(true);
    // The list is intentionally hardcoded; guard the exact roster + order so a
    // careless edit trips the test.
    expect(FEATURED_DAPPS.map(d => d.id)).toEqual([
      'miden',
      'zoro',
      'faucet',
      'lumina',
      'qash',
      'playground',
      'miden-name'
    ]);
  });

  it('has unique ids', () => {
    const ids = FEATURED_DAPPS.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every entry the required non-empty string fields', () => {
    for (const d of FEATURED_DAPPS) {
      expect(typeof d.id).toBe('string');
      expect(d.id.length).toBeGreaterThan(0);
      expect(typeof d.name).toBe('string');
      expect(d.name.length).toBeGreaterThan(0);
      expect(typeof d.shortDescription).toBe('string');
      expect(d.shortDescription.length).toBeGreaterThan(0);
      // Icons resolve to the jest fileMock stub for PNG imports.
      expect(d.icon).toBe('test-file-stub');
    }
  });

  it('uses only valid category values', () => {
    for (const d of FEATURED_DAPPS) {
      expect(VALID_CATEGORIES).toContain(d.category);
    }
  });

  it('uses a valid badge when one is present', () => {
    const badges = FEATURED_DAPPS.map(d => d.badge).filter((badge): badge is FeaturedDappBadge => badge !== undefined);
    for (const badge of badges) {
      expect(VALID_BADGES).toContain(badge);
    }
    // Sanity: at least one entry omits the optional badge (branch coverage of
    // the optional field), and at least one supplies it.
    expect(FEATURED_DAPPS.some(d => d.badge === undefined)).toBe(true);
    expect(FEATURED_DAPPS.some(d => d.badge !== undefined)).toBe(true);
  });

  it('supplies a well-formed 6-digit hex brand color for every entry', () => {
    for (const d of FEATURED_DAPPS) {
      expect(d.brandColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('uses absolute https urls', () => {
    for (const d of FEATURED_DAPPS) {
      expect(d.url).toMatch(/^https:\/\//);
      // URL must be parseable.
      expect(() => new URL(d.url)).not.toThrow();
    }
  });

  it('only sets the optional genre to a non-empty string when present', () => {
    const genres = FEATURED_DAPPS.map(d => d.genre).filter((genre): genre is string => genre !== undefined);
    for (const genre of genres) {
      expect(typeof genre).toBe('string');
      expect(genre.length).toBeGreaterThan(0);
    }
    // Both the "has genre" and "no genre" branches exist in the data.
    expect(FEATURED_DAPPS.some(d => d.genre !== undefined)).toBe(true);
    expect(FEATURED_DAPPS.some(d => d.genre === undefined)).toBe(true);
  });

  it('only sets the optional featured flag to true when present', () => {
    const featuredFlags = FEATURED_DAPPS.map(d => d.featured).filter((flag): flag is boolean => flag !== undefined);
    for (const flag of featuredFlags) {
      expect(flag).toBe(true);
    }
    // Both featured and non-featured entries exist.
    expect(FEATURED_DAPPS.some(d => d.featured === true)).toBe(true);
    expect(FEATURED_DAPPS.some(d => d.featured === undefined)).toBe(true);
  });
});

describe('CAROUSEL_DAPPS', () => {
  it('is exactly the featured subset of FEATURED_DAPPS', () => {
    // Exercises the `.filter(d => d.featured)` predicate for both truthy and
    // falsy `featured` values.
    const expected = FEATURED_DAPPS.filter(d => d.featured === true);
    expect(CAROUSEL_DAPPS).toEqual(expected);
    expect(CAROUSEL_DAPPS.map(d => d.id)).toEqual(['miden', 'zoro', 'lumina']);
  });

  it('every carousel entry is flagged featured', () => {
    expect(CAROUSEL_DAPPS.length).toBeGreaterThan(0);
    for (const d of CAROUSEL_DAPPS) {
      expect(d.featured).toBe(true);
    }
  });

  it('is a strict subset of FEATURED_DAPPS by reference identity', () => {
    for (const d of CAROUSEL_DAPPS) {
      expect(FEATURED_DAPPS).toContain(d);
    }
    expect(CAROUSEL_DAPPS.length).toBeLessThan(FEATURED_DAPPS.length);
  });
});

describe('EXPLORE_GRID_DAPPS', () => {
  it('contains the four curated apps in explicit display order', () => {
    // Exercises the `.flatMap` over the id list and the inner
    // `.filter(d => d.id === id)` predicate (matching + non-matching ids).
    expect(EXPLORE_GRID_DAPPS.map(d => d.id)).toEqual(['zoro', 'qash', 'faucet', 'miden-name']);
    expect(EXPLORE_GRID_DAPPS).toHaveLength(4);
  });

  it('resolves each id to the corresponding FEATURED_DAPPS entry by identity', () => {
    for (const d of EXPLORE_GRID_DAPPS) {
      const source = FEATURED_DAPPS.find(f => f.id === d.id);
      expect(source).toBeDefined();
      expect(d).toBe(source as FeaturedDapp);
    }
  });

  it('preserves the requested order even when it differs from FEATURED_DAPPS order', () => {
    // 'zoro' precedes 'faucet' in the grid, matching the id list — not the
    // source-array order where faucet also appears before qash.
    const gridIds = EXPLORE_GRID_DAPPS.map(d => d.id);
    expect(gridIds.indexOf('zoro')).toBeLessThan(gridIds.indexOf('faucet'));
    expect(gridIds.indexOf('qash')).toBeLessThan(gridIds.indexOf('faucet'));
  });
});
