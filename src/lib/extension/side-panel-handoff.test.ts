import { isExtension } from 'lib/platform';

import {
  canHandoffToSidePanel,
  closeOnboardingTab,
  openSidePanelToWallet,
  postOnboardingRoute
} from './side-panel-handoff';

jest.mock('lib/platform', () => ({
  isExtension: jest.fn()
}));

const mockIsExtension = isExtension as jest.MockedFunction<typeof isExtension>;

interface ChromeMock {
  storage: { local: { set: jest.Mock } };
  sidePanel: { open: jest.Mock; setPanelBehavior: jest.Mock };
  action: { setPopup: jest.Mock };
  windows: { getLastFocused: jest.Mock };
  tabs: { getCurrent: jest.Mock; query: jest.Mock; remove: jest.Mock };
}

function makeChrome(): ChromeMock {
  return {
    storage: { local: { set: jest.fn().mockResolvedValue(undefined) } },
    sidePanel: {
      open: jest.fn().mockResolvedValue(undefined),
      setPanelBehavior: jest.fn().mockResolvedValue(undefined)
    },
    action: { setPopup: jest.fn() },
    windows: { getLastFocused: jest.fn().mockResolvedValue({ id: 7 }) },
    tabs: {
      getCurrent: jest.fn().mockResolvedValue({ id: 5, windowId: 2 }),
      query: jest.fn().mockResolvedValue([{ id: 5 }, { id: 6 }]),
      remove: jest.fn().mockResolvedValue(undefined)
    }
  };
}

function setChrome(chrome: ChromeMock | undefined): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).chrome = chrome;
}

let warnSpy: jest.SpyInstance;
const originalE2E = process.env.MIDEN_E2E_TEST;
const originalDisable = process.env.MIDEN_E2E_DISABLE_SIDEPANEL;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsExtension.mockReturnValue(true);
  process.env.MIDEN_E2E_TEST = 'false';
  delete process.env.MIDEN_E2E_DISABLE_SIDEPANEL;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setChrome(undefined);
  restoreEnv('MIDEN_E2E_TEST', originalE2E);
  restoreEnv('MIDEN_E2E_DISABLE_SIDEPANEL', originalDisable);
  warnSpy.mockRestore();
});

describe('canHandoffToSidePanel', () => {
  it('is true on an extension with the side panel API', () => {
    setChrome(makeChrome());
    expect(canHandoffToSidePanel()).toBe(true);
  });

  it('is false when the build opts out via MIDEN_E2E_DISABLE_SIDEPANEL', () => {
    process.env.MIDEN_E2E_DISABLE_SIDEPANEL = 'true';
    setChrome(makeChrome());
    expect(canHandoffToSidePanel()).toBe(false);
  });

  it('is unaffected by MIDEN_E2E_TEST alone, so an E2E build can reach the panel', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    setChrome(makeChrome());
    expect(canHandoffToSidePanel()).toBe(true);
  });

  it('ignores a non-"true" value of the opt-out flag', () => {
    process.env.MIDEN_E2E_DISABLE_SIDEPANEL = 'false';
    setChrome(makeChrome());
    expect(canHandoffToSidePanel()).toBe(true);
  });

  it('is false when not running as an extension', () => {
    mockIsExtension.mockReturnValue(false);
    setChrome(makeChrome());
    expect(canHandoffToSidePanel()).toBe(false);
  });

  it('is false when the side panel API is absent (e.g. Firefox)', () => {
    setChrome(undefined);
    expect(canHandoffToSidePanel()).toBe(false);
  });
});

describe('postOnboardingRoute', () => {
  it('routes to the side-panel handoff when handoff is available', () => {
    setChrome(makeChrome());
    expect(postOnboardingRoute()).toBe('/finish-side-panel');
  });

  it('routes in-tab to / when the side panel is unavailable (non-extension)', () => {
    mockIsExtension.mockReturnValue(false);
    setChrome(makeChrome());
    expect(postOnboardingRoute()).toBe('/');
  });

  it('routes in-tab to / when the build opts out of the handoff (classic in-tab flow)', () => {
    process.env.MIDEN_E2E_DISABLE_SIDEPANEL = 'true';
    setChrome(makeChrome());
    expect(postOnboardingRoute()).toBe('/');
  });

  it('still routes to the handoff under MIDEN_E2E_TEST alone', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    setChrome(makeChrome());
    expect(postOnboardingRoute()).toBe('/finish-side-panel');
  });
});

describe('openSidePanelToWallet', () => {
  it('opens the panel for the focused window and enables side-panel mode', async () => {
    const chrome = makeChrome();
    setChrome(chrome);

    await expect(openSidePanelToWallet()).resolves.toBe(true);

    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    expect(chrome.action.setPopup).toHaveBeenCalledWith({ popup: '' });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ sidepanel_mode: true });
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
  });

  it('returns false without side panel support', async () => {
    setChrome(undefined);
    await expect(openSidePanelToWallet()).resolves.toBe(false);
  });

  it('returns false (without switching surface) when opening throws', async () => {
    const chrome = makeChrome();
    chrome.sidePanel.open.mockRejectedValue(new Error('no user gesture'));
    setChrome(chrome);

    await expect(openSidePanelToWallet()).resolves.toBe(false);

    // The panel never opened, so the primary-surface switch must not run —
    // otherwise the toolbar icon would be left popup-less with no panel.
    expect(chrome.action.setPopup).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('returns false when there is no focused window id', async () => {
    const chrome = makeChrome();
    chrome.windows.getLastFocused.mockResolvedValue({});
    setChrome(chrome);

    await expect(openSidePanelToWallet()).resolves.toBe(false);
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
  });

  it('still returns true (panel stays open) when enabling side-panel mode fails', async () => {
    const chrome = makeChrome();
    chrome.sidePanel.setPanelBehavior.mockRejectedValue(new Error('behavior gone'));
    setChrome(chrome);

    // Open succeeded; the post-open surface switch failing is non-fatal.
    await expect(openSidePanelToWallet()).resolves.toBe(true);
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
  });
});

describe('closeOnboardingTab', () => {
  it('closes the onboarding tab when other tabs remain', async () => {
    const chrome = makeChrome();
    setChrome(chrome);

    await expect(closeOnboardingTab()).resolves.toBe(true);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(5);
  });

  it('does not close the last tab in the window (would close the panel)', async () => {
    const chrome = makeChrome();
    chrome.tabs.query.mockResolvedValue([{ id: 5 }]);
    setChrome(chrome);

    await expect(closeOnboardingTab()).resolves.toBe(false);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('returns false when the current tab has no id', async () => {
    const chrome = makeChrome();
    chrome.tabs.getCurrent.mockResolvedValue(undefined);
    setChrome(chrome);

    await expect(closeOnboardingTab()).resolves.toBe(false);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('returns false when there is no tabs API', async () => {
    setChrome(undefined);
    await expect(closeOnboardingTab()).resolves.toBe(false);
  });

  it('returns false and swallows errors', async () => {
    const chrome = makeChrome();
    chrome.tabs.query.mockRejectedValue(new Error('boom'));
    setChrome(chrome);
    await expect(closeOnboardingTab()).resolves.toBe(false);
  });
});
