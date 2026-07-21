import { PageLayoutSelectors } from './PageLayout.selectors';

// PageLayout.selectors is a pure, dependency-free TypeScript string enum used to
// tag the PageLayout header's back button with a stable automation/testID.
// A string enum has no reverse mapping, so the compiled object is exactly the set
// of named string members. We exercise the single exported member end-to-end:
// its value, the shape of the compiled enum object, and the string-enum invariants
// (no numeric reverse-mapping keys). This covers every line the enum emits.

describe('PageLayoutSelectors', () => {
  it('maps BackButton to its stable selector string', () => {
    expect(PageLayoutSelectors.BackButton).toBe('PageLayout/BackButton');
  });

  it('exposes exactly one member', () => {
    expect(Object.keys(PageLayoutSelectors)).toEqual(['BackButton']);
    expect(Object.values(PageLayoutSelectors)).toEqual(['PageLayout/BackButton']);
  });

  it('is a string enum without a numeric reverse mapping', () => {
    // String enums (unlike numeric ones) do not generate reverse `value -> key`
    // entries, so no numeric keys and no lookup by value should exist.
    const keys = Object.keys(PageLayoutSelectors);
    expect(keys.every(key => Number.isNaN(Number(key)))).toBe(true);
    expect((PageLayoutSelectors as Record<string, string>)['PageLayout/BackButton']).toBeUndefined();
  });

  it('has a namespaced selector value prefixed with the component name', () => {
    const value = PageLayoutSelectors.BackButton;
    expect(value.startsWith('PageLayout/')).toBe(true);
    expect(typeof value).toBe('string');
  });

  it('is consistent across accesses', () => {
    // Two reads of the same member must yield the identical string.
    expect(PageLayoutSelectors.BackButton).toBe(PageLayoutSelectors.BackButton);
  });
});
