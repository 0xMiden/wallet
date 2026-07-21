/**
 * Unit tests for the LocalBiometric / HardwareSecurity Capacitor plugin
 * handles. The module is a thin `registerPlugin` wrapper (the concrete impl
 * lives in native Swift/Kotlin), so the runtime surface is just the two
 * `registerPlugin(...)` calls and the exported handles. We mock
 * `@capacitor/core` and assert each handle is registered under the correct
 * jsName and re-exported verbatim — mirroring the sibling
 * `secure-hot-key/hotKeyPlugin.test.ts`.
 */

// Distinct handle per jsName so we can prove each export maps to its own
// `registerPlugin` call (not the same shared object).
const mockLocalBiometric = {
  isAvailable: jest.fn(),
  verifyIdentity: jest.fn(),
  setCredentials: jest.fn(),
  getCredentials: jest.fn(),
  deleteCredentials: jest.fn(),
  isHardwareSecurityAvailable: jest.fn(),
  hasHardwareKey: jest.fn(),
  generateHardwareKey: jest.fn(),
  encryptWithHardwareKey: jest.fn(),
  decryptWithHardwareKey: jest.fn(),
  deleteHardwareKey: jest.fn()
};

const mockHardwareSecurity = {
  isHardwareSecurityAvailable: jest.fn(),
  hasHardwareKey: jest.fn(),
  generateHardwareKey: jest.fn(),
  encryptWithHardwareKey: jest.fn(),
  decryptWithHardwareKey: jest.fn(),
  deleteHardwareKey: jest.fn()
};

const mockRegisterBiometricPlugin = jest.fn((name: string) => {
  if (name === 'LocalBiometric') return mockLocalBiometric;
  if (name === 'HardwareSecurity') return mockHardwareSecurity;
  return {};
});

jest.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) => mockRegisterBiometricPlugin(name)
}));

describe('biometric localBiometricPlugin', () => {
  it('registers the Capacitor LocalBiometric plugin handle', async () => {
    const { LocalBiometric } = await import('./localBiometricPlugin');

    expect(mockRegisterBiometricPlugin).toHaveBeenCalledWith('LocalBiometric');
    expect(LocalBiometric).toBe(mockLocalBiometric);
  });

  it('registers the Capacitor HardwareSecurity plugin handle', async () => {
    const { HardwareSecurity } = await import('./localBiometricPlugin');

    expect(mockRegisterBiometricPlugin).toHaveBeenCalledWith('HardwareSecurity');
    expect(HardwareSecurity).toBe(mockHardwareSecurity);
  });

  it('registers exactly the two expected native plugins by jsName', async () => {
    await import('./localBiometricPlugin');

    const registeredNames = mockRegisterBiometricPlugin.mock.calls.map(([name]) => name);
    expect(registeredNames).toEqual(expect.arrayContaining(['LocalBiometric', 'HardwareSecurity']));
    // No stray registrations beyond the two documented handles.
    expect(new Set(registeredNames)).toEqual(new Set(['LocalBiometric', 'HardwareSecurity']));
  });

  it('exposes distinct handles for the two plugins', async () => {
    const { LocalBiometric, HardwareSecurity } = await import('./localBiometricPlugin');

    expect(LocalBiometric).not.toBe(HardwareSecurity);
  });
});
