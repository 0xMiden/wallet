import {
  DELEGATE_PROOF_STORAGE_KEY,
  AUTO_CONSUME_STORAGE_KEY,
  HAPTIC_FEEDBACK_STORAGE_KEY,
  DEFAULT_DELEGATE_PROOF,
  DEFAULT_AUTO_CONSUME,
  DEFAULT_HAPTIC_FEEDBACK,
  TELEMETRY_STORAGE_KEY,
  BG_SETTINGS_MIRRORED_KEY
} from './constants';
import {
  setDelegateProofSetting,
  isDelegateProofEnabled,
  setAutoConsumeSetting,
  isAutoConsumeEnabled,
  setHapticFeedbackSetting,
  isHapticFeedbackEnabled,
  setThemeSetting,
  getThemeSetting,
  isValidGuardianUrl,
  sanitizeGuardianUrl,
  sameGuardianEndpoint,
  isAutoConsumeEnabledAsync,
  isCrashReportingEnabledAsync,
  isDelegateProofEnabledAsync,
  mirrorBackgroundSettings,
  areBackgroundSettingsMirrored,
  setTelemetrySetting,
  isTelemetryEnabled,
  isTelemetryEnabledAsync,
  hasTelemetryChoice
} from './helpers';

const mockKvStore: Record<string, unknown> = {};
let mockStorageThrows = false;
let mockGet: ((keys: string[]) => Promise<Record<string, unknown>>) | null = null;
let mockSet: ((items: Record<string, unknown>) => Promise<void>) | null = null;
// The async storage mock adopts nested promises before its writes settle.
const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => {
    if (mockStorageThrows) throw new Error('storage provider not ready');
    return {
      get: async (keys: string[]) => {
        if (mockGet) return mockGet(keys);
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        if (mockSet) return mockSet(obj);
        Object.assign(mockKvStore, obj);
      }
    };
  }
}));

describe('settings helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
    mockStorageThrows = false;
    mockGet = null;
    mockSet = null;
  });

  describe('boolean preferences with unavailable storage', () => {
    const readers = [
      { name: 'delegated proving', key: DELEGATE_PROOF_STORAGE_KEY, read: isDelegateProofEnabled, closed: false },
      { name: 'auto-consume', key: AUTO_CONSUME_STORAGE_KEY, read: isAutoConsumeEnabled, closed: false },
      { name: 'haptics', key: HAPTIC_FEEDBACK_STORAGE_KEY, read: isHapticFeedbackEnabled, closed: true },
      { name: 'telemetry', key: TELEMETRY_STORAGE_KEY, read: isTelemetryEnabled, closed: false }
    ];
    const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');

    afterEach(() => {
      if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
      jest.restoreAllMocks();
      localStorage.clear();
    });

    it.each(readers)('settles $name to $closed when storage is null', ({ read, closed }) => {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: null });
      expect(read()).toBe(closed);
    });

    it.each(readers)('settles $name to $closed when the storage getter throws', ({ read, closed }) => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('Storage unavailable', 'SecurityError');
        }
      });
      expect(read()).toBe(closed);
    });

    it.each(readers)('settles $name to $closed when reading storage throws', ({ read, closed }) => {
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('Storage unavailable', 'SecurityError');
      });
      expect(read()).toBe(closed);
    });

    it.each(readers)('settles $name to $closed for malformed JSON', ({ key, read, closed }) => {
      localStorage.setItem(key, '{broken');
      expect(read()).toBe(closed);
    });

    it.each(readers)('settles $name to $closed for nonboolean JSON', ({ key, read, closed }) => {
      for (const value of ['null', '0', '1', '"false"', '[]', '{}']) {
        localStorage.setItem(key, value);
        expect(read()).toBe(closed);
      }
    });

    it.each(readers)('preserves explicit $name choices', ({ key, read }) => {
      localStorage.setItem(key, 'false');
      expect(read()).toBe(false);
      localStorage.setItem(key, 'true');
      expect(read()).toBe(true);
    });

    it.each(['null', 'getter', 'getItem'])('reports no recorded choice when storage is %s', arm => {
      if (arm === 'null') {
        Object.defineProperty(window, 'localStorage', { configurable: true, value: null });
      } else if (arm === 'getter') {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() {
            throw new DOMException('Storage unavailable', 'SecurityError');
          }
        });
      } else {
        jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
          throw new DOMException('Storage unavailable', 'SecurityError');
        });
      }
      expect(hasTelemetryChoice()).toBe(false);
    });

    it('counts a stored non-boolean value as a choice', () => {
      for (const stored of ['', '{broken']) {
        localStorage.setItem(TELEMETRY_STORAGE_KEY, stored);
        expect(hasTelemetryChoice()).toBe(true);
      }
    });

    it.each(['null', 'getter', 'read', 'json', 'nonboolean'])(
      'keeps established background choices when storage fails with %s',
      async failure => {
        setAutoConsumeSetting(false);
        setDelegateProofSetting(false);
        await Promise.resolve();
        localStorage.setItem(AUTO_CONSUME_STORAGE_KEY, 'true');
        if (failure === 'null') {
          Object.defineProperty(window, 'localStorage', { configurable: true, value: null });
        } else if (failure === 'getter') {
          Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() {
              throw new DOMException('Storage unavailable', 'SecurityError');
            }
          });
        } else if (failure === 'read') {
          jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('Storage unavailable', 'SecurityError');
          });
        } else {
          localStorage.setItem(DELEGATE_PROOF_STORAGE_KEY, failure === 'json' ? '{broken' : '"false"');
        }

        expect(() => mirrorBackgroundSettings()).not.toThrow();
        await Promise.resolve();
        expect(await isAutoConsumeEnabledAsync()).toBe(false);
        expect(await isDelegateProofEnabledAsync()).toBe(false);
        expect(await areBackgroundSettingsMirrored()).toBe(false);
      }
    );
  });

  describe('isValidGuardianUrl', () => {
    it('accepts https URLs', () => {
      expect(isValidGuardianUrl('https://guardian.example.com')).toBe(true);
      expect(isValidGuardianUrl('  https://guardian.example.com/path  ')).toBe(true);
    });

    it('accepts http only for localhost / 127.0.0.1', () => {
      expect(isValidGuardianUrl('http://localhost:8080')).toBe(true);
      expect(isValidGuardianUrl('http://127.0.0.1:3000')).toBe(true);
    });

    it('rejects plain http on non-localhost hosts (signatures must use TLS)', () => {
      expect(isValidGuardianUrl('http://guardian.example.com')).toBe(false);
    });

    it('rejects malformed / non-http(s) input', () => {
      expect(isValidGuardianUrl('')).toBe(false);
      expect(isValidGuardianUrl('not-a-url')).toBe(false);
      expect(isValidGuardianUrl('ftp://guardian.example.com')).toBe(false);
      expect(isValidGuardianUrl('guardian.example.com')).toBe(false);
    });
  });

  describe('sanitizeGuardianUrl', () => {
    it('trims whitespace and strips trailing slashes', () => {
      expect(sanitizeGuardianUrl('  https://guardian.example.com/  ')).toBe('https://guardian.example.com');
      expect(sanitizeGuardianUrl('https://guardian.example.com///')).toBe('https://guardian.example.com');
      expect(sanitizeGuardianUrl('https://guardian.example.com/path/')).toBe('https://guardian.example.com/path');
    });

    it('leaves an already-clean URL unchanged', () => {
      expect(sanitizeGuardianUrl('https://guardian.example.com')).toBe('https://guardian.example.com');
    });
  });

  describe('sameGuardianEndpoint', () => {
    it('treats host case, a default port, trailing slashes and whitespace as the same endpoint', () => {
      expect(sameGuardianEndpoint('https://guardian.example.com', 'https://Guardian.Example.COM')).toBe(true);
      expect(sameGuardianEndpoint('https://guardian.example.com:443/', 'https://guardian.example.com')).toBe(true);
      expect(sameGuardianEndpoint('http://localhost:80', 'http://localhost')).toBe(true);
      expect(sameGuardianEndpoint('  https://guardian.example.com/v1/ ', 'https://guardian.example.com/v1')).toBe(true);
    });

    it('keeps the scheme, a non-default port, the path case and the query meaningful', () => {
      expect(sameGuardianEndpoint('http://guardian.example.com', 'https://guardian.example.com')).toBe(false);
      expect(sameGuardianEndpoint('https://guardian.example.com:8443', 'https://guardian.example.com')).toBe(false);
      expect(sameGuardianEndpoint('https://guardian.example.com/Path', 'https://guardian.example.com/path')).toBe(
        false
      );
      expect(sameGuardianEndpoint('https://guardian.example.com/?a=1', 'https://guardian.example.com/?a=2')).toBe(
        false
      );
    });

    it('compares an unparseable value as its own text', () => {
      expect(sameGuardianEndpoint('not a url', ' NOT A URL/')).toBe(true);
      expect(sameGuardianEndpoint('not a url', 'https://guardian.example.com')).toBe(false);
    });

    // A stored spelling with userinfo, a query or a fragment isn't the working
    // endpoint: GuardianHttpClient concatenates `${baseUrl}${path}`, so a `?` or `#`
    // swallows every path the client appends, and credentials in a URL make `fetch`
    // throw. None may compare equal to the plain endpoint it looks like.
    it('keeps userinfo, an empty query and the fragment meaningful', () => {
      expect(sameGuardianEndpoint('https://u:p@guardian.example.com', 'https://guardian.example.com')).toBe(false);
      expect(sameGuardianEndpoint('https://:p@guardian.example.com', 'https://guardian.example.com')).toBe(false);
      expect(sameGuardianEndpoint('https://guardian.example.com#section', 'https://guardian.example.com')).toBe(false);
      expect(sameGuardianEndpoint('https://guardian.example.com#', 'https://guardian.example.com')).toBe(false);
      expect(sameGuardianEndpoint('https://guardian.example.com?', 'https://guardian.example.com')).toBe(false);
    });

    it('treats a renamed built-in host as its current name', () => {
      expect(
        sameGuardianEndpoint('https://guardian.openzeppelin.com', 'https://guardian-testnet.openzeppelin.com')
      ).toBe(true);
      expect(
        sameGuardianEndpoint('https://Guardian-Stg.OpenZeppelin.com/', 'https://guardian-devnet.openzeppelin.com')
      ).toBe(true);
      // The rename is per network: the old testnet name is not the devnet operator.
      expect(
        sameGuardianEndpoint('https://guardian.openzeppelin.com', 'https://guardian-devnet.openzeppelin.com')
      ).toBe(false);
      // Only the host is renamed: a path on the old host is not the new host's root.
      expect(
        sameGuardianEndpoint('https://guardian.openzeppelin.com/v1', 'https://guardian-testnet.openzeppelin.com')
      ).toBe(false);
    });
  });

  describe('delegate proof setting', () => {
    it('returns default value when not set', () => {
      expect(isDelegateProofEnabled()).toBe(DEFAULT_DELEGATE_PROOF);
    });

    it('sets and gets true value', () => {
      setDelegateProofSetting(true);
      expect(isDelegateProofEnabled()).toBe(true);
      expect(localStorage.getItem(DELEGATE_PROOF_STORAGE_KEY)).toBe('true');
    });

    it('sets and gets false value', () => {
      setDelegateProofSetting(false);
      expect(isDelegateProofEnabled()).toBe(false);
      expect(localStorage.getItem(DELEGATE_PROOF_STORAGE_KEY)).toBe('false');
    });
  });

  describe('auto consume setting', () => {
    it('returns default value when not set', () => {
      expect(isAutoConsumeEnabled()).toBe(DEFAULT_AUTO_CONSUME);
    });

    it('sets and gets true value', () => {
      setAutoConsumeSetting(true);
      expect(isAutoConsumeEnabled()).toBe(true);
      expect(localStorage.getItem(AUTO_CONSUME_STORAGE_KEY)).toBe('true');
    });

    it('sets and gets false value', () => {
      setAutoConsumeSetting(false);
      expect(isAutoConsumeEnabled()).toBe(false);
      expect(localStorage.getItem(AUTO_CONSUME_STORAGE_KEY)).toBe('false');
    });
  });

  describe('auto consume setting mirror (service-worker readable)', () => {
    it('isAutoConsumeEnabledAsync defaults ON when the mirror is absent', async () => {
      expect(await isAutoConsumeEnabledAsync()).toBe(DEFAULT_AUTO_CONSUME);
    });

    it('setAutoConsumeSetting write-throughs to the SW-readable mirror', async () => {
      setAutoConsumeSetting(false);
      expect(await isAutoConsumeEnabledAsync()).toBe(false);
      setAutoConsumeSetting(true);
      expect(await isAutoConsumeEnabledAsync()).toBe(true);
    });

    it('mirrorBackgroundSettings copies the current localStorage values into the mirror', async () => {
      localStorage.setItem(AUTO_CONSUME_STORAGE_KEY, JSON.stringify(false));
      localStorage.setItem(DELEGATE_PROOF_STORAGE_KEY, JSON.stringify(false));
      mirrorBackgroundSettings();
      await Promise.resolve();
      expect(await isAutoConsumeEnabledAsync()).toBe(false);
      expect(await isDelegateProofEnabledAsync()).toBe(false);
    });
  });

  describe('delegate proof setting mirror (service-worker readable)', () => {
    it('isDelegateProofEnabledAsync defaults to the delegate default when the mirror is absent', async () => {
      expect(await isDelegateProofEnabledAsync()).toBe(DEFAULT_DELEGATE_PROOF);
    });

    it('setDelegateProofSetting write-throughs to the SW-readable mirror', async () => {
      setDelegateProofSetting(false);
      expect(await isDelegateProofEnabledAsync()).toBe(false);
      setDelegateProofSetting(true);
      expect(await isDelegateProofEnabledAsync()).toBe(true);
    });
  });

  describe('background-settings mirror marker', () => {
    it('areBackgroundSettingsMirrored defaults false until the popup mirrors', async () => {
      expect(await areBackgroundSettingsMirrored()).toBe(false);
    });

    it('mirrorBackgroundSettings sets the marker so the SW may act', async () => {
      mirrorBackgroundSettings();
      await nextTask();
      expect(await areBackgroundSettingsMirrored()).toBe(true);
    });
  });

  describe('mirror is resilient to an unavailable storage provider', () => {
    it('setters and mirrorBackgroundSettings do not throw when getStorageProvider throws', () => {
      mockStorageThrows = true;
      expect(() => setAutoConsumeSetting(false)).not.toThrow();
      expect(() => setDelegateProofSetting(false)).not.toThrow();
      expect(() => mirrorBackgroundSettings()).not.toThrow();
    });

    it('returns false for operational mirrors when the provider throws', async () => {
      mockStorageThrows = true;
      expect(await isAutoConsumeEnabledAsync()).toBe(false);
      expect(await isDelegateProofEnabledAsync()).toBe(false);
      expect(await areBackgroundSettingsMirrored()).toBe(false);
    });

    it('returns false when a mirrored operational read is rejected after the marker', async () => {
      mockKvStore[BG_SETTINGS_MIRRORED_KEY] = true;
      mockGet = async keys => {
        if (keys.includes(AUTO_CONSUME_STORAGE_KEY) || keys.includes(DELEGATE_PROOF_STORAGE_KEY)) {
          throw new Error('Preference read unavailable');
        }
        return Object.fromEntries(keys.filter(key => key in mockKvStore).map(key => [key, mockKvStore[key]]));
      };
      expect(await areBackgroundSettingsMirrored()).toBe(true);
      expect(await isAutoConsumeEnabledAsync()).toBe(false);
      expect(await isDelegateProofEnabledAsync()).toBe(false);
    });

    it('returns false for a malformed mirrored operational preference', async () => {
      mockKvStore[AUTO_CONSUME_STORAGE_KEY] = 'false';
      mockKvStore[DELEGATE_PROOF_STORAGE_KEY] = 0;
      expect(await isAutoConsumeEnabledAsync()).toBe(false);
      expect(await isDelegateProofEnabledAsync()).toBe(false);
    });

    it.each([
      { name: 'leaves the mirror marker false when the preference batch is rejected', trusted: false },
      { name: 'clears a trusted marker when the preference batch is rejected', trusted: true }
    ])('$name', async ({ trusted }) => {
      if (trusted) {
        mockKvStore[BG_SETTINGS_MIRRORED_KEY] = true;
        mockKvStore[AUTO_CONSUME_STORAGE_KEY] = true;
      }
      localStorage.setItem(AUTO_CONSUME_STORAGE_KEY, 'false');
      localStorage.setItem(DELEGATE_PROOF_STORAGE_KEY, 'true');
      localStorage.setItem(TELEMETRY_STORAGE_KEY, 'false');
      const payloads: Record<string, unknown>[] = [];
      mockSet = async items => {
        payloads.push(items);
        if (items[AUTO_CONSUME_STORAGE_KEY] === false) throw new Error('Preference write unavailable');
        Object.assign(mockKvStore, items);
      };
      mirrorBackgroundSettings();
      await nextTask();
      expect(mockKvStore[BG_SETTINGS_MIRRORED_KEY]).toBe(false);
      expect(payloads[0]).toEqual({ [BG_SETTINGS_MIRRORED_KEY]: false });
      expect(payloads).toContainEqual({ [AUTO_CONSUME_STORAGE_KEY]: false });
      expect(payloads.some(items => items[BG_SETTINGS_MIRRORED_KEY] === true)).toBe(false);
      expect(await isAutoConsumeEnabledAsync()).toBe(true);
      expect((await areBackgroundSettingsMirrored()) && (await isAutoConsumeEnabledAsync())).toBe(false);
    });

    it('does not copy preferences when clearing the mirror marker is rejected', async () => {
      mockKvStore[BG_SETTINGS_MIRRORED_KEY] = true;
      mockKvStore[AUTO_CONSUME_STORAGE_KEY] = true;
      localStorage.setItem(AUTO_CONSUME_STORAGE_KEY, 'false');
      const payloads: Record<string, unknown>[] = [];
      mockSet = async items => {
        payloads.push(items);
        if (items[BG_SETTINGS_MIRRORED_KEY] === false && Object.keys(items).length === 1) {
          throw new Error('Marker write unavailable');
        }
        Object.assign(mockKvStore, items);
      };
      mirrorBackgroundSettings();
      await nextTask();
      expect(payloads[0]).toEqual({ [BG_SETTINGS_MIRRORED_KEY]: false });
      expect(payloads.some(items => AUTO_CONSUME_STORAGE_KEY in items)).toBe(false);
      expect(mockKvStore[BG_SETTINGS_MIRRORED_KEY]).toBe(true);
    });

    it.each([
      { name: 'keeps a false choice made while the mirror marker clear is pending', readFails: false },
      { name: 'does not copy preferences when a local read fails after the marker clear', readFails: true }
    ])('$name', async ({ readFails }) => {
      const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
      for (const key of [AUTO_CONSUME_STORAGE_KEY, DELEGATE_PROOF_STORAGE_KEY, TELEMETRY_STORAGE_KEY]) {
        localStorage.setItem(key, 'true');
      }
      let releaseClear!: () => void;
      const clearPending = new Promise<void>(resolve => {
        releaseClear = resolve;
      });
      const payloads: Record<string, unknown>[] = [];
      mockSet = async items => {
        payloads.push(items);
        Object.assign(mockKvStore, items);
        if (items[BG_SETTINGS_MIRRORED_KEY] === false && Object.keys(items).length === 1) {
          await clearPending;
        }
      };
      try {
        mirrorBackgroundSettings();
        expect(payloads[0]).toEqual({ [BG_SETTINGS_MIRRORED_KEY]: false });
        if (readFails) {
          Object.defineProperty(window, 'localStorage', { configurable: true, value: null });
        } else {
          setAutoConsumeSetting(false);
          await setTelemetrySetting(false);
        }
        releaseClear();
        await nextTask();
        const expectedBatch = readFails
          ? undefined
          : {
              [BG_SETTINGS_MIRRORED_KEY]: true
            };
        expect(payloads.find(items => items[BG_SETTINGS_MIRRORED_KEY] === true)).toEqual(expectedBatch);
        const preferencePayloads = payloads.filter(
          items =>
            AUTO_CONSUME_STORAGE_KEY in items || DELEGATE_PROOF_STORAGE_KEY in items || TELEMETRY_STORAGE_KEY in items
        );
        const expectedPreferencePayloads = readFails
          ? []
          : [
              { [AUTO_CONSUME_STORAGE_KEY]: false },
              { [DELEGATE_PROOF_STORAGE_KEY]: true },
              { [TELEMETRY_STORAGE_KEY]: false }
            ];
        expect(preferencePayloads).toEqual(expect.arrayContaining(expectedPreferencePayloads));
        expect(preferencePayloads).toHaveLength(readFails ? 0 : 5);
        expect(payloads.filter(items => AUTO_CONSUME_STORAGE_KEY in items)).toHaveLength(readFails ? 0 : 2);
        expect(mockKvStore[AUTO_CONSUME_STORAGE_KEY]).toBe(readFails ? undefined : false);
        expect(mockKvStore[TELEMETRY_STORAGE_KEY]).toBe(readFails ? undefined : false);
        expect(mockKvStore[BG_SETTINGS_MIRRORED_KEY]).toBe(!readFails);
        expect(await areBackgroundSettingsMirrored()).toBe(!readFails);
        expect((await areBackgroundSettingsMirrored()) && (await isAutoConsumeEnabledAsync())).toBe(false);
        expect(await isTelemetryEnabledAsync()).toBe(false);
      } finally {
        releaseClear();
        if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      }
    });
  });

  describe('in-flight background settings copies', () => {
    it('does not restore telemetry from an older copy after a newer copy fails', async () => {
      for (const key of [AUTO_CONSUME_STORAGE_KEY, DELEGATE_PROOF_STORAGE_KEY, TELEMETRY_STORAGE_KEY]) {
        localStorage.setItem(key, 'true');
      }
      let releaseCopy!: () => void;
      const copyPending = new Promise<void>(resolve => {
        releaseCopy = resolve;
      });
      let signalPaused!: () => void;
      const copyPaused = new Promise<void>(resolve => {
        signalPaused = resolve;
      });
      let parked = false;
      let clears = 0;
      mockSet = async items => {
        if (items[BG_SETTINGS_MIRRORED_KEY] === false && ++clears === 2) {
          throw new Error('Newer copy cannot clear its marker');
        }
        if (!parked && items[DELEGATE_PROOF_STORAGE_KEY] === true) {
          parked = true;
          signalPaused();
          await copyPending;
        }
        Object.assign(mockKvStore, items);
      };

      try {
        mirrorBackgroundSettings();
        await copyPaused;
        await setTelemetrySetting(false);
        expect(await isTelemetryEnabledAsync()).toBe(false);
        mirrorBackgroundSettings();
        releaseCopy();
        await nextTask();
        expect(await isTelemetryEnabledAsync()).toBe(false);
        expect(await areBackgroundSettingsMirrored()).toBe(false);
      } finally {
        releaseCopy();
      }
    });

    it('does not apply an older telemetry write after a completed opt-out of that key', async () => {
      for (const key of [AUTO_CONSUME_STORAGE_KEY, DELEGATE_PROOF_STORAGE_KEY, TELEMETRY_STORAGE_KEY]) {
        localStorage.setItem(key, 'true');
      }
      let releaseWrite!: () => void;
      const writePending = new Promise<void>(resolve => {
        releaseWrite = resolve;
      });
      let signalPaused!: () => void;
      const writePaused = new Promise<void>(resolve => {
        signalPaused = resolve;
      });
      let parked = false;
      mockSet = async items => {
        if (!parked && items[TELEMETRY_STORAGE_KEY] === true) {
          parked = true;
          signalPaused();
          await writePending;
        }
        Object.assign(mockKvStore, items);
      };

      try {
        mirrorBackgroundSettings();
        await writePaused;
        let completedDuringPark = false;
        const optOut = setTelemetrySetting(false).then(() => {
          completedDuringPark = true;
        });
        await nextTask();
        const completedConsent = completedDuringPark && (await isTelemetryEnabledAsync());
        expect(completedConsent).toBe(false);
        releaseWrite();
        await optOut;
        expect(await isTelemetryEnabledAsync()).toBe(false);
        expect(mockKvStore[TELEMETRY_STORAGE_KEY]).toBe(false);
      } finally {
        releaseWrite();
      }
    });

    it('a rejected telemetry copy does not block a later opt-out', async () => {
      for (const key of [AUTO_CONSUME_STORAGE_KEY, DELEGATE_PROOF_STORAGE_KEY, TELEMETRY_STORAGE_KEY]) {
        localStorage.setItem(key, 'true');
      }
      mockSet = async items => {
        if (items[TELEMETRY_STORAGE_KEY] === true) throw new Error('Telemetry copy unavailable');
        Object.assign(mockKvStore, items);
      };
      mirrorBackgroundSettings();
      await nextTask();
      expect(await areBackgroundSettingsMirrored()).toBe(false);
      await setTelemetrySetting(false);
      expect(await isTelemetryEnabledAsync()).toBe(false);
    });
  });

  describe('haptic feedback setting', () => {
    it('returns default value when not set', () => {
      expect(isHapticFeedbackEnabled()).toBe(DEFAULT_HAPTIC_FEEDBACK);
    });

    it('sets and gets true value', () => {
      setHapticFeedbackSetting(true);
      expect(isHapticFeedbackEnabled()).toBe(true);
      expect(localStorage.getItem(HAPTIC_FEEDBACK_STORAGE_KEY)).toBe('true');
    });

    it('sets and gets false value', () => {
      setHapticFeedbackSetting(false);
      expect(isHapticFeedbackEnabled()).toBe(false);
      expect(localStorage.getItem(HAPTIC_FEEDBACK_STORAGE_KEY)).toBe('false');
    });
  });

  describe('theme setting', () => {
    it('returns default theme (system) when not set', () => {
      expect(getThemeSetting()).toBe('system');
    });

    it('sets and gets dark theme', () => {
      setThemeSetting('dark');
      expect(getThemeSetting()).toBe('dark');
    });

    it('sets and gets light theme', () => {
      setThemeSetting('light');
      expect(getThemeSetting()).toBe('light');
    });

    it('sets and gets system theme', () => {
      setThemeSetting('system');
      expect(getThemeSetting()).toBe('system');
    });

    it('returns default when stored value is invalid', () => {
      localStorage.setItem('theme_setting', 'invalid');
      expect(getThemeSetting()).toBe('system');
    });

    it('handles localStorage error in getThemeSetting', () => {
      const originalGetItem = localStorage.getItem;
      localStorage.getItem = () => {
        throw new Error('Storage error');
      };
      expect(getThemeSetting()).toBe('system');
      localStorage.getItem = originalGetItem;
    });

    it('handles localStorage error in setThemeSetting', () => {
      const originalSetItem = localStorage.setItem;
      localStorage.setItem = () => {
        throw new Error('Storage full');
      };
      expect(() => setThemeSetting('dark')).not.toThrow();
      localStorage.setItem = originalSetItem;
    });
  });

  describe('error handling', () => {
    it('handles localStorage errors gracefully on set', () => {
      const originalSetItem = localStorage.setItem;
      localStorage.setItem = () => {
        throw new Error('Storage full');
      };

      // Should not throw
      expect(() => setDelegateProofSetting(true)).not.toThrow();

      localStorage.setItem = originalSetItem;
    });
  });
});

describe('telemetry consent setting', () => {
  afterEach(() => {
    localStorage.clear();
    for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
  });

  it('is off on a fresh install', () => {
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('reports no choice made on a fresh install', () => {
    expect(hasTelemetryChoice()).toBe(false);
  });

  it('reports a choice once the user turns it on', () => {
    setTelemetrySetting(true);
    expect(hasTelemetryChoice()).toBe(true);
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('reports a choice once the user explicitly turns it off', () => {
    setTelemetrySetting(false);
    expect(hasTelemetryChoice()).toBe(true);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('persists under the documented key', () => {
    setTelemetrySetting(true);
    expect(localStorage.getItem(TELEMETRY_STORAGE_KEY)).toBe('true');
  });

  it('resolves false from the background mirror on a read miss', async () => {
    await expect(isTelemetryEnabledAsync()).resolves.toBe(false);
  });

  it('permits crash reporting before a usage-sharing choice is stored', async () => {
    await expect(isCrashReportingEnabledAsync()).resolves.toBe(true);
    await expect(isTelemetryEnabledAsync()).resolves.toBe(false);
  });

  it('keeps crash reporting enabled after usage sharing is explicitly disabled', async () => {
    await setTelemetrySetting(false);

    await expect(isCrashReportingEnabledAsync()).resolves.toBe(true);
    await expect(isTelemetryEnabledAsync()).resolves.toBe(false);
  });

  it('does not read the usage-sharing mirror to permit crash reporting', async () => {
    mockStorageThrows = true;
    try {
      await expect(isCrashReportingEnabledAsync()).resolves.toBe(true);
      await expect(isTelemetryEnabledAsync()).resolves.toBe(false);
    } finally {
      mockStorageThrows = false;
    }
  });
});
