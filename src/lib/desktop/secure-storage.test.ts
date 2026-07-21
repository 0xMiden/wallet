/**
 * Unit tests for the Tauri hardware-backed secure storage bridge.
 *
 * The module under test:
 * - imports `isDesktop` from `lib/platform`, which reads `window.__TAURI__`
 *   live on every call — so we toggle desktop-ness by setting/deleting that
 *   global rather than mocking the platform module.
 * - lazy-imports `@tauri-apps/api/core` and memoises the `invoke` function in
 *   a module-level cache — so we `jest.resetModules()` + `jest.doMock()` +
 *   `require()` for a fresh module (and fresh cache) per scenario.
 */

// This file uses only dynamic `require()`/`typeof import()` and has no other
// top-level import/export, so mark it as an ES module explicitly. Without this,
// TypeScript treats the file as a global script: its top-level helpers collide
// with same-named globals in other script-mode test files, and the crossed
// global `SecureStorageModule` type mis-resolves `./secure-storage`.
// eslint-disable-next-line jest/no-export -- module marker, exports nothing testable
export {};

// Marks the jsdom window as a Tauri context so `isDesktop()` returns true.
function setDesktop(): void {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
}

function unsetDesktop(): void {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

type SecureStorageModule = typeof import('./secure-storage');

interface LoadOptions {
  desktop?: boolean;
  invoke?: jest.Mock;
  /** When true, the dynamic import of `@tauri-apps/api/core` throws. */
  importThrows?: boolean;
}

/**
 * Loads a fresh copy of the module (resetting its lazy `tauriInvoke` cache)
 * with the Tauri `invoke` function stubbed and the desktop flag configured.
 */
function loadModule(opts: LoadOptions = {}): { mod: SecureStorageModule; invoke: jest.Mock } {
  const { desktop = true, invoke = jest.fn().mockResolvedValue(undefined), importThrows = false } = opts;

  jest.resetModules();

  if (desktop) {
    setDesktop();
  } else {
    unsetDesktop();
  }

  jest.doMock('@tauri-apps/api/core', () => {
    if (importThrows) {
      throw new Error('tauri core import failed');
    }
    return { invoke };
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./secure-storage') as SecureStorageModule;
  return { mod, invoke };
}

afterEach(() => {
  unsetDesktop();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('secure-storage', () => {
  describe('isHardwareSecurityAvailable', () => {
    it('returns false immediately when not running on desktop (never invokes)', async () => {
      const invoke = jest.fn();
      const { mod } = loadModule({ desktop: false, invoke });

      await expect(mod.isHardwareSecurityAvailable()).resolves.toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    });

    it('returns true when the native bridge reports availability', async () => {
      const invoke = jest.fn().mockResolvedValue(true);
      const { mod } = loadModule({ desktop: true, invoke });

      await expect(mod.isHardwareSecurityAvailable()).resolves.toBe(true);
      expect(invoke).toHaveBeenCalledWith('is_hardware_security_available');
    });

    it('returns false when the native bridge reports unavailability', async () => {
      const invoke = jest.fn().mockResolvedValue(false);
      const { mod } = loadModule({ desktop: true, invoke });

      await expect(mod.isHardwareSecurityAvailable()).resolves.toBe(false);
      expect(invoke).toHaveBeenCalledWith('is_hardware_security_available');
    });

    it('swallows errors and returns false when acquiring the invoke bridge throws', async () => {
      // Desktop is true (so we pass the early guard) but the Tauri core import
      // throws inside `getInvoke()`, which is awaited -> caught -> false.
      const { mod } = loadModule({ desktop: true, importThrows: true });

      await expect(mod.isHardwareSecurityAvailable()).resolves.toBe(false);
    });
  });

  describe('hasHardwareKey', () => {
    it('forwards the native boolean result', async () => {
      const invoke = jest.fn().mockResolvedValue(true);
      const { mod } = loadModule({ desktop: true, invoke });

      await expect(mod.hasHardwareKey()).resolves.toBe(true);
      expect(invoke).toHaveBeenCalledWith('has_hardware_key');
    });

    it('rejects when called outside of the desktop app', async () => {
      const { mod } = loadModule({ desktop: false });

      await expect(mod.hasHardwareKey()).rejects.toThrow('Secure storage operations are only available in desktop app');
    });
  });

  describe('generateHardwareKey', () => {
    it('invokes the generate command and resolves to undefined', async () => {
      const invoke = jest.fn().mockResolvedValue('ignored-return-value');
      const { mod } = loadModule({ desktop: true, invoke });

      await expect(mod.generateHardwareKey()).resolves.toBeUndefined();
      expect(invoke).toHaveBeenCalledWith('generate_hardware_key');
    });
  });

  describe('encryptWithHardwareKey', () => {
    it('passes the data through and returns the base64 ciphertext', async () => {
      const invoke = jest.fn().mockResolvedValue('base64-cipher');
      const { mod } = loadModule({ desktop: true, invoke });

      await expect(mod.encryptWithHardwareKey('secret-plaintext')).resolves.toBe('base64-cipher');
      expect(invoke).toHaveBeenCalledWith('encrypt_with_hardware_key', { data: 'secret-plaintext' });
    });
  });

  describe('decryptWithHardwareKey', () => {
    it('passes the ciphertext through and returns the plaintext', async () => {
      const invoke = jest.fn().mockResolvedValue('secret-plaintext');
      const { mod } = loadModule({ desktop: true, invoke });

      await expect(mod.decryptWithHardwareKey('base64-cipher')).resolves.toBe('secret-plaintext');
      expect(invoke).toHaveBeenCalledWith('decrypt_with_hardware_key', { encrypted: 'base64-cipher' });
    });
  });

  describe('deleteHardwareKey', () => {
    it('invokes the delete command and resolves to undefined', async () => {
      const invoke = jest.fn().mockResolvedValue('ignored-return-value');
      const { mod } = loadModule({ desktop: true, invoke });

      await expect(mod.deleteHardwareKey()).resolves.toBeUndefined();
      expect(invoke).toHaveBeenCalledWith('delete_hardware_key');
    });
  });

  describe('tauriLog', () => {
    it('forwards the message to the native js_log command on desktop', async () => {
      const invoke = jest.fn().mockResolvedValue(undefined);
      const { mod } = loadModule({ desktop: true, invoke });
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await mod.tauriLog('hello from js');

      expect(invoke).toHaveBeenCalledWith('js_log', { message: 'hello from js' });
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('falls back to console.log when the Tauri bridge is unavailable', async () => {
      const { mod } = loadModule({ desktop: false });
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(mod.tauriLog('fallback message')).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith('fallback message');
    });

    it('falls back to console.log when the native invoke rejects', async () => {
      const invoke = jest.fn().mockRejectedValue(new Error('native boom'));
      const { mod } = loadModule({ desktop: true, invoke });
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await mod.tauriLog('rejected message');

      expect(invoke).toHaveBeenCalledWith('js_log', { message: 'rejected message' });
      expect(consoleSpy).toHaveBeenCalledWith('rejected message');
    });
  });

  describe('getInvoke caching', () => {
    it('reuses the memoised invoke on subsequent calls without re-checking the platform', async () => {
      // First call runs while desktop -> imports & caches `invoke`.
      const invoke = jest.fn().mockResolvedValue(true);
      const { mod } = loadModule({ desktop: true, invoke });

      await expect(mod.hasHardwareKey()).resolves.toBe(true);
      expect(invoke).toHaveBeenCalledTimes(1);

      // Now leave the desktop context. Because `tauriInvoke` is already cached,
      // `getInvoke()` short-circuits and never re-evaluates `isDesktop()`, so
      // the second call still succeeds instead of throwing.
      unsetDesktop();

      await expect(mod.hasHardwareKey()).resolves.toBe(true);
      expect(invoke).toHaveBeenCalledTimes(2);
    });
  });
});
