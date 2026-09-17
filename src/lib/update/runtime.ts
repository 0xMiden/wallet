import semver from 'semver';

import { isAndroid, isExtension, isIOS, isMobile } from 'lib/platform';
import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';

import { UpdateController } from './controller';
import { CHROME_UPDATE_AVAILABLE_MESSAGE } from './events';
import { parseUpdateManifest } from './manifest';
import { UpdateDismissalStore } from './storage';
import type {
  UpdateAvailability,
  UpdateAvailabilityAdapter,
  UpdateCheckResult,
  UpdateNotice,
  UpdateRefreshReason
} from './types';

export const RELEASE_MANIFEST_URL = 'https://raw.githubusercontent.com/0xMiden/wallet/main/updates/manifest.json';
const E2E_UPDATE_STORAGE_KEY = '__miden_e2e_update__';
const MANIFEST_CACHE_KEY = 'update_manifest_cache_v1';
// The extension popup is a new realm on every open, so an in-memory cache would
// refetch the catalog each time an update is pending. This is the same window
// the controller caches a result for.
const MANIFEST_CACHE_MS = 6 * 60 * 60 * 1_000;
// The controller's deadline abandons a slow catalog read but cannot cancel it,
// so the request carries its own, and a body far past any valid catalog is
// refused before it is parsed.
const MANIFEST_REQUEST_TIMEOUT_MS = 10_000;
const MANIFEST_MAX_BYTES = 64 * 1_024;
// A real resume delivers appStateChange and visibilitychange nearly together
// (lib/miden/front/useForegroundRefresh.ts uses the same window), and two checks
// for one resume race each other.
const FOREGROUND_COALESCE_MS = 500;

interface RuntimeController {
  check(options?: { force?: boolean }): Promise<UpdateCheckResult>;
}

interface RuntimeDismissals {
  isDismissed(platform: UpdateNotice['platform'], availableVersion: string): Promise<boolean>;
  dismiss(platform: UpdateNotice['platform'], availableVersion: string): Promise<void>;
}

export interface UpdateNotificationRuntime {
  controller: RuntimeController;
  dismissals: RuntimeDismissals;
  subscribe(listener: (reason: UpdateRefreshReason) => void): Promise<() => void> | (() => void);
}

interface ManifestResponse {
  ok: boolean;
  headers?: { get(name: string): string | null };
  text?(): Promise<string>;
  json(): Promise<unknown>;
}

interface RuntimeDependencies {
  createAdapter(): Promise<UpdateAvailabilityAdapter>;
  storage: StorageProvider;
  now(): number;
  fetchManifest(
    input: string,
    init: { cache: 'no-store'; headers: { Accept: string }; signal?: AbortSignal }
  ): Promise<ManifestResponse>;
  subscribe(listener: (reason: UpdateRefreshReason) => void): Promise<() => void> | (() => void);
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
  const now = dependencies.now ?? Date.now;
  const adapter = await createAdapter();
  const loadManifest = async (): Promise<unknown> => {
    // Test builds use an in-memory catalog so platform E2E never depends on a
    // public store or a just-merged raw GitHub file.
    const injected = getE2EPresentationManifest();
    if (injected) return injected;
    const cached = await readCachedManifest(storage, now());
    if (cached) return cached;
    const response = await fetchManifest(RELEASE_MANIFEST_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(MANIFEST_REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error('Update manifest request failed');
    // The declared length is the cheap rejection; the body is measured too,
    // because a chunked or re-encoded response declares nothing useful.
    const declaredLength = Number(response.headers?.get('content-length') ?? '0');
    if (declaredLength > MANIFEST_MAX_BYTES) throw new Error('Update manifest is too large');
    // Validate before storing: the cache is device storage every realm reads for
    // six hours, so it holds the bounded shape the schema allows, not whatever
    // the network returned.
    const manifest = parseUpdateManifest(await readBoundedBody(response));
    // Optional metadata: a storage failure only costs the next realm a refetch.
    await storage.set({ [MANIFEST_CACHE_KEY]: { fetchedAt: now(), body: manifest } }).catch(() => undefined);
    return manifest;
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
  return new (await import('./desktop')).DesktopUpdateAdapter();
}

async function readBoundedBody(response: ManifestResponse): Promise<unknown> {
  if (!response.text) return response.json();
  const raw = await response.text();
  if (raw.length > MANIFEST_MAX_BYTES) throw new Error('Update manifest is too large');
  return JSON.parse(raw);
}

async function readCachedManifest(storage: StorageProvider, now: number): Promise<unknown | null> {
  try {
    const cached = (await storage.get([MANIFEST_CACHE_KEY]))[MANIFEST_CACHE_KEY];
    if (typeof cached !== 'object' || cached === null) return null;
    const { fetchedAt, body } = cached as { fetchedAt?: unknown; body?: unknown };
    if (typeof fetchedAt !== 'number' || now - fetchedAt >= MANIFEST_CACHE_MS || now < fetchedAt) return null;
    return body ?? null;
  } catch {
    return null;
  }
}

function getE2EPresentationManifest(): unknown | null {
  const injected = getE2EUpdateInjection();
  if (!injected) return null;
  if (injected.summary === undefined) return { schemaVersion: 1, releases: [] };
  return {
    schemaVersion: 1,
    releases: [
      {
        version: injected.availableVersion,
        summary: injected.summary,
        urgency: injected.urgency ?? 'normal',
        platforms: [injected.platform]
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

export async function subscribeToRuntimeUpdates(listener: (reason: UpdateRefreshReason) => void): Promise<() => void> {
  const cleanups: Array<() => void> = [];
  let lastForegroundAt = 0;
  const onForeground = () => {
    const now = Date.now();
    if (now - lastForegroundAt < FOREGROUND_COALESCE_MS) return;
    lastForegroundAt = now;
    listener('foreground');
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') onForeground();
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  if (isMobile()) {
    // Attached without awaiting the bridge: the caller runs its first check as
    // soon as this returns, and a native registration that never settles must
    // not hold that check back. visibilitychange already covers resume.
    let removeAppListener: (() => void) | undefined;
    let detached = false;
    void import('@capacitor/app')
      .then(({ App }) =>
        App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) onForeground();
        })
      )
      .then(handle => {
        if (detached) void handle.remove();
        else removeAppListener = () => void handle.remove();
      })
      .catch(() => {
        // Visibility changes still provide a foreground retry when the native listener is unavailable.
      });
    cleanups.push(() => {
      detached = true;
      removeAppListener?.();
    });
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
          listener('platform');
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
