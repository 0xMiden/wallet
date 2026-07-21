import { AdvancedSettingsSelectors } from './AdvancedSettings.selectors';

// AdvancedSettings.selectors is a pure, dependency-free TypeScript string enum
// used to tag the "resync" control with a stable automation/testID. A string enum
// has no reverse mapping, so the compiled object is exactly the set of named string
// members. We exercise the single exported member end-to-end: its value, the shape
// of the compiled enum object, and the string-enum invariants (no numeric
// reverse-mapping keys). This covers every line the enum emits.

describe('AdvancedSettingsSelectors', () => {
  it('maps ResyncButton to its stable selector string', () => {
    expect(AdvancedSettingsSelectors.ResyncButton).toBe('Advanced Settings/Resync Button');
  });

  it('exposes exactly one member', () => {
    expect(Object.keys(AdvancedSettingsSelectors)).toEqual(['ResyncButton']);
    expect(Object.values(AdvancedSettingsSelectors)).toEqual(['Advanced Settings/Resync Button']);
  });

  it('is a string enum without a numeric reverse mapping', () => {
    // String enums (unlike numeric ones) do not generate reverse `value -> key`
    // entries, so no numeric keys and no lookup by value should exist.
    const keys = Object.keys(AdvancedSettingsSelectors);
    expect(keys.every(key => Number.isNaN(Number(key)))).toBe(true);
    expect((AdvancedSettingsSelectors as Record<string, string>)['Advanced Settings/Resync Button']).toBeUndefined();
  });

  it('has a namespaced selector value prefixed with the "Advanced Settings/" namespace', () => {
    const value = AdvancedSettingsSelectors.ResyncButton;
    expect(value.startsWith('Advanced Settings/')).toBe(true);
    expect(typeof value).toBe('string');
  });

  it('is consistent across repeated accesses', () => {
    // Two reads of the same member must yield the identical string.
    expect(AdvancedSettingsSelectors.ResyncButton).toBe(AdvancedSettingsSelectors.ResyncButton);
  });
});
