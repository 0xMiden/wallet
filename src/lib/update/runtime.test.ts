import { App } from '@capacitor/app';
import browser from 'webextension-polyfill';

import type { StorageProvider } from 'lib/platform/storage-adapter';

import { CHROME_UPDATE_AVAILABLE_MESSAGE } from './events';
import {
  createDefaultAdapter,
  createUpdateNotificationRuntime,
  E2EUpdateAdapter,
  RELEASE_MANIFEST_URL,
  subscribeToRuntimeUpdates
} from './runtime';
import type { UpdateAvailabilityAdapter } from './types';
import manifestV3 from '../../../public/manifest.json';
import manifestV2 from '../../../public/manifest.v2.json';

const mockIsAndroid = jest.fn(() => false);
const mockIsDesktop = jest.fn(() => false);
const mockIsExtension = jest.fn(() => false);
const mockIsIOS = jest.fn(() => false);
const mockIsMobile = jest.fn(() => false);

jest.mock('lib/platform', () => ({
  isAndroid: () => mockIsAndroid(),
  isDesktop: () => mockIsDesktop(),
  isExtension: () => mockIsExtension(),
  isIOS: () => mockIsIOS(),
  isMobile: () => mockIsMobile()
}));

jest.mock('@capacitor/app', () => ({ App: { addListener: jest.fn() } }));
jest.mock('./android', () => ({
  AndroidUpdateAdapter: class {
    readonly platform = 'android';
    check = async () => ({ status: 'unknown' as const });
  }
}));
jest.mock('./ios', () => ({
  IOSUpdateAdapter: class {
    readonly platform = 'ios';
    check = async () => ({ status: 'unknown' as const });
  }
}));
jest.mock('./chrome', () => ({
  ChromeUpdateAdapter: class {
    readonly platform = 'chrome';
    check = async () => ({ status: 'unknown' as const });
  }
}));
jest.mock('./desktop', () => ({
  DesktopUpdateAdapter: class {
    readonly platform = 'desktop';
    check = async () => ({ status: 'unknown' as const });
  }
}));

const storage: StorageProvider = {
  get: jest.fn().mockResolvedValue({}),
  set: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined)
};

/** A storage stub that remembers what was written, like the real one does. */
const persistentStorage = (): StorageProvider => {
  const state: Record<string, unknown> = {};
  return {
    get: jest.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter(key => key in state).map(key => [key, state[key]]))
    ),
    set: jest.fn(async (items: Record<string, unknown>) => {
      Object.assign(state, items);
    }),
    remove: jest.fn(async (keys: string[]) => {
      keys.forEach(key => delete state[key]);
    })
  };
};

describe('createUpdateNotificationRuntime', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockIsAndroid.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(false);
    mockIsExtension.mockReturnValue(false);
    mockIsIOS.mockReturnValue(false);
    mockIsMobile.mockReturnValue(false);
  });

  it('reads the catalog once per window, across the realms a popup open creates', async () => {
    const shared = persistentStorage();
    const catalog = {
      schemaVersion: 1,
      releases: [{ version: '1.1.0', summary: 'Cached copy.', urgency: 'normal', platforms: ['chrome'] }]
    };
    const fetchManifest = jest.fn().mockResolvedValue({ ok: true, json: async () => catalog });
    let clock = 5_000;
    const build = () =>
      createUpdateNotificationRuntime({
        createAdapter: async () => ({
          platform: 'chrome',
          check: async () => ({
            status: 'available' as const,
            currentVersion: '1.0.0',
            availableVersion: '1.1.0',
            action: async () => {}
          })
        }),
        storage: shared,
        fetchManifest,
        now: () => clock,
        subscribe: async () => () => {}
      });

    await expect((await build()).controller.check()).resolves.toMatchObject({
      notice: { summary: 'Cached copy.' }
    });
    await expect((await build()).controller.check()).resolves.toMatchObject({
      notice: { summary: 'Cached copy.' }
    });
    expect(fetchManifest).toHaveBeenCalledTimes(1);

    clock += 6 * 60 * 60 * 1_000;
    await (await build()).controller.check();

    expect(fetchManifest).toHaveBeenCalledTimes(2);
  });

  it('stores only schema-valid catalog entries in device storage', async () => {
    const shared = persistentStorage();
    const fetchManifest = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        releases: [
          { version: '1.1.0', summary: 'Valid entry.', urgency: 'normal', platforms: ['chrome'] },
          { version: '1.2.0', summary: '<b>unsafe</b>', urgency: 'critical', platforms: ['chrome'] }
        ]
      })
    });
    const runtime = await createUpdateNotificationRuntime({
      createAdapter: async () => ({
        platform: 'chrome',
        check: async () => ({
          status: 'available' as const,
          currentVersion: '1.0.0',
          availableVersion: '1.1.0',
          action: async () => {}
        })
      }),
      storage: shared,
      fetchManifest,
      subscribe: async () => () => {}
    });

    await runtime.controller.check();

    const stored = (await shared.get(['update_manifest_cache_v1']))['update_manifest_cache_v1'];
    expect(stored.body.releases).toEqual([
      { version: '1.1.0', summary: 'Valid entry.', urgency: 'normal', platforms: ['chrome'] }
    ]);
  });

  it('asks for no new host access to read the presentation catalog', () => {
    // The catalog host answers `Access-Control-Allow-Origin: *`, so a default
    // fetch reaches it without a grant. Adding one would be a privilege
    // increase, which disables the auto-updated extension until every user
    // approves it again.
    const host = new URL(RELEASE_MANIFEST_URL).host;
    expect(manifestV3.host_permissions.some(pattern => pattern.includes(host))).toBe(false);
    expect(manifestV2.permissions.some(pattern => pattern.includes(host))).toBe(false);
  });

  it('loads the presentation catalog from the fixed raw main URL without a browser cache', async () => {
    const fetchManifest = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 1, releases: [] }) });
    const runtime = await createUpdateNotificationRuntime({
      createAdapter: async () => ({
        platform: 'chrome',
        check: async () => ({
          status: 'available',
          currentVersion: '1.0.0',
          availableVersion: '1.1.0',
          action: async () => {}
        })
      }),
      storage,
      fetchManifest,
      subscribe: async () => () => {}
    });

    await runtime.controller.check();

    expect(fetchManifest).toHaveBeenCalledWith(RELEASE_MANIFEST_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      // The controller's deadline abandons a slow read; only the request's own
      // signal ends it.
      signal: expect.objectContaining({ aborted: false })
    });
  });

  it.each([
    ['a declared length past the cap', { get: () => String(128 * 1024) }, undefined],
    // A chunked or re-encoded response declares nothing useful, so the body is
    // measured as it is read.
    ['a body past the cap with no declared length', { get: () => null }, 'x'.repeat(128 * 1024)]
  ])('refuses a catalog response far larger than any valid one: %s', async (_case, headers, text) => {
    const json = jest.fn();
    const fetchManifest = jest.fn().mockResolvedValue({
      ok: true,
      headers,
      json,
      ...(text === undefined ? {} : { text: async () => text })
    });
    const runtime = await createUpdateNotificationRuntime({
      createAdapter: async () => ({
        platform: 'chrome',
        check: async () => ({
          status: 'available' as const,
          currentVersion: '1.0.0',
          availableVersion: '1.1.0',
          action: async () => {}
        })
      }),
      storage,
      fetchManifest,
      subscribe: async () => () => {}
    });

    await expect(runtime.controller.check()).resolves.toMatchObject({ notice: { summary: null } });
    expect(json).not.toHaveBeenCalled();
  });

  it('keeps authoritative availability usable when presentation fetching fails', async () => {
    const available: UpdateAvailabilityAdapter = {
      platform: 'ios',
      check: async () => ({
        status: 'available',
        currentVersion: '1.0.0',
        availableVersion: '1.1.0',
        action: async () => {}
      })
    };
    const runtime = await createUpdateNotificationRuntime({
      createAdapter: async () => available,
      storage,
      fetchManifest: jest.fn().mockRejectedValue(new Error('offline')),
      subscribe: async () => () => {}
    });

    await expect(runtime.controller.check()).resolves.toMatchObject({
      notice: { platform: 'ios', availableVersion: '1.1.0', summary: null }
    });
  });

  it('rejects non-success manifest responses', async () => {
    // The adapter must report an update, or nothing loads the manifest and the
    // assertion would hold with the response check deleted.
    const json = jest.fn().mockResolvedValue({
      schemaVersion: 1,
      releases: [{ version: '1.1.0', summary: 'Served by an error page.', urgency: 'critical', platforms: ['chrome'] }]
    });
    const fetchManifest = jest.fn().mockResolvedValue({ ok: false, json });
    const runtime = await createUpdateNotificationRuntime({
      createAdapter: async () => ({
        platform: 'chrome',
        check: async () => ({
          status: 'available' as const,
          currentVersion: '1.0.0',
          availableVersion: '1.1.0',
          action: async () => {}
        })
      }),
      storage,
      fetchManifest,
      subscribe: async () => () => {}
    });

    await expect(runtime.controller.check()).resolves.toMatchObject({
      notice: { availableVersion: '1.1.0', summary: null, urgency: 'normal' }
    });
    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
  });

  it('uses the default E2E adapter, storage, fetch, and subscription only in a test build', async () => {
    const original = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    mockIsIOS.mockReturnValue(true);
    sessionStorage.setItem(
      '__miden_e2e_update__',
      JSON.stringify({
        platform: 'ios',
        currentVersion: '1.0.0',
        availableVersion: '1.1.0',
        summary: 'Reload-safe release text.'
      })
    );
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schemaVersion: 1, releases: [] })
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    const runtime = await createUpdateNotificationRuntime();

    await expect(runtime.controller.check()).resolves.toMatchObject({
      notice: {
        platform: 'ios',
        availableVersion: '1.1.0',
        summary: 'Reload-safe release text.',
        urgency: 'normal'
      }
    });
    const unsubscribe = await runtime.subscribe(jest.fn());
    unsubscribe();
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
    process.env.MIDEN_E2E_TEST = original;
    sessionStorage.clear();
  });

  it('uses the fixed network loader when no E2E presentation is injected', async () => {
    const originalE2E = process.env.MIDEN_E2E_TEST;
    const originalFetch = globalThis.fetch;
    process.env.MIDEN_E2E_TEST = 'false';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schemaVersion: 1, releases: [] })
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
    const runtime = await createUpdateNotificationRuntime({
      createAdapter: async () => ({
        platform: 'chrome',
        check: async () => ({
          status: 'available',
          currentVersion: '1.0.0',
          availableVersion: '1.1.0',
          action: async () => {}
        })
      })
    });

    await runtime.controller.check();

    expect(fetchMock).toHaveBeenCalledWith(RELEASE_MANIFEST_URL, expect.any(Object));
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
    process.env.MIDEN_E2E_TEST = originalE2E;
  });

  it('validates deterministic E2E presentation metadata without contacting the network', async () => {
    const original = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    window.__MIDEN_E2E_UPDATE__ = {
      platform: 'android',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      summary: 'Safer release text.',
      urgency: 'important'
    };
    const fetchManifest = jest.fn().mockRejectedValue(new Error('must not fetch'));
    const runtime = await createUpdateNotificationRuntime({
      createAdapter: async () => new E2EUpdateAdapter('android'),
      storage,
      fetchManifest,
      subscribe: async () => () => {}
    });

    await expect(runtime.controller.check()).resolves.toMatchObject({
      notice: { platform: 'android', summary: 'Safer release text.', urgency: 'important' }
    });
    expect(fetchManifest).not.toHaveBeenCalled();
    process.env.MIDEN_E2E_TEST = original;
    delete window.__MIDEN_E2E_UPDATE__;
  });
});

describe('default runtime platform adapter', () => {
  const original = {
    e2e: process.env.MIDEN_E2E_TEST,
    target: process.env.TARGET_BROWSER
  };

  beforeEach(() => {
    sessionStorage.clear();
    process.env.MIDEN_E2E_TEST = 'false';
    process.env.TARGET_BROWSER = 'chrome';
    delete window.__MIDEN_E2E_UPDATE__;
    mockIsAndroid.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(false);
    mockIsExtension.mockReturnValue(false);
    mockIsIOS.mockReturnValue(false);
  });

  afterAll(() => {
    process.env.MIDEN_E2E_TEST = original.e2e;
    process.env.TARGET_BROWSER = original.target;
  });

  it.each([
    ['android', mockIsAndroid],
    ['ios', mockIsIOS],
    ['desktop', mockIsDesktop]
  ] as const)('selects the %s adapter only for that runtime', async (platform, predicate) => {
    predicate.mockReturnValue(true);

    await expect(createDefaultAdapter()).resolves.toMatchObject({ platform });
  });

  it('selects Chrome only for a Chrome extension target', async () => {
    mockIsExtension.mockReturnValue(true);
    await expect(createDefaultAdapter()).resolves.toMatchObject({ platform: 'chrome' });

    process.env.TARGET_BROWSER = 'firefox';
    await expect(createDefaultAdapter()).resolves.toMatchObject({ platform: 'desktop' });
  });

  it('falls back to the silent desktop boundary on plain web', async () => {
    await expect(createDefaultAdapter()).resolves.toMatchObject({ platform: 'desktop' });
  });

  it.each([
    ['android', mockIsAndroid],
    ['ios', mockIsIOS],
    ['chrome', mockIsExtension]
  ] as const)('binds E2E injection to the real %s runtime before data is injected', async (platform, predicate) => {
    process.env.MIDEN_E2E_TEST = 'true';
    predicate.mockReturnValue(true);

    await expect(createDefaultAdapter()).resolves.toBeInstanceOf(E2EUpdateAdapter);
    await expect(createDefaultAdapter()).resolves.toMatchObject({ platform });
  });
});

// Let promise callbacks that this module schedules without awaiting them run.
const act = () => new Promise(resolve => setTimeout(resolve, 0));

describe('subscribeToRuntimeUpdates', () => {
  let appStateListener: ((state: { isActive: boolean }) => void) | undefined;
  let messageListener: ((message: unknown) => void) | undefined;
  const removeAppListener = jest.fn();
  const removeMessageListener = jest.fn();

  beforeEach(() => {
    appStateListener = undefined;
    messageListener = undefined;
    jest.clearAllMocks();
    mockIsMobile.mockReturnValue(true);
    mockIsExtension.mockReturnValue(true);
    process.env.TARGET_BROWSER = 'chrome';
    (App.addListener as jest.Mock).mockImplementation((_event: string, listener: typeof appStateListener) => {
      appStateListener = listener;
      return Promise.resolve({ remove: removeAppListener });
    });
    Object.assign(browser.runtime, {
      onMessage: {
        addListener: jest.fn((listener: (message: unknown) => void) => {
          messageListener = listener;
        }),
        removeListener: removeMessageListener
      }
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports visible documents, active native apps, and authoritative Chrome events, then cleans up', async () => {
    const listener = jest.fn();
    const unsubscribe = await subscribeToRuntimeUpdates(listener);
    // The native listener is attached without being awaited, so let its
    // registration settle before driving it.
    await act();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    appStateListener?.({ isActive: false });
    messageListener?.('not-an-event');
    messageListener?.(null);
    messageListener?.({ type: 'OTHER' });
    messageListener?.({ type: CHROME_UPDATE_AVAILABLE_MESSAGE });

    expect(listener.mock.calls).toEqual([['foreground'], ['platform']]);
    unsubscribe();
    expect(removeAppListener).toHaveBeenCalledTimes(1);
    expect(removeMessageListener).toHaveBeenCalledWith(messageListener);
  });

  it('treats the two events of one native resume as a single foreground', async () => {
    const listener = jest.fn();
    const unsubscribe = await subscribeToRuntimeUpdates(listener);
    await act();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    appStateListener?.({ isActive: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(listener).toHaveBeenCalledTimes(1);

    // A later resume, outside the coalescing window, is its own foreground.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 600);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(listener.mock.calls).toEqual([['foreground'], ['foreground']]);
    unsubscribe();
  });

  it('does not wait for a native registration that never settles', async () => {
    (App.addListener as jest.Mock).mockImplementation(() => new Promise(() => {}));
    const listener = jest.fn();

    const unsubscribe = await subscribeToRuntimeUpdates(listener);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(listener).toHaveBeenCalledWith('foreground');
    unsubscribe();
  });

  it('keeps the document fallback when native or extension listener registration fails', async () => {
    (App.addListener as jest.Mock).mockRejectedValue(new Error('native unavailable'));
    (browser.runtime.onMessage.addListener as jest.Mock).mockImplementation(() => {
      throw new Error('surface closing');
    });
    const listener = jest.fn();

    const unsubscribe = await subscribeToRuntimeUpdates(listener);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(listener).toHaveBeenCalledWith('foreground');
    unsubscribe();
  });
});

describe('E2EUpdateAdapter', () => {
  const original = process.env.MIDEN_E2E_TEST;

  afterEach(() => {
    process.env.MIDEN_E2E_TEST = original;
    delete window.__MIDEN_E2E_UPDATE__;
    sessionStorage.clear();
  });

  it('is silent unless the explicit E2E build boundary is enabled', async () => {
    process.env.MIDEN_E2E_TEST = 'false';
    window.__MIDEN_E2E_UPDATE__ = {
      platform: 'android',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0'
    };

    await expect(new E2EUpdateAdapter('android').check()).resolves.toEqual({ status: 'unknown' });
  });

  it('injects deterministic availability and dispatches only the compiled test action event', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    window.__MIDEN_E2E_UPDATE__ = {
      platform: 'android',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0'
    };
    const listener = jest.fn();
    window.addEventListener('miden:e2e-update-action', listener);

    const result = await new E2EUpdateAdapter('android').check();
    expect(result).toMatchObject({ status: 'available', availableVersion: '1.1.0' });
    if (result.status === 'available') await result.action();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('miden:e2e-update-action', listener);
  });

  it('reads reload-safe session injection when the document global is absent', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    sessionStorage.setItem(
      '__miden_e2e_update__',
      JSON.stringify({ platform: 'android', currentVersion: '1.0.0', availableVersion: '1.1.0' })
    );

    await expect(new E2EUpdateAdapter('android').check()).resolves.toMatchObject({
      status: 'available',
      availableVersion: '1.1.0'
    });
  });

  it('ignores malformed reload-safe session injection', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    sessionStorage.setItem('__miden_e2e_update__', '{');

    await expect(new E2EUpdateAdapter('android').check()).resolves.toEqual({ status: 'unknown' });
  });

  it('is silent when an E2E build has no injected session data', async () => {
    process.env.MIDEN_E2E_TEST = 'true';

    await expect(new E2EUpdateAdapter('android').check()).resolves.toEqual({ status: 'unknown' });
  });

  it('rejects mismatched platforms and malformed versions', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    window.__MIDEN_E2E_UPDATE__ = {
      platform: 'ios',
      currentVersion: 'not-semver',
      availableVersion: '1.1.0'
    };

    await expect(new E2EUpdateAdapter('android').check()).resolves.toEqual({ status: 'unknown' });
    await expect(new E2EUpdateAdapter('ios').check()).resolves.toEqual({ status: 'unknown' });
  });

  it('reports none for an injected current or older version', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    window.__MIDEN_E2E_UPDATE__ = {
      platform: 'ios',
      currentVersion: '1.1.0',
      availableVersion: '1.1.0'
    };

    await expect(new E2EUpdateAdapter('ios').check()).resolves.toEqual({
      status: 'none',
      currentVersion: '1.1.0'
    });
  });
});
