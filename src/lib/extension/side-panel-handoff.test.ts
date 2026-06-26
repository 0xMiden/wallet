import { renderHook, act } from '@testing-library/react';

import { isExtension } from 'lib/platform';

import {
  abortSidePanelHandoff,
  beginSidePanelHandoff,
  canHandoffToSidePanel,
  clearOnboardingHandoff,
  finishSidePanelHandoff,
  useOnboardingHandoff
} from './side-panel-handoff';

jest.mock('lib/platform', () => ({
  isExtension: jest.fn()
}));

const mockIsExtension = isExtension as jest.MockedFunction<typeof isExtension>;

type StorageChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

interface ChromeMock {
  storage: {
    local: {
      set: jest.Mock;
      get: jest.Mock;
    };
    onChanged: {
      addListener: jest.Mock;
      removeListener: jest.Mock;
    };
  };
  sidePanel: {
    open: jest.Mock;
    setPanelBehavior: jest.Mock;
  };
  action: { setPopup: jest.Mock };
  windows: { getLastFocused: jest.Mock };
  tabs: {
    getCurrent: jest.Mock;
    query: jest.Mock;
    remove: jest.Mock;
  };
}

let changeListeners: StorageChangeListener[];

function makeChrome(initialFlag = false): ChromeMock {
  changeListeners = [];
  return {
    storage: {
      local: {
        set: jest.fn().mockResolvedValue(undefined),
        get: jest.fn((_key: string, cb: (res: Record<string, unknown>) => void) =>
          cb({ onboarding_handoff: initialFlag })
        )
      },
      onChanged: {
        addListener: jest.fn((l: StorageChangeListener) => changeListeners.push(l)),
        removeListener: jest.fn((l: StorageChangeListener) => {
          changeListeners = changeListeners.filter(x => x !== l);
        })
      }
    },
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

beforeEach(() => {
  jest.clearAllMocks();
  mockIsExtension.mockReturnValue(true);
  // The helpers log via console.warn on the (intentionally exercised) failure
  // paths — silence it so the expected errors don't clutter the test output.
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setChrome(undefined);
  warnSpy.mockRestore();
});

describe('canHandoffToSidePanel', () => {
  it('is true on an extension with the side panel API', () => {
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

describe('beginSidePanelHandoff', () => {
  it('opens the panel, enables side-panel mode, and sets the handoff flag', async () => {
    const chrome = makeChrome();
    setChrome(chrome);

    await expect(beginSidePanelHandoff()).resolves.toBe(true);

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      onboarding_handoff: true,
      sidepanel_mode: true
    });
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    expect(chrome.action.setPopup).toHaveBeenCalledWith({ popup: '' });
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
  });

  it('returns false without side panel support', async () => {
    setChrome(undefined);
    await expect(beginSidePanelHandoff()).resolves.toBe(false);
  });

  it('reverts and returns false when opening the panel throws', async () => {
    const chrome = makeChrome();
    chrome.sidePanel.open.mockRejectedValue(new Error('no user gesture'));
    setChrome(chrome);

    await expect(beginSidePanelHandoff()).resolves.toBe(false);

    // abort path: popup restored, mode flag cleared.
    expect(chrome.action.setPopup).toHaveBeenLastCalledWith({ popup: 'popup.html' });
    expect(chrome.storage.local.set).toHaveBeenLastCalledWith({
      onboarding_handoff: false,
      sidepanel_mode: false
    });
  });
});

describe('finishSidePanelHandoff', () => {
  it('clears the flag and closes the onboarding tab when other tabs remain', async () => {
    const chrome = makeChrome();
    setChrome(chrome);

    await expect(finishSidePanelHandoff()).resolves.toBe(true);

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ onboarding_handoff: false });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(5);
  });

  it('does not close the last tab in the window (would close the panel)', async () => {
    const chrome = makeChrome();
    chrome.tabs.query.mockResolvedValue([{ id: 5 }]);
    setChrome(chrome);

    await expect(finishSidePanelHandoff()).resolves.toBe(false);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('returns false when the current tab has no id', async () => {
    const chrome = makeChrome();
    chrome.tabs.getCurrent.mockResolvedValue(undefined);
    setChrome(chrome);

    await expect(finishSidePanelHandoff()).resolves.toBe(false);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('returns false when there is no tabs API', async () => {
    setChrome(undefined);
    await expect(finishSidePanelHandoff()).resolves.toBe(false);
  });

  it('returns false and swallows errors', async () => {
    const chrome = makeChrome();
    chrome.tabs.query.mockRejectedValue(new Error('boom'));
    setChrome(chrome);
    await expect(finishSidePanelHandoff()).resolves.toBe(false);
  });
});

describe('abortSidePanelHandoff', () => {
  it('clears flags and restores popup mode', async () => {
    const chrome = makeChrome();
    setChrome(chrome);

    await abortSidePanelHandoff();

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      onboarding_handoff: false,
      sidepanel_mode: false
    });
    expect(chrome.action.setPopup).toHaveBeenCalledWith({ popup: 'popup.html' });
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
  });

  it('is a no-op without chrome.storage', async () => {
    setChrome(undefined);
    await expect(abortSidePanelHandoff()).resolves.toBeUndefined();
  });

  it('swallows errors thrown while reverting', async () => {
    const chrome = makeChrome();
    chrome.storage.local.set.mockRejectedValue(new Error('storage gone'));
    setChrome(chrome);
    await expect(abortSidePanelHandoff()).resolves.toBeUndefined();
  });
});

describe('clearOnboardingHandoff', () => {
  it('sets the flag to false', () => {
    const chrome = makeChrome();
    setChrome(chrome);
    clearOnboardingHandoff();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ onboarding_handoff: false });
  });

  it('is safe without chrome', () => {
    setChrome(undefined);
    expect(() => clearOnboardingHandoff()).not.toThrow();
  });
});

describe('useOnboardingHandoff', () => {
  it('returns false outside the extension', () => {
    mockIsExtension.mockReturnValue(false);
    setChrome(undefined);
    const { result } = renderHook(() => useOnboardingHandoff());
    expect(result.current).toBe(false);
  });

  it('reflects the initial flag and reacts to storage changes', () => {
    const chrome = makeChrome(true);
    setChrome(chrome);

    const { result, unmount } = renderHook(() => useOnboardingHandoff());
    expect(result.current).toBe(true);

    act(() => {
      changeListeners.forEach(l => l({ onboarding_handoff: { newValue: false } }, 'local'));
    });
    expect(result.current).toBe(false);

    // Ignores other areas / unrelated keys.
    act(() => {
      changeListeners.forEach(l => l({ onboarding_handoff: { newValue: true } }, 'sync'));
      changeListeners.forEach(l => l({ something_else: { newValue: true } }, 'local'));
    });
    expect(result.current).toBe(false);

    unmount();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalled();
  });
});
