import { Capacitor, registerPlugin } from '@capacitor/core';
import semver from 'semver';

import type { UpdateAvailability, UpdateAvailabilityAdapter } from './types';

interface NativeCheckResult {
  status: 'available' | 'none' | 'unknown';
  currentVersion: string;
  availableVersionCode?: number;
  action?: string;
}

interface NativeUpdatePlugin {
  check(): Promise<unknown>;
  performUpdate(): Promise<{ started: boolean }>;
}

const NativeUpdateAvailability = registerPlugin<NativeUpdatePlugin>('UpdateAvailability');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStrictVersion = (value: unknown): value is string => typeof value === 'string' && semver.valid(value) === value;

const parseResponse = (value: unknown): NativeCheckResult | null => {
  if (!isRecord(value) || !['available', 'none', 'unknown'].includes(value.status as string)) return null;
  if (!isStrictVersion(value.currentVersion)) return null;
  if (value.status !== 'available')
    return { status: value.status as 'none' | 'unknown', currentVersion: value.currentVersion };
  if (!Number.isSafeInteger(value.availableVersionCode)) return null;
  return {
    status: 'available',
    currentVersion: value.currentVersion,
    availableVersionCode: value.availableVersionCode as number,
    action: typeof value.action === 'string' ? value.action : undefined
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
      if (!availableVersion || !semver.gt(availableVersion, response.currentVersion)) {
        return { status: 'unknown', currentVersion: response.currentVersion };
      }
      return {
        status: 'available',
        currentVersion: response.currentVersion,
        availableVersion,
        action: async () => {
          await this.plugin.performUpdate();
        }
      };
    } catch {
      return { status: 'unknown' };
    }
  }
}
