import { Capacitor, registerPlugin } from '@capacitor/core';
import semver from 'semver';

import type { UpdateAvailability, UpdateAvailabilityAdapter } from './types';

interface IOSUpdatePlugin {
  check(): Promise<unknown>;
  openAppStore(): Promise<void>;
}

const NativeUpdateAvailability = registerPlugin<IOSUpdatePlugin>('UpdateAvailability');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStrictVersion = (value: unknown): value is string => typeof value === 'string' && semver.valid(value) === value;

export class IOSUpdateAdapter implements UpdateAvailabilityAdapter {
  readonly platform = 'ios' as const;

  constructor(
    private readonly plugin: IOSUpdatePlugin = NativeUpdateAvailability,
    private readonly getPlatform: () => string = () => Capacitor.getPlatform()
  ) {}

  async check(): Promise<UpdateAvailability> {
    if (this.getPlatform() !== 'ios') return { status: 'unknown' };
    try {
      const response = await this.plugin.check();
      if (!isRecord(response) || !isStrictVersion(response.currentVersion)) return { status: 'unknown' };
      if (response.status === 'none') return { status: 'none', currentVersion: response.currentVersion };
      if (response.status === 'unknown') return { status: 'unknown', currentVersion: response.currentVersion };
      if (
        response.status !== 'available' ||
        !isStrictVersion(response.availableVersion) ||
        !semver.gt(response.availableVersion, response.currentVersion)
      ) {
        return { status: 'unknown', currentVersion: response.currentVersion };
      }
      return {
        status: 'available',
        currentVersion: response.currentVersion,
        availableVersion: response.availableVersion,
        action: async () => {
          await this.plugin.openAppStore();
        }
      };
    } catch {
      return { status: 'unknown' };
    }
  }
}
