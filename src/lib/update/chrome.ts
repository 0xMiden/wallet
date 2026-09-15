import semver from 'semver';
import browser from 'webextension-polyfill';

import type { UpdateAvailability, UpdateAvailabilityAdapter } from './types';

export const CHROME_UPDATE_STORAGE_KEY = 'miden_update_available_v1';
export const CHROME_UPDATE_AVAILABLE_MESSAGE = 'MIDEN_UPDATE_AVAILABLE';
const CHROME_UPDATE_HINT_KEY = 'miden_update_check_hint_v1';

interface ChromeUpdateEvent {
  addListener(listener: (details: { version: string }) => void): void;
}

interface ChromeRuntime {
  getManifest(): { version?: string };
  reload(): void;
  sendMessage(message: unknown): Promise<unknown>;
  requestUpdateCheck?: () => Promise<unknown>;
  onUpdateAvailable: ChromeUpdateEvent;
}

interface ChromeStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

interface ChromeManagement {
  getSelf(): Promise<{ installType?: string }>;
}

export interface ChromeUpdateDependencies {
  runtime: ChromeRuntime;
  storage: ChromeStorage;
  management?: ChromeManagement;
}

interface StoredAvailability {
  currentVersion: string;
  availableVersion: string;
}

const isStrictVersion = (value: unknown): value is string => typeof value === 'string' && semver.valid(value) === value;

const isStoredAvailability = (value: unknown): value is StoredAvailability => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 2 &&
    isStrictVersion(candidate.currentVersion) &&
    isStrictVersion(candidate.availableVersion)
  );
};

const isNormalInstall = async (dependencies: ChromeUpdateDependencies): Promise<boolean> => {
  if (!dependencies.management?.getSelf) return false;
  return (await dependencies.management.getSelf()).installType === 'normal';
};

export async function persistChromeUpdate(
  details: { version: string },
  dependencies: ChromeUpdateDependencies = defaultDependencies()
): Promise<void> {
  try {
    const currentVersion = dependencies.runtime.getManifest().version;
    if (!isStrictVersion(currentVersion) || !isStrictVersion(details.version)) return;
    if (!semver.gt(details.version, currentVersion) || !(await isNormalInstall(dependencies))) return;

    const existing = (await dependencies.storage.get([CHROME_UPDATE_STORAGE_KEY]))[CHROME_UPDATE_STORAGE_KEY];
    if (
      isStoredAvailability(existing) &&
      existing.currentVersion === currentVersion &&
      existing.availableVersion === details.version
    ) {
      return;
    }
    await dependencies.storage.set({
      [CHROME_UPDATE_STORAGE_KEY]: { currentVersion, availableVersion: details.version } satisfies StoredAvailability
    });
    await dependencies.runtime
      .sendMessage({ type: CHROME_UPDATE_AVAILABLE_MESSAGE, availableVersion: details.version })
      .catch(() => undefined);
  } catch {
    // The update notice is optional and must not disrupt the service worker.
  }
}

const registrations = new WeakSet<object>();

export function registerChromeUpdateListener(dependencies: ChromeUpdateDependencies = defaultDependencies()): void {
  const event = dependencies.runtime.onUpdateAvailable;
  if (registrations.has(event)) return;
  registrations.add(event);
  event.addListener(details => {
    void persistChromeUpdate(details, dependencies);
  });
}

export class ChromeUpdateAdapter implements UpdateAvailabilityAdapter {
  readonly platform = 'chrome' as const;

  constructor(private readonly dependencies: ChromeUpdateDependencies = defaultDependencies()) {}

  async check(): Promise<UpdateAvailability> {
    const currentVersion = this.dependencies.runtime.getManifest().version;
    if (!isStrictVersion(currentVersion)) return { status: 'unknown' };
    try {
      if (!(await isNormalInstall(this.dependencies))) return { status: 'unknown', currentVersion };
      const stored = (await this.dependencies.storage.get([CHROME_UPDATE_STORAGE_KEY]))[CHROME_UPDATE_STORAGE_KEY];
      if (stored === undefined) return { status: 'none', currentVersion };
      if (!isStoredAvailability(stored)) return { status: 'unknown', currentVersion };
      if (!semver.gt(stored.availableVersion, currentVersion)) {
        await this.dependencies.storage.remove([CHROME_UPDATE_STORAGE_KEY]);
        return { status: 'none', currentVersion };
      }
      return {
        status: 'available',
        currentVersion,
        availableVersion: stored.availableVersion,
        action: async () => {
          this.dependencies.runtime.reload();
        }
      };
    } catch {
      return { status: 'unknown', currentVersion };
    }
  }

  async hintAvailableVersion(candidateVersion: string): Promise<void> {
    const currentVersion = this.dependencies.runtime.getManifest().version;
    if (!isStrictVersion(currentVersion) || !isStrictVersion(candidateVersion)) return;
    if (!semver.gt(candidateVersion, currentVersion) || !this.dependencies.runtime.requestUpdateCheck) return;
    try {
      if (!(await isNormalInstall(this.dependencies))) return;
      const previous = (await this.dependencies.storage.get([CHROME_UPDATE_HINT_KEY]))[CHROME_UPDATE_HINT_KEY];
      if (previous === candidateVersion) return;
      await this.dependencies.storage.set({ [CHROME_UPDATE_HINT_KEY]: candidateVersion });
      await this.dependencies.runtime.requestUpdateCheck();
    } catch {
      // Chrome throttling or extension teardown leaves availability unknown.
    }
  }
}

function defaultDependencies(): ChromeUpdateDependencies {
  return {
    runtime: browser.runtime as unknown as ChromeRuntime,
    storage: browser.storage.local as unknown as ChromeStorage,
    management: browser.management as unknown as ChromeManagement
  };
}
