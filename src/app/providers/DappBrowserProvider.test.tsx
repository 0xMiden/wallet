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

import { act, renderHook, waitFor } from '@testing-library/react';

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
const mockNativeClose = jest.fn(async (_options: unknown) => {});
const mockMorph: jest.Mock = jest.fn(async () => ({ accepted: false }));

function makeInstance(id: string) {
  return {
    id,
    setVisible: (...args: unknown[]) => mockSetVisible(id, ...args),
    setRect: (...args: unknown[]) => mockSetRect(id, ...args),
    executeScript: (...args: unknown[]) => mockExecuteScript(id, ...args),
    morph: (...args: unknown[]) => mockMorph(id, ...args),
    close: () => mockInstanceClose(id)
  };
}

jest.mock('app/icons/brand/new-bread.svg?raw', () => '<svg />', { virtual: true });

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    close: (options: unknown) => mockNativeClose(options),
    completeManagedClose: jest.fn(async () => {}),
    addListener: (...args: unknown[]) => mockAddListener(...args)
  },
  ToolBarType: { BLANK: 'BLANK' },
  dappWebViewManager: {
    reserveClose: jest.fn(),
    forget: jest.fn(),
    open: async (opts: { id: string }) => {
      await mockPluginOpen(opts);
      return makeInstance(opts.id);
    }
  }
}));

const mockReportUserVisibleError = jest.fn();
jest.mock('lib/telemetry/user-visible-error', () => ({
  reportUserVisibleError: (...args: unknown[]) => mockReportUserVisibleError(...args)
}));

// ── isMobile must be true so the provider runs its full lifecycle ──
const mockIsMobile = jest.fn(() => true);
const mockIsIOS = jest.fn(() => false);
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile(),
  isExtension: () => false,
  isDesktop: () => false,
  isIOS: () => mockIsIOS(),
  isAndroid: () => !mockIsIOS()
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
// The confirmation modal records its props, so a test can drive the onResolve the provider hands it.
let mockModalProps: { onResolve: (result: { confirmed: boolean }, requestId: string) => void } | null = null;
jest.mock('app/pages/Browser/DappConfirmationModal', () => ({
  DappConfirmationModal: (props: { onResolve: (result: { confirmed: boolean }, requestId: string) => void }) => {
    mockModalProps = props;
    return null;
  }
}));
jest.mock('app/pages/Browser/DappPeekTray', () => ({ DappPeekTray: () => null }));
jest.mock('app/pages/Browser/DappSwitcher', () => ({ DappSwitcher: () => null }));

// ── wallet store — stubs setActiveDappSession + selectIsReady ──────
const mockSetActiveDappSession = jest.fn();
jest.mock('lib/store', () => {
  const useWalletStoreImpl = <T,>(selector: (s: unknown) => T) =>
    selector({
      setActiveDappSession: mockSetActiveDappSession,
      activeDappSessionId: null,
      isReady: true,
      isInitialized: true
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
const mockGetSnapshot = jest.fn();
const mockSnapshotSetRaw: jest.Mock = jest.fn();
jest.mock('lib/dapp-browser/snapshot-store', () => ({
  captureSnapshot: (...args: unknown[]) => mockCaptureSnapshot(...args),
  clearSnapshot: (...args: unknown[]) => mockClearSnapshot(...args),
  getSnapshot: (id: string) => mockGetSnapshot(id),
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

// A pending dApp confirmation for the foreground session; tests set it and rerender.
let mockConfirmationRequest: unknown = null;
const mockConfirmationResolve = jest.fn();

jest.mock('lib/dapp-browser', () => ({
  INJECTION_SCRIPT: 'INJECTED;',
  // Real implementation — the provider derives a session's security principal
  // with it, so a stub would make the origin assertions vacuous.
  parseOrigin: (url: string) => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  },
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
  useDappConfirmation: () => ({ request: mockConfirmationRequest, resolve: mockConfirmationResolve })
}));

// ── confirmation-store: REAL module so we can assert against it ────
import { dappConfirmationStore, type DAppConfirmationRequest } from 'lib/dapp-browser/confirmation-store';
// ── screen-key: REAL module — the E2E signal under test below ──────
import { getCurrentScreen, setRoutePart, __resetScreenKeyForTest } from 'lib/e2e/screen-key';
import { getEffectiveFaucetUrl } from 'lib/miden-chain/effective-endpoints';
import { onExternalPageFailed } from 'lib/mobile/external-page-failed';
import { faucetNoTopInsetScript } from 'lib/mobile/faucet-top-inset';
import { useHideDappBubblesWhileOpen } from 'lib/mobile/useHideDappBubblesWhileOpen';
import { DialogsProvider } from 'lib/ui/dialog';

// Imports under test come LAST, after all mocks.
import { DappBrowserProvider, useDappBrowser, useHideForegroundDappWhileOpen } from './DappBrowserProvider';

// Harness for exercising the provider via its context.
function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(DialogsProvider, null, React.createElement(DappBrowserProvider, null, children));
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
    expect(result.current.sessionStates[0]!.session.id).toBe('dapp-a');
    expect(result.current.sessionStates[0]!.isLoading).toBe(true);
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
    expect(result.current.sessionStates[0]!.session.id).toBe('dapp-a');
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

describe('confirmation modal', () => {
  afterEach(() => {
    mockConfirmationRequest = null;
    mockModalProps = null;
  });

  it('resolves through the hook with the id of the request the modal decided', () => {
    mockConfirmationRequest = makeConfirmationRequest('dapp-a');
    renderHook(() => useDappBrowser(), { wrapper });

    mockModalProps!.onResolve({ confirmed: true }, 'req-dapp-a');

    expect(mockConfirmationResolve).toHaveBeenCalledWith({ confirmed: true }, 'req-dapp-a');
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

  it('parks the foreground once its surface clears the slot rect, as leaving the browser page does', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openAndWaitForInstance(hook, makeSession('dapp-a'));
    mockSetVisible.mockClear();

    act(() => hook.result.current.setSlotRect(null));

    await waitFor(() => expect(hook.result.current.parkedSessions.map(s => s.session.id)).toContain('dapp-a'));
    expect(hook.result.current.session).toBeNull();
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

  it('restores a dApp that was minimized while its surface was still measuring the slot', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openAndWaitForInstance(hook, makeSession('dapp-a'));
    let releaseSnapshot: (dataUrl: string) => void = () => undefined;
    mockCaptureSnapshot.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          releaseSnapshot = resolve;
        })
    );

    let parking: Promise<void> = Promise.resolve();
    // Async: the park asks native for the morph first, and starts the snapshot once that is refused.
    await act(async () => {
      parking = hook.result.current.park('dapp-a');
    });
    // DappActive re-measures the slot on timers after it mounts, so a minimize right after opening can land one
    // while park waits for the snapshot.
    act(() => hook.result.current.setSlotRect({ ...SLOT_RECT }));
    await act(async () => {
      releaseSnapshot('data:image/jpeg;base64,AAAA');
      await parking;
    });
    // Parking swaps DappActive for the launcher, and its unmount clears the slot.
    act(() => hook.result.current.setSlotRect(null));
    mockCaptureSnapshot.mockClear();
    mockSetVisible.mockClear();

    await act(async () => {
      await hook.result.current.restore('dapp-a');
    });
    expect(hook.result.current.session?.id).toBe('dapp-a');
    expect(mockCaptureSnapshot).not.toHaveBeenCalled();

    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await waitFor(() => expect(mockSetVisible).toHaveBeenCalledWith('dapp-a', true));
    expect(hook.result.current.session?.id).toBe('dapp-a');
  });
});

describe('bridge traffic', () => {
  const SLOT_RECT = { x: 0, y: 0, width: 375, height: 600 };
  const LANDSCAPE = { x: 0, y: 0, width: 667, height: 375 };
  const flush = () =>
    act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  const hides = (id: string) =>
    mockSetVisible.mock.calls.filter(([callId, visible]) => callId === id && !visible).length;
  const injections = (id: string) =>
    mockExecuteScript.mock.calls.filter(([callId, code]) => callId === id && code === 'INJECTED;').length;

  async function openTwo() {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.open(makeSession('dapp-a')));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await flush();
    act(() => hook.result.current.open(makeSession('dapp-b')));
    await flush();
    return hook;
  }

  it('keeps the same slotRect object for an equal rect', () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.setSlotRect({ ...SLOT_RECT }));
    const first = hook.result.current.slotRect;

    act(() => hook.result.current.setSlotRect({ ...SLOT_RECT }));
    expect(hook.result.current.slotRect).toBe(first);

    act(() => hook.result.current.setSlotRect(LANDSCAPE));
    expect(hook.result.current.slotRect).toEqual(LANDSCAPE);
  });

  it('does not re-send hides to other instances when the slot rect value repeats', async () => {
    const hook = await openTwo();
    mockSetVisible.mockClear();

    act(() => hook.result.current.setSlotRect({ ...SLOT_RECT }));
    await flush();

    expect(hides('dapp-a')).toBe(0);
  });

  it('does not re-send hides to other instances when the slot rect changes', async () => {
    const hook = await openTwo();
    mockSetVisible.mockClear();

    act(() => hook.result.current.setSlotRect(LANDSCAPE));
    await flush();

    expect(hides('dapp-a')).toBe(0);
  });

  it('injects the bridge once per foreground change, not per rect change', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.open(makeSession('dapp-a')));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await flush();
    const loaded = mockAddListener.mock.calls.find(call => call[0] === 'browserPageLoaded')?.[1];
    await act(async () => loaded?.({ id: 'dapp-a' }));
    mockExecuteScript.mockClear();

    act(() => hook.result.current.setSlotRect(LANDSCAPE));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await flush();
    expect(injections('dapp-a')).toBe(0);

    await act(async () => hook.result.current.park('dapp-a'));
    await act(async () => hook.result.current.restore('dapp-a'));
    act(() => hook.result.current.setSlotRect(LANDSCAPE));
    await flush();
    expect(injections('dapp-a')).toBe(1);
  });
});

// ── SEC-03: the security principal must follow the page actually loaded ──

describe('session origin is derived from the URL being loaded, not a carried-over value', () => {
  const SLOT_RECT = { x: 0, y: 0, width: 375, height: 600 };

  /** Pull a plugin listener registered by the provider's one wiring effect. */
  function listenerFor(event: string): (e: unknown) => void | Promise<void> {
    const call = mockAddListener.mock.calls.find(c => c[0] === event);
    if (!call) throw new Error(`no listener registered for ${event}`);
    return call[1] as (e: unknown) => void | Promise<void>;
  }

  async function settle() {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  it('a cold restore is stamped with the origin of session.url, not the persisted origin', async () => {
    // The pair a pre-fix park could persist: the user opened evil.example, which
    // navigated to gooddapp.io, so the LIVE origin was gooddapp.io while
    // `session.url` still pointed at evil.example. A restore loads `session.url`.
    mockLoadPersistedSessions.mockResolvedValueOnce([
      {
        id: 'dapp-cold',
        url: 'https://evil.example/',
        origin: 'https://gooddapp.io',
        title: 'Good dApp',
        favicon: null,
        openedAt: 1,
        parkedAt: 2
      }
    ]);
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await settle();
    expect(hook.result.current.sessionStates).toHaveLength(1);

    await act(async () => {
      await hook.result.current.restore('dapp-cold');
    });
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await settle();

    // The native webview was pointed at evil.example …
    expect(mockPluginOpen).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://evil.example/' }));
    // … so that is the principal its requests are authorized against.
    expect(hook.result.current.sessionStates[0]!.origin).toBe('https://evil.example');
    expect(hook.result.current.sessionStates[0]!.originConfirmed).toBe(false);
  });

  it('refuses a dApp request that arrives before urlChangeEvent confirms the load', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.open(makeSession('dapp-a', 'https://dapp-a.test/')));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await settle();

    const onMessage = listenerFor('messageFromWebview');
    mockExecuteScript.mockClear();

    await act(async () => {
      await onMessage({
        id: 'dapp-a',
        detail: JSON.stringify({
          type: 'MIDEN_PAGE_REQUEST',
          payload: { type: 'PRIVATE_NOTES_REQUEST' },
          reqId: 'r1'
        })
      });
    });

    expect(mockHandleWebViewMessage).not.toHaveBeenCalled();
    const refusal = mockExecuteScript.mock.calls.map(c => String(c[1])).join('\n');
    expect(refusal).toContain('NOT_GRANTED');
  });

  it('answers PING before confirmation — it is the bridge probe, not an origin-scoped request', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.open(makeSession('dapp-a', 'https://dapp-a.test/')));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await settle();

    const onMessage = listenerFor('messageFromWebview');
    await act(async () => {
      await onMessage({
        id: 'dapp-a',
        detail: JSON.stringify({ type: 'MIDEN_PAGE_REQUEST', payload: 'PING', reqId: 'p1' })
      });
    });

    expect(mockHandleWebViewMessage).toHaveBeenCalledTimes(1);
  });

  it('handles the request once urlChangeEvent confirms it, and moves url + origin together', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.open(makeSession('dapp-a', 'https://dapp-a.test/')));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await settle();

    act(() => {
      void listenerFor('urlChangeEvent')({ id: 'dapp-a', url: 'https://moved.example/app' });
    });
    await settle();

    // url and origin are rewritten as a pair — a park would otherwise persist the
    // new origin next to the old url.
    expect(hook.result.current.sessionStates[0]!.session.url).toBe('https://moved.example/app');
    expect(hook.result.current.sessionStates[0]!.session.origin).toBe('https://moved.example');
    expect(hook.result.current.sessionStates[0]!.origin).toBe('https://moved.example');

    await act(async () => {
      await listenerFor('messageFromWebview')({
        id: 'dapp-a',
        detail: JSON.stringify({
          type: 'MIDEN_PAGE_REQUEST',
          payload: { type: 'PRIVATE_NOTES_REQUEST' },
          reqId: 'r2'
        })
      });
    });

    expect(mockHandleWebViewMessage).toHaveBeenCalledWith(expect.anything(), 'https://moved.example', 'dapp-a');
  });
});

// #1416: a wait lasts up to five minutes and the next document numbers its requests from req_1 too.

describe('an answer goes only to the origin that asked (#1416)', () => {
  const SLOT_RECT = { x: 0, y: 0, width: 375, height: 600 };
  const WAIT = JSON.stringify({
    type: 'MIDEN_PAGE_REQUEST',
    payload: { type: 'WAIT_FOR_TRANSACTION_REQUEST', txId: 'tx-1' },
    reqId: 'req_1'
  });

  function listenerFor(event: string): (e: unknown) => void | Promise<void> {
    const call = mockAddListener.mock.calls.find(c => c[0] === event);
    if (!call) throw new Error(`no listener registered for ${event}`);
    return call[1] as (e: unknown) => void | Promise<void>;
  }

  async function settle() {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  async function navigate(url: string) {
    act(() => {
      void listenerFor('urlChangeEvent')({ id: 'dapp-a', url });
    });
    await settle();
  }

  const answers = () =>
    mockExecuteScript.mock.calls.map(c => String(c[1])).filter(code => code.includes('__midenWalletResponse'));

  // Opens dapp-a with its origin confirmed and starts a wait whose answer the test releases.
  async function startWait(): Promise<{ release: () => void; handled: Promise<void> }> {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.open(makeSession('dapp-a', 'https://dapp-a.test/')));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await settle();
    await navigate('https://dapp-a.test/');
    let release: () => void = () => undefined;
    mockHandleWebViewMessage.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () =>
            resolve({ type: 'MIDEN_PAGE_RESPONSE', payload: { outputNotes: ['private-note'] }, reqId: 'req_1' });
        })
    );
    mockExecuteScript.mockClear();
    const handled = Promise.resolve(listenerFor('messageFromWebview')({ id: 'dapp-a', detail: WAIT }));
    await settle();
    return { release: () => release(), handled };
  }

  async function finish(wait: { release: () => void; handled: Promise<void> }) {
    await act(async () => {
      wait.release();
      await wait.handled;
    });
  }

  it('delivers the answer while the instance still shows the origin that asked', async () => {
    const wait = await startWait();
    await finish(wait);
    expect(answers()).toHaveLength(1);
    expect(answers()[0]).toContain('private-note');
  });

  it('still delivers it after a route change within the same origin', async () => {
    const wait = await startWait();
    await navigate('https://dapp-a.test/history');
    await finish(wait);
    expect(answers()).toHaveLength(1);
  });

  it('drops it once the instance shows another origin', async () => {
    const wait = await startWait();
    await navigate('https://evil.example/');
    await finish(wait);
    expect(mockHandleWebViewMessage).toHaveBeenCalledWith(expect.anything(), 'https://dapp-a.test', 'dapp-a');
    expect(answers()).toEqual([]);
  });

  // Evaluates an answer script in a document of `origin`, returning the response hook it may call.
  function runIn(code: string, origin: string): jest.Mock {
    const hook = jest.fn();
    // eslint-disable-next-line no-new-func -- runs the shipped script, as the WebView does
    new Function('location', 'window', code)({ origin }, { __midenWalletResponse: hook });
    return hook;
  }

  // A navigation can commit after the host-side check and before the script is evaluated.
  it('hands the answer over only in a document of the origin that asked', async () => {
    const wait = await startWait();
    await finish(wait);
    expect(answers()).toHaveLength(1);
    const asked = runIn(answers()[0]!, 'https://dapp-a.test');
    expect(asked).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(asked.mock.calls[0]![0]))).toEqual({
      type: 'MIDEN_PAGE_RESPONSE',
      payload: { outputNotes: ['private-note'] },
      reqId: 'req_1'
    });
    expect(runIn(answers()[0]!, 'https://evil.example')).not.toHaveBeenCalled();
  });

  it('never confirms an opaque document, so its requests get the refusal', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.open(makeSession('dapp-a', 'https://dapp-a.test/')));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await settle();
    await navigate('https://dapp-a.test/');
    await navigate('data:text/html,<h1>hi</h1>');
    mockExecuteScript.mockClear();
    await act(async () => {
      await listenerFor('messageFromWebview')({ id: 'dapp-a', detail: WAIT });
    });
    expect(answers()).toHaveLength(1);
    expect(answers()[0]).toContain('NOT_GRANTED');
    expect(mockHandleWebViewMessage).not.toHaveBeenCalled();
    expect(hook.result.current.sessionStates[0]!.originConfirmed).toBe(false);
  });

  it('delivers the PONG to a PING sent before the origin is confirmed, in any document', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.open(makeSession('dapp-a', 'https://dapp-a.test/')));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await settle();
    mockHandleWebViewMessage.mockResolvedValueOnce({ type: 'MIDEN_PAGE_RESPONSE', payload: 'PONG', reqId: 'p1' });
    mockExecuteScript.mockClear();
    await act(async () => {
      await listenerFor('messageFromWebview')({
        id: 'dapp-a',
        detail: JSON.stringify({ type: 'MIDEN_PAGE_REQUEST', payload: 'PING', reqId: 'p1' })
      });
    });
    expect(answers()).toHaveLength(1);
    expect(answers()[0]).toContain('PONG');
    // It carries no data, so it is not bound to the origin the session was opened at.
    expect(runIn(answers()[0]!, 'https://redirected.example')).toHaveBeenCalledTimes(1);
  });
});

// ── The faucet's top inset style ──────────────────────────────────

describe('faucet top inset style', () => {
  const SLOT_RECT = { x: 0, y: 0, width: 375, height: 600 };
  // The suite runs on the build's network, which has a faucet.
  const FAUCET_URL = getEffectiveFaucetUrl() ?? '';
  const FAUCET_SCRIPT = faucetNoTopInsetScript(new URL(FAUCET_URL).origin);

  function listenerFor(event: string): (e: unknown) => void | Promise<void> {
    const call = mockAddListener.mock.calls.find(c => c[0] === event);
    if (!call) throw new Error(`no listener registered for ${event}`);
    return call[1] as (e: unknown) => void | Promise<void>;
  }

  async function settle() {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  // Matched by the style id, not the exact script: the script embeds the origin it was built for, so an exact
  // match never counts one built for another origin and the negative cases could not see it.
  const faucetInjections = () =>
    mockExecuteScript.mock.calls.filter(c => typeof c[1] === 'string' && c[1].includes('miden-faucet-no-top-inset'));

  async function openAt(url: string) {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.open(makeSession('dapp-a', url)));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await settle();
    return hook;
  }

  async function confirmUrl(url: string) {
    act(() => {
      void listenerFor('urlChangeEvent')({ id: 'dapp-a', url });
    });
    await settle();
  }

  async function loadPage() {
    await act(async () => {
      await listenerFor('browserPageLoaded')({ id: 'dapp-a' });
    });
    await settle();
  }

  beforeEach(() => mockIsIOS.mockReturnValue(true));
  afterEach(() => mockIsIOS.mockReturnValue(false));

  it('injects the style again once the faucet page has loaded after its origin was confirmed', async () => {
    await openAt(FAUCET_URL);
    await confirmUrl(FAUCET_URL);
    await loadPage();

    expect(faucetInjections()).toEqual([
      ['dapp-a', FAUCET_SCRIPT],
      ['dapp-a', FAUCET_SCRIPT]
    ]);
  });

  it('injects nothing into a faucet page whose origin is not confirmed', async () => {
    await openAt(FAUCET_URL);
    await loadPage();

    expect(faucetInjections()).toHaveLength(0);
  });

  it('injects nothing into another origin', async () => {
    await openAt('https://dapp-a.test/');
    await confirmUrl('https://dapp-a.test/');
    await loadPage();

    expect(faucetInjections()).toHaveLength(0);
  });

  it('injects nothing into the faucet on Android', async () => {
    mockIsIOS.mockReturnValue(false);
    await openAt(FAUCET_URL);
    await confirmUrl(FAUCET_URL);
    await loadPage();

    expect(faucetInjections()).toHaveLength(0);
  });

  it('injects the style once when the faucet is confirmed after its page loaded', async () => {
    await openAt(FAUCET_URL);
    await loadPage();
    await confirmUrl(FAUCET_URL);

    expect(faucetInjections()).toEqual([['dapp-a', FAUCET_SCRIPT]]);
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

// ── E2E screen-key publishing ──────────────────────────────────────
//
// The mobile E2E suites take exactly one screenshot per screen-key change, and
// the whole dApp browser lives on a single route. These assertions are what
// keep the dApp-browser filmstrip from collapsing to one frame — each one
// corresponds to a transition the gallery has to show.

describe('E2E screen-key publishing', () => {
  const SLOT_RECT = { x: 0, y: 0, width: 375, height: 600 };
  const ORIGINAL_E2E = process.env.MIDEN_E2E_TEST;

  beforeEach(() => {
    process.env.MIDEN_E2E_TEST = 'true';
    __resetScreenKeyForTest();
    // Stands in for ScreenKeyPublisher, which isn't in this tree.
    setRoutePart('/browser');
  });

  afterEach(() => {
    __resetScreenKeyForTest();
    if (ORIGINAL_E2E === undefined) delete process.env.MIDEN_E2E_TEST;
    else process.env.MIDEN_E2E_TEST = ORIGINAL_E2E;
  });

  type Hook = ReturnType<typeof renderHook<ReturnType<typeof useDappBrowser>, void>>;

  function flush(): Promise<void> {
    return act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  /**
   * Fire the plugin's `browserPageLoaded` the way the native side does. This is
   * what clears `isLoading`, and therefore the last of the three conditions the
   * provider waits for before naming the dApp — so a test that skips it is
   * asserting the "still loading" state, not the loaded one.
   */
  async function firePageLoaded(id: string): Promise<void> {
    const call = mockAddListener.mock.calls.find(c => c[0] === 'browserPageLoaded');
    const handler = call?.[1] as ((event: { id: string }) => Promise<void>) | undefined;
    if (!handler) throw new Error('browserPageLoaded listener was never registered');
    await act(async () => {
      await handler({ id });
    });
  }

  /** Open a session and drive it all the way to "painted": instance up, page loaded. */
  async function openUntilPainted(hook: Hook, session: ReturnType<typeof makeSession>): Promise<void> {
    act(() => hook.result.current.open(session));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await flush();
    await firePageLoaded(session.id);
  }

  it('publishes live sanitized cleanup observations and the real failure-notice trigger', async () => {
    renderHook(() => useDappBrowser(), { wrapper });
    const probe: {
      pendingConfirmationCount: number;
      hasPendingConfirmation: (id: string) => boolean;
      hasSnapshot: (id: string) => boolean;
      notifyExternalPageFailed: () => void;
    } = Object.getOwnPropertyDescriptor(globalThis, '__TEST_DAPP_BROWSER__')?.value;
    expect(probe.pendingConfirmationCount).toBe(0);
    const pending = dappConfirmationStore.requestConfirmation(makeConfirmationRequest('probe'));
    expect(probe.pendingConfirmationCount).toBe(1);
    expect(probe.hasPendingConfirmation('probe')).toBe(true);
    expect(probe.hasPendingConfirmation('unrelated')).toBe(false);
    mockGetSnapshot.mockReturnValueOnce('private snapshot');
    expect(probe.hasSnapshot('probe')).toBe(true);
    expect(probe.hasSnapshot('gone')).toBe(false);
    const notice = jest.fn();
    const unsubscribe = onExternalPageFailed(notice);
    probe.notifyExternalPageFailed();
    expect(notice).toHaveBeenCalledTimes(1);
    unsubscribe();
    dappConfirmationStore.resolveConfirmation('probe', { confirmed: false });
    await pending;
    expect(probe.pendingConfirmationCount).toBe(0);
    expect(probe.hasPendingConfirmation('probe')).toBe(false);
  });

  it('publishes the motion while one runs', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openUntilPainted(hook, makeSession('dapp-a'));
    const probe = () => Object.getOwnPropertyDescriptor(globalThis, '__TEST_DAPP_BROWSER__')?.value.motion;
    expect(probe()).toBeNull();
    mockMorph.mockResolvedValueOnce({ accepted: true });

    act(() => void hook.result.current.park('dapp-a'));
    await flush();

    expect(probe()).toEqual({
      id: 'dapp-a',
      target: 'collapsed',
      started: false,
      acknowledging: false,
      progress: 1,
      tracking: false
    });
  });

  it('stays on the bare route while the dApp is still loading', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => hook.result.current.open(makeSession('dapp-a')));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    await flush();

    // The native instance exists by now, but browserPageLoaded hasn't fired —
    // capturing here would photograph a blank slot.
    expect(getCurrentScreen().key).toBe('/browser');
  });

  it('names the dApp once it is foregrounded, loaded and has a slot', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openUntilPainted(hook, makeSession('dapp-a'));

    expect(getCurrentScreen().key).toBe('/browser > dapp:dapp-a.test');
  });

  it('returns to the bare route when the dApp is parked', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openUntilPainted(hook, makeSession('dapp-a'));

    await act(async () => {
      await hook.result.current.park('dapp-a');
    });

    expect(getCurrentScreen().key).toBe('/browser');
  });

  it('changes the key when a second dApp takes the foreground', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openUntilPainted(hook, makeSession('dapp-a'));
    const afterFirst = getCurrentScreen().seq;

    await openUntilPainted(hook, makeSession('dapp-b'));

    // A switch that didn't bump the sequence is a switch the suite never
    // photographs — the alpha→beta frame is the whole point of the journey.
    expect(getCurrentScreen().key).toBe('/browser > dapp:dapp-b.test');
    expect(getCurrentScreen().seq).toBeGreaterThan(afterFirst);
  });

  it('names the switcher, in preference to the dApp underneath it', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openUntilPainted(hook, makeSession('dapp-a'));

    act(() => hook.result.current.openSwitcher());
    // The switcher hides every native dApp window, so the dApp is genuinely
    // not what's on screen any more.
    expect(getCurrentScreen().key).toBe('/browser > dapp-switcher');

    act(() => hook.result.current.closeSwitcher());
    expect(getCurrentScreen().key).toBe('/browser > dapp:dapp-a.test');
  });

  it('publishes nothing when MIDEN_E2E_TEST is not "true"', async () => {
    process.env.MIDEN_E2E_TEST = 'false';
    __resetScreenKeyForTest();

    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await openUntilPainted(hook, makeSession('dapp-a'));

    expect(getCurrentScreen()).toEqual({ key: '', seq: 0 });
  });

  it.each([undefined, 'false', 'TRUE'])('does not install browser test hooks in ordinary mode %s', flag => {
    Reflect.deleteProperty(globalThis, '__TEST_DAPP_BROWSER__');
    if (flag === undefined) delete process.env.MIDEN_E2E_TEST;
    else process.env.MIDEN_E2E_TEST = flag;

    renderHook(() => useDappBrowser(), { wrapper });

    expect(Object.getOwnPropertyDescriptor(globalThis, '__TEST_DAPP_BROWSER__')).toBeUndefined();
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

// ── Host overlays (#875): the network banner's sheet over a foregrounded dApp ──

describe('host overlays (useHideForegroundDappWhileOpen)', () => {
  const SLOT_RECT = { x: 0, y: 0, width: 375, height: 600 };
  const LANDSCAPE = { x: 0, y: 0, width: 667, height: 375 };

  function useOverlayHarness(open: boolean) {
    const browser = useDappBrowser();
    useHideForegroundDappWhileOpen(open);
    return browser;
  }

  function renderHarness(open = false) {
    return renderHook(({ overlay }: { overlay: boolean }) => useOverlayHarness(overlay), {
      wrapper,
      initialProps: { overlay: open }
    });
  }

  async function openForeground(hook: ReturnType<typeof renderHarness>, id = 'dapp-a') {
    act(() => hook.result.current.open(makeSession(id)));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    // Let the foreground-driving effect run and the plugin open resolve.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  const lastVisibility = (id: string) => {
    const calls = mockSetVisible.mock.calls.filter(([callId]) => callId === id);
    return calls.length ? calls[calls.length - 1][1] : undefined;
  };

  afterEach(() => {
    mockConfirmationRequest = null;
  });

  it('hides the foreground window while held and shows it on release', async () => {
    const hook = renderHarness();
    await openForeground(hook);
    mockSetVisible.mockClear();

    hook.rerender({ overlay: true });
    expect(lastVisibility('dapp-a')).toBe(false);

    await act(async () => hook.rerender({ overlay: false }));
    expect(lastVisibility('dapp-a')).toBe(true);
  });

  it('moves but does not re-show the window when the slot rect changes while held (rotation)', async () => {
    const hook = renderHarness();
    await openForeground(hook);
    hook.rerender({ overlay: true });
    mockSetVisible.mockClear();
    mockSetRect.mockClear();

    act(() => hook.result.current.setSlotRect(LANDSCAPE));

    expect(mockSetRect).toHaveBeenCalledWith('dapp-a', LANDSCAPE);
    expect(mockSetVisible).not.toHaveBeenCalledWith('dapp-a', true);
  });

  it('does not re-show the window on a rect change while a confirmation is pending', async () => {
    const hook = renderHarness();
    await openForeground(hook);
    mockConfirmationRequest = makeConfirmationRequest('dapp-a');
    hook.rerender({ overlay: false });
    expect(lastVisibility('dapp-a')).toBe(false);
    mockSetVisible.mockClear();

    act(() => hook.result.current.setSlotRect(LANDSCAPE));

    expect(mockSetVisible).not.toHaveBeenCalledWith('dapp-a', true);
  });

  it('stays hidden when the overlay is released while a confirmation is pending', async () => {
    const hook = renderHarness();
    await openForeground(hook);
    hook.rerender({ overlay: true });
    mockConfirmationRequest = makeConfirmationRequest('dapp-a');
    hook.rerender({ overlay: true });
    mockSetVisible.mockClear();

    hook.rerender({ overlay: false });
    expect(mockSetVisible).not.toHaveBeenCalledWith('dapp-a', true);

    mockConfirmationRequest = null;
    await act(async () => hook.rerender({ overlay: false }));
    expect(lastVisibility('dapp-a')).toBe(true);
  });

  it('does not re-show the window when the switcher closes while held', async () => {
    const hook = renderHarness();
    await openForeground(hook);
    hook.rerender({ overlay: true });
    act(() => hook.result.current.openSwitcher());
    mockSetVisible.mockClear();

    act(() => hook.result.current.closeSwitcher());

    expect(mockSetVisible).not.toHaveBeenCalledWith('dapp-a', true);
  });

  it('hides a window created while held (the plugin opens it visible)', async () => {
    const hook = renderHarness(true);
    await openForeground(hook);

    expect(lastVisibility('dapp-a')).toBe(false);
  });

  it('hides a window created while the switcher is open, and shows it when the switcher closes', async () => {
    const hook = renderHarness();
    act(() => hook.result.current.open(makeSession('dapp-a')));
    act(() => hook.result.current.setSlotRect(SLOT_RECT));
    // The switcher opens during the plugin's openWebView round trip.
    act(() => hook.result.current.openSwitcher());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(lastVisibility('dapp-a')).toBe(false);

    await act(async () => hook.result.current.closeSwitcher());
    expect(lastVisibility('dapp-a')).toBe(true);
  });

  describe('logs native window failures instead of dropping them', () => {
    let warnSpy: jest.SpyInstance;
    const warned = (op: string) =>
      warnSpy.mock.calls.filter(([message]) => message === `[DappBrowserProvider] ${op} failed:`).length;
    const failNative = () => {
      const reject = () => Promise.reject(new Error('native window gone'));
      mockSetVisible.mockImplementation(reject);
      mockSetRect.mockImplementation(reject);
      mockExecuteScript.mockImplementation(reject);
    };
    const settle = () =>
      act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      const resolve = () => Promise.resolve();
      mockSetVisible.mockImplementation(resolve);
      mockSetRect.mockImplementation(resolve);
      mockExecuteScript.mockImplementation(resolve);
    });

    it('on the slot restore', async () => {
      const hook = renderHarness();
      await openForeground(hook);
      failNative();
      mockSetVisible.mockClear();

      act(() => hook.result.current.setSlotRect(LANDSCAPE));
      await settle();

      expect([warned('setRect'), warned('setVisible(true)'), warned('executeScript')]).toEqual([1, 0, 0]);
      expect(mockSetVisible).not.toHaveBeenCalledWith('dapp-a', true);
    });

    it('on the bridge injection of a warm restore', async () => {
      const hook = renderHarness();
      await openForeground(hook);
      const loaded = mockAddListener.mock.calls.find(call => call[0] === 'browserPageLoaded')?.[1];
      await act(async () => loaded?.({ id: 'dapp-a' }));
      await act(async () => hook.result.current.park('dapp-a'));
      failNative();

      await act(async () => hook.result.current.restore('dapp-a'));
      await settle();

      expect(warned('executeScript')).toBe(1);
    });

    it('when the switcher opens', async () => {
      const hook = renderHarness();
      await openForeground(hook);
      failNative();

      act(() => hook.result.current.openSwitcher());
      await settle();

      expect(warned('setVisible(false)')).toBe(1);
    });

    it('when the switcher closes', async () => {
      const hook = renderHarness();
      await openForeground(hook);
      act(() => hook.result.current.openSwitcher());
      await settle();
      failNative();

      act(() => hook.result.current.closeSwitcher());
      await settle();

      expect([warned('setVisible(true)'), warned('setRect')]).toEqual([0, 1]);
    });

    it('when an overlay is held', async () => {
      const hook = renderHarness();
      await openForeground(hook);
      failNative();

      hook.rerender({ overlay: true });
      await settle();

      expect(warned('setVisible(false)')).toBe(1);
    });

    it('when an overlay is released', async () => {
      const hook = renderHarness(true);
      await openForeground(hook);
      failNative();
      mockSetRect.mockImplementation(() => Promise.resolve());

      hook.rerender({ overlay: false });
      await settle();

      expect(warned('setVisible(true)')).toBe(1);
    });
  });

  it('does not require the provider', () => {
    expect(() => renderHook(() => useHideForegroundDappWhileOpen(true))).not.toThrow();
  });

  it('is a no-op outside the provider off mobile (extension, desktop, confirm window)', () => {
    mockIsMobile.mockReturnValue(false);
    try {
      renderHook(() => useHideForegroundDappWhileOpen(true));
      expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
    } finally {
      mockIsMobile.mockReturnValue(true);
    }
  });

  it('shares the parked-bubble flag with the other holders, in either order', () => {
    const modal = renderHook(() => useHideDappBubblesWhileOpen(true));
    const sheet = renderHarness(true);
    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);

    sheet.rerender({ overlay: false });
    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);
    modal.unmount();
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);

    const sheet2 = renderHarness(true);
    const modal2 = renderHook(() => useHideDappBubblesWhileOpen(true));
    modal2.unmount();
    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);
    sheet2.rerender({ overlay: false });
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });
});

describe('native presentation lifecycle', () => {
  function listenerFor(event: string): (value: unknown) => Promise<void> {
    const call = mockAddListener.mock.calls.find(c => c[0] === event);
    if (!call) throw new Error(`Missing listener: ${event}`);
    return call[1];
  }

  it('native close rejects its approval, clears all session storage, and preserves an unrelated approval', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockAddListener).toHaveBeenCalledWith('closeEvent', expect.any(Function)));
    act(() => hook.result.current.open(makeSession('dapp-b')));
    act(() => hook.result.current.open(makeSession('dapp-a')));
    const other = dappConfirmationStore.requestConfirmation(makeConfirmationRequest('dapp-b'));
    const pending = dappConfirmationStore.requestConfirmation(makeConfirmationRequest('dapp-a'));
    await act(async () => {
      await listenerFor('closeEvent')({
        id: 'dapp-a',
        managedHostCloseToken: mockPluginOpen.mock.calls.find(call => call[0].id === 'dapp-a')?.[0].managedHostClose
          ?.token
      });
    });
    expect(dappConfirmationStore.getPendingRequest('dapp-a')).toBeNull();
    await expect(pending).resolves.toEqual({ confirmed: false });
    expect(dappConfirmationStore.getPendingRequest('dapp-b')).not.toBeNull();
    expect(hook.result.current.sessionStates.map(s => s.session.id)).toEqual(['dapp-b']);
    expect(mockClearSnapshot).toHaveBeenCalledWith('dapp-a');
    expect(mockRemovePersistedSession).toHaveBeenCalledWith('dapp-a');
    expect(mockRemoveSnapshotFromDisk).toHaveBeenCalledWith('dapp-a');
    expect(mockSetActiveDappSession).toHaveBeenCalledWith(null);
    dappConfirmationStore.resolveConfirmation('dapp-b', { confirmed: false });
    await other;
  });

  it('finalizes once when explicit close triggers native closeEvent', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockAddListener).toHaveBeenCalledWith('closeEvent', expect.any(Function)));
    act(() => {
      hook.result.current.open(makeSession('dapp-a'));
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 375, height: 600 });
    });
    await waitFor(() => expect(mockPluginOpen).toHaveBeenCalled());
    mockInstanceClose.mockImplementationOnce(() =>
      listenerFor('closeEvent')({
        id: 'dapp-a',
        managedHostCloseToken: mockPluginOpen.mock.calls.find(call => call[0].id === 'dapp-a')?.[0].managedHostClose
          ?.token
      })
    );
    await act(async () => {
      await hook.result.current.close('dapp-a');
    });
    expect(hook.result.current.sessionStates).toHaveLength(0);
    expect(mockClearSnapshot).toHaveBeenCalledTimes(1);
    expect(mockRemovePersistedSession).toHaveBeenCalledTimes(1);
    expect(mockRemoveSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });

  it('waits for presentation listener registration before opening the page', async () => {
    let register: (() => void) | undefined;
    mockAddListener.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          register = () => resolve({ remove: jest.fn() });
        })
    );
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    act(() => {
      hook.result.current.open(makeSession('dapp-a'));
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 375, height: 600 });
    });
    expect(mockPluginOpen).not.toHaveBeenCalled();
    await act(async () => {
      register?.();
    });
    await waitFor(() => expect(mockPluginOpen).toHaveBeenCalled());
  });

  it('closes an instance returned after its session has already been finalized', async () => {
    let finishOpen: (() => void) | undefined;
    mockPluginOpen.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishOpen = resolve;
        })
    );
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockAddListener).toHaveBeenCalledWith('closeEvent', expect.any(Function)));
    act(() => {
      hook.result.current.open(makeSession('dapp-a'));
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 375, height: 600 });
    });
    await waitFor(() => expect(mockPluginOpen).toHaveBeenCalled());
    await act(async () => {
      await hook.result.current.close('dapp-a');
    });
    await act(async () => {
      finishOpen?.();
    });
    expect(mockNativeClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dapp-a', force: true, managedHostCloseToken: expect.any(String) })
    );
    expect(hook.result.current.sessionStates).toHaveLength(0);
    expect(mockClearSnapshot).toHaveBeenCalledTimes(1);
  });

  it('ignores a rejected old open after terminal cleanup and same-id replacement', async () => {
    let rejectOpen: (error: Error) => void = () => {};
    mockPluginOpen.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOpen = reject;
        })
    );
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockAddListener).toHaveBeenCalledWith('closeEvent', expect.any(Function)));
    act(() => {
      hook.result.current.open(makeSession('dapp-a'));
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 375, height: 600 });
    });
    await waitFor(() => expect(mockPluginOpen).toHaveBeenCalledTimes(1));
    const token = mockPluginOpen.mock.calls[0][0].managedHostClose?.token;
    await act(async () => {
      await listenerFor('closeEvent')({ id: 'dapp-a', managedHostCloseToken: token });
    });
    act(() => hook.result.current.open(makeSession('dapp-a')));
    await waitFor(() => expect(hook.result.current.sessionStates[0]?.status).toBe('active'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => rejectOpen(new Error('retired open rejected')));
    expect(hook.result.current.sessionStates[0]?.status).toBe('active');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('does not persist a parked snapshot that finishes after native close', async () => {
    let finishSnapshot: ((value: string) => void) | undefined;
    mockCaptureSnapshot.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finishSnapshot = resolve;
        })
    );
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockAddListener).toHaveBeenCalledWith('closeEvent', expect.any(Function)));
    act(() => {
      hook.result.current.open(makeSession('dapp-a'));
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 375, height: 600 });
    });
    await waitFor(() => expect(mockPluginOpen).toHaveBeenCalled());
    let parking: Promise<void> | undefined;
    // Async, so the refused morph hands over to the legacy park and its snapshot starts before the close.
    await act(async () => {
      parking = hook.result.current.park('dapp-a');
    });
    expect(finishSnapshot).toBeDefined();
    await act(async () => {
      await listenerFor('closeEvent')({
        id: 'dapp-a',
        managedHostCloseToken: mockPluginOpen.mock.calls.find(call => call[0].id === 'dapp-a')?.[0].managedHostClose
          ?.token
      });
    });
    await act(async () => {
      finishSnapshot?.('data:image/jpeg;base64,AAAA');
      await parking;
    });
    expect(mockUpsertPersistedSession).not.toHaveBeenCalled();
    expect(mockWriteSnapshotToDisk).not.toHaveBeenCalled();
    expect(hook.result.current.sessionStates).toHaveLength(0);
  });

  it('opens a loading session once when its slot changes before native opening finishes', async () => {
    let finishOpen: (() => void) | undefined;
    mockPluginOpen.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishOpen = resolve;
        })
    );
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockAddListener).toHaveBeenCalledWith('closeEvent', expect.any(Function)));
    act(() => {
      hook.result.current.open(makeSession('dapp-a'));
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 375, height: 600 });
    });
    await waitFor(() => expect(mockPluginOpen).toHaveBeenCalled());
    await act(async () => {
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 600, height: 375 });
    });
    const opens = mockPluginOpen.mock.calls.length;
    await act(async () => {
      finishOpen?.();
    });
    mockPluginOpen.mockReset();
    expect(opens).toBe(1);
  });

  it('does not select a restore target that closes while another session is parking', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockAddListener).toHaveBeenCalledWith('closeEvent', expect.any(Function)));
    act(() => {
      hook.result.current.open(makeSession('target'));
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 375, height: 600 });
    });
    await waitFor(() => expect(mockPluginOpen).toHaveBeenCalledTimes(1));
    await act(async () => {
      await hook.result.current.park('target');
    });
    act(() => {
      hook.result.current.open(makeSession('keep'));
    });
    await waitFor(() => expect(mockPluginOpen).toHaveBeenCalledTimes(2));
    let finish: (value: string) => void = () => {
      throw new Error('capture has not started');
    };
    mockCaptureSnapshot.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finish = resolve;
        })
    );
    let restoring: Promise<boolean> | undefined;
    act(() => {
      restoring = hook.result.current.restore('target');
    });
    await act(async () => {
      await listenerFor('closeEvent')({
        id: 'target',
        managedHostCloseToken: mockPluginOpen.mock.calls.find(call => call[0].id === 'target')?.[0].managedHostClose
          ?.token
      });
    });
    mockSetActiveDappSession.mockClear();
    await act(async () => {
      finish('data:image/jpeg;base64,AAAA');
      await restoring;
    });
    expect(hook.result.current.sessionStates.map(s => s.session.id)).toEqual(['keep']);
    expect(mockSetActiveDappSession).not.toHaveBeenCalledWith('target');
    expect(hook.result.current.mode).toBe('launcher');
  });

  it('restores a live target whose native opening completes while another session is parking', async () => {
    let finishOpen: () => void = () => {
      throw new Error('open has not started');
    };
    mockPluginOpen.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishOpen = resolve;
        })
    );
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockAddListener).toHaveBeenCalledWith('closeEvent', expect.any(Function)));
    act(() => {
      hook.result.current.open(makeSession('target'));
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 375, height: 600 });
    });
    await waitFor(() => expect(mockPluginOpen).toHaveBeenCalledTimes(1));
    expect(hook.result.current.sessionStates.find(s => s.session.id === 'target')?.instance).toBeNull();
    act(() => {
      hook.result.current.open(makeSession('keep'));
    });
    await waitFor(() =>
      expect(hook.result.current.sessionStates.find(s => s.session.id === 'keep')?.instance).not.toBeNull()
    );
    let finishSnapshot: (value: string) => void = () => {
      throw new Error('capture has not started');
    };
    mockCaptureSnapshot.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finishSnapshot = resolve;
        })
    );
    let restoring: Promise<boolean> | undefined;
    act(() => {
      restoring = hook.result.current.restore('target');
    });
    await act(async () => {
      finishOpen();
    });
    const instance = hook.result.current.sessionStates.find(s => s.session.id === 'target')?.instance;
    expect(instance).not.toBeNull();
    mockSetActiveDappSession.mockClear();
    await act(async () => {
      finishSnapshot('data:image/jpeg;base64,AAAA');
      await restoring;
    });
    expect(hook.result.current.session?.id).toBe('target');
    expect(mockSetActiveDappSession).toHaveBeenCalledWith('target');
    expect(hook.result.current.sessionStates.find(s => s.session.id === 'target')?.instance).toBe(instance);
    expect(hook.result.current.sessionStates.find(s => s.session.id === 'keep')?.status).toBe('parked');
  });

  it('rejects an earlier restore when a target ID and timestamp are reused for a replacement session', async () => {
    let finishOpen: () => void = () => {
      throw new Error('open has not started');
    };
    mockPluginOpen.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishOpen = resolve;
        })
    );
    const target = makeSession('target');
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockAddListener).toHaveBeenCalledWith('closeEvent', expect.any(Function)));
    act(() => {
      hook.result.current.open(target);
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 375, height: 600 });
    });
    await waitFor(() => expect(mockPluginOpen).toHaveBeenCalledTimes(1));
    act(() => {
      hook.result.current.open(makeSession('keep'));
    });
    await waitFor(() =>
      expect(hook.result.current.sessionStates.find(s => s.session.id === 'keep')?.instance).not.toBeNull()
    );
    let finishSnapshot: (value: string) => void = () => {
      throw new Error('capture has not started');
    };
    mockCaptureSnapshot.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finishSnapshot = resolve;
        })
    );
    let restoring: Promise<boolean> | undefined;
    act(() => {
      restoring = hook.result.current.restore('target');
    });
    await act(async () => {
      await hook.result.current.close('target');
    });
    act(() => {
      hook.result.current.open(target);
    });
    mockSetActiveDappSession.mockClear();
    await act(async () => {
      finishSnapshot('data:image/jpeg;base64,AAAA');
      await restoring;
    });
    const selectedAgain = mockSetActiveDappSession.mock.calls.some(call => call[0] === 'target');
    await act(async () => {
      await hook.result.current.close('target');
      finishOpen();
    });
    expect(selectedAgain).toBe(false);
    expect(hook.result.current.sessionStates.map(s => s.session.id)).toEqual(['keep']);
  });

  it('passes the native contract and captures presentation events before opening returns', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockAddListener).toHaveBeenCalledWith('presentationChanged', expect.any(Function)));
    mockPluginOpen.mockImplementationOnce((options: { id: string; managedHostClose: { token: string } }) => {
      void listenerFor('presentationChanged')({
        id: options.id,
        display: 'fullscreen',
        policyResolved: true,
        policyRevision: 2,
        managedHostCloseToken: options.managedHostClose.token
      });
    });
    act(() => {
      hook.result.current.open(makeSession('dapp-a'));
      hook.result.current.setSlotRect({ x: 0, y: 0, width: 375, height: 600 });
    });
    await waitFor(() => expect(hook.result.current.sessionStates[0]).toMatchObject({ presentation: 'fullscreen' }));
    expect(mockPluginOpen.mock.calls[0]![0].breadPresentation).toMatchObject({
      script: expect.any(String),
      logoSvg: expect.any(String),
      backLabel: 'breadPresentationBack',
      hintLabel: 'breadPresentationHint',
      retryLabel: 'retry',
      errorLabel: 'breadPresentationError',
      readinessTimeoutMs: 30000
    });
  });
});

describe('native permission-denied toast reporting', () => {
  type Listener = { callback: (payload: unknown) => unknown; remove: jest.Mock; active: boolean };
  let listeners: Map<string, Listener[]>;

  beforeEach(() => {
    listeners = new Map();
    mockReportUserVisibleError.mockClear();
    mockAddListener.mockImplementation((event: string, callback: Listener['callback']) => {
      const listener: Listener = {
        callback,
        active: true,
        remove: jest.fn(() => {
          listener.active = false;
        })
      };
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return Promise.resolve({ remove: listener.remove });
    });
  });

  afterEach(() => {
    mockAddListener.mockImplementation(() => Promise.resolve({ remove: jest.fn() }));
  });

  async function registered() {
    await waitFor(() => expect(listeners.get('permissionDeniedToast') ?? []).toHaveLength(1));
    return listeners.get('permissionDeniedToast')![0]!;
  }

  async function emit(event: string, payload: unknown) {
    await act(async () => {
      for (const listener of listeners.get(event) ?? []) {
        if (listener.active) await listener.callback(payload);
      }
    });
  }

  it('reports exactly the fixed pair only after an empty native event arrives', async () => {
    renderHook(() => useDappBrowser(), { wrapper });
    await registered();
    expect(mockReportUserVisibleError).not.toHaveBeenCalled();
    await emit('permissionDeniedToast', {});
    expect(mockReportUserVisibleError.mock.calls).toEqual([['raw_dapp_permission_denied', 'native_toast']]);
  });

  it('reports each native display once across rerenders without duplicate listeners', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await registered();
    hook.rerender();
    hook.rerender();
    expect(listeners.get('permissionDeniedToast') ?? []).toHaveLength(1);
    await emit('permissionDeniedToast', {});
    await emit('permissionDeniedToast', {});
    expect(mockReportUserVisibleError.mock.calls).toEqual([
      ['raw_dapp_permission_denied', 'native_toast'],
      ['raw_dapp_permission_denied', 'native_toast']
    ]);
  });

  it('removes the listener on unmount and leaves only the remounted provider active', async () => {
    const first = renderHook(() => useDappBrowser(), { wrapper });
    const old = await registered();
    first.unmount();
    expect(old.remove).toHaveBeenCalledTimes(1);
    await emit('permissionDeniedToast', {});
    expect(mockReportUserVisibleError).not.toHaveBeenCalled();
    const second = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(listeners.get('permissionDeniedToast') ?? []).toHaveLength(2));
    expect(listeners.get('permissionDeniedToast')!.filter(listener => listener.active)).toHaveLength(1);
    await emit('permissionDeniedToast', {});
    expect(mockReportUserVisibleError.mock.calls).toEqual([['raw_dapp_permission_denied', 'native_toast']]);
    second.unmount();
    await emit('permissionDeniedToast', {});
    expect(mockReportUserVisibleError).toHaveBeenCalledTimes(1);
  });

  it('ignores callbacks delivered after provider disposal', async () => {
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    const listener = await registered();
    hook.unmount();
    await act(async () => {
      await listener.callback({});
    });
    expect(mockReportUserVisibleError).not.toHaveBeenCalled();
  });

  it('removes a permission listener whose registration resolves after unmount', async () => {
    const register = mockAddListener.getMockImplementation()!;
    let finishRegistration: (() => void) | undefined;
    mockAddListener.mockImplementation((event: string, callback: Listener['callback']) => {
      const handle = register(event, callback);
      if (event !== 'permissionDeniedToast') return handle;
      return new Promise(resolve => {
        finishRegistration = () => resolve(handle);
      });
    });
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    const listener = await registered();
    hook.unmount();
    await act(async () => {
      finishRegistration?.();
    });
    await waitFor(() => expect(listener.remove).toHaveBeenCalledTimes(1));
    await emit('permissionDeniedToast', {});
    expect(mockReportUserVisibleError).not.toHaveBeenCalled();
  });

  it('forwards no raw payload fields or values to the final reporter boundary', async () => {
    renderHook(() => useDappBrowser(), { wrapper });
    await registered();
    await emit('permissionDeniedToast', {
      id: 'private-instance',
      url: 'https://private.fixture.example/path?secret=value',
      origin: 'https://private.fixture.example',
      permission: 'private-permission',
      message: 'private denial text',
      errorId: 'raw_startup_init_failed',
      surface: 'inline'
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([['raw_dapp_permission_denied', 'native_toast']]);
  });

  it('keeps unrelated successful native events silent', async () => {
    renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(listeners.get('closeEvent')).toHaveLength(1));
    await emit('browserPageLoaded', { id: 'absent' });
    await emit('urlChangeEvent', { id: 'absent', url: 'https://private.fixture.example' });
    await emit('presentationChanged', {
      id: 'absent',
      display: 'browser',
      policyResolved: true,
      policyRevision: 1
    });
    await emit('closeEvent', { id: 'absent' });
    expect(mockReportUserVisibleError).not.toHaveBeenCalled();
  });
});

describe('Task5 cache provider ownership', () => {
  it('a cold preview read completed after unmount cannot populate the shared memory store', async () => {
    let finish!: (data: string) => void;
    mockLoadPersistedSessions.mockResolvedValueOnce([
      {
        id: 'dapp-retired-preview',
        url: 'https://dapp.invalid/',
        origin: 'https://dapp.invalid',
        title: 'Disposable dApp',
        favicon: null,
        openedAt: 1,
        parkedAt: 2
      }
    ]);
    mockReadSnapshotFromDisk.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finish = resolve;
        })
    );
    const hook = renderHook(() => useDappBrowser(), { wrapper });
    await waitFor(() => expect(mockReadSnapshotFromDisk).toHaveBeenCalledWith('dapp-retired-preview'));
    hook.unmount();
    await act(async () => {
      finish('data:image/jpeg;base64,RETIRED');
    });
    expect(mockSnapshotSetRaw).not.toHaveBeenCalled();
  });
});
