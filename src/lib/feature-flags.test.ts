import { isSwapEnabled, isUpdateNotificationsEnabled } from './feature-flags';

describe('feature-flags — isSwapEnabled', () => {
  it('enables swap on every platform (including iOS)', () => {
    expect(isSwapEnabled()).toBe(true);
  });
});

describe('feature-flags - isUpdateNotificationsEnabled', () => {
  it('uses the build-time flag as the single source of truth', () => {
    const original = process.env.MIDEN_UPDATE_NOTIFICATIONS;
    const environment = process.env as Record<string, string | undefined>;
    environment.MIDEN_UPDATE_NOTIFICATIONS = 'true';
    expect(isUpdateNotificationsEnabled()).toBe(true);
    environment.MIDEN_UPDATE_NOTIFICATIONS = 'false';
    expect(isUpdateNotificationsEnabled()).toBe(false);
    environment.MIDEN_UPDATE_NOTIFICATIONS = original;
  });
});
