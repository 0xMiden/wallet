import { UpdateController } from './controller';
import type { UpdateAvailability, UpdateAvailabilityAdapter } from './types';

const available = (version = '1.17.0'): UpdateAvailability => ({
  status: 'available',
  currentVersion: '1.16.0',
  availableVersion: version,
  action: jest.fn().mockResolvedValue(undefined)
});

const manifest = {
  schemaVersion: 1,
  releases: [
    {
      version: '1.17.0',
      summary: 'Security fixes and reliability improvements.',
      urgency: 'important',
      platforms: { chrome: { version: '1.17.0' } }
    }
  ]
};

const adapter = (check: jest.Mock<Promise<UpdateAvailability>, []>): UpdateAvailabilityAdapter => ({
  platform: 'chrome',
  check
});

describe('UpdateController', () => {
  it('joins exact authoritative availability with safe presentation metadata', async () => {
    const action = jest.fn().mockResolvedValue(undefined);
    const check = jest.fn().mockResolvedValue({ ...available(), action });
    const controller = new UpdateController({ adapter: adapter(check), loadManifest: async () => manifest });

    await expect(controller.check()).resolves.toEqual({
      platform: 'chrome',
      currentVersion: '1.16.0',
      availableVersion: '1.17.0',
      summary: 'Security fixes and reliability improvements.',
      urgency: 'important',
      action
    });
  });

  it.each<UpdateAvailability>([{ status: 'none', currentVersion: '1.16.0' }, { status: 'unknown' }])(
    'stays silent for $status',
    async result => {
      const controller = new UpdateController({
        adapter: adapter(jest.fn().mockResolvedValue(result)),
        loadManifest: async () => manifest
      });

      await expect(controller.check()).resolves.toBeNull();
    }
  );

  it('stays silent when an adapter reports the current or an older version', async () => {
    const check = jest
      .fn<Promise<UpdateAvailability>, []>()
      .mockResolvedValueOnce(available('1.16.0'))
      .mockResolvedValueOnce(available('1.15.9'));
    const controller = new UpdateController({ adapter: adapter(check), loadManifest: async () => manifest });

    await expect(controller.check({ force: true })).resolves.toBeNull();
    await expect(controller.check({ force: true })).resolves.toBeNull();
  });

  it('uses generic presentation when metadata is missing or invalid', async () => {
    const missing = new UpdateController({
      adapter: adapter(jest.fn().mockResolvedValue(available('1.18.0'))),
      loadManifest: async () => manifest
    });
    const invalid = new UpdateController({
      adapter: adapter(jest.fn().mockResolvedValue(available())),
      loadManifest: async () => ({ schemaVersion: 9 })
    });

    await expect(missing.check()).resolves.toMatchObject({ summary: null, urgency: 'normal' });
    await expect(invalid.check()).resolves.toMatchObject({ summary: null, urgency: 'normal' });
  });

  it('deduplicates an in-flight check and caches successful results for six hours', async () => {
    let resolveCheck: ((value: UpdateAvailability) => void) | undefined;
    const check = jest.fn(
      () =>
        new Promise<UpdateAvailability>(resolve => {
          resolveCheck = resolve;
        })
    );
    let now = 1_000;
    const controller = new UpdateController({
      adapter: adapter(check),
      loadManifest: async () => manifest,
      now: () => now
    });

    const first = controller.check();
    const second = controller.check();
    expect(check).toHaveBeenCalledTimes(1);
    resolveCheck?.(available());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    now += 6 * 60 * 60 * 1_000 - 1;
    await controller.check();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('backs off unknown results but lets a forced foreground check retry', async () => {
    const check = jest
      .fn<Promise<UpdateAvailability>, []>()
      .mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValueOnce(available());
    let now = 1_000;
    const controller = new UpdateController({
      adapter: adapter(check),
      loadManifest: async () => manifest,
      now: () => now,
      unknownRetryBaseMs: 5_000
    });

    await expect(controller.check()).resolves.toBeNull();
    now += 4_999;
    await expect(controller.check()).resolves.toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
    await expect(controller.check({ force: true })).resolves.toMatchObject({ availableVersion: '1.17.0' });
  });

  it('does not cache a result from an invalidated platform session', async () => {
    let resolveCheck: ((value: UpdateAvailability) => void) | undefined;
    const check = jest.fn(
      () =>
        new Promise<UpdateAvailability>(resolve => {
          resolveCheck = resolve;
        })
    );
    const controller = new UpdateController({ adapter: adapter(check), loadManifest: async () => manifest });

    const pending = controller.check();
    controller.invalidate();
    resolveCheck?.(available());
    await expect(pending).resolves.toBeNull();
  });

  it('times out without turning an adapter failure into no update', async () => {
    jest.useFakeTimers();
    const controller = new UpdateController({
      adapter: adapter(jest.fn(() => new Promise<UpdateAvailability>(() => {}))),
      loadManifest: async () => manifest,
      timeoutMs: 100
    });

    const pending = controller.check();
    await jest.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeNull();
    jest.useRealTimers();
  });
});
