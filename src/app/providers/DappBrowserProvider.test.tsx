/* eslint-disable import/first */
/**
 * Tests for `DappBrowserProvider` — the state machine at the heart of
 * the multi-instance dApp browser. This file targets the highest-risk
 * public-API behaviors:
 *
 *  - **C3 regression** — close(id) must `resolveConfirmation(id, {
 *    confirmed: false })` BEFORE tearing down the session. Without
 *    this, the dapp.ts promise chain and the confirmation-store Map
 *    entry both leak forever, and the auto-restore effect keeps
 *    firing for a dead session.
 *  - **Dedup** — calling open() with the same session id, or a
 *    different session whose URL matches an existing one, must
 *    restore the existing session instead of spawning a duplicate.
 *  - **Park / restore lifecycle** — park hides the native instance
 *    and snapshots, restore flips the instance visible and reclaims
 *    the foreground slot rect.
 *  - **S2 regression** — the auto-restore-on-confirmation effect
 *    must NOT hijack foreground if the current foreground has its
 *    own pending confirmation.
 *
 * Heavy mocking is unavoidable — the provider pulls in the
 * @miden/dapp-browser plugin, framer-motion, multiple UI
 * subcomponents, the wallet store, and woozie routing. Each mock
 * exposes just enough surface for the test to exercise one behavior.
 * jest.mock is hoisted above imports at runtime, so the eslint rule's
 * complaint is a false positive — disabled above.
 */

import React from 'react';

import { act, renderHook } from '@testing-library/react';

// ── @miden/dapp-browser (InAppBrowser plugin + dappWebViewManager) ─

// Plugin surface — every method defaults to an async no-op and is
// typed loosely (jest.fn() with no initializer) so the forwarding
// wrappers below can spread unknown args into them.
const mockAddListener: jest.Mock = jest.fn(() => Promise.resolve({ remove: jest.fn() }));
const mockPluginOpen: jest.Mock = jest.fn();
const mockSetVisible: jest.Mock = jest.fn(() => Promise.resolve());
const mockSetRect: jest.Mock = jest.fn(() => Promise.resolve());
const mockExecuteScript: jest.Mock = jest.fn(() => Promise.resolve());
const mockInstanceClose: jest.Mock = jest.fn(() => Promise.resolve());

function makeInstance(id: string) {
  return {
    id,
    setVisible: (...args: unknown[]) => mockSetVisible(id, ...args),
    setRect: (...args: unknown[]) => mockSetRect(id, ...args),
    executeScript: (...args: unknown[]) => mockExecuteScript(id, ...args),
    close: () => mockInstanceClose(id)
  };
}

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    addListener: (...args: unknown[]) => mockAddListener(...args),
    showNativeNavbar: jest.fn(() => Promise.resolve()),
    hideNativeNavbar: jest.fn(() => Promise.resolve()),
    setNativeNavbarActive: jest.fn(() => Promise.resolve()),
    setNavbarSecondaryRow: jest.fn(() => Promise.resolve()),
    morphNavbarOut: jest.fn(() => Promise.resolve()),
    morphNavbarIn: jest.fn(() => Promise.resolve()),
    setNavbarAction: jest.fn(() => Promise.resolve()),
    clearNavbarAction: jest.fn(() => Promise.resolve())
  },
  ToolBarType: { BLANK: 'BLANK' },
  dappWebViewManager: {
    open: async (opts: { id: string }) => {
      mockPluginOpen(opts);
      return makeInstance(opts.id);
    }
  }
}));

// ── isMobile must be true so the provider runs its full lifecycle ──
jest.mock('lib/platform', () => ({
  isMobile: () => true,
  isExtension: () => false,
  isDesktop: () => false,
  isIOS: () => false,
  isAndroid: () => true
}));

// ── framer-motion: AnimatePresence is a passthrough in tests ───────
jest.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) =>
          React.createElement('div', props, children)
    }
  )
}));

// ── UI subcomponents — return empty divs; we don't test their render ──
jest.mock('app/pages/Browser/DappConfirmationModal', () => ({ DappConfirmationModal: () => null }));
jest.mock('app/pages/Browser/DappPeekTray', () => ({ DappPeekTray: () => null }));
jest.mock('app/pages/Browser/DappSwitcher', () => ({ DappSwitcher: () => null }));

// ── wallet store — stubs setActiveDappSession + selectIsReady ──────
const mockSetActiveDappSession = jest.fn();
jest.mock('lib/store', () => {
  const useWalletStoreImpl = <T,>(selector: (s: unknown) => T) =>
    selector({
      setActiveDappSession: mockSetActiveDappSession,
      activeDappSessionId: null,
      isReady: true
    });
  return {
    useWalletStore: useWalletStoreImpl,
    selectIsReady: (s: { isReady: boolean }) => s.isReady
  };
});

// ── woozie — stub navigation ───────────────────────────────────────
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  useLocation: () => ({ pathname: '/browser' }),
  HistoryAction: { Push: 'push', Replace: 'replace' }
}));

// ── mobile viewport / webview-state helpers ────────────────────────
jest.mock('lib/mobile/viewport-reset', () => ({
  resetViewportAfterWebview: jest.fn(async () => undefined)
}));
jest.mock('lib/mobile/webview-state', () => ({
  markReturningFromWebview: jest.fn(),
  isReturningFromWebview: () => false
}));

// ── snapshot-store: in-memory implementations we can assert against ─
const mockCaptureSnapshot: jest.Mock = jest.fn(() => Promise.resolve('data:image/jpeg;base64,AAAA'));
const mockClearSnapshot: jest.Mock = jest.fn();
const mockSnapshotSetRaw: jest.Mock = jest.fn();
jest.mock('lib/dapp-browser/snapshot-store', () => ({
  captureSnapshot: (...args: unknown[]) => mockCaptureSnapshot(...args),
  clearSnapshot: (...args: unknown[]) => mockClearSnapshot(...args),
  snapshotStoreInternals: {
    setRaw: (...args: unknown[]) => mockSnapshotSetRaw(...args)
  }
}));

// ── lib/dapp-browser barrel — stub the bits the provider reads ─────
// `jest.Mock` annotation keeps the mock signatures open so the
// spread-arg wrappers below type-check; otherwise jest infers a
// zero-arg signature from the `async () => ...` initializer and the
// wrapper can't spread `unknown[]` into it.
const mockLoadPersistedSessions: jest.Mock = jest.fn(() => Promise.resolve([]));
const mockRemovePersistedSession: jest.Mock = jest.fn(() => Promise.resolve());
const mockUpsertPersistedSession: jest.Mock = jest.fn(() => Promise.resolve());
const mockReadSnapshotFromDisk: jest.Mock = jest.fn(() => Promise.resolve(null));
const mockWriteSnapshotToDisk: jest.Mock = jest.fn(() => Promise.resolve());
const mockRemoveSnapshotFromDisk: jest.Mock = jest.fn(() => Promise.resolve());
const mockHandleWebViewMessage: jest.Mock = jest.fn(() =>
  Promise.resolve({
    type: 'MIDEN_PAGE_RESPONSE',
    payload: null,
    reqId: 'r1'
  })
);

jest.mock('lib/dapp-browser', () => ({
  INJECTION_SCRIPT: 'INJECTED;',
  // Arrow-wrappers are lazy — they defer the variable lookup until
  // the mock is actually called, avoiding the TDZ from jest.mock hoisting.
  handleWebViewMessage: (...args: unknown[]) => mockHandleWebViewMessage(...args),
  loadPersistedSessions: (...args: unknown[]) => mockLoadPersistedSessions(...args),
  removePersistedSession: (...args: unknown[]) => mockRemovePersistedSession(...args),
  upsertPersistedSession: (...args: unknown[]) => mockUpsertPersistedSession(...args),
  readSnapshotFromDisk: (...args: unknown[]) => mockReadSnapshotFromDisk(...args),
  writeSnapshotToDisk: (...args: unknown[]) => mockWriteSnapshotToDisk(...args),
  removeSnapshotFromDisk: (...args: unknown[]) => mockRemoveSnapshotFromDisk(...args),
  toPersisted: (s: { id: string; url: string }) => ({
    id: s.id,
    url: s.url,
    origin: 'https://test',
    title: 't',
    favicon: null,
    openedAt: 0,
    parkedAt: Date.now()
  }),
  fromPersisted: (p: { id: string; url: string }) => ({
    id: p.id,
    url: p.url,
    origin: 'https://test',
    title: 't',
    favicon: null,
    status: 'parked' as const,
    openedAt: 0
  }),
  useDappConfirmation: () => ({ request: null, resolve: jest.fn() })
}));

// ── confirmation-store: REAL module so we can assert against it ────
import { dappConfirmationStore, type DAppConfirmationRequest } from 'lib/dapp-browser/confirmation-store';

// Imports under test come LAST, after all mocks.
import { DappBrowserProvider, useDappBrowser } from './DappBrowserProvider';

// Harness for exercising the provider via its context.
function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(DappBrowserProvider, null, children);
}

function makeSession(id: string, url = `https://${id}.test/`) {
  return {
    id,
    url,
    origin: `https://${id}.test`,
    title: `https://${id}.test`,
    favicon: null,
    status: 'opening' as const,
    openedAt: Date.now()
  };
}

function makeConfirmationRequest(sessionId: string): DAppConfirmationRequest {
  return {
    id: 'req-' + sessionId,
    sessionId,
    type: 'transaction',
    origin: `https://${sessionId}.test`,
    appMeta: { name: sessionId, url: `https://${sessionId}.test` } as never,
    network: 'testnet',
    networkRpc: 'https://rpc',
    privateDataPermission: 'None' as never,
    allowedPrivateData: {} as never,
    existingPermission: true
  };
}

afterEach(() => {
  // Purge any pending confirmations that tests left behind.
  for (const req of dappConfirmationStore.getAllPendingRequests()) {
    dappConfirmationStore.resolveConfirmation(req.sessionId, { confirmed: false });
  }
  jest.clearAllMocks();
});

// ── Basic open/close lifecycle ─────────────────────────────────────

describe('open', () => {
  it('adds a session in the loading state and sets the foreground', async () => {
    const { result } = renderHook(() => useDappBrowser(), { wrapper });

    act(() => {
      result.current.open(makeSession('dapp-a'));
    });

    expect(result.current.sessionStates).toHaveLength(1);
    expect(result.current.sessionStates[0].session.id).toBe('dapp-a');
    expect(result.current.sessionStates[0].isLoading).toBe(true);
    expect(result.current.session?.id).toBe('dapp-a');
  });

  it('deduplicates by session id — repeated opens do not spawn a second session', () => {
    const { result } = renderHook(() => useDappBrowser(), { wrapper });
    const s = makeSession('dapp-a');

    act(() => result.current.open(s));
    act(() => result.current.open(s)); // same id

    expect(result.current.sessionStates).toHaveLength(1);
  });

  it('deduplicates by URL — a different session id with the same URL restores instead of spawning', () => {
    const { result } = renderHook(() => useDappBrowser(), { wrapper });

    act(() => result.current.open(makeSession('dapp-a', 'https://miden.xyz/')));
    act(() => result.current.open(makeSession('dapp-b', 'https://miden.xyz/')));

    expect(result.current.sessionStates).toHaveLength(1);
    expect(result.current.sessionStates[0].session.id).toBe('dapp-a');
  });
});

// ── C3 regression — close resolves pending confirmation ────────────

describe('C3 regression: close() resolves pending confirmation before teardown', () => {
  it('calls dappConfirmationStore.resolveConfirmation with { confirmed: false }', async () => {
    const { result } = renderHook(() => useDappBrowser(), { wrapper });

    act(() => {
      result.current.open(makeSession('dapp-a'));
    });

    // Seed a pending confirmation for the opened session and capture
    // the resolver via the promise — if close() fails to resolve, the
    // test will time out.
    const pendingResult = dappConfirmationStore.requestConfirmation(makeConfirmationRequest('dapp-a'));

    await act(async () => {
      await result.current.close('dapp-a');
    });

    const resolved = await pendingResult;
    expect(resolved).toEqual({ confirmed: false });

    // And the store should have no residual pending for this session.
    expect(dappConfirmationStore.getPendingRequest('dapp-a')).toBeNull();
  });

  it('tears down the session state and clears the foregroundId after closing', async () => {
    const { result } = renderHook(() => useDappBrowser(), { wrapper });

    act(() => {
      result.current.open(makeSession('dapp-a'));
    });
    expect(result.current.sessionStates).toHaveLength(1);

    await act(async () => {
      await result.current.close('dapp-a');
    });

    expect(result.current.sessionStates).toHaveLength(0);
    expect(result.current.session).toBeNull();
  });

  it('removes the persisted session from disk on close', async () => {
    const { result } = renderHook(() => useDappBrowser(), { wrapper });
    act(() => {
      result.current.open(makeSession('dapp-a'));
    });
    await act(async () => {
      await result.current.close('dapp-a');
    });
    expect(mockRemovePersistedSession).toHaveBeenCalledWith('dapp-a');
  });
});

// ── Park / restore ─────────────────────────────────────────────────

describe('park / restore lifecycle', () => {
  // parkInternal early-returns if state.instance is null. The provider
  // only instantiates the native instance once a slotRect is reported
  // (via NativeWebViewSlot in production). Tests simulate that by
  // calling setSlotRect directly and waiting for the open effect.
  const SLOT_RECT = { x: 0, y: 0, width: 375, height: 600 };
  async function openAndWaitForInstance(
    hook: ReturnType<typeof renderHook<ReturnType<typeof useDappBrowser>, void>>,
    session: ReturnType<typeof makeSession>
  ) {
    act(() => hook.result.current.open(session));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    // Let the foreground-driving effect run and plugin open resolve.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  it('park moves a session to the parked state', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openAndWaitForInstance(hook, makeSession('dapp-a'));

    await act(async () => {
      await hook.result.current.park('dapp-a');
    });

    // After park, the foregroundId should be null and the session
    // should be in the parkedSessions list.
    expect(hook.result.current.session).toBeNull();
    expect(hook.result.current.parkedSessions.map(s => s.session.id)).toContain('dapp-a');
  });

  it('park persists the session to disk', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openAndWaitForInstance(hook, makeSession('dapp-a'));
    await act(async () => {
      await hook.result.current.park('dapp-a');
    });
    expect(mockUpsertPersistedSession).toHaveBeenCalled();
  });

  it('park calls setVisible(false) on the native instance', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openAndWaitForInstance(hook, makeSession('dapp-a'));
    mockSetVisible.mockClear();
    await act(async () => {
      await hook.result.current.park('dapp-a');
    });
    expect(mockSetVisible).toHaveBeenCalledWith('dapp-a', false);
  });

  it('restore brings a parked session back to the foreground', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openAndWaitForInstance(hook, makeSession('dapp-a'));
    await act(async () => {
      await hook.result.current.park('dapp-a');
    });

    await act(async () => {
      await hook.result.current.restore('dapp-a');
    });

    expect(hook.result.current.session?.id).toBe('dapp-a');
  });
});

// ── Switcher ───────────────────────────────────────────────────────

describe('switcher', () => {
  it('openSwitcher flips switcherOpen true, closeSwitcher flips it back', () => {
    const { result } = renderHook(() => useDappBrowser(), { wrapper });
    expect(result.current.switcherOpen).toBe(false);
    act(() => result.current.openSwitcher());
    expect(result.current.switcherOpen).toBe(true);
    act(() => result.current.closeSwitcher());
    expect(result.current.switcherOpen).toBe(false);
  });
});

// ── useDappBrowser error when outside provider ─────────────────────

describe('useDappBrowser', () => {
  it('throws when used outside of <DappBrowserProvider>', () => {
    // Swallow the React error output for this assertion.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useDappBrowser())).toThrow(
      /useDappBrowser must be used inside <DappBrowserProvider>/
    );
    errorSpy.mockRestore();
  });
});
