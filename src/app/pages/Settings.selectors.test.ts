import { SettingsSelectors } from './Settings.selectors';

// Settings.selectors is a pure, dependency-free TypeScript string enum used to
// tag the Settings page rows/controls with stable automation/testIDs. A string
// enum has no reverse mapping, so the compiled object is exactly the set of
// named string members. We exercise every exported member end-to-end: its value,
// the shape of the compiled enum object, and the string-enum invariants (no
// numeric reverse-mapping keys). This covers every line the enum emits.

describe('SettingsSelectors', () => {
  // Verbatim expected mapping — one entry per source member (all 19).
  const EXPECTED: Record<string, string> = {
    GeneralButton: 'Settings/GeneralButton',
    LanguageButton: 'Settings/LanguageButton',
    SynchronizationButton: 'Settings/SynchronizationButton',
    AddressBookButton: 'Settings/AddressBookButton',
    RevealViewKeyButton: 'Settings/RevealViewKeyButton',
    RevealPrivateKeyButton: 'Settings/RevealPrivateKeyButton',
    RevealHotKeyButton: 'Settings/RevealHotKeyButton',
    KeysButton: 'Settings/KeysButton',
    RevealSeedPhraseButton: 'Settings/RevealSeedPhraseButton',
    DAppsButton: 'Settings/DAppsButton',
    NetworksButton: 'Settings/NetworksButton',
    ActivateAccountButton: 'Settings/ActivateAccountButton',
    RemoveAccountButton: 'Settings/RemoveAccountButton',
    AboutButton: 'Settings/AboutButton',
    FileSettingsButton: 'Settings/FileSettingsButton',
    AdvancedSettingsButton: 'Settings/AdvancedSettingsButton',
    EditMidenFaucetButton: 'Settings/EditMidenFaucetButton',
    EncryptedWalletFile: 'Settings/EncryptedWalletFile',
    SendFeedbackButton: 'Settings/SendFeedbackButton'
  };

  it('maps every member to its exact stable selector string', () => {
    expect(SettingsSelectors.GeneralButton).toBe('Settings/GeneralButton');
    expect(SettingsSelectors.LanguageButton).toBe('Settings/LanguageButton');
    expect(SettingsSelectors.SynchronizationButton).toBe('Settings/SynchronizationButton');
    expect(SettingsSelectors.AddressBookButton).toBe('Settings/AddressBookButton');
    expect(SettingsSelectors.RevealViewKeyButton).toBe('Settings/RevealViewKeyButton');
    expect(SettingsSelectors.RevealPrivateKeyButton).toBe('Settings/RevealPrivateKeyButton');
    expect(SettingsSelectors.RevealHotKeyButton).toBe('Settings/RevealHotKeyButton');
    expect(SettingsSelectors.KeysButton).toBe('Settings/KeysButton');
    expect(SettingsSelectors.RevealSeedPhraseButton).toBe('Settings/RevealSeedPhraseButton');
    expect(SettingsSelectors.DAppsButton).toBe('Settings/DAppsButton');
    expect(SettingsSelectors.NetworksButton).toBe('Settings/NetworksButton');
    expect(SettingsSelectors.ActivateAccountButton).toBe('Settings/ActivateAccountButton');
    expect(SettingsSelectors.RemoveAccountButton).toBe('Settings/RemoveAccountButton');
    expect(SettingsSelectors.AboutButton).toBe('Settings/AboutButton');
    expect(SettingsSelectors.FileSettingsButton).toBe('Settings/FileSettingsButton');
    expect(SettingsSelectors.AdvancedSettingsButton).toBe('Settings/AdvancedSettingsButton');
    expect(SettingsSelectors.EditMidenFaucetButton).toBe('Settings/EditMidenFaucetButton');
    expect(SettingsSelectors.EncryptedWalletFile).toBe('Settings/EncryptedWalletFile');
    expect(SettingsSelectors.SendFeedbackButton).toBe('Settings/SendFeedbackButton');
  });

  it('exposes exactly the expected members in declaration order', () => {
    expect(Object.keys(SettingsSelectors)).toEqual(Object.keys(EXPECTED));
    expect(Object.values(SettingsSelectors)).toEqual(Object.values(EXPECTED));
  });

  it('matches the full expected key -> value mapping', () => {
    expect({ ...(SettingsSelectors as Record<string, string>) }).toEqual(EXPECTED);
  });

  it('is a string enum without a numeric reverse mapping', () => {
    // String enums (unlike numeric ones) do not generate reverse `value -> key`
    // entries, so no numeric keys and no lookup by value should exist.
    const keys = Object.keys(SettingsSelectors);
    expect(keys.every(key => Number.isNaN(Number(key)))).toBe(true);
    for (const value of Object.values(EXPECTED)) {
      expect((SettingsSelectors as Record<string, string>)[value]).toBeUndefined();
    }
  });

  it('namespaces every value under the "Settings/" prefix and yields strings', () => {
    for (const value of Object.values(SettingsSelectors)) {
      expect(typeof value).toBe('string');
      expect((value as string).startsWith('Settings/')).toBe(true);
    }
  });

  it('has unique selector values across all members', () => {
    const values = Object.values(SettingsSelectors);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is consistent across repeated accesses', () => {
    // Two reads of the same member must yield the identical string.
    expect(SettingsSelectors.EncryptedWalletFile).toBe(SettingsSelectors.EncryptedWalletFile);
  });
});
