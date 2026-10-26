import { Capacitor, registerPlugin } from '@capacitor/core';
import semver from 'semver';

import { isRecord, isStrictVersion } from './guards';
import type { UpdateAvailability, UpdateAvailabilityAdapter } from './types';

interface NativeCheckResult {
  status: 'available' | 'none' | 'unknown';
  currentVersion: string;
  availableVersionCode?: number;
}

interface NativeUpdatePlugin {
  check(): Promise<unknown>;
  performUpdate(): Promise<{ started: boolean }>;
}

const NativeUpdateAvailability = registerPlugin<NativeUpdatePlugin>('UpdateAvailability');

const parseResponse = (value: unknown): NativeCheckResult | null => {
  if (!isRecord(value) || !['available', 'none', 'unknown'].includes(value.status as string)) return null;
  if (!isStrictVersion(value.currentVersion)) return null;
  if (value.status !== 'available')
    return { status: value.status as 'none' | 'unknown', currentVersion: value.currentVersion };
  if (!Number.isSafeInteger(value.availableVersionCode)) return null;
  return {
    status: 'available',
    currentVersion: value.currentVersion,
    availableVersionCode: value.availableVersionCode as number
  };
};

export function versionCodeToSemver(versionCode: number): string | null {
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) return null;
  const major = Math.floor(versionCode / 10_000_000);
  const minor = Math.floor((versionCode % 10_000_000) / 100_000);
  const patch = Math.floor((versionCode % 100_000) / 1_000);
  const build = versionCode % 1_000;
  if (build <= 0) return null;
  return `${major}.${minor}.${patch}`;
}

export class AndroidUpdateAdapter implements UpdateAvailabilityAdapter {
  readonly platform = 'android' as const;

  constructor(
    private readonly plugin: NativeUpdatePlugin = NativeUpdateAvailability,
    private readonly getPlatform: () => string = () => Capacitor.getPlatform()
  ) {}

  async check(): Promise<UpdateAvailability> {
    if (this.getPlatform() !== 'android') return { status: 'unknown' };
    try {
      const response = parseResponse(await this.plugin.check());
      if (!response) return { status: 'unknown' };
      if (response.status === 'none') return { status: 'none', currentVersion: response.currentVersion };
      if (response.status === 'unknown') return { status: 'unknown', currentVersion: response.currentVersion };
      const availableVersion = versionCodeToSemver(response.availableVersionCode!);
      if (!availableVersion) return { status: 'unknown', currentVersion: response.currentVersion };
      // Play answered, and what it offers is not newer - a re-upload of the same
      // marketing version reads exactly like this. That is an answer, so it is
      // `none`: `unknown` would keep a stale card up and arm the retry backoff.
      if (!semver.gt(availableVersion, response.currentVersion)) {
        return { status: 'none', currentVersion: response.currentVersion };
      }
      return {
        status: 'available',
        currentVersion: response.currentVersion,
        availableVersion,
        action: async () => {
          await this.plugin.performUpdate();
        }
      };
    } catch (error) {
      // A bridge failure and an up-to-date wallet look identical on screen.
      console.warn('[UpdateNotification] Play update check failed:', error);
      return { status: 'unknown' };
    }
  }
}
