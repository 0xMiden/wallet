import { ChangelogOverlaySelectors } from './ChangelogOverlay.selectors';

// ChangelogOverlay.selectors is a pure, dependency-free TypeScript string enum
// used to tag the changelog overlay's "Continue" and "Skip" controls with stable
// automation/testIDs. A string enum has no reverse mapping, so the compiled object
// is exactly the set of named string members. We exercise every exported member
// end-to-end: its value, the shape of the compiled enum object, and the string-enum
// invariants (no numeric reverse-mapping keys). This covers every line the enum emits.

describe('ChangelogOverlaySelectors', () => {
  it('maps Continue to its stable selector string', () => {
    expect(ChangelogOverlaySelectors.Continue).toBe('ChangelogOverlay/Continue');
  });

  it('maps Skip to its stable selector string', () => {
    expect(ChangelogOverlaySelectors.Skip).toBe('ChangelogOverlay/Skip');
  });

  it('exposes exactly the two named members', () => {
    expect(Object.keys(ChangelogOverlaySelectors)).toEqual(['Continue', 'Skip']);
    expect(Object.values(ChangelogOverlaySelectors)).toEqual(['ChangelogOverlay/Continue', 'ChangelogOverlay/Skip']);
  });

  it('is a string enum without a numeric reverse mapping', () => {
    // String enums (unlike numeric ones) do not generate reverse `value -> key`
    // entries, so no numeric keys and no lookup by value should exist.
    const keys = Object.keys(ChangelogOverlaySelectors);
    expect(keys.every(key => Number.isNaN(Number(key)))).toBe(true);
    expect((ChangelogOverlaySelectors as Record<string, string>)['ChangelogOverlay/Continue']).toBeUndefined();
    expect((ChangelogOverlaySelectors as Record<string, string>)['ChangelogOverlay/Skip']).toBeUndefined();
  });

  it('has namespaced selector values prefixed with the component name', () => {
    for (const value of Object.values(ChangelogOverlaySelectors)) {
      expect(value.startsWith('ChangelogOverlay/')).toBe(true);
      expect(typeof value).toBe('string');
    }
  });

  it('yields distinct values for each member', () => {
    expect(ChangelogOverlaySelectors.Continue).not.toBe(ChangelogOverlaySelectors.Skip);
    expect(new Set(Object.values(ChangelogOverlaySelectors)).size).toBe(2);
  });

  it('is consistent across repeated accesses', () => {
    // Two reads of the same member must yield the identical string.
    expect(ChangelogOverlaySelectors.Continue).toBe(ChangelogOverlaySelectors.Continue);
    expect(ChangelogOverlaySelectors.Skip).toBe(ChangelogOverlaySelectors.Skip);
  });
});
