import semver from 'semver';

import { isAndroid, isDesktop, isExtension, isIOS, isMobile } from 'lib/platform';
import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';

import { UpdateController } from './controller';
import { CHROME_UPDATE_AVAILABLE_MESSAGE } from './events';
import { UpdateDismissalStore } from './storage';
import type { UpdateAvailability, UpdateAvailabilityAdapter, UpdateNotice } from './types';

export const RELEASE_MANIFEST_URL = 'https://raw.githubusercontent.com/0xMiden/wallet/main/updates/manifest.json';
const E2E_UPDATE_STORAGE_KEY = '__miden_e2e_update__';

interface RuntimeController {
  check(options?: { force?: boolean }): Promise<UpdateNotice | null>;
  invalidate(): void;
}

interface RuntimeDismissals {
  isDismissed(platform: UpdateNotice['platform'], availableVersion: string): Promise<boolean>;
  dismiss(platform: UpdateNotice['platform'], availableVersion: string): Promise<void>;
}

export interface UpdateNotificationRuntime {
  controller: RuntimeController;
  dismissals: RuntimeDismissals;
  subscribe(listener: () => void): Promise<() => void> | (() => void);
}

interface ManifestResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

interface RuntimeDependencies {
  createAdapter(): Promise<UpdateAvailabilityAdapter>;
  storage: StorageProvider;
  fetchManifest(input: string, init: { cache: 'no-store'; headers: { Accept: string } }): Promise<ManifestResponse>;
  subscribe(listener: () => void): Promise<() => void> | (() => void);
}

export class E2EUpdateAdapter implements UpdateAvailabilityAdapter {
  constructor(readonly platform: UpdateNotice['platform']) {}

  async check(): Promise<UpdateAvailability> {
    // Vite replaces this condition with false in production and removes the
    // test-only global path from shipped bundles.
    if (process.env.MIDEN_E2E_TEST !== 'true') return { status: 'unknown' };
    const injected = getE2EUpdateInjection();
    if (injected?.platform !== this.platform) return { status: 'unknown' };
    if (!semver.valid(injected.currentVersion) || !semver.valid(injected.availableVersion)) {
      return { status: 'unknown' };
    }
    if (!semver.gt(injected.availableVersion, injected.currentVersion)) {
      return { status: 'none', currentVersion: injected.currentVersion };
    }
    return {
      status: 'available',
      currentVersion: injected.currentVersion,
      availableVersion: injected.availableVersion,
      action: async () => {
        window.dispatchEvent(new CustomEvent('miden:e2e-update-action', { detail: { platform: this.platform } }));
      }
    };
  }
}

export async function createUpdateNotificationRuntime(
  dependencies: Partial<RuntimeDependencies> = {}
): Promise<UpdateNotificationRuntime> {
  const createAdapter = dependencies.createAdapter ?? createDefaultAdapter;
  const storage = dependencies.storage ?? getStorageProvider();
  const fetchManifest = dependencies.fetchManifest ?? ((input, init) => fetch(input, init));
  const subscribe = dependencies.subscribe ?? subscribeToRuntimeUpdates;
  const adapter = await createAdapter();
  const loadManifest = async (): Promise<unknown> => {
    // Test builds use an in-memory catalog so platform E2E never depends on a
    // public store or a just-merged raw GitHub file.
    const injected = getE2EPresentationManifest();
    if (injected) return injected;
    const response = await fetchManifest(RELEASE_MANIFEST_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Update manifest request failed');
    return response.json();
  };

  return {
    controller: new UpdateController({ adapter, loadManifest }),
    dismissals: new UpdateDismissalStore(storage),
    subscribe
  };
}

export async function createDefaultAdapter(): Promise<UpdateAvailabilityAdapter> {
  if (process.env.MIDEN_E2E_TEST === 'true') {
    if (isAndroid()) return new E2EUpdateAdapter('android');
    if (isIOS()) return new E2EUpdateAdapter('ios');
    if (isExtension() && process.env.TARGET_BROWSER === 'chrome') return new E2EUpdateAdapter('chrome');
  }
  if (isAndroid()) return new (await import('./android')).AndroidUpdateAdapter();
  if (isIOS()) return new (await import('./ios')).IOSUpdateAdapter();
  if (isExtension() && process.env.TARGET_BROWSER === 'chrome') {
    return new (await import('./chrome')).ChromeUpdateAdapter();
  }
  // Desktop and unrecognized web runtimes share the explicit silent boundary.
  // Neither can inherit another platform's authoritative signal.
  if (isDesktop()) return new (await import('./desktop')).DesktopUpdateAdapter();
  return new (await import('./desktop')).DesktopUpdateAdapter();
}

function getE2EPresentationManifest(): unknown | null {
  const injected = getE2EUpdateInjection();
  if (!injected) return null;
  if (injected.summary === undefined) return { schemaVersion: 1, releases: [] };
  const platformMetadata =
    injected.platform === 'android'
      ? {
          version: injected.availableVersion,
          versionCode: androidVersionCode(injected.availableVersion)
        }
      : { version: injected.availableVersion };
  return {
    schemaVersion: 1,
    releases: [
      {
        version: injected.availableVersion,
        summary: injected.summary,
        urgency: injected.urgency ?? 'normal',
        platforms: { [injected.platform]: platformMetadata }
      }
    ]
  };
}

function getE2EUpdateInjection(): NonNullable<typeof window.__MIDEN_E2E_UPDATE__> | null {
  if (process.env.MIDEN_E2E_TEST !== 'true') return null;
  if (window.__MIDEN_E2E_UPDATE__) return window.__MIDEN_E2E_UPDATE__;
  try {
    const value = window.sessionStorage.getItem(E2E_UPDATE_STORAGE_KEY);
    return value ? (JSON.parse(value) as NonNullable<typeof window.__MIDEN_E2E_UPDATE__>) : null;
  } catch {
    return null;
  }
}

function androidVersionCode(version: string): number {
  const parsed = semver.parse(version)!;
  return parsed.major * 10_000_000 + parsed.minor * 100_000 + parsed.patch * 1_000 + 1;
}

export async function subscribeToRuntimeUpdates(listener: () => void): Promise<() => void> {
  const cleanups: Array<() => void> = [];
  const onVisibility = () => {
    if (document.visibilityState === 'visible') listener();
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  if (isMobile()) {
    try {
      const { App } = await import('@capacitor/app');
      const handle = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) listener();
      });
      cleanups.push(() => void handle.remove());
    } catch {
      // Visibility changes still provide a foreground retry when the native listener is unavailable.
    }
  }

  if (isExtension() && process.env.TARGET_BROWSER === 'chrome') {
    try {
      const browser = await import('webextension-polyfill').then(module => module.default);
      const onMessage = (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === CHROME_UPDATE_AVAILABLE_MESSAGE
        ) {
          listener();
        }
      };
      browser.runtime.onMessage.addListener(onMessage);
      cleanups.push(() => browser.runtime.onMessage.removeListener(onMessage));
    } catch {
      // A closed extension surface needs no notification listener.
    }
  }

  return () => cleanups.forEach(cleanup => cleanup());
}
