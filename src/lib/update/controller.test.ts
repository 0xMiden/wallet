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
      platforms: ['chrome']
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
      status: 'available',
      notice: {
        platform: 'chrome',
        currentVersion: '1.16.0',
        availableVersion: '1.17.0',
        summary: 'Security fixes and reliability improvements.',
        urgency: 'important',
        action
      }
    });
  });

  it.each<UpdateAvailability>([{ status: 'none', currentVersion: '1.16.0' }, { status: 'unknown' }])(
    'reports $status without a notice',
    async result => {
      const controller = new UpdateController({
        adapter: adapter(jest.fn().mockResolvedValue(result)),
        loadManifest: async () => manifest
      });

      await expect(controller.check()).resolves.toEqual({ status: result.status });
    }
  );

  it('stays silent when an adapter reports the current or an older version', async () => {
    const check = jest
      .fn<Promise<UpdateAvailability>, []>()
      .mockResolvedValueOnce(available('1.16.0'))
      .mockResolvedValueOnce(available('1.15.9'));
    const controller = new UpdateController({ adapter: adapter(check), loadManifest: async () => manifest });

    await expect(controller.check({ force: true })).resolves.toEqual({ status: 'none' });
    await expect(controller.check({ force: true })).resolves.toEqual({ status: 'none' });
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

    await expect(missing.check()).resolves.toMatchObject({ notice: { summary: null, urgency: 'normal' } });
    await expect(invalid.check()).resolves.toMatchObject({ notice: { summary: null, urgency: 'normal' } });
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

    await expect(controller.check()).resolves.toEqual({ status: 'unknown' });
    now += 4_999;
    // Inside the backoff the platform has not answered; reporting `none` here
    // would retract a card it confirmed earlier.
    await expect(controller.check()).resolves.toEqual({ status: 'unknown' });
    expect(check).toHaveBeenCalledTimes(1);
    await expect(controller.check({ force: true })).resolves.toMatchObject({
      notice: { availableVersion: '1.17.0' }
    });
  });

  it('answers a superseded check with the newest result instead of no update', async () => {
    const resolvers: Array<(value: UpdateAvailability) => void> = [];
    const check = jest.fn(
      () =>
        new Promise<UpdateAvailability>(resolve => {
          resolvers.push(resolve);
        })
    );
    const controller = new UpdateController({ adapter: adapter(check), loadManifest: async () => manifest });

    const older = controller.check();
    const newer = controller.check({ force: true });
    expect(check).toHaveBeenCalledTimes(2);

    // The newest answer lands first, and the superseded request answers last.
    resolvers[1]?.(available('1.18.0'));
    await expect(newer).resolves.toMatchObject({ notice: { availableVersion: '1.18.0' } });
    resolvers[0]?.({ status: 'none', currentVersion: '1.16.0' });

    await expect(older).resolves.toMatchObject({ notice: { availableVersion: '1.18.0' } });
  });

  it('reports unknown rather than no update when the adapter never answers', async () => {
    jest.useFakeTimers();
    const check = jest
      .fn<Promise<UpdateAvailability>, []>()
      .mockImplementationOnce(() => new Promise<UpdateAvailability>(() => {}))
      .mockResolvedValue(available());
    const controller = new UpdateController({
      adapter: adapter(check),
      loadManifest: async () => manifest,
      timeoutMs: 100,
      unknownRetryBaseMs: 1_000
    });

    const pending = controller.check();
    await jest.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ status: 'unknown' });

    // A cached `none` would keep the adapter out of the next six hours; an
    // unknown result only holds it back for the backoff.
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(controller.check()).resolves.toMatchObject({ notice: { availableVersion: '1.17.0' } });
    expect(check).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('publishes generic copy when presentation metadata outlives the deadline', async () => {
    jest.useFakeTimers();
    const controller = new UpdateController({
      adapter: adapter(jest.fn().mockResolvedValue(available())),
      loadManifest: () => new Promise<unknown>(() => {}),
      timeoutMs: 100
    });

    const pending = controller.check();
    await jest.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toMatchObject({
      status: 'available',
      notice: { availableVersion: '1.17.0', summary: null, urgency: 'normal' }
    });
    jest.useRealTimers();
  });

  it('answers a none result without waiting for the hint to load metadata', async () => {
    let loadCandidate: (() => Promise<string | null>) | undefined;
    const hintAvailableVersion = jest.fn(async (load: () => Promise<string | null>) => {
      loadCandidate = load;
      await load();
    });
    const controller = new UpdateController({
      adapter: {
        platform: 'chrome',
        check: jest.fn().mockResolvedValue({ status: 'none', currentVersion: '1.16.0' }),
        hintAvailableVersion
      },
      // A catalog that never answers must not hold up the platform's own result.
      loadManifest: () => new Promise<unknown>(() => {})
    });

    await expect(controller.check()).resolves.toEqual({ status: 'none' });
    expect(loadCandidate).toBeDefined();
  });

  it('offers only the newest validated manifest candidate to an adapter hint', async () => {
    let candidate: string | null = null;
    const hintAvailableVersion = jest.fn(async (load: () => Promise<string | null>) => {
      candidate = await load();
    });
    const controller = new UpdateController({
      adapter: {
        platform: 'chrome',
        check: jest.fn().mockResolvedValue({ status: 'none', currentVersion: '1.16.0' }),
        hintAvailableVersion
      },
      loadManifest: async () => ({
        schemaVersion: 1,
        releases: [
          ...manifest.releases,
          {
            version: '1.18.0',
            summary: 'Another safe release.',
            urgency: 'normal',
            platforms: ['chrome']
          },
          {
            version: 'invalid',
            summary: '<unsafe>',
            urgency: 'critical',
            platforms: ['chrome']
          }
        ]
      })
    });

    await controller.check();
    await Promise.resolve();

    expect(hintAvailableVersion).toHaveBeenCalledTimes(1);
    expect(candidate).toBe('1.18.0');
  });
});
