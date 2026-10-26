import browser from 'webextension-polyfill';

import {
  CHROME_UPDATE_AVAILABLE_MESSAGE,
  CHROME_UPDATE_STORAGE_KEY,
  ChromeUpdateAdapter,
  persistChromeUpdate,
  registerChromeUpdateListener
} from './chrome';
import type { UpdateAvailability } from './types';

const makeEvent = () => {
  const listeners: Array<(details: { version: string }) => void> = [];
  return {
    listeners,
    addListener: jest.fn((listener: (details: { version: string }) => void) => listeners.push(listener))
  };
};

const makeDependencies = () => {
  const state: Record<string, unknown> = {};
  const onUpdateAvailable = makeEvent();
  const runtime = {
    getManifest: jest.fn(() => ({ version: '1.16.0' })),
    reload: jest.fn(),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    requestUpdateCheck: jest.fn().mockResolvedValue(['update_available', { version: '1.17.0' }]),
    onUpdateAvailable
  };
  const storage = {
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
  const management = { getSelf: jest.fn().mockResolvedValue({ installType: 'normal' }) };
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  return { clock, management, now, onUpdateAvailable, runtime, state, storage };
};

describe('Chrome update service worker', () => {
  it('persists Chrome-authoritative availability and notifies open surfaces without reloading', async () => {
    const deps = makeDependencies();

    await persistChromeUpdate({ version: '1.17.0' }, deps);

    expect(deps.state).toEqual({
      [CHROME_UPDATE_STORAGE_KEY]: { currentVersion: '1.16.0', availableVersion: '1.17.0' }
    });
    expect(deps.runtime.sendMessage).toHaveBeenCalledWith({
      type: CHROME_UPDATE_AVAILABLE_MESSAGE,
      availableVersion: '1.17.0'
    });
    expect(deps.runtime.reload).not.toHaveBeenCalled();
  });

  it('ignores a duplicate event', async () => {
    const deps = makeDependencies();
    await persistChromeUpdate({ version: '1.17.0' }, deps);

    await expect(persistChromeUpdate({ version: '1.17.0' }, deps)).resolves.toBeUndefined();

    expect(deps.storage.set).toHaveBeenCalledTimes(1);
    expect(deps.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('still records availability when no surface is open to notify', async () => {
    const deps = makeDependencies();
    deps.runtime.sendMessage.mockRejectedValueOnce(new Error('no open surface'));

    await expect(persistChromeUpdate({ version: '1.17.0' }, deps)).resolves.toBeUndefined();

    expect(deps.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.state).toEqual({
      [CHROME_UPDATE_STORAGE_KEY]: { currentVersion: '1.16.0', availableVersion: '1.17.0' }
    });
  });

  it.each([
    ['development', '1.17.0'],
    ['sideload', '1.17.0'],
    ['normal', 'invalid'],
    ['normal', '1.16.0']
  ])('ignores an unverifiable %s install reporting %s', async (installType, version) => {
    const deps = makeDependencies();
    deps.management.getSelf.mockResolvedValue({ installType });

    await persistChromeUpdate({ version }, deps);

    expect(deps.storage.set).not.toHaveBeenCalled();
    expect(deps.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('registers its listener only once', () => {
    const deps = makeDependencies();

    registerChromeUpdateListener(deps);
    registerChromeUpdateListener(deps);

    expect(deps.onUpdateAvailable.addListener).toHaveBeenCalledTimes(1);
  });

  it('routes registered events through persistence', async () => {
    const deps = makeDependencies();
    registerChromeUpdateListener(deps);

    deps.onUpdateAvailable.listeners[0]?.({ version: '1.17.0' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(deps.state[CHROME_UPDATE_STORAGE_KEY]).toEqual({
      currentVersion: '1.16.0',
      availableVersion: '1.17.0'
    });
  });

  it('contains storage failures instead of disrupting the service worker', async () => {
    const deps = makeDependencies();
    deps.storage.get.mockRejectedValueOnce(new Error('disabled extension'));

    await expect(persistChromeUpdate({ version: '1.17.0' }, deps)).resolves.toBeUndefined();

    expect(deps.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('ChromeUpdateAdapter', () => {
  it('restores a persisted event after service-worker restart and reloads only on explicit action', async () => {
    const deps = makeDependencies();
    deps.state[CHROME_UPDATE_STORAGE_KEY] = { currentVersion: '1.16.0', availableVersion: '1.17.0' };
    const adapter = new ChromeUpdateAdapter(deps);

    const result = await adapter.check();

    expect(result).toMatchObject({ status: 'available', currentVersion: '1.16.0', availableVersion: '1.17.0' });
    expect(deps.runtime.reload).not.toHaveBeenCalled();
    await (result as Extract<UpdateAvailability, { status: 'available' }>).action();
    expect(deps.runtime.reload).toHaveBeenCalledTimes(1);
  });

  it('removes stale availability for the installed version', async () => {
    const deps = makeDependencies();
    deps.state[CHROME_UPDATE_STORAGE_KEY] = { currentVersion: '1.15.0', availableVersion: '1.16.0' };

    await expect(new ChromeUpdateAdapter(deps).check()).resolves.toEqual({
      status: 'none',
      currentVersion: '1.16.0'
    });
    expect(deps.storage.remove).toHaveBeenCalledWith([CHROME_UPDATE_STORAGE_KEY]);
  });

  it.each(['development', 'sideload'])('returns unknown for a %s install', async installType => {
    const deps = makeDependencies();
    deps.management.getSelf.mockResolvedValue({ installType });

    await expect(new ChromeUpdateAdapter(deps).check()).resolves.toEqual({
      status: 'unknown',
      currentVersion: '1.16.0'
    });
  });

  it('returns unknown for missing APIs, malformed storage, and API failures', async () => {
    const missing = makeDependencies();
    const malformed = makeDependencies();
    malformed.state[CHROME_UPDATE_STORAGE_KEY] = { availableVersion: '1.17.0', command: 'reload' };
    const failed = makeDependencies();
    failed.storage.get.mockRejectedValueOnce(new Error('storage failed'));

    await expect(new ChromeUpdateAdapter({ ...missing, management: undefined }).check()).resolves.toEqual({
      status: 'unknown',
      currentVersion: '1.16.0'
    });
    await expect(new ChromeUpdateAdapter(malformed).check()).resolves.toEqual({
      status: 'unknown',
      currentVersion: '1.16.0'
    });
    await expect(new ChromeUpdateAdapter(failed).check()).resolves.toEqual({
      status: 'unknown',
      currentVersion: '1.16.0'
    });
  });

  it('throttles the update-check hint by time, without reading the catalog when one is not due', async () => {
    const deps = makeDependencies();
    const adapter = new ChromeUpdateAdapter(deps);
    const loadCandidate = jest.fn().mockResolvedValue('1.17.0');

    await adapter.hintAvailableVersion(loadCandidate);
    expect(deps.runtime.requestUpdateCheck).toHaveBeenCalledTimes(1);

    // Chrome answers `no_update` while the store is still publishing, so the
    // second hint is refused by the clock, not by the version.
    deps.clock.now += 6 * 60 * 60 * 1_000 - 1;
    await adapter.hintAvailableVersion(loadCandidate);
    expect(loadCandidate).toHaveBeenCalledTimes(1);
    expect(deps.runtime.requestUpdateCheck).toHaveBeenCalledTimes(1);

    deps.clock.now += 1;
    await adapter.hintAvailableVersion(loadCandidate);

    expect(loadCandidate).toHaveBeenCalledTimes(2);
    expect(deps.runtime.requestUpdateCheck).toHaveBeenCalledTimes(2);
    await expect(adapter.check()).resolves.toEqual({ status: 'none', currentVersion: '1.16.0' });
  });

  it('does not request checks for current, invalid, or unverifiable candidates', async () => {
    const deps = makeDependencies();
    const adapter = new ChromeUpdateAdapter(deps);

    await adapter.hintAvailableVersion(async () => '1.16.0');
    await adapter.hintAvailableVersion(async () => 'invalid');
    await adapter.hintAvailableVersion(async () => null);
    deps.management.getSelf.mockResolvedValue({ installType: 'development' });
    await adapter.hintAvailableVersion(async () => '1.18.0');

    expect(deps.runtime.requestUpdateCheck).not.toHaveBeenCalled();
  });

  it('contains update-check API errors after recording the attempt', async () => {
    const deps = makeDependencies();
    deps.runtime.requestUpdateCheck.mockRejectedValueOnce(new Error('extension disabled'));

    await expect(new ChromeUpdateAdapter(deps).hintAvailableVersion(async () => '1.17.0')).resolves.toBeUndefined();

    expect(deps.runtime.requestUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it('can bind the production browser namespaces by default', async () => {
    const browserApi = browser as any;
    const originalManagement = browserApi.management;
    const originalGetManifest = browserApi.runtime.getManifest;
    browserApi.management = { getSelf: jest.fn().mockResolvedValue({ installType: 'normal' }) };
    browserApi.runtime.getManifest = jest.fn(() => ({ version: '1.16.0' }));
    browserApi.storage.local.remove = jest.fn().mockResolvedValue(undefined);

    await expect(new ChromeUpdateAdapter().check()).resolves.toEqual({ status: 'none', currentVersion: '1.16.0' });

    browserApi.management = originalManagement;
    browserApi.runtime.getManifest = originalGetManifest;
  });
});
