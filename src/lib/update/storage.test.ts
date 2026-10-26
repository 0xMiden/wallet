import type { StorageProvider } from 'lib/platform/storage-adapter';

import { UpdateDismissalStore } from './storage';

const provider = (initial: Record<string, unknown> = {}) => {
  const state = { ...initial };
  const storage: StorageProvider = {
    get: jest.fn(async keys => Object.fromEntries(keys.filter(key => key in state).map(key => [key, state[key]]))),
    set: jest.fn(async items => {
      Object.assign(state, items);
    }),
    remove: jest.fn(async keys => keys.forEach(key => delete state[key]))
  };
  return { state, storage };
};

describe('UpdateDismissalStore', () => {
  it('scopes a dismissal to the platform and available version', async () => {
    const { storage } = provider();
    const dismissals = new UpdateDismissalStore(storage);

    await dismissals.dismiss('chrome', '1.17.0');

    await expect(dismissals.isDismissed('chrome', '1.17.0')).resolves.toBe(true);
    await expect(dismissals.isDismissed('chrome', '1.18.0')).resolves.toBe(false);
    await expect(dismissals.isDismissed('ios', '1.17.0')).resolves.toBe(false);
  });

  it('fails open on malformed storage', async () => {
    const { storage } = provider({ update_notification_dismissal_v1: { accountId: 'secret' } });

    await expect(new UpdateDismissalStore(storage).isDismissed('chrome', '1.17.0')).resolves.toBe(false);
  });

  it('stores only platform and version', async () => {
    const { state, storage } = provider();
    await new UpdateDismissalStore(storage).dismiss('android', '1.17.0');

    expect(state).toEqual({
      update_notification_dismissal_v1: { platform: 'android', availableVersion: '1.17.0' }
    });
  });
});
