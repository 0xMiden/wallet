import { OpenInExplorerChipSelectors } from './OpenInExplorerChip.selectors';

// OpenInExplorerChip.selectors is a pure, dependency-free TypeScript string enum
// used to tag the "open in block explorer" link with a stable automation/testID.
// A string enum has no reverse mapping, so the compiled object is exactly the set
// of named string members. We exercise the single exported member end-to-end:
// its value, the shape of the compiled enum object, and the string-enum invariants
// (no numeric reverse-mapping keys). This covers every line the enum emits.

describe('OpenInExplorerChipSelectors', () => {
  it('maps ViewOnBlockExplorerLink to its stable selector string', () => {
    expect(OpenInExplorerChipSelectors.ViewOnBlockExplorerLink).toBe('OpenInExplorerChip/ViewOnBlockExplorerLink');
  });

  it('exposes exactly one member', () => {
    expect(Object.keys(OpenInExplorerChipSelectors)).toEqual(['ViewOnBlockExplorerLink']);
    expect(Object.values(OpenInExplorerChipSelectors)).toEqual(['OpenInExplorerChip/ViewOnBlockExplorerLink']);
  });

  it('is a string enum without a numeric reverse mapping', () => {
    // String enums (unlike numeric ones) do not generate reverse `value -> key`
    // entries, so no numeric keys and no lookup by value should exist.
    const keys = Object.keys(OpenInExplorerChipSelectors);
    expect(keys.every(key => Number.isNaN(Number(key)))).toBe(true);
    expect(
      (OpenInExplorerChipSelectors as Record<string, string>)['OpenInExplorerChip/ViewOnBlockExplorerLink']
    ).toBeUndefined();
  });

  it('has a namespaced selector value prefixed with the component name', () => {
    const value = OpenInExplorerChipSelectors.ViewOnBlockExplorerLink;
    expect(value.startsWith('OpenInExplorerChip/')).toBe(true);
    expect(typeof value).toBe('string');
  });

  it('is immutable at the type level and consistent across accesses', () => {
    // Two reads of the same member must yield the identical string.
    expect(OpenInExplorerChipSelectors.ViewOnBlockExplorerLink).toBe(
      OpenInExplorerChipSelectors.ViewOnBlockExplorerLink
    );
  });
});
