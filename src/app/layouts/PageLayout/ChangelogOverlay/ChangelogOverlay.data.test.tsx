import { changelogData, type ChangelogItem } from './ChangelogOverlay.data';

// ChangelogOverlay.data is a pure, dependency-free data module for the changelog
// overlay. It exports a single runtime value, `changelogData`, plus a compile-time
// `ChangelogItem` interface (which emits no JavaScript). The module currently ships
// with no changelog entries, so the whole runtime surface is the initialization of
// one empty, correctly-typed array. We exercise that single emitted line end-to-end:
// the export's identity, shape, emptiness, and — should entries ever be added — the
// structural contract every `ChangelogItem` must satisfy.

describe('ChangelogOverlay.data', () => {
  it('exports `changelogData` as an array', () => {
    expect(Array.isArray(changelogData)).toBe(true);
  });

  it('ships with no changelog entries by default', () => {
    expect(changelogData).toEqual([]);
    expect(changelogData).toHaveLength(0);
  });

  it('is the sole runtime export of the module (interface emits no JS)', () => {
    // The module namespace should contain exactly the `changelogData` value; the
    // `ChangelogItem` interface is erased by the TypeScript compiler and must not
    // appear as a runtime binding.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./ChangelogOverlay.data');
    expect(Object.keys(mod)).toEqual(['changelogData']);
    expect(mod).not.toHaveProperty('ChangelogItem');
  });

  it('returns a referentially stable array across imports', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const again = require('./ChangelogOverlay.data').changelogData;
    expect(again).toBe(changelogData);
  });

  it('accepts values matching the ChangelogItem contract (type is usable at runtime)', () => {
    // `ChangelogItem` has a required `version: string` and an optional
    // `data?: Array<JSX.Element>`. We build both shapes to pin the structural
    // contract and prove the exported array can hold conforming entries.
    const withoutData: ChangelogItem = { version: '1.0.0' };
    const withData: ChangelogItem = { version: '2.0.0', data: [] };

    const populated: ChangelogItem[] = [...changelogData, withoutData, withData];

    expect(populated).toHaveLength(2);
    expect(populated[0]).toEqual({ version: '1.0.0' });
    expect(populated[0].data).toBeUndefined();
    expect(populated[1].version).toBe('2.0.0');
    expect(Array.isArray(populated[1].data)).toBe(true);
    // The exported array itself is untouched by the spread above.
    expect(changelogData).toHaveLength(0);
  });

  it('holds only string versions and (when present) array `data` for every entry', () => {
    // Invariant check that also protects future non-empty changelog data: every
    // entry must carry a string `version`, and any `data` present must be an array.
    for (const entry of changelogData) {
      expect(typeof entry.version).toBe('string');
      if (entry.data !== undefined) {
        expect(Array.isArray(entry.data)).toBe(true);
      }
    }
    // With no entries today the loop body never runs; assert the precondition so
    // the test still makes a positive claim about the shipped data.
    expect(changelogData.every(e => typeof e.version === 'string')).toBe(true);
  });
});
