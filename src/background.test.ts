/* eslint-disable import/first */
// Type-only import (erased at runtime) that marks this file as a module, so its
// top-level `const`/`let` declarations are module-scoped rather than leaking
// into the global scope shared with other non-module test files — which would
// otherwise trigger TS2451 redeclare errors for `flush`/`warnSpy`/`logSpy`.
import type {} from 'webextension-polyfill';
/**
 * Coverage tests for `src/background.ts` — the MV3 service-worker entry module.
 *
 * Everything in `background.ts` runs at module scope: it wires up browser
 * event listeners, optionally restores the Chrome side-panel preference, and
 * chains the SyncManager / transaction-processor setup after `start()`. There
 * are no exports — the whole surface is import-time side effects — so we drive
 * it by (re)requiring the module under different `process.env.TARGET_BROWSER`
 * values and then firing the captured listeners.
 *
 * The heavy `lib/miden/back/*` modules and the `xhr-shim` side-effect import are
 * mocked so requiring `background.ts` neither boots the real WASM client nor
 * installs the XHR shim. `webextension-polyfill` is mocked with a listener-
 * capturing stub (the shared `__mocks__/webextension-polyfill.ts` lacks
 * `alarms` / `notifications` / `browserAction`, which this module needs).
 */

// ── Spies for the mocked back-end modules (must be `mock*`-prefixed so the
//    hoisted `jest.mock` factories may reference them) ──────────────────────

const mockStart = jest.fn(() => Promise.resolve());
const mockDoSync = jest.fn(() => Promise.resolve());
const mockSetupSyncManager = jest.fn();
const mockSetupTransactionProcessor = jest.fn();

jest.mock('./xhr-shim', () => ({}));

jest.mock('lib/miden/back/main', () => ({
  start: (...args: unknown[]) => mockStart(...(args as [])) as Promise<void>
}));

jest.mock('lib/miden/back/sync-manager', () => ({
  doSync: (...args: unknown[]) => mockDoSync(...(args as [])) as Promise<void>,
  setupSyncManager: (...args: unknown[]) => mockSetupSyncManager(...(args as []))
}));

jest.mock('lib/miden/back/transaction-processor', () => ({
  setupTransactionProcessor: (...args: unknown[]) => mockSetupTransactionProcessor(...(args as []))
}));

// ── Listener-capturing `webextension-polyfill` stub ─────────────────────────

interface CapturedEvent {
  listeners: Array<(...args: any[]) => any>;
  addListener: (fn: (...args: any[]) => any) => void;
  removeListener: (fn: (...args: any[]) => any) => void;
}

jest.mock('webextension-polyfill', () => {
  const makeEvent = (): CapturedEvent => {
    const listeners: Array<(...args: any[]) => any> = [];
    return {
      listeners,
      addListener: fn => {
        listeners.push(fn);
      },
      removeListener: fn => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      }
    };
  };

  const runtime = {
    onUpdateAvailable: makeEvent(),
    reload: jest.fn(),
    getURL: jest.fn((path: string) => `chrome-extension://test-id/${path}`)
  };
  const tabs = { create: jest.fn() };
  const alarms = { onAlarm: makeEvent() };
  const notifications = { onClicked: makeEvent(), clear: jest.fn() };
  const browserAction = { onClicked: makeEvent() };

  const browser = { runtime, tabs, alarms, notifications, browserAction };

  return { __esModule: true, default: browser, runtime, tabs, alarms, notifications, browserAction };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

type Polyfill = {
  runtime: { onUpdateAvailable: CapturedEvent; reload: jest.Mock; getURL: jest.Mock };
  tabs: { create: jest.Mock };
  alarms: { onAlarm: CapturedEvent };
  notifications: { onClicked: CapturedEvent; clear: jest.Mock };
  browserAction: { onClicked: CapturedEvent };
};

/** Fire every listener registered on a captured event. */
const fire = (event: CapturedEvent, ...args: any[]) => event.listeners.forEach(fn => fn(...args));

/** Run a macrotask so microtask chains (`start().then`, promise `.catch`) settle. */
const flush = () => new Promise<void>(res => setTimeout(res, 0));

const ORIGINAL_TARGET_BROWSER = process.env.TARGET_BROWSER;
const ORIGINAL_CHROME = (globalThis as any).chrome;

/**
 * Reset the module registry, apply the requested `TARGET_BROWSER` + `chrome`
 * globals, (re)require `background.ts` so its top-level code runs afresh, and
 * return the shared polyfill stub instance the module wired its listeners onto.
 */
const loadBackground = (opts: { target?: string; chrome?: any } = {}): Polyfill => {
  jest.resetModules();

  mockStart.mockClear();
  mockDoSync.mockClear();
  mockSetupSyncManager.mockClear();
  mockSetupTransactionProcessor.mockClear();

  if (opts.target === undefined) {
    delete process.env.TARGET_BROWSER;
  } else {
    process.env.TARGET_BROWSER = opts.target;
  }

  if ('chrome' in opts) {
    (globalThis as any).chrome = opts.chrome;
  } else {
    delete (globalThis as any).chrome;
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./background');

  // Same registry ⇒ the module we grab here is the exact instance the module
  // under test imported and attached its listeners to.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('webextension-polyfill') as Polyfill;
};

/** Build a controllable `chrome` global for the side-panel restore branch. */
const makeChromeStub = (getResult: Record<string, unknown>, panelBehavior: 'resolve' | 'reject') => ({
  storage: {
    local: {
      get: jest.fn((_key: string, cb: (result: Record<string, unknown>) => void) => cb(getResult)),
      set: jest.fn()
    }
  },
  action: { setPopup: jest.fn() },
  sidePanel: {
    setPanelBehavior: jest.fn(() =>
      panelBehavior === 'resolve' ? Promise.resolve() : Promise.reject(new Error('panel boom'))
    )
  }
});

let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

afterAll(() => {
  if (ORIGINAL_TARGET_BROWSER === undefined) {
    delete process.env.TARGET_BROWSER;
  } else {
    process.env.TARGET_BROWSER = ORIGINAL_TARGET_BROWSER;
  }
  if (ORIGINAL_CHROME === undefined) {
    delete (globalThis as any).chrome;
  } else {
    (globalThis as any).chrome = ORIGINAL_CHROME;
  }
});

// ── Chrome side-panel restore branch ────────────────────────────────────────

describe('background.ts — Chrome side-panel restore', () => {
  it('enables open-on-action-click when sidepanel_mode was saved and setup succeeds', async () => {
    const chrome = makeChromeStub({ sidepanel_mode: true }, 'resolve');
    loadBackground({ target: 'chrome', chrome });
    await flush();

    expect(chrome.storage.local.get).toHaveBeenCalledWith('sidepanel_mode', expect.any(Function));
    expect(chrome.action.setPopup).toHaveBeenCalledWith({ popup: '' });
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    // Success path: no revert, no warning.
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reverts to the popup and disables sidepanel_mode when panel setup rejects', async () => {
    const chrome = makeChromeStub({ sidepanel_mode: true }, 'reject');
    loadBackground({ target: 'chrome', chrome });
    await flush();

    // First call opens the panel (empty popup), the catch restores 'popup.html'.
    expect(chrome.action.setPopup).toHaveBeenNthCalledWith(1, { popup: '' });
    expect(chrome.action.setPopup).toHaveBeenNthCalledWith(2, { popup: 'popup.html' });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ sidepanel_mode: false });
    expect(warnSpy).toHaveBeenCalledWith(
      '[Background] Side panel restore failed, reverting to popup:',
      expect.any(Error)
    );
  });

  it('does nothing when sidepanel_mode was not saved', async () => {
    const chrome = makeChromeStub({}, 'resolve');
    loadBackground({ target: 'chrome', chrome });
    await flush();

    expect(chrome.storage.local.get).toHaveBeenCalledTimes(1);
    expect(chrome.action.setPopup).not.toHaveBeenCalled();
    expect(chrome.sidePanel.setPanelBehavior).not.toHaveBeenCalled();
  });

  it('skips the side-panel restore entirely on non-chrome targets', () => {
    const chrome = makeChromeStub({ sidepanel_mode: true }, 'resolve');
    // firefox: the `chrome` global is present but the TARGET_BROWSER guard is false.
    loadBackground({ target: 'firefox', chrome });

    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });
});

// ── Always-registered listeners (target-independent) ────────────────────────

describe('background.ts — core service-worker listeners', () => {
  it('reloads the runtime when an update becomes available', () => {
    const wep = loadBackground({ target: 'firefox' });
    expect(wep.runtime.reload).not.toHaveBeenCalled();

    fire(wep.runtime.onUpdateAvailable);

    expect(wep.runtime.reload).toHaveBeenCalledTimes(1);
  });

  it('runs a sync when the miden-sync alarm fires', () => {
    const wep = loadBackground({ target: 'firefox' });

    fire(wep.alarms.onAlarm, { name: 'miden-sync' });

    expect(mockDoSync).toHaveBeenCalledTimes(1);
  });

  it('logs a warning when the alarm-triggered sync rejects', async () => {
    const wep = loadBackground({ target: 'firefox' });
    const err = new Error('sync failed');
    mockDoSync.mockReturnValueOnce(Promise.reject(err));

    fire(wep.alarms.onAlarm, { name: 'miden-sync' });
    await flush();

    expect(mockDoSync).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('[SyncManager] Alarm sync error:', err);
  });

  it('ignores alarms other than miden-sync (e.g. the keepalive)', () => {
    const wep = loadBackground({ target: 'firefox' });

    fire(wep.alarms.onAlarm, { name: 'miden-tx-processor' });

    expect(mockDoSync).not.toHaveBeenCalled();
  });

  it('sets up the sync manager and transaction processor after start() resolves', async () => {
    loadBackground({ target: 'firefox' });

    expect(mockStart).toHaveBeenCalledTimes(1);
    // The setup calls are chained off start().then, i.e. a microtask later.
    expect(mockSetupSyncManager).not.toHaveBeenCalled();

    await flush();

    expect(mockSetupSyncManager).toHaveBeenCalledTimes(1);
    expect(mockSetupTransactionProcessor).toHaveBeenCalledTimes(1);
  });

  it('opens the receive full page when a notification is clicked', () => {
    const wep = loadBackground({ target: 'firefox' });

    fire(wep.notifications.onClicked, 'note-123');

    expect(wep.notifications.clear).toHaveBeenCalledWith('note-123');
    expect(wep.runtime.getURL).toHaveBeenCalledWith('fullpage.html#/receive');
    expect(wep.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-id/fullpage.html#/receive'
    });
  });
});

// ── Safari browser-action ────────────────────────────────────────────────────

describe('background.ts — Safari browser action', () => {
  it('opens the full page when the Safari toolbar button is clicked', () => {
    const wep = loadBackground({ target: 'safari' });

    // Listener is only registered on Safari.
    expect(wep.browserAction.onClicked.listeners).toHaveLength(1);

    fire(wep.browserAction.onClicked);

    expect(wep.runtime.getURL).toHaveBeenCalledWith('fullpage.html');
    expect(wep.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-id/fullpage.html'
    });
  });

  it('does not register the browser-action listener on non-safari targets', () => {
    const wep = loadBackground({ target: 'chrome', chrome: makeChromeStub({}, 'resolve') });

    expect(wep.browserAction.onClicked.listeners).toHaveLength(0);
  });
});
