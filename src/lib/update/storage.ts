import type { StorageProvider } from 'lib/platform/storage-adapter';

import type { UpdatePlatform } from './manifest';

const DISMISSAL_KEY = 'update_notification_dismissal_v1';
const PLATFORMS: UpdatePlatform[] = ['chrome', 'android', 'ios', 'desktop'];

interface Dismissal {
  platform: UpdatePlatform;
  availableVersion: string;
}

const isDismissal = (value: unknown): value is Dismissal => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 2 &&
    PLATFORMS.includes(candidate.platform as UpdatePlatform) &&
    typeof candidate.availableVersion === 'string'
  );
};

export class UpdateDismissalStore {
  constructor(private readonly storage: StorageProvider) {}

  async isDismissed(platform: UpdatePlatform, availableVersion: string): Promise<boolean> {
    const value = (await this.storage.get([DISMISSAL_KEY]))[DISMISSAL_KEY];
    return isDismissal(value) && value.platform === platform && value.availableVersion === availableVersion;
  }

  async dismiss(platform: UpdatePlatform, availableVersion: string): Promise<void> {
    await this.storage.set({ [DISMISSAL_KEY]: { platform, availableVersion } satisfies Dismissal });
  }
}
