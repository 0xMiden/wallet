import { isDesktop, isExtension, isMobile } from './index';

/**
 * Storage provider interface that abstracts browser.storage.local
 * for cross-platform compatibility.
 *
 * Note: Capacitor Preferences is imported lazily to avoid 'window is not defined'
 * errors in service worker contexts.
 */
export interface StorageProvider {
  get(keys: string[]): Promise<Record<string, any>>;
  set(items: Record<string, any>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/**
 * Desktop storage implementation using localStorage
 * Works in Tauri webview context
 */
export class DesktopStorage implements StorageProvider {
  private prefix = 'miden_wallet_';

  async get(keys: string[]): Promise<Record<string, any>> {
    const result: Record<string, any> = {};
    for (const key of keys) {
      const value = localStorage.getItem(this.prefix + key);
      if (value !== null) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          // If it's not JSON, store as-is
          result[key] = value;
        }
      }
    }
    return result;
  }

  async set(items: Record<string, any>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      localStorage.setItem(this.prefix + key, serialized);
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      localStorage.removeItem(this.prefix + key);
    }
  }
}

/**
 * Browser extension storage implementation using browser.storage.local
 */
export class ExtensionStorage implements StorageProvider {
  async get(keys: string[]): Promise<Record<string, any>> {
    const browser = await import('webextension-polyfill').then(m => m.default);
    return browser.storage.local.get(keys);
  }

  async set(items: Record<string, any>): Promise<void> {
    const browser = await import('webextension-polyfill').then(m => m.default);
    await browser.storage.local.set(items);
  }

  async remove(keys: string[]): Promise<void> {
    const browser = await import('webextension-polyfill').then(m => m.default);
    await browser.storage.local.remove(keys);
  }
}

// Lazy-load Capacitor Preferences using require() to avoid:
// 1. window errors in service workers (static import would bundle it)
// 2. Android issues with dynamic import()
function getPreferences(): typeof import('@capacitor/preferences').Preferences {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@capacitor/preferences').Preferences;
}

/**
 * Capacitor storage implementation using @capacitor/preferences
 */
export class CapacitorStorage implements StorageProvider {
  async get(keys: string[]): Promise<Record<string, any>> {
    const Preferences = getPreferences();
    const result: Record<string, any> = {};
    for (const key of keys) {
      const { value } = await Preferences.get({ key });
      if (value !== null) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          // If it's not JSON, store as-is
          result[key] = value;
        }
      }
    }
    return result;
  }

  async set(items: Record<string, any>): Promise<void> {
    const Preferences = getPreferences();
    for (const [key, value] of Object.entries(items)) {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      await Preferences.set({ key, value: serialized });
    }
  }

  async remove(keys: string[]): Promise<void> {
    const Preferences = getPreferences();
    for (const key of keys) {
      await Preferences.remove({ key });
    }
  }
}

// Singleton instances
let extensionStorage: ExtensionStorage | null = null;
let capacitorStorage: CapacitorStorage | null = null;
let desktopStorage: DesktopStorage | null = null;

/**
 * Gets the appropriate storage provider based on the current platform.
 *
 * IMPORTANT: Platform detection is checked on every call (not cached) because
 * Tauri may inject its globals after initial script execution. The provider
 * instances are cached, but the platform selection is always re-evaluated.
 */
export function getStorageProvider(): StorageProvider {
  const mobile = isMobile();
  const desktop = isDesktop();
  const extension = isExtension();

  // Extra safety: direct check for Tauri globals
  const hasTauriGlobal = typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

  // Check mobile first (Capacitor)
  if (mobile) {
    if (!capacitorStorage) {
      capacitorStorage = new CapacitorStorage();
    }
    return capacitorStorage;
  }

  // Check desktop (Tauri) - use DesktopStorage if either isDesktop() or Tauri globals present
  // This handles timing issues where Tauri injects globals after script starts
  if (desktop || hasTauriGlobal) {
    if (!desktopStorage) {
      desktopStorage = new DesktopStorage();
    }
    return desktopStorage;
  }

  // Check if we're actually in an extension context before using ExtensionStorage
  // This prevents using webextension-polyfill in non-extension contexts
  if (extension) {
    if (!extensionStorage) {
      extensionStorage = new ExtensionStorage();
    }
    return extensionStorage;
  }

  // Fallback: use DesktopStorage (localStorage) for any other context
  // This handles cases where platform detection fails or we're in a web context
  if (!desktopStorage) {
    desktopStorage = new DesktopStorage();
  }
  return desktopStorage;
}

export default getStorageProvider;
