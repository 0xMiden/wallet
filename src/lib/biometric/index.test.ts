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

// Type-only import of the module-under-test. This has no runtime effect (it is
// erased), but as a top-level `import` it marks this file as an ES module, so
// its top-level helpers (`load`, `makePlugin`, `IOS`, …) stay file-scoped
// instead of leaking into the global scope, where they would collide with
// same-named helpers in sibling test files (TS2393 "Duplicate function
// implementation").
import type * as BiometricModule from './index';

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
    biometricStatus: jest.fn().mockResolvedValue({ code: 0, managedProfile: false }),
    openBiometricSettings: jest.fn().mockResolvedValue(undefined),
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
  const mod = require('./index') as typeof BiometricModule;
  return { mod, platformMock, localPlugin, hardwarePlugin, nativePlugin, prefs };
}

const UNKNOWN_SETUP = { available: false, reason: 'unknown', managedProfile: false };

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
      [0, 'none'],
      [1, 'fingerprint'],
      [2, 'face'],
      [3, 'fingerprint'],
      [4, 'face'],
      [5, 'iris'],
      [6, 'multiple'],
      [99, 'none']
    ])('maps Android biometryType %s to "%s"', async (raw, mapped) => {
      const native = makePlugin({
        isAvailable: jest.fn().mockResolvedValue({ isAvailable: true, biometryType: raw, errorCode: 7 })
      });
      const { mod } = load({ platform: ANDROID, native });

      const res = await mod.checkBiometricAvailability();

      expect(res).toEqual({ isAvailable: true, biometryType: mapped, errorCode: 7 });
    });

    it.each([
      [1, 'fingerprint'],
      [2, 'face']
    ])('maps iOS biometryType %s to "%s"', async (raw, mapped) => {
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

  describe('reasonForAndroidStatus', () => {
    it.each([
      [0, null],
      [11, 'none-enrolled'],
      [12, 'no-strong-biometric'],
      [1, 'hardware-unavailable'],
      [15, 'security-update-required'],
      [-1, 'unknown'],
      [-2, 'unknown'],
      [99, 'unknown']
    ])('maps canAuthenticate(BIOMETRIC_STRONG) %s to %s', (code, reason) => {
      const { mod } = load({ platform: ANDROID });

      expect(mod.reasonForAndroidStatus(code)).toBe(reason);
    });

    // A class-2-only enrollment (weakCode 0, strong code 11) is distinct from no
    // enrollment at all (weakCode 11 or missing): only the former can be fixed by
    // enrolling a stronger biometric rather than any biometric.
    it.each([
      [11, 0, 'strong-not-enrolled'],
      [11, 11, 'none-enrolled'],
      [11, undefined, 'none-enrolled'],
      [0, 0, null]
    ])('maps canAuthenticate(BIOMETRIC_STRONG) %s with BIOMETRIC_WEAK %s to %s', (code, weakCode, reason) => {
      const { mod } = load({ platform: ANDROID });

      expect(mod.reasonForAndroidStatus(code, weakCode)).toBe(reason);
    });
  });

  describe('reasonForPluginError', () => {
    it.each([
      [3, 'none-enrolled'],
      [1, 'hardware-unavailable'],
      [2, 'locked-out'],
      [4, 'locked-out'],
      [14, 'passcode-not-set'],
      [0, 'unknown'],
      [10, 'unknown'],
      [undefined, 'unknown']
    ])('maps plugin error %s to %s', (code, reason) => {
      const { mod } = load({ platform: IOS });

      expect(mod.reasonForPluginError(code)).toBe(reason);
    });
  });

  describe('checkBiometricSetup', () => {
    it.each([
      [0, false, { available: true, reason: null, managedProfile: false }],
      [0, true, { available: true, reason: null, managedProfile: true }],
      [11, false, { available: false, reason: 'none-enrolled', managedProfile: false }],
      [11, true, { available: false, reason: 'none-enrolled', managedProfile: true }],
      [12, false, { available: false, reason: 'no-strong-biometric', managedProfile: false }]
    ])('on Android reads biometricStatus code %s (managed profile: %s)', async (code, managedProfile, expected) => {
      const hardware = makePlugin({ biometricStatus: jest.fn().mockResolvedValue({ code, managedProfile }) });
      const native = makePlugin();
      const { mod } = load({ platform: ANDROID, hardware, native });

      expect(await mod.checkBiometricSetup()).toEqual(expected);
      expect(hardware.biometricStatus).toHaveBeenCalledTimes(1);
      expect(native.isAvailable).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'on Android reads strong-not-enrolled from biometricStatus weakCode (managed profile: %s)',
      async managedProfile => {
        const hardware = makePlugin({
          biometricStatus: jest.fn().mockResolvedValue({ code: 11, weakCode: 0, managedProfile })
        });
        const { mod } = load({ platform: ANDROID, hardware });

        expect(await mod.checkBiometricSetup()).toEqual({
          available: false,
          reason: 'strong-not-enrolled',
          managedProfile
        });
      }
    );

    it.each([
      [
        { isAvailable: true, biometryType: 2 },
        { available: true, reason: null, managedProfile: false }
      ],
      [
        { isAvailable: false, biometryType: 0, errorCode: 3 },
        { available: false, reason: 'none-enrolled', managedProfile: false }
      ],
      [
        { isAvailable: false, biometryType: 0, errorCode: 2 },
        { available: false, reason: 'locked-out', managedProfile: false }
      ],
      [{ isAvailable: false, biometryType: 0 }, UNKNOWN_SETUP]
    ])('on iOS reads LocalBiometric.isAvailable %j', async (availability, expected) => {
      const local = makePlugin({ isAvailable: jest.fn().mockResolvedValue(availability) });
      const hardware = makePlugin();
      const { mod } = load({ platform: IOS, local, hardware });

      expect(await mod.checkBiometricSetup()).toEqual(expected);
      expect(local.isAvailable).toHaveBeenCalledTimes(1);
      expect(hardware.biometricStatus).not.toHaveBeenCalled();
    });

    it.each([
      ['off mobile', NOT_MOBILE],
      ['on a mobile platform that is neither iOS nor Android', MOBILE_OTHER]
    ])('reads as unknown %s without asking a plugin', async (_label, platform) => {
      const local = makePlugin();
      const hardware = makePlugin();
      const { mod } = load({ platform, local, hardware });

      expect(await mod.checkBiometricSetup()).toEqual(UNKNOWN_SETUP);
      expect(local.isAvailable).not.toHaveBeenCalled();
      expect(hardware.biometricStatus).not.toHaveBeenCalled();
    });

    it('reads as unknown when the Android status call rejects, as on a native build without it', async () => {
      const hardware = makePlugin({ biometricStatus: jest.fn().mockRejectedValue(new Error('not implemented')) });
      const { mod } = load({ platform: ANDROID, hardware });

      await expect(mod.checkBiometricSetup()).resolves.toEqual(UNKNOWN_SETUP);
    });

    it('reads as unknown when the iOS availability call rejects', async () => {
      const local = makePlugin({ isAvailable: jest.fn().mockRejectedValue(new Error('LAContext failed')) });
      const { mod } = load({ platform: IOS, local });

      await expect(mod.checkBiometricSetup()).resolves.toEqual(UNKNOWN_SETUP);
    });
  });

  describe('openBiometricSettings', () => {
    it('on Android asks the plugin to open Settings', async () => {
      const hardware = makePlugin();
      const { mod } = load({ platform: ANDROID, hardware });

      await expect(mod.openBiometricSettings()).resolves.toBeUndefined();
      expect(hardware.openBiometricSettings).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['on iOS', IOS],
      ['off mobile', NOT_MOBILE]
    ])('resolves undefined %s without calling the plugin', async (_label, platform) => {
      const hardware = makePlugin();
      const { mod } = load({ platform, hardware });

      await expect(mod.openBiometricSettings()).resolves.toBeUndefined();
      expect(hardware.openBiometricSettings).not.toHaveBeenCalled();
    });

    it('resolves undefined when the plugin rejects, as on a native build without it', async () => {
      const hardware = makePlugin({ openBiometricSettings: jest.fn().mockRejectedValue(new Error('not implemented')) });
      const { mod } = load({ platform: ANDROID, hardware });

      await expect(mod.openBiometricSettings()).resolves.toBeUndefined();
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
    it('off mobile, resolves true without probing or verifying', async () => {
      const local = makePlugin();
      const { mod } = load({ platform: NOT_MOBILE, local });
      const probe = jest.fn().mockResolvedValue(true);

      expect(await mod.confirmSensitiveAction('Confirm your send', probe)).toBe(true);
      expect(probe).not.toHaveBeenCalled();
      expect(local.verifyIdentity).not.toHaveBeenCalled();
    });

    it('on mobile, no hardware protector: resolves true without verifying', async () => {
      const local = makePlugin();
      const { mod } = load({ platform: IOS, local });
      const probe = jest.fn().mockResolvedValue(false);

      expect(await mod.confirmSensitiveAction('Confirm your send', probe)).toBe(true);
      expect(local.verifyIdentity).not.toHaveBeenCalled();
    });

    it('on mobile with a hardware protector, authenticates with the given reason', async () => {
      const local = makePlugin();
      const { mod } = load({ platform: IOS, local });
      const probe = jest.fn().mockResolvedValue(true);

      expect(await mod.confirmSensitiveAction('Confirm your send', probe)).toBe(true);
      expect(local.verifyIdentity).toHaveBeenCalledWith({ reason: 'Confirm your send', useFallback: true });
    });

    it('on mobile with a hardware protector, blocks when authentication fails', async () => {
      const local = makePlugin({ verifyIdentity: jest.fn().mockRejectedValue(new Error('denied')) });
      const { mod } = load({ platform: IOS, local });
      const probe = jest.fn().mockResolvedValue(true);

      expect(await mod.confirmSensitiveAction('Confirm your send', probe)).toBe(false);
    });

    it('still authenticates through a biometry lockout, via the passcode fallback', async () => {
      const local = makePlugin({ isAvailable: jest.fn().mockResolvedValue({ isAvailable: false, biometryType: 0 }) });
      const { mod } = load({ platform: IOS, local });
      const probe = jest.fn().mockResolvedValue(true);

      expect(await mod.confirmSensitiveAction('Confirm your send', probe)).toBe(true);
      expect(local.verifyIdentity).toHaveBeenCalledWith({ reason: 'Confirm your send', useFallback: true });
    });

    it('propagates a rejecting protector probe without authenticating', async () => {
      const local = makePlugin();
      const { mod } = load({ platform: IOS, local });
      const probe = jest.fn().mockRejectedValue(new Error('protector check failed'));

      await expect(mod.confirmSensitiveAction('Confirm your send', probe)).rejects.toThrow('protector check failed');
      expect(local.verifyIdentity).not.toHaveBeenCalled();
    });
  });

  describe('service objects', () => {
    it('exposes biometricService and default export with all functions', () => {
      const { mod } = load({ platform: IOS });

      const expected = ['checkBiometricAvailability', 'authenticate'];
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
