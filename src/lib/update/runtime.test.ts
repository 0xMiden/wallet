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

const adapter = (platform: UpdateAvailabilityAdapter['platform']): UpdateAvailabilityAdapter => ({
  platform,
  check: jest.fn().mockResolvedValue({ status: 'none', currentVersion: '1.0.0' })
});

describe('createUpdateNotificationRuntime', () => {
  beforeEach(() => {
    mockIsAndroid.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(false);
    mockIsExtension.mockReturnValue(false);
    mockIsIOS.mockReturnValue(false);
    mockIsMobile.mockReturnValue(false);
  });

  it('grants both extension manifests access only to the fixed presentation host', () => {
    expect(manifestV3.host_permissions).toContain('https://raw.githubusercontent.com/0xMiden/wallet/*');
    expect(manifestV2.permissions).toContain('https://raw.githubusercontent.com/0xMiden/wallet/*');
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
      headers: { Accept: 'application/json' }
    });
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
      platform: 'ios',
      availableVersion: '1.1.0',
      summary: null
    });
  });

  it('rejects non-success manifest responses', async () => {
    const runtime = await createUpdateNotificationRuntime({
      createAdapter: async () => adapter('chrome'),
      storage,
      fetchManifest: jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
      subscribe: async () => () => {}
    });

    await expect(runtime.controller.check()).resolves.toBeNull();
  });

  it('uses the default E2E adapter, storage, fetch, and subscription only in a test build', async () => {
    const original = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    window.__MIDEN_E2E_UPDATE__ = {
      platform: 'ios',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0'
    };
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schemaVersion: 1, releases: [] })
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    const runtime = await createUpdateNotificationRuntime();

    await expect(runtime.controller.check()).resolves.toMatchObject({ platform: 'ios', availableVersion: '1.1.0' });
    const unsubscribe = await runtime.subscribe(jest.fn());
    unsubscribe();
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
    process.env.MIDEN_E2E_TEST = original;
    delete window.__MIDEN_E2E_UPDATE__;
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
      platform: 'android',
      summary: 'Safer release text.',
      urgency: 'important'
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
});

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

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    appStateListener?.({ isActive: false });
    appStateListener?.({ isActive: true });
    messageListener?.('not-an-event');
    messageListener?.(null);
    messageListener?.({ type: 'OTHER' });
    messageListener?.({ type: CHROME_UPDATE_AVAILABLE_MESSAGE });

    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    expect(removeAppListener).toHaveBeenCalledTimes(1);
    expect(removeMessageListener).toHaveBeenCalledWith(messageListener);
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

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('E2EUpdateAdapter', () => {
  const original = process.env.MIDEN_E2E_TEST;

  afterEach(() => {
    process.env.MIDEN_E2E_TEST = original;
    delete window.__MIDEN_E2E_UPDATE__;
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
