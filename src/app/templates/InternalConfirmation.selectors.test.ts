import { InternalConfirmationSelectors } from './InternalConfirmation.selectors';

// InternalConfirmation.selectors is a pure, dependency-free TypeScript string enum
// used to tag the internal-confirmation UI controls (tabs + action buttons) with
// stable automation/testIDs. A string enum has no reverse mapping, so the compiled
// object is exactly the set of named string members. We exercise every exported
// member end-to-end: its value, the shape of the compiled enum object, and the
// string-enum invariants (no numeric reverse-mapping keys). This covers every line
// the enum emits.

describe('InternalConfirmationSelectors', () => {
  // Verbatim expected mapping — one entry per source member (all 6).
  const EXPECTED: Record<string, string> = {
    PreviewTab: 'InternalConfirmation/PreviewTab',
    RawTab: 'InternalConfirmation/RawTab',
    BytesTab: 'InternalConfirmation/BytesTab',
    ConfirmButton: 'InternalConfirmation/ConfirmButton',
    RetryButton: 'InternalConfirmation/RetryButton',
    DeclineButton: 'InternalConfirmation/DeclineButton'
  };

  it('maps every member to its exact stable selector string', () => {
    expect(InternalConfirmationSelectors.PreviewTab).toBe('InternalConfirmation/PreviewTab');
    expect(InternalConfirmationSelectors.RawTab).toBe('InternalConfirmation/RawTab');
    expect(InternalConfirmationSelectors.BytesTab).toBe('InternalConfirmation/BytesTab');
    expect(InternalConfirmationSelectors.ConfirmButton).toBe('InternalConfirmation/ConfirmButton');
    expect(InternalConfirmationSelectors.RetryButton).toBe('InternalConfirmation/RetryButton');
    expect(InternalConfirmationSelectors.DeclineButton).toBe('InternalConfirmation/DeclineButton');
  });

  it('exposes exactly the expected members in declaration order', () => {
    expect(Object.keys(InternalConfirmationSelectors)).toEqual(Object.keys(EXPECTED));
    expect(Object.values(InternalConfirmationSelectors)).toEqual(Object.values(EXPECTED));
  });

  it('matches the full expected key -> value mapping', () => {
    expect({ ...(InternalConfirmationSelectors as Record<string, string>) }).toEqual(EXPECTED);
  });

  it('is a string enum without a numeric reverse mapping', () => {
    // String enums (unlike numeric ones) do not generate reverse `value -> key`
    // entries, so no numeric keys and no lookup by value should exist.
    const keys = Object.keys(InternalConfirmationSelectors);
    expect(keys.every(key => Number.isNaN(Number(key)))).toBe(true);
    for (const value of Object.values(EXPECTED)) {
      expect((InternalConfirmationSelectors as Record<string, string>)[value]).toBeUndefined();
    }
  });

  it('namespaces every value under the "InternalConfirmation/" prefix and yields strings', () => {
    for (const value of Object.values(InternalConfirmationSelectors)) {
      expect(typeof value).toBe('string');
      expect((value as string).startsWith('InternalConfirmation/')).toBe(true);
    }
  });

  it('has unique selector values across all members', () => {
    const values = Object.values(InternalConfirmationSelectors);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is consistent across repeated accesses', () => {
    // Two reads of the same member must yield the identical string.
    expect(InternalConfirmationSelectors.ConfirmButton).toBe(InternalConfirmationSelectors.ConfirmButton);
  });
});
