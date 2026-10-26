import { GeneralSettingsSelectors } from './GeneralSettings.selectors';

// GeneralSettings.selectors is a pure, dependency-free TypeScript string enum
// used to tag the general-settings toggles/controls with stable automation/testIDs.
// A string enum has no reverse mapping, so the compiled object is exactly the set
// of named string members. We exercise every exported member end-to-end: its value,
// the shape of the compiled enum object, and the string-enum invariants (no numeric
// reverse-mapping keys). This covers every line the enum emits.

describe('GeneralSettingsSelectors', () => {
  // Verbatim expected mapping — one entry per source member (all 12).
  const EXPECTED: Record<string, string> = {
    AnalyticsToggle: 'General Settings/AnalyticsToggle',
    DAppToggle: 'General Settings/DAppToggle',
    GPUToggle: 'General Settings/GPUToggle',
    DelegateToggle: 'General Settings/DelegateToggle',
    LockUpToggle: 'General Settings/LockUpToggle',
    PopupToggle: 'General Settings/PopupToggle',
    AutoConsumeToggle: 'General Settings/AutoConsumeToggle',
    BiometricToggle: 'General Settings/BiometricToggle',
    HapticFeedbackToggle: 'General Settings/HapticFeedbackToggle',
    DarkModeToggle: 'General Settings/DarkModeToggle',
    TelemetryToggle: 'General Settings/TelemetryToggle',
    ThemeSelector: 'General Settings/ThemeSelector'
  };

  it('maps every member to its exact stable selector string', () => {
    expect(GeneralSettingsSelectors.AnalyticsToggle).toBe('General Settings/AnalyticsToggle');
    expect(GeneralSettingsSelectors.DAppToggle).toBe('General Settings/DAppToggle');
    expect(GeneralSettingsSelectors.GPUToggle).toBe('General Settings/GPUToggle');
    expect(GeneralSettingsSelectors.DelegateToggle).toBe('General Settings/DelegateToggle');
    expect(GeneralSettingsSelectors.LockUpToggle).toBe('General Settings/LockUpToggle');
    expect(GeneralSettingsSelectors.PopupToggle).toBe('General Settings/PopupToggle');
    expect(GeneralSettingsSelectors.AutoConsumeToggle).toBe('General Settings/AutoConsumeToggle');
    expect(GeneralSettingsSelectors.BiometricToggle).toBe('General Settings/BiometricToggle');
    expect(GeneralSettingsSelectors.HapticFeedbackToggle).toBe('General Settings/HapticFeedbackToggle');
    expect(GeneralSettingsSelectors.DarkModeToggle).toBe('General Settings/DarkModeToggle');
    expect(GeneralSettingsSelectors.TelemetryToggle).toBe('General Settings/TelemetryToggle');
    expect(GeneralSettingsSelectors.ThemeSelector).toBe('General Settings/ThemeSelector');
  });

  it('exposes exactly the expected members in declaration order', () => {
    expect(Object.keys(GeneralSettingsSelectors)).toEqual(Object.keys(EXPECTED));
    expect(Object.values(GeneralSettingsSelectors)).toEqual(Object.values(EXPECTED));
  });

  it('matches the full expected key -> value mapping', () => {
    expect({ ...(GeneralSettingsSelectors as Record<string, string>) }).toEqual(EXPECTED);
  });

  it('is a string enum without a numeric reverse mapping', () => {
    // String enums (unlike numeric ones) do not generate reverse `value -> key`
    // entries, so no numeric keys and no lookup by value should exist.
    const keys = Object.keys(GeneralSettingsSelectors);
    expect(keys.every(key => Number.isNaN(Number(key)))).toBe(true);
    for (const value of Object.values(EXPECTED)) {
      expect((GeneralSettingsSelectors as Record<string, string>)[value]).toBeUndefined();
    }
  });

  it('namespaces every value under the "General Settings/" prefix and yields strings', () => {
    for (const value of Object.values(GeneralSettingsSelectors)) {
      expect(typeof value).toBe('string');
      expect((value as string).startsWith('General Settings/')).toBe(true);
    }
  });

  it('has unique selector values across all members', () => {
    const values = Object.values(GeneralSettingsSelectors);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is consistent across repeated accesses', () => {
    // Two reads of the same member must yield the identical string.
    expect(GeneralSettingsSelectors.ThemeSelector).toBe(GeneralSettingsSelectors.ThemeSelector);
  });
});
