/**
 * Unit tests for the biometric authentication service.
 *
 * The module lazy-loads `capacitor-native-biometric` and `@capacitor/preferences`
 * via `require`, memoizes the native module in module scope, and branches on
 * platform (iOS uses the custom `LocalBiometric` plugin, Android uses
 * `NativeBiometric` / `HardwareSecurity`). To exercise every branch cleanly we
 * reset the module registry and re-mock `lib/platform`, `./localBiometricPlugin`,
 * `capacitor-native-biometric` and `@capacitor/preferences` per test, following
 * the `jest.resetModules()` + `jest.doMock` + dynamic `require` pattern used by
 * sibling tests (see `src/lib/mobile/back-handler.test.ts`).
 */

type PlatformCfg = {
  mobile: boolean;
  ios: boolean;
  android: boolean;
  mobileThrows?: boolean;
};

const IOS: PlatformCfg = { mobile: true, ios: true, android: false };
const ANDROID: PlatformCfg = { mobile: true, ios: false, android: true };
const NOT_MOBILE: PlatformCfg = { mobile: false, ios: false, android: false };
// mobile but neither iOS nor Android (e.g. an unexpected Capacitor platform)
const MOBILE_OTHER: PlatformCfg = { mobile: true, ios: false, android: false };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePlugin(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    isAvailable: jest.fn().mockResolvedValue({ isAvailable: true, biometryType: 2, errorCode: undefined }),
    verifyIdentity: jest.fn().mockResolvedValue(undefined),
    setCredentials: jest.fn().mockResolvedValue(undefined),
    getCredentials: jest.fn().mockResolvedValue({ username: 'vault_biometric_key', password: 'secret-pw' }),
    deleteCredentials: jest.fn().mockResolvedValue(undefined),
    isHardwareSecurityAvailable: jest.fn().mockResolvedValue({ available: true }),
    hasHardwareKey: jest.fn().mockResolvedValue({ exists: true }),
    generateHardwareKey: jest.fn().mockResolvedValue(undefined),
    encryptWithHardwareKey: jest.fn().mockResolvedValue({ encrypted: 'ENC' }),
    decryptWithHardwareKey: jest.fn().mockResolvedValue({ decrypted: 'DEC' }),
    deleteHardwareKey: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

// Stateful Preferences mock: get returns whatever set last wrote for the key.
function makePreferences() {
  const store: Record<string, string> = {};
  return {
    get: jest.fn(async ({ key }: { key: string }) => ({ value: key in store ? store[key] : null })),
    set: jest.fn(async ({ key, value }: { key: string; value: string }) => {
      store[key] = value;
    })
  };
}

type LoadOpts = {
  platform?: PlatformCfg;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  local?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hardware?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  native?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  preferences?: any;
  nativeThrows?: boolean;
};

function load(opts: LoadOpts = {}) {
  const { platform = IOS, local, hardware, native, preferences, nativeThrows = false } = opts;

  jest.resetModules();

  const platformMock = {
    isMobile: platform.mobileThrows
      ? jest.fn(() => {
          throw new Error('platform boom');
        })
      : jest.fn(() => platform.mobile),
    isIOS: jest.fn(() => platform.ios),
    isAndroid: jest.fn(() => platform.android)
  };
  jest.doMock('lib/platform', () => platformMock);

  const localPlugin = local ?? makePlugin();
  const hardwarePlugin = hardware ?? makePlugin();
  jest.doMock('./localBiometricPlugin', () => ({
    LocalBiometric: localPlugin,
    HardwareSecurity: hardwarePlugin
  }));

  const nativePlugin = native ?? makePlugin();
  jest.doMock('capacitor-native-biometric', () => {
    if (nativeThrows) {
      throw new Error('native module load failed');
    }
    return { NativeBiometric: nativePlugin };
  });

  const prefs = preferences ?? makePreferences();
  jest.doMock('@capacitor/preferences', () => ({ Preferences: prefs }));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./index') as typeof import('./index');
  return { mod, platformMock, localPlugin, hardwarePlugin, nativePlugin, prefs };
}

const SERVER = 'miden.wallet.biometric';
const CRED_KEY = 'vault_biometric_key';
const ENABLED_KEY = 'biometric_enabled';

beforeAll(() => {
  // The module is intentionally chatty; silence console to keep test output clean.
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('biometric service', () => {
  describe('checkBiometricAvailability', () => {
    it('returns not-available when not on mobile (plugin is null)', async () => {
      const { mod } = load({ platform: NOT_MOBILE });

      const res = await mod.checkBiometricAvailability();

      expect(res).toEqual({
        isAvailable: false,
        biometryType: 'none',
        errorMessage: 'Biometric plugin not available'
      });
    });

    it.each([
      [1, 'fingerprint'],
      [2, 'face'],
      [3, 'iris'],
      [4, 'multiple'],
      [0, 'none'],
      [99, 'none']
    ])('maps biometryType %s to "%s"', async (raw, mapped) => {
      const local = makePlugin({
        isAvailable: jest.fn().mockResolvedValue({ isAvailable: true, biometryType: raw, errorCode: 7 })
      });
      const { mod } = load({ platform: IOS, local });

      const res = await mod.checkBiometricAvailability();

      expect(res).toEqual({ isAvailable: true, biometryType: mapped, errorCode: 7 });
    });

    it('returns error message from thrown Error', async () => {
      const local = makePlugin({
        isAvailable: jest.fn().mockRejectedValue(new Error('hardware fault'))
      });
      const { mod } = load({ platform: IOS, local });

      const res = await mod.checkBiometricAvailability();

      expect(res).toEqual({ isAvailable: false, biometryType: 'none', errorMessage: 'hardware fault' });
    });

    it('falls back to default message when thrown value has no message', async () => {
      const local = makePlugin({
        // reject with an object that has no `.message`
        isAvailable: jest.fn().mockRejectedValue({})
      });
      const { mod } = load({ platform: IOS, local });

      const res = await mod.checkBiometricAvailability();

      expect(res).toEqual({
        isAvailable: false,
        biometryType: 'none',
        errorMessage: 'Failed to check biometric availability'
      });
    });

    it('uses the Android NativeBiometric plugin when on Android', async () => {
      const native = makePlugin({
        isAvailable: jest.fn().mockResolvedValue({ isAvailable: true, biometryType: 1 })
      });
      const { mod } = load({ platform: ANDROID, native });

      const res = await mod.checkBiometricAvailability();

      expect(res.isAvailable).toBe(true);
      expect(res.biometryType).toBe('fingerprint');
      expect(native.isAvailable).toHaveBeenCalledTimes(1);
    });

    it('returns not-available when the native module fails to load on Android', async () => {
      const { mod } = load({ platform: ANDROID, nativeThrows: true });

      const res = await mod.checkBiometricAvailability();

      expect(res.isAvailable).toBe(false);
      expect(res.errorMessage).toBe('Biometric plugin not available');
    });
  });

  describe('authenticate', () => {
    it('returns false when plugin is null', async () => {
      const { mod } = load({ platform: NOT_MOBILE });
      expect(await mod.authenticate('Unlock')).toBe(false);
    });

    it('verifies identity with the simple iOS options', async () => {
      const local = makePlugin();
      const { mod } = load({ platform: IOS, local });

      const ok = await mod.authenticate('Unlock wallet');

      expect(ok).toBe(true);
      expect(local.verifyIdentity).toHaveBeenCalledWith({ reason: 'Unlock wallet', useFallback: true });
    });

    it('verifies identity with the richer Android options', async () => {
      const native = makePlugin();
      const { mod } = load({ platform: ANDROID, native });

      const ok = await mod.authenticate('Confirm');

      expect(ok).toBe(true);
      expect(native.verifyIdentity).toHaveBeenCalledWith({
        reason: 'Confirm',
        title: 'Bread',
        subtitle: 'Confirm',
        description: '',
        useFallback: true,
        fallbackTitle: 'Use Password'
      });
    });

    it('returns false when verification throws', async () => {
      const local = makePlugin({ verifyIdentity: jest.fn().mockRejectedValue(new Error('denied')) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.authenticate('Unlock')).toBe(false);
    });
  });

  describe('confirmSensitiveAction', () => {
    it('allows the action when biometrics are unavailable', async () => {
      const local = makePlugin({ isAvailable: jest.fn().mockResolvedValue({ isAvailable: false, biometryType: 0 }) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.confirmSensitiveAction('Confirm send')).toBe(true);
    });

    it('allows the action when biometrics are available but not enabled', async () => {
      const preferences = { get: jest.fn().mockResolvedValue({ value: 'false' }), set: jest.fn() };
      const { mod } = load({ platform: IOS, preferences });

      expect(await mod.confirmSensitiveAction('Confirm send')).toBe(true);
    });

    it('gates on authentication when available and enabled (allowed)', async () => {
      const local = makePlugin();
      const preferences = { get: jest.fn().mockResolvedValue({ value: 'true' }), set: jest.fn() };
      const { mod } = load({ platform: IOS, local, preferences });

      expect(await mod.confirmSensitiveAction('Confirm send')).toBe(true);
      expect(local.verifyIdentity).toHaveBeenCalled();
    });

    it('blocks when available and enabled but authentication fails', async () => {
      const local = makePlugin({ verifyIdentity: jest.fn().mockRejectedValue(new Error('nope')) });
      const preferences = { get: jest.fn().mockResolvedValue({ value: 'true' }), set: jest.fn() };
      const { mod } = load({ platform: IOS, local, preferences });

      expect(await mod.confirmSensitiveAction('Confirm send')).toBe(false);
    });

    it('allows the action (fails open) when the probe throws', async () => {
      // isMobile throwing makes checkBiometricAvailability reject, hitting the outer catch.
      const { mod } = load({ platform: { ...IOS, mobileThrows: true } });

      expect(await mod.confirmSensitiveAction('Confirm send')).toBe(true);
    });
  });

  describe('storeCredential', () => {
    it('throws when plugin is null', async () => {
      const { mod } = load({ platform: NOT_MOBILE });
      await expect(mod.storeCredential('pw')).rejects.toThrow('Biometric plugin not available');
    });

    it('stores the credential under the biometric server/key', async () => {
      const local = makePlugin();
      const { mod } = load({ platform: IOS, local });

      await mod.storeCredential('super-secret');

      expect(local.setCredentials).toHaveBeenCalledWith({
        username: CRED_KEY,
        password: 'super-secret',
        server: SERVER
      });
    });
  });

  describe('getCredential', () => {
    it('returns null when plugin is null', async () => {
      const { mod } = load({ platform: NOT_MOBILE });
      expect(await mod.getCredential()).toBeNull();
    });

    it('returns the stored password', async () => {
      const local = makePlugin({
        getCredentials: jest.fn().mockResolvedValue({ username: CRED_KEY, password: 'pw-123' })
      });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.getCredential()).toBe('pw-123');
      expect(local.getCredentials).toHaveBeenCalledWith({ server: SERVER });
    });

    it('returns null when retrieval throws', async () => {
      const local = makePlugin({ getCredentials: jest.fn().mockRejectedValue(new Error('no cred')) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.getCredential()).toBeNull();
    });
  });

  describe('deleteCredential', () => {
    it('does nothing when plugin is null', async () => {
      const { mod } = load({ platform: NOT_MOBILE });
      await expect(mod.deleteCredential()).resolves.toBeUndefined();
    });

    it('deletes the stored credential', async () => {
      const local = makePlugin();
      const { mod } = load({ platform: IOS, local });

      await mod.deleteCredential();

      expect(local.deleteCredentials).toHaveBeenCalledWith({ server: SERVER });
    });

    it('swallows errors when deletion throws', async () => {
      const local = makePlugin({ deleteCredentials: jest.fn().mockRejectedValue(new Error('missing')) });
      const { mod } = load({ platform: IOS, local });

      await expect(mod.deleteCredential()).resolves.toBeUndefined();
    });
  });

  describe('isBiometricEnabled', () => {
    it('returns false when not on mobile', async () => {
      const { mod } = load({ platform: NOT_MOBILE });
      expect(await mod.isBiometricEnabled()).toBe(false);
    });

    it('returns true when the preference is the string "true"', async () => {
      const preferences = { get: jest.fn().mockResolvedValue({ value: 'true' }), set: jest.fn() };
      const { mod } = load({ platform: IOS, preferences });

      expect(await mod.isBiometricEnabled()).toBe(true);
      expect(preferences.get).toHaveBeenCalledWith({ key: ENABLED_KEY });
    });

    it('returns false when the preference is any other value', async () => {
      const preferences = { get: jest.fn().mockResolvedValue({ value: 'false' }), set: jest.fn() };
      const { mod } = load({ platform: IOS, preferences });

      expect(await mod.isBiometricEnabled()).toBe(false);
    });

    it('returns false when reading the preference throws', async () => {
      const preferences = { get: jest.fn().mockRejectedValue(new Error('prefs down')), set: jest.fn() };
      const { mod } = load({ platform: IOS, preferences });

      expect(await mod.isBiometricEnabled()).toBe(false);
    });
  });

  describe('setBiometricEnabled', () => {
    it('does nothing when not on mobile', async () => {
      const preferences = makePreferences();
      const { mod } = load({ platform: NOT_MOBILE, preferences });

      await mod.setBiometricEnabled(true);

      expect(preferences.set).not.toHaveBeenCalled();
    });

    it('writes "true" and verifies successfully when enabling', async () => {
      const preferences = makePreferences();
      const local = makePlugin();
      const { mod } = load({ platform: IOS, preferences, local });

      await mod.setBiometricEnabled(true);

      expect(preferences.set).toHaveBeenCalledWith({ key: ENABLED_KEY, value: 'true' });
      // Enabling must NOT delete the stored credential.
      expect(local.deleteCredentials).not.toHaveBeenCalled();
    });

    it('writes "false" and deletes the credential when disabling', async () => {
      const preferences = makePreferences();
      const local = makePlugin();
      const { mod } = load({ platform: IOS, preferences, local });

      await mod.setBiometricEnabled(false);

      expect(preferences.set).toHaveBeenCalledWith({ key: ENABLED_KEY, value: 'false' });
      expect(local.deleteCredentials).toHaveBeenCalledWith({ server: SERVER });
    });

    it('handles verification mismatch without throwing', async () => {
      // set writes 'true' but get reports a different value -> verification-failed branch.
      const preferences = {
        set: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue({ value: 'unexpected' })
      };
      const local = makePlugin();
      const { mod } = load({ platform: IOS, preferences, local });

      await expect(mod.setBiometricEnabled(true)).resolves.toBeUndefined();
      expect(preferences.set).toHaveBeenCalledWith({ key: ENABLED_KEY, value: 'true' });
    });

    it('swallows errors when the preference write throws', async () => {
      const preferences = { set: jest.fn().mockRejectedValue(new Error('write fail')), get: jest.fn() };
      const { mod } = load({ platform: IOS, preferences });

      await expect(mod.setBiometricEnabled(true)).resolves.toBeUndefined();
    });
  });

  describe('unlockWithBiometric', () => {
    it('returns null when plugin is null', async () => {
      const { mod } = load({ platform: NOT_MOBILE });
      expect(await mod.unlockWithBiometric('Unlock')).toBeNull();
    });

    it('verifies (iOS, no fallback) then returns the credential', async () => {
      const local = makePlugin({
        getCredentials: jest.fn().mockResolvedValue({ username: CRED_KEY, password: 'unlocked-pw' })
      });
      const { mod } = load({ platform: IOS, local });

      const pw = await mod.unlockWithBiometric('Unlock wallet');

      expect(pw).toBe('unlocked-pw');
      expect(local.verifyIdentity).toHaveBeenCalledWith({ reason: 'Unlock wallet', useFallback: false });
      expect(local.getCredentials).toHaveBeenCalledWith({ server: SERVER });
    });

    it('verifies (Android, no fallback) then returns the credential', async () => {
      const native = makePlugin({
        getCredentials: jest.fn().mockResolvedValue({ username: CRED_KEY, password: 'android-pw' })
      });
      const { mod } = load({ platform: ANDROID, native });

      const pw = await mod.unlockWithBiometric('Unlock');

      expect(pw).toBe('android-pw');
      expect(native.verifyIdentity).toHaveBeenCalledWith({
        reason: 'Unlock',
        title: 'Bread',
        subtitle: 'Unlock',
        description: '',
        useFallback: false
      });
    });

    it('returns null when verification/retrieval throws', async () => {
      const local = makePlugin({ verifyIdentity: jest.fn().mockRejectedValue(new Error('denied')) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.unlockWithBiometric('Unlock')).toBeNull();
    });
  });

  describe('setupBiometric', () => {
    it('returns false when biometrics are unavailable', async () => {
      const local = makePlugin({ isAvailable: jest.fn().mockResolvedValue({ isAvailable: false, biometryType: 0 }) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.setupBiometric('pw')).toBe(false);
    });

    it('returns false when authentication fails', async () => {
      const local = makePlugin({ verifyIdentity: jest.fn().mockRejectedValue(new Error('denied')) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.setupBiometric('pw')).toBe(false);
    });

    it('stores the credential, enables biometrics, and returns true on success', async () => {
      const preferences = makePreferences();
      const local = makePlugin();
      const { mod } = load({ platform: IOS, local, preferences });

      const ok = await mod.setupBiometric('wallet-pw');

      expect(ok).toBe(true);
      expect(local.setCredentials).toHaveBeenCalledWith({
        username: CRED_KEY,
        password: 'wallet-pw',
        server: SERVER
      });
      expect(preferences.set).toHaveBeenCalledWith({ key: ENABLED_KEY, value: 'true' });
    });

    it('returns false when a step throws', async () => {
      // isAvailable/authenticate succeed, but storing the credential rejects.
      const local = makePlugin({ setCredentials: jest.fn().mockRejectedValue(new Error('keystore fail')) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.setupBiometric('pw')).toBe(false);
    });
  });

  describe('service objects', () => {
    it('exposes biometricService and default export with all functions', () => {
      const { mod } = load({ platform: IOS });

      const expected = [
        'checkBiometricAvailability',
        'authenticate',
        'storeCredential',
        'getCredential',
        'deleteCredential',
        'isBiometricEnabled',
        'setBiometricEnabled',
        'unlockWithBiometric',
        'setupBiometric'
      ];
      for (const fn of expected) {
        expect(typeof (mod.biometricService as Record<string, unknown>)[fn]).toBe('function');
      }
      expect(mod.default).toBe(mod.biometricService);
    });
  });
});

describe('hardware security service', () => {
  describe('getHardwareSecurityPlugin (via public functions)', () => {
    it('uses LocalBiometric on iOS', async () => {
      const local = makePlugin({ isHardwareSecurityAvailable: jest.fn().mockResolvedValue({ available: true }) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.isHardwareSecurityAvailable()).toBe(true);
      expect(local.isHardwareSecurityAvailable).toHaveBeenCalled();
    });

    it('uses HardwareSecurity on Android', async () => {
      const hardware = makePlugin({ isHardwareSecurityAvailable: jest.fn().mockResolvedValue({ available: true }) });
      const { mod } = load({ platform: ANDROID, hardware });

      expect(await mod.isHardwareSecurityAvailable()).toBe(true);
      expect(hardware.isHardwareSecurityAvailable).toHaveBeenCalled();
    });

    it('returns false when mobile but neither iOS nor Android', async () => {
      const { mod } = load({ platform: MOBILE_OTHER });
      expect(await mod.isHardwareSecurityAvailable()).toBe(false);
    });

    it('returns false/handles null plugin when not on mobile', async () => {
      const { mod } = load({ platform: NOT_MOBILE });

      expect(await mod.isHardwareSecurityAvailable()).toBe(false);
      expect(await mod.hasHardwareKey()).toBe(false);
      await expect(mod.generateHardwareKey()).rejects.toThrow('Hardware security not available');
      await expect(mod.encryptWithHardwareKey('x')).rejects.toThrow('Hardware security not available');
      await expect(mod.decryptWithHardwareKey('x')).rejects.toThrow('Hardware security not available');
      await expect(mod.deleteHardwareKey()).resolves.toBeUndefined();
    });
  });

  describe('isHardwareSecurityAvailable', () => {
    it('returns the reported availability', async () => {
      const local = makePlugin({ isHardwareSecurityAvailable: jest.fn().mockResolvedValue({ available: false }) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.isHardwareSecurityAvailable()).toBe(false);
    });

    it('returns false when the probe throws', async () => {
      const local = makePlugin({ isHardwareSecurityAvailable: jest.fn().mockRejectedValue(new Error('boom')) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.isHardwareSecurityAvailable()).toBe(false);
    });
  });

  describe('hasHardwareKey', () => {
    it('returns whether a key exists', async () => {
      const local = makePlugin({ hasHardwareKey: jest.fn().mockResolvedValue({ exists: true }) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.hasHardwareKey()).toBe(true);
    });

    it('returns false when the check throws', async () => {
      const local = makePlugin({ hasHardwareKey: jest.fn().mockRejectedValue(new Error('boom')) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.hasHardwareKey()).toBe(false);
    });
  });

  describe('generateHardwareKey', () => {
    it('delegates to the plugin', async () => {
      const local = makePlugin();
      const { mod } = load({ platform: IOS, local });

      await mod.generateHardwareKey();

      expect(local.generateHardwareKey).toHaveBeenCalledTimes(1);
    });

    it('throws when hardware security is unavailable', async () => {
      const { mod } = load({ platform: NOT_MOBILE });
      await expect(mod.generateHardwareKey()).rejects.toThrow('Hardware security not available');
    });
  });

  describe('encryptWithHardwareKey', () => {
    it('returns the encrypted payload', async () => {
      const local = makePlugin({ encryptWithHardwareKey: jest.fn().mockResolvedValue({ encrypted: 'CIPHER' }) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.encryptWithHardwareKey('plain')).toBe('CIPHER');
      expect(local.encryptWithHardwareKey).toHaveBeenCalledWith({ data: 'plain' });
    });

    it('throws when hardware security is unavailable', async () => {
      const { mod } = load({ platform: NOT_MOBILE });
      await expect(mod.encryptWithHardwareKey('plain')).rejects.toThrow('Hardware security not available');
    });
  });

  describe('decryptWithHardwareKey', () => {
    it('returns the decrypted payload', async () => {
      const local = makePlugin({ decryptWithHardwareKey: jest.fn().mockResolvedValue({ decrypted: 'PLAIN' }) });
      const { mod } = load({ platform: IOS, local });

      expect(await mod.decryptWithHardwareKey('CIPHER')).toBe('PLAIN');
      expect(local.decryptWithHardwareKey).toHaveBeenCalledWith({ encrypted: 'CIPHER' });
    });

    it('throws when hardware security is unavailable', async () => {
      const { mod } = load({ platform: NOT_MOBILE });
      await expect(mod.decryptWithHardwareKey('CIPHER')).rejects.toThrow('Hardware security not available');
    });
  });

  describe('deleteHardwareKey', () => {
    it('delegates to the plugin', async () => {
      const local = makePlugin();
      const { mod } = load({ platform: IOS, local });

      await mod.deleteHardwareKey();

      expect(local.deleteHardwareKey).toHaveBeenCalledTimes(1);
    });

    it('does nothing when hardware security is unavailable', async () => {
      const { mod } = load({ platform: NOT_MOBILE });
      await expect(mod.deleteHardwareKey()).resolves.toBeUndefined();
    });

    it('swallows errors when deletion throws', async () => {
      const local = makePlugin({ deleteHardwareKey: jest.fn().mockRejectedValue(new Error('boom')) });
      const { mod } = load({ platform: IOS, local });

      await expect(mod.deleteHardwareKey()).resolves.toBeUndefined();
    });
  });

  describe('hardwareSecurityService object', () => {
    it('exposes all hardware security functions', () => {
      const { mod } = load({ platform: IOS });

      const expected = [
        'isHardwareSecurityAvailable',
        'hasHardwareKey',
        'generateHardwareKey',
        'encryptWithHardwareKey',
        'decryptWithHardwareKey',
        'deleteHardwareKey'
      ];
      for (const fn of expected) {
        expect(typeof (mod.hardwareSecurityService as Record<string, unknown>)[fn]).toBe('function');
      }
    });
  });
});
