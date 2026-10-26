import { Capacitor, registerPlugin } from '@capacitor/core';
import semver from 'semver';

import { isRecord, isStrictVersion } from './guards';
import type { UpdateAvailability, UpdateAvailabilityAdapter } from './types';

interface IOSUpdatePlugin {
  check(): Promise<unknown>;
  openAppStore(): Promise<void>;
}

const NativeUpdateAvailability = registerPlugin<IOSUpdatePlugin>('UpdateAvailability');

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
      if (response.status !== 'available' || !isStrictVersion(response.availableVersion)) {
        return { status: 'unknown', currentVersion: response.currentVersion };
      }
      // The App Store answered, and its version is not newer: an answer, not a
      // failure, so it clears a stale card instead of keeping it.
      if (!semver.gt(response.availableVersion, response.currentVersion)) {
        return { status: 'none', currentVersion: response.currentVersion };
      }
      return {
        status: 'available',
        currentVersion: response.currentVersion,
        availableVersion: response.availableVersion,
        action: async () => {
          await this.plugin.openAppStore();
        }
      };
    } catch (error) {
      // A bridge failure and an up-to-date wallet look identical on screen.
      console.warn('[UpdateNotification] App Store update check failed:', error);
      return { status: 'unknown' };
    }
  }
}
