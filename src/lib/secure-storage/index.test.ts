/**
 * Unit tests for the unified, platform-agnostic secure-storage facade.
 *
 * The module under test:
 * - statically imports `isDesktop` / `isMobile` from `lib/platform` and calls
 *   them live inside `getSecureStorage()` / `isSecureStorageAvailable()`.
 * - lazy-imports `lib/desktop/secure-storage` inside every `DesktopSecureStorage`
 *   method and inside `isSecureStorageAvailable()`.
 * - keeps module-level singletons (`desktopStorage` / `mobileStorage`).
 *
 * To exercise the singleton create/reuse branches and to make the dynamic
 * `import('lib/desktop/secure-storage')` throw for the catch path, we follow the
 * sibling `lib/desktop/secure-storage.test.ts` idiom: `jest.resetModules()` +
 * `jest.doMock()` + `require()` for a fresh module (and fresh singletons) per
 * scenario.
 */

type IndexModule = typeof import('./index');

interface DesktopMock {
  isHardwareSecurityAvailable: jest.Mock;
  hasHardwareKey: jest.Mock;
  generateHardwareKey: jest.Mock;
  encryptWithHardwareKey: jest.Mock;
  decryptWithHardwareKey: jest.Mock;
  deleteHardwareKey: jest.Mock;
}

interface LoadOptions {
  isDesktop?: boolean;
  isMobile?: boolean;
  /** When true, the dynamic import of `lib/desktop/secure-storage` throws. */
  desktopImportThrows?: boolean;
  /** Overrides for individual desktop-bridge functions. */
  desktop?: Partial<DesktopMock>;
}

interface LoadResult {
  mod: IndexModule;
  desktopMock: DesktopMock;
  isDesktopMock: jest.Mock;
  isMobileMock: jest.Mock;
}

/**
 * Loads a fresh copy of the module (resetting its `desktopStorage` /
 * `mobileStorage` singletons) with `lib/platform` and the desktop bridge stubbed.
 */
function loadModule(opts: LoadOptions = {}): LoadResult {
  const { isDesktop = false, isMobile = false, desktopImportThrows = false, desktop = {} } = opts;

  jest.resetModules();

  const isDesktopMock = jest.fn(() => isDesktop);
  const isMobileMock = jest.fn(() => isMobile);

  jest.doMock('lib/platform', () => ({
    isDesktop: isDesktopMock,
    isMobile: isMobileMock
  }));

  const desktopMock: DesktopMock = {
    isHardwareSecurityAvailable: jest.fn().mockResolvedValue(false),
    hasHardwareKey: jest.fn().mockResolvedValue(false),
    generateHardwareKey: jest.fn().mockResolvedValue(undefined),
    encryptWithHardwareKey: jest.fn().mockResolvedValue(''),
    decryptWithHardwareKey: jest.fn().mockResolvedValue(''),
    deleteHardwareKey: jest.fn().mockResolvedValue(undefined),
    ...desktop
  };

  jest.doMock('lib/desktop/secure-storage', () => {
    if (desktopImportThrows) {
      throw new Error('desktop secure-storage import failed');
    }
    return desktopMock;
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./index') as IndexModule;
  return { mod, desktopMock, isDesktopMock, isMobileMock };
}

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('secure-storage facade', () => {
  describe('getSecureStorage — desktop', () => {
    it('returns the desktop storage instance when hardware security is available', async () => {
      const { mod, desktopMock } = loadModule({
        isDesktop: true,
        desktop: { isHardwareSecurityAvailable: jest.fn().mockResolvedValue(true) }
      });

      const storage = await mod.getSecureStorage();

      expect(storage).not.toBeNull();
      expect(desktopMock.isHardwareSecurityAvailable).toHaveBeenCalledTimes(1);
    });

    it('returns null when hardware security is unavailable (falsy ternary branch)', async () => {
      const { mod, desktopMock } = loadModule({
        isDesktop: true,
        desktop: { isHardwareSecurityAvailable: jest.fn().mockResolvedValue(false) }
      });

      const storage = await mod.getSecureStorage();

      expect(storage).toBeNull();
      expect(desktopMock.isHardwareSecurityAvailable).toHaveBeenCalledTimes(1);
    });

    it('reuses the cached desktop singleton on subsequent calls', async () => {
      const { mod } = loadModule({
        isDesktop: true,
        desktop: { isHardwareSecurityAvailable: jest.fn().mockResolvedValue(true) }
      });

      const first = await mod.getSecureStorage();
      const second = await mod.getSecureStorage();

      expect(first).not.toBeNull();
      // Same reference proves the `if (!desktopStorage)` create branch ran once
      // and the reuse branch ran on the second call.
      expect(second).toBe(first);
    });
  });

  describe('getSecureStorage — mobile', () => {
    it('creates the mobile singleton but returns null (mobile storage never available)', async () => {
      const { mod, isMobileMock } = loadModule({ isDesktop: false, isMobile: true });

      const storage = await mod.getSecureStorage();

      expect(storage).toBeNull();
      expect(isMobileMock).toHaveBeenCalled();
    });

    it('reuses the cached mobile singleton on subsequent calls', async () => {
      const { mod } = loadModule({ isDesktop: false, isMobile: true });

      const first = await mod.getSecureStorage();
      const second = await mod.getSecureStorage();

      expect(first).toBeNull();
      expect(second).toBeNull();
    });
  });

  describe('getSecureStorage — browser extension / web', () => {
    it('returns null when neither desktop nor mobile', async () => {
      const { mod } = loadModule({ isDesktop: false, isMobile: false });

      await expect(mod.getSecureStorage()).resolves.toBeNull();
    });
  });

  describe('DesktopSecureStorage instance methods', () => {
    async function getDesktopInstance(desktop: Partial<DesktopMock>) {
      const loaded = loadModule({
        isDesktop: true,
        desktop: {
          isHardwareSecurityAvailable: jest.fn().mockResolvedValue(true),
          ...desktop
        }
      });
      const storage = await loaded.mod.getSecureStorage();
      expect(storage).not.toBeNull();
      return { storage: storage!, desktopMock: loaded.desktopMock };
    }

    it('isAvailable forwards to isHardwareSecurityAvailable', async () => {
      const { storage, desktopMock } = await getDesktopInstance({
        isHardwareSecurityAvailable: jest.fn().mockResolvedValue(true)
      });
      desktopMock.isHardwareSecurityAvailable.mockClear();

      await expect(storage.isAvailable()).resolves.toBe(true);
      expect(desktopMock.isHardwareSecurityAvailable).toHaveBeenCalledTimes(1);
    });

    it('hasKey forwards to hasHardwareKey', async () => {
      const { storage, desktopMock } = await getDesktopInstance({
        hasHardwareKey: jest.fn().mockResolvedValue(true)
      });

      await expect(storage.hasKey()).resolves.toBe(true);
      expect(desktopMock.hasHardwareKey).toHaveBeenCalledTimes(1);
    });

    it('generateKey delegates to generateHardwareKey and resolves to undefined', async () => {
      const { storage, desktopMock } = await getDesktopInstance({
        generateHardwareKey: jest.fn().mockResolvedValue('ignored')
      });

      await expect(storage.generateKey()).resolves.toBeUndefined();
      expect(desktopMock.generateHardwareKey).toHaveBeenCalledTimes(1);
    });

    it('encrypt passes the plaintext through and returns the ciphertext', async () => {
      const { storage, desktopMock } = await getDesktopInstance({
        encryptWithHardwareKey: jest.fn().mockResolvedValue('base64-cipher')
      });

      await expect(storage.encrypt('secret-plaintext')).resolves.toBe('base64-cipher');
      expect(desktopMock.encryptWithHardwareKey).toHaveBeenCalledWith('secret-plaintext');
    });

    it('decrypt passes the ciphertext through and returns the plaintext', async () => {
      const { storage, desktopMock } = await getDesktopInstance({
        decryptWithHardwareKey: jest.fn().mockResolvedValue('secret-plaintext')
      });

      await expect(storage.decrypt('base64-cipher')).resolves.toBe('secret-plaintext');
      expect(desktopMock.decryptWithHardwareKey).toHaveBeenCalledWith('base64-cipher');
    });

    it('deleteKey delegates to deleteHardwareKey and resolves to undefined', async () => {
      const { storage, desktopMock } = await getDesktopInstance({
        deleteHardwareKey: jest.fn().mockResolvedValue('ignored')
      });

      await expect(storage.deleteKey()).resolves.toBeUndefined();
      expect(desktopMock.deleteHardwareKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('isSecureStorageAvailable', () => {
    it('returns true on desktop when the native bridge reports availability', async () => {
      const { mod, desktopMock } = loadModule({
        isDesktop: true,
        desktop: { isHardwareSecurityAvailable: jest.fn().mockResolvedValue(true) }
      });

      await expect(mod.isSecureStorageAvailable()).resolves.toBe(true);
      expect(desktopMock.isHardwareSecurityAvailable).toHaveBeenCalledTimes(1);
    });

    it('returns false on desktop when the native bridge reports unavailability', async () => {
      const { mod } = loadModule({
        isDesktop: true,
        desktop: { isHardwareSecurityAvailable: jest.fn().mockResolvedValue(false) }
      });

      await expect(mod.isSecureStorageAvailable()).resolves.toBe(false);
    });

    it('swallows errors and returns false when the desktop import throws', async () => {
      const { mod } = loadModule({ isDesktop: true, desktopImportThrows: true });

      await expect(mod.isSecureStorageAvailable()).resolves.toBe(false);
    });

    it('returns false on mobile (not yet implemented)', async () => {
      const { mod } = loadModule({ isDesktop: false, isMobile: true });

      await expect(mod.isSecureStorageAvailable()).resolves.toBe(false);
    });

    it('returns false on browser extension / web', async () => {
      const { mod } = loadModule({ isDesktop: false, isMobile: false });

      await expect(mod.isSecureStorageAvailable()).resolves.toBe(false);
    });
  });
});
