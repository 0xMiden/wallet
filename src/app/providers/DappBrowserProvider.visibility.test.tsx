import React from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { ExternalPageFailedNotice } from 'app/ExternalPageFailedNotice';
import Dialogs from 'app/layouts/Dialogs';
import { PageActiveContext } from 'app/layouts/page-active';
import { BrowserScreen } from 'app/pages/Browser/BrowserScreen';
import { DappActive } from 'app/pages/Browser/DappActive';
import { dappConfirmationStore, type DAppConfirmationRequest } from 'lib/dapp-browser/confirmation-store';
import { externalPageFailed } from 'lib/mobile/external-page-failed';
import { WalletStatus } from 'lib/shared/types';
import { DialogsProvider, dispatchAlertClose, dispatchConfirmClose, useConfirm } from 'lib/ui/dialog';

import { DappBrowserProvider, useDappBrowser, useHideForegroundDappWhileOpen } from './DappBrowserProvider';
import en from '../../../public/_locales/en/en.json';

const mockSetVisible = jest.fn(async (_id: string, _visible: boolean, _revision?: number) => {});
const mockCaptureSnapshot = jest.fn(
  async (_id: string, _scale?: number, _quality?: number): Promise<string | null> => null
);
const mockSetRect = jest.fn(async (_id: string, _rect: unknown) => {});
const mockOpen = jest.fn(
  async (_options: { id: string; initiallyVisible?: boolean; managedHostClose?: { token: string } }) => {}
);
const mockCompleteClose = jest.fn(async (_options: unknown) => {});
const mockRemoveSession = jest.fn(async () => {});
const mockRemoveSnapshot = jest.fn(async () => {});
const mockResetViewport = jest.fn(async () => {});
const mockClose = jest.fn(async (_id: string) => {});
const mockMorph = jest.fn(async (_id: string, _request: unknown) => ({ accepted: false }));
const mockExecuteScript = jest.fn(async (_id: string, _code: string) => {});
const mockSetMorphTarget = jest.fn(async (_card: unknown) => {});
const mockUpsertSession = jest.fn(async (_session: unknown) => {});
const mockLoadPersisted = jest.fn(async (): Promise<unknown[]> => []);
const nativeListeners = new Map<
  string,
  (event: {
    id: string;
    morphId?: string;
    phase?: string;
    target?: string;
    progress?: number;
    velocity?: number;
    tracking?: boolean;
    display?: 'fullscreen' | 'browser';
    policyResolved?: boolean;
    policyRevision?: number;
    detail?: unknown;
    token?: string;
    requestId?: string;
    visible?: boolean;
    managedHostCloseToken?: string;
    visibilitySequence?: number;
  }) => void
>();
jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    completeManagedClose: (options: unknown) => mockCompleteClose(options),
    close: async () => {},
    addListener: async (
      event: string,
      listener: (event: { id: string; display?: 'fullscreen' | 'browser'; detail?: unknown }) => void
    ) => {
      nativeListeners.set(event, listener);
      return {
        remove: () => {
          if (nativeListeners.get(event) === listener) nativeListeners.delete(event);
        }
      };
    },
    setVisible: ({ id, visible }: { id: string; visible: boolean }) => mockSetVisible(id, visible),
    reload: jest.fn(async () => {})
  },
  ToolBarType: { BLANK: 'BLANK' },
  dappWebViewManager: {
    reserveClose: jest.fn(),
    forget: jest.fn(),
    setMorphTarget: (card: unknown) => mockSetMorphTarget(card),
    open: async (options: { id: string; initiallyVisible?: boolean }) => {
      await mockOpen(options);
      let visibilitySequence = 0;
      return {
        id: options.id,
        get currentVisibilitySequence() {
          return visibilitySequence;
        },
        setRect: (rect: unknown) => mockSetRect(options.id, rect),
        setVisible: (visible: boolean, revision?: number) => {
          visibilitySequence++;
          return revision === undefined
            ? mockSetVisible(options.id, visible)
            : mockSetVisible(options.id, visible, revision);
        },
        morph: (request: unknown) => {
          visibilitySequence++;
          return mockMorph(options.id, request);
        },
        executeScript: (code: string) => mockExecuteScript(options.id, code),
        close: () => mockClose(options.id)
      };
    }
  }
}));
jest.mock('app/icons/brand/new-bread.svg?raw', () => '<svg />', { virtual: true });
jest.mock('lib/platform', () => ({
  isMobile: () => true,
  isExtension: () => false,
  isDesktop: () => false,
  isIOS: () => false,
  isAndroid: () => true
}));
let mockStatus = WalletStatus.Ready;
let mockHydrated = true;
let mockPath = '/browser';
const mockSetActiveSession = jest.fn();
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: unknown) => T) =>
    selector({
      status: mockStatus,
      isInitialized: mockHydrated,
      setActiveDappSession: mockSetActiveSession,
      accounts: [],
      currentAccount: null
    }),
  selectIsReady: (state: { status: number }) => state.status === WalletStatus.Ready
}));
jest.mock('lib/woozie', () => ({ navigate: jest.fn(), useLocation: () => ({ pathname: mockPath }) }));
jest.mock('lib/mobile/viewport-reset', () => ({ resetViewportAfterWebview: () => mockResetViewport() }));
jest.mock('lib/mobile/webview-state', () => ({ markReturningFromWebview: () => {} }));
let mockRealApproval = false;
const mockBackHandlers: { handler: () => boolean | void; overlay: boolean; active: boolean }[] = [];
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (...args: unknown[]) => {
    const real = jest.requireActual<typeof import('lib/mobile/useMobileBackHandler')>(
      'lib/mobile/useMobileBackHandler'
    );
    if (mockRealApproval) real.useMobileBackHandler(...(args as Parameters<typeof real.useMobileBackHandler>));
  }
}));
jest.mock('lib/mobile/back-handler', () => ({
  registerMobileBackHandler: (handler: () => boolean | void, options: { overlay?: boolean } = {}) => {
    const entry = { handler, overlay: options.overlay === true, active: true };
    mockBackHandlers.push(entry);
    return () => {
      entry.active = false;
    };
  }
}));
jest.mock('lib/biometric', () => ({ confirmSensitiveAction: jest.fn() }));
jest.mock('lib/miden/back/protector-probe', () => ({ probeHardwareProtector: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
  hapticSelection: jest.fn()
}));
jest.mock('lib/dapp-browser/snapshot-store', () => ({
  captureSnapshot: (id: string, scale: number, quality: number) => mockCaptureSnapshot(id, scale, quality),
  clearSnapshot: () => {},
  getSnapshot: () => undefined,
  snapshotStoreInternals: { setRaw: () => {} }
}));
jest.mock('lib/dapp-browser', () => ({
  INJECTION_SCRIPT: 'INJECTED;',
  parseOrigin: (url: string) => new URL(url).origin,
  loadPersistedSessions: () => mockLoadPersisted(),
  readSnapshotFromDisk: async () => null,
  removePersistedSession: () => mockRemoveSession(),
  removeSnapshotFromDisk: () => mockRemoveSnapshot(),
  upsertPersistedSession: (session: unknown) => mockUpsertSession(session),
  writeSnapshotToDisk: async () => {},
  toPersisted: (session: unknown) => session,
  fromPersisted: (session: unknown) => session,
  getRecentDapps: async () => [],
  recordRecentDapp: async () => {},
  getDappDisplayName: () => 'Test app',
  createDappSession: jest.requireActual<typeof import('lib/dapp-browser/dapp-session')>('lib/dapp-browser/dapp-session')
    .createDappSession,
  useDappConfirmation: (...args: unknown[]) => {
    const real = jest.requireActual<typeof import('lib/dapp-browser/use-dapp-confirmation')>(
      'lib/dapp-browser/use-dapp-confirmation'
    );
    return real.useDappConfirmation(typeof args[0] === 'string' ? args[0] : undefined);
  }
}));
jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST' },
  AllowedPrivateData: { None: 0 }
}));
jest.mock('app/pages/Browser/DappPeekTray', () => ({ DappPeekTray: () => null }));
jest.mock('app/pages/Browser/DappSwitcher', () => ({ DappSwitcher: () => null }));
jest.mock('app/pages/Browser/DappConfirmationModal', () => ({
  DappConfirmationModal: (
    props: React.ComponentProps<typeof import('app/pages/Browser/DappConfirmationModal').DappConfirmationModal>
  ) => {
    const { DappConfirmationModal } = jest.requireActual<typeof import('app/pages/Browser/DappConfirmationModal')>(
      'app/pages/Browser/DappConfirmationModal'
    );
    return mockRealApproval ? <DappConfirmationModal {...props} /> : null;
  }
}));
// Only the capsule trigger is adapted; DappActive and its actions Drawer remain production components.
jest.mock('app/pages/Browser/CapsuleBar', () => ({
  CapsuleBar: ({ onOpenActions }: { onOpenActions: () => void }) => (
    <button data-testid="actions-trigger" onClick={onOpenActions}>
      Actions
    </button>
  )
}));
jest.mock('app/pages/Browser/DappLauncher', () => ({
  DappLauncher: ({ onOpen }: { onOpen: (url: string) => void }) => (
    <div data-testid="retained-launcher">
      Launcher<button onClick={() => onOpen('https://origin.test')}>Open game</button>
    </div>
  )
}));
jest.mock('app/pages/Browser/ProgressBar', () => ({ ProgressBar: () => null }));
jest.mock('app/pages/Browser/NativeWebViewSlot', () => {
  const react = jest.requireActual<typeof React>('react');
  return { NativeWebViewSlot: react.forwardRef<HTMLDivElement>((_props, ref) => <div ref={ref} />) };
});
// The real dialog module captures #root on first evaluation, exactly as the production bootstrap does.
jest.mock('lib/ui/dialog', () => {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  return jest.requireActual('lib/ui/dialog');
});

const RECT = { x: 0, y: 0, width: 375, height: 600 };
let browser: ReturnType<typeof useDappBrowser> | undefined;
let confirm: ReturnType<typeof useConfirm> | undefined;
let testI18n: typeof i18n;
const pendingDialogs: Promise<unknown>[] = [];
let currentTree: ReturnType<typeof render> | undefined;

let driverAction: (() => void) | undefined;
function Driver() {
  browser = useDappBrowser();
  confirm = useConfirm();
  return <span data-testid="driver-action" onClick={() => driverAction?.()} />;
}
function HeldOverlay() {
  useHideForegroundDappWhileOpen(true);
  return null;
}
function control() {
  if (!browser) throw new Error('Provider not mounted');
  return browser;
}
function Tree({
  held = false,
  actions = false,
  screen = false,
  onScreen = true
}: {
  held?: boolean;
  actions?: boolean;
  screen?: boolean;
  onScreen?: boolean;
}) {
  return (
    <I18nextProvider i18n={testI18n}>
      <DialogsProvider>
        <Dialogs />
        <ExternalPageFailedNotice />
        <DappBrowserProvider>
          <Driver />
          {held && <HeldOverlay />}
          {actions && <DappActive />}
          {screen && (
            <PageActiveContext.Provider value={onScreen}>
              <BrowserScreen />
            </PageActiveContext.Provider>
          )}
        </DappBrowserProvider>
      </DialogsProvider>
    </I18nextProvider>
  );
}
function session(id: string) {
  return {
    id,
    url: `https://${id}.test`,
    origin: `https://${id}.test`,
    title: id,
    favicon: null,
    openedAt: Date.now(),
    status: 'opening' as const
  };
}
const lastVisibility = (id = 'origin') => mockSetVisible.mock.calls.filter(call => call[0] === id).at(-1)?.[1];
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function openForeground(options: { held?: boolean; actions?: boolean } = {}) {
  currentTree = render(<Tree {...options} />);
  await waitFor(() => expect(nativeListeners.has('presentationChanged')).toBe(true));
  act(() => {
    control().open(session('origin'));
    control().setSlotRect(RECT);
  });
  await waitFor(() => expect(control().sessionStates[0]?.instance).not.toBeNull());
  act(() =>
    nativeListeners.get('presentationChanged')?.({
      id: 'origin',
      display: 'fullscreen',
      policyResolved: true,
      policyRevision: 2,
      managedHostCloseToken: mockOpen.mock.calls[0]?.[0].managedHostClose?.token
    })
  );
  await settle();
  if (!options.held) expect(lastVisibility()).toBe(true);
  mockSetVisible.mockReset().mockResolvedValue(undefined);
  return currentTree;
}
function managedTokenFor(id: string) {
  const options = mockOpen.mock.calls.find(([candidate]) => candidate.id === id)?.[0];
  const token = options?.managedHostClose?.token;
  if (!token) throw new Error(`No managed-close token for ${id}`);
  return token;
}
function holdSnapshotsFor(id: string) {
  const releases: ((snapshot: string | null) => void)[] = [];
  mockCaptureSnapshot.mockImplementation(candidate =>
    candidate === id ? new Promise<string | null>(resolve => releases.push(resolve)) : Promise.resolve(null)
  );
  return releases;
}
async function finishManagedClose(id: string) {
  const token = managedTokenFor(id);
  act(() => nativeListeners.get('hostCloseRequested')?.({ id, token, requestId: `close-${id}`, visible: false }));
  await settle();
  await act(async () => nativeListeners.get('closeEvent')?.({ id, managedHostCloseToken: token }));
  await settle();
}
async function openManagedSession(id: string) {
  act(() => {
    control().open(session(id));
    control().setSlotRect(RECT);
  });
  await waitFor(() => expect(control().sessionStates.find(state => state.session.id === id)?.instance).not.toBeNull());
  act(() =>
    nativeListeners.get('presentationChanged')?.({
      id,
      display: 'fullscreen',
      policyResolved: true,
      policyRevision: 2,
      managedHostCloseToken: managedTokenFor(id)
    })
  );
  await settle();
  await waitFor(() => expect(lastVisibility(id)).toBe(true));
}
async function closeAlert() {
  const sheet = screen.getByRole('alertdialog', { name: en.error });
  await act(async () => {
    fireEvent.click(within(sheet).getByRole('button', { name: en.ok }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
function closeActions() {
  const button = document.querySelector('[role="dialog"] [data-slot="drawer-header"] button');
  if (!(button instanceof HTMLElement)) throw new Error('Actions close button missing');
  fireEvent.click(button);
}
function approval(): DAppConfirmationRequest {
  return {
    id: 'approval',
    sessionId: 'origin',
    type: 'transaction',
    origin: 'https://origin.test',
    appMeta: { name: 'Test app' },
    network: 'testnet',
    networkRpc: 'https://rpc.test',
    privateDataPermission: PrivateDataPermission.UponRequest,
    allowedPrivateData: AllowedPrivateData.None,
    existingPermission: true
  };
}

beforeEach(async () => {
  mockRealApproval = false;
  mockBackHandlers.length = 0;
  mockSetVisible.mockClear();
  mockSetRect.mockClear();
  mockOpen.mockClear();
  mockCaptureSnapshot.mockReset().mockResolvedValue(null);
  mockClose.mockClear();
  mockMorph.mockReset().mockResolvedValue({ accepted: false });
  mockSetMorphTarget.mockClear();
  mockUpsertSession.mockClear();
  mockLoadPersisted.mockReset().mockResolvedValue([]);
  mockCompleteClose.mockClear();
  mockRemoveSession.mockReset().mockResolvedValue(undefined);
  mockRemoveSnapshot.mockReset().mockResolvedValue(undefined);
  mockResetViewport.mockReset().mockResolvedValue(undefined);
  mockStatus = WalletStatus.Ready;
  mockHydrated = true;
  mockPath = '/browser';
  testI18n = i18n.createInstance();
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false, prefix: '$', suffix: '$' },
    resources: { en: { translation: en } }
  });
  jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 375, 600));
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await act(async () => {
    dispatchAlertClose();
    dispatchConfirmClose(false);
    for (const request of dappConfirmationStore.getAllPendingRequests())
      dappConfirmationStore.resolveConfirmation(request.sessionId, { confirmed: false });
    await Promise.all(pendingDialogs.splice(0));
  });
  currentTree?.unmount();
  currentTree = undefined;
  browser = undefined;
  confirm = undefined;
  jest.restoreAllMocks();
});

it('minimizes the native Bread capsule through the standard parked session and reselects retained fullscreen', async () => {
  await openForeground();
  currentTree!.rerender(<Tree screen />);
  await settle();
  const original = control().sessionStates[0]!;
  const lifetime = mockOpen.mock.calls[0]![0].managedHostClose!.token;
  expect(nativeListeners.has('presentationMinimizeRequested')).toBe(true);
  await act(async () =>
    nativeListeners.get('presentationMinimizeRequested')?.({
      id: 'origin',
      managedHostCloseToken: lifetime,
      policyRevision: 2,
      visibilitySequence: control().sessionStates[0]?.instance?.currentVisibilitySequence
    })
  );
  await waitFor(() => expect(control().mode).toBe('launcher'));
  expect(control().parkedSessions.map(state => state.session.id)).toContain('origin');
  expect(screen.getByTestId('retained-launcher')).toBeVisible();
  expect(screen.queryByTestId('dapp-active')).not.toBeInTheDocument();
  expect(lastVisibility()).toBe(false);
  expect(mockClose).not.toHaveBeenCalled();
  expect(mockRemoveSession).not.toHaveBeenCalled();
  expect(mockRemoveSnapshot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open game' }));
  await waitFor(() => expect(lastVisibility()).toBe(true));
  expect(control().session?.id).toBe('origin');
  expect(control().sessionStates[0]?.instance).toBe(original.instance);
  expect(control().sessionStates[0]?.presentation).toBe('fullscreen');
  expect(control().sessionStates[0]?.policyRevision).toBe(2);
  expect(mockOpen).toHaveBeenCalledTimes(1);
});

it('cancels deferred native minimize when a confirmation takes ownership', async () => {
  mockRealApproval = true;
  await openForeground();
  let finishSnapshot: (value: null) => void = () => undefined;
  mockCaptureSnapshot.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishSnapshot = resolve;
      })
  );
  const event = {
    id: 'origin',
    managedHostCloseToken: mockOpen.mock.calls[0]![0].managedHostClose!.token,
    policyRevision: 2,
    visibilitySequence: control().sessionStates[0]?.instance?.currentVisibilitySequence
  };
  act(() => nativeListeners.get('presentationMinimizeRequested')?.(event));
  await waitFor(() => expect(mockCaptureSnapshot).toHaveBeenCalled());
  let answer: Promise<unknown> | undefined;
  act(() => {
    answer = dappConfirmationStore.requestConfirmation({
      ...approval(),
      type: 'sign',
      transactionMessages: ['Held ownership']
    });
  });
  await screen.findByText('Held ownership');
  await act(async () => {
    finishSnapshot(null);
    await Promise.resolve();
  });
  expect(control().session?.id).toBe('origin');
  expect(control().mode).toBe('active');
  await waitFor(() => expect(screen.getByText('Held ownership').closest('[role="dialog"]')).toBeVisible());
  act(() => dappConfirmationStore.resolveConfirmation('origin', { confirmed: false }));
  await answer;
});

it('cancels deferred native minimize after a newer same-game restore', async () => {
  await openForeground();
  let finishSnapshot: (value: null) => void = () => undefined;
  mockCaptureSnapshot.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishSnapshot = resolve;
      })
  );
  const event = {
    id: 'origin',
    managedHostCloseToken: mockOpen.mock.calls[0]![0].managedHostClose!.token,
    policyRevision: 2,
    visibilitySequence: control().sessionStates[0]?.instance?.currentVisibilitySequence
  };
  act(() => nativeListeners.get('presentationMinimizeRequested')?.(event));
  await waitFor(() => expect(mockCaptureSnapshot).toHaveBeenCalled());
  await act(async () => control().restore('origin'));
  await act(async () => {
    finishSnapshot(null);
    await Promise.resolve();
  });
  expect(control().mode).toBe('active');
  expect(control().session?.id).toBe('origin');
});

it('supersedes an already-issued deferred minimize hide when the same game is restored', async () => {
  await openForeground();
  let finishHide: () => void = () => undefined;
  mockSetVisible.mockImplementation((_id, visible) =>
    visible
      ? Promise.resolve()
      : new Promise(resolve => {
          finishHide = resolve;
        })
  );
  const original = control().sessionStates[0]!;
  const event = {
    id: 'origin',
    managedHostCloseToken: mockOpen.mock.calls[0]![0].managedHostClose!.token,
    policyRevision: 2,
    visibilitySequence: original.instance?.currentVisibilitySequence
  };
  act(() => nativeListeners.get('presentationMinimizeRequested')?.(event));
  await waitFor(() => expect(lastVisibility()).toBe(false));
  const hideSequence = original.instance!.currentVisibilitySequence;
  await act(async () => control().restore('origin'));
  await act(async () => {
    finishHide();
    await Promise.resolve();
  });
  await waitFor(() => expect(lastVisibility()).toBe(true));
  expect(original.instance!.currentVisibilitySequence).toBeGreaterThan(hideSequence);
  expect(control().sessionStates[0]?.instance).toBe(original.instance);
  expect(control().session?.id).toBe('origin');
  expect(control().mode).toBe('active');
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockRemoveSession).not.toHaveBeenCalled();
  mockSetVisible.mockImplementation(async () => {});
});

it('rejects a delayed native minimize replay from the prior visible stay', async () => {
  await openForeground();
  const event = {
    id: 'origin',
    managedHostCloseToken: mockOpen.mock.calls[0]![0].managedHostClose!.token,
    policyRevision: 2,
    visibilitySequence: control().sessionStates[0]?.instance?.currentVisibilitySequence
  };
  act(() => nativeListeners.get('presentationMinimizeRequested')?.(event));
  await waitFor(() => expect(control().mode).toBe('launcher'));
  await act(async () => control().restore('origin'));
  await waitFor(() => expect(lastVisibility()).toBe(true));
  expect(control().sessionStates[0]?.instance?.currentVisibilitySequence).toBeGreaterThan(event.visibilitySequence!);
  await act(async () => nativeListeners.get('presentationMinimizeRequested')?.(event));
  await settle();
  expect(control().mode).toBe('active');
  expect(control().session?.id).toBe('origin');
});

it('rejects stale or host-blocked native capsule minimize requests', async () => {
  await openForeground();
  const lifetime = mockOpen.mock.calls[0]![0].managedHostClose!.token;
  expect(nativeListeners.has('presentationMinimizeRequested')).toBe(true);
  for (const event of [
    { id: 'origin', managedHostCloseToken: 'outgoing', policyRevision: 2 },
    { id: 'origin', managedHostCloseToken: lifetime, policyRevision: 1 },
    { id: 'other', managedHostCloseToken: lifetime, policyRevision: 2 }
  ])
    await act(async () => nativeListeners.get('presentationMinimizeRequested')?.(event));
  expect(control().mode).toBe('active');
  act(() => externalPageFailed());
  await act(async () =>
    nativeListeners.get('presentationMinimizeRequested')?.({
      id: 'origin',
      managedHostCloseToken: lifetime,
      policyRevision: 2,
      visibilitySequence: control().sessionStates[0]?.instance?.currentVisibilitySequence
    })
  );
  expect(control().mode).toBe('active');
});

it('suspends fullscreen for the production external failure alert outside the dapp provider', async () => {
  await openForeground();
  act(() => externalPageFailed());
  expect(screen.getByRole('alertdialog', { name: en.error })).toHaveAccessibleDescription(en.externalPageLoadFailed);
  expect(lastVisibility()).toBe(false);
  await closeAlert();
  await waitFor(() => expect(lastVisibility()).toBe(true));
  expect(control().sessionStates[0]?.presentation).toBe('fullscreen');
  expect(control().session?.id).toBe('origin');
  expect(mockOpen).toHaveBeenCalledTimes(1);
});

it('suspends fullscreen for a real generic confirm and resolves through its actual cancel button', async () => {
  await openForeground();
  let answer: Promise<boolean> | undefined;
  act(() => {
    answer = confirm?.({ title: 'Delete contact', children: 'Keep the game paused.' });
    if (answer) pendingDialogs.push(answer);
  });
  expect(screen.getByRole('alertdialog', { name: 'Delete contact' })).toBeInTheDocument();
  expect(lastVisibility()).toBe(false);
  await act(async () => {
    fireEvent.click(screen.getByTestId('confirmation-modal-cancel'));
    await expect(answer).resolves.toBe(false);
  });
  expect(lastVisibility()).toBe(true);
  expect(mockOpen).toHaveBeenCalledTimes(1);
});

it.each(['actions', 'alert'])('keeps actions plus a generic alert hidden when %s closes first', async first => {
  await openForeground({ actions: true });
  fireEvent.click(screen.getByTestId('actions-trigger'));
  act(() => externalPageFailed());
  mockSetVisible.mockClear();
  if (first === 'actions') closeActions();
  else await closeAlert();
  await settle();
  act(() => control().setSlotRect({ x: 0, y: 0, width: 600, height: 375 }));
  await settle();
  expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
  if (first === 'actions') await closeAlert();
  else closeActions();
  await settle();
  expect(lastVisibility()).toBe(true);
  expect(mockOpen).toHaveBeenCalledTimes(1);
});

it.each(['actions', 'approval'])('keeps actions plus real approval state hidden when %s closes first', async first => {
  await openForeground({ actions: true });
  fireEvent.click(screen.getByTestId('actions-trigger'));
  let pending: Promise<unknown> | undefined;
  act(() => {
    pending = dappConfirmationStore.requestConfirmation(approval());
  });
  await settle();
  mockSetVisible.mockClear();
  if (first === 'actions') closeActions();
  else
    act(() => {
      dappConfirmationStore.resolveConfirmation('origin', { confirmed: false });
    });
  await settle();
  expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
  if (first === 'actions')
    act(() => {
      dappConfirmationStore.resolveConfirmation('origin', { confirmed: false });
    });
  else closeActions();
  await pending;
  await settle();
  expect(lastVisibility()).toBe(true);
});

it.each(['locked', 'unhydrated', 'outside shell'])(
  'does not reveal on hold release with a non-null slot while %s',
  async condition => {
    const tree = await openForeground({ held: true });
    if (condition === 'locked') mockStatus = WalletStatus.Locked;
    if (condition === 'unhydrated') mockHydrated = false;
    if (condition === 'outside shell') mockPath = '/welcome';
    tree.rerender(<Tree held />);
    mockSetVisible.mockClear();
    tree.rerender(<Tree held={false} />);
    await settle();
    expect(control().slotRect).toEqual(RECT);
    expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
    mockStatus = WalletStatus.Ready;
    mockHydrated = true;
    mockPath = '/browser';
    tree.rerender(<Tree />);
    await settle();
    expect(lastVisibility()).toBe(true);
  }
);

it('keeps the popup block through unlock and never restores a closed hidden origin', async () => {
  const tree = await openForeground();
  act(() => externalPageFailed());
  expect(lastVisibility()).toBe(false);
  mockStatus = WalletStatus.Locked;
  tree.rerender(<Tree />);
  await settle();
  mockSetVisible.mockClear();
  mockStatus = WalletStatus.Ready;
  tree.rerender(<Tree />);
  await settle();
  expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
  await act(async () => {
    await control().close('origin');
  });
  mockSetVisible.mockClear();
  await closeAlert();
  expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
  expect(control().sessionStates).toHaveLength(0);
});

it('cancels a pending native positioning continuation when a popup opens and the origin closes', async () => {
  await openForeground();
  let finish: () => void = () => {
    throw new Error('positioning not started');
  };
  mockSetRect.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  act(() => control().setSlotRect({ x: 0, y: 0, width: 600, height: 375 }));
  expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
  act(() => externalPageFailed());
  await act(async () => {
    await control().close('origin');
  });
  mockSetVisible.mockClear();
  await act(async () => {
    finish();
  });
  await closeAlert();
  expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
  expect(control().sessionStates).toHaveLength(0);
});

it('keeps a delayed fullscreen window hidden until both a popup and its hold release', async () => {
  let finish: () => void = () => {
    throw new Error('opening not started');
  };
  mockOpen.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  currentTree = render(<Tree held />);
  await waitFor(() => expect(nativeListeners.has('presentationChanged')).toBe(true));
  act(() => {
    control().open(session('origin'));
    control().setSlotRect(RECT);
  });
  await waitFor(() => expect(mockOpen).toHaveBeenCalled());
  act(() =>
    nativeListeners.get('presentationChanged')?.({
      id: 'origin',
      display: 'fullscreen',
      policyResolved: true,
      policyRevision: 2,
      managedHostCloseToken: mockOpen.mock.calls[0]?.[0].managedHostClose?.token
    })
  );
  act(() => externalPageFailed());
  await act(async () => {
    finish();
  });
  expect(lastVisibility()).toBe(false);
  expect(control().sessionStates[0]?.presentation).toBe('fullscreen');
  mockSetVisible.mockClear();
  currentTree.rerender(<Tree />);
  await settle();
  expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
  await closeAlert();
  expect(lastVisibility()).toBe(true);
});

it('suppresses lock immediately while the reported native slot remains mounted', async () => {
  const tree = await openForeground();
  mockStatus = WalletStatus.Locked;
  tree.rerender(<Tree />);
  expect(lastVisibility()).toBe(false);
  expect(control().slotRect).toEqual(RECT);
  expect(control().session?.id).toBe('origin');
});

it('releases unmounted hold owners without leaving the next provider blocked', async () => {
  const first = await openForeground({ held: true });
  expect(document.body.hasAttribute('data-drawer-open')).toBe(true);
  await act(async () => {
    await control().close('origin');
  });
  first.unmount();
  expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  await openForeground();
  await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2));
  await settle();
  expect(control().session?.id).toBe('origin');
  act(() => externalPageFailed());
  expect(lastVisibility()).toBe(false);
  await closeAlert();
  expect(lastVisibility()).toBe(true);
});

it('does not reveal the previous foreground when positioning completes after replacement under a popup', async () => {
  await openForeground();
  let finish: () => void = () => {
    throw new Error('positioning not started');
  };
  mockSetRect.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  act(() => control().setSlotRect({ x: 0, y: 0, width: 600, height: 375 }));
  act(() => externalPageFailed());
  act(() => control().open(session('replacement')));
  await waitFor(() =>
    expect(control().sessionStates.find(state => state.session.id === 'replacement')?.instance).not.toBeNull()
  );
  mockSetVisible.mockClear();
  await act(async () => {
    finish();
  });
  expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
  expect(mockSetVisible).not.toHaveBeenCalledWith('replacement', true);
  await closeAlert();
  expect(lastVisibility('replacement')).toBe(true);
  expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
  expect(control().session?.id).toBe('replacement');
});

it('keeps the native opening hidden before its handle returns under a hold and real alert', async () => {
  let nativeVisible = false;
  let finish = () => {};
  mockSetVisible.mockImplementation(async (_id, visible) => {
    nativeVisible = visible;
  });
  mockOpen.mockImplementationOnce(options => {
    nativeVisible = options.initiallyVisible !== false;
    return new Promise<void>(resolve => {
      finish = resolve;
    });
  });
  currentTree = render(<Tree held />);
  await waitFor(() => expect(nativeListeners.has('presentationChanged')).toBe(true));
  act(() => {
    control().open(session('origin'));
    control().setSlotRect(RECT);
  });
  await waitFor(() => expect(mockOpen).toHaveBeenCalled());
  act(() => externalPageFailed());
  expect(screen.getByRole('alertdialog', { name: en.error })).toBeInTheDocument();
  await settle();
  try {
    expect(control().sessionStates[0]?.instance).toBeNull();
    expect(nativeVisible).toBe(false);
  } finally {
    await act(async () => {
      finish();
    });
    mockSetVisible.mockImplementation(async () => {});
  }
});

it('does not reposition or reveal after a production title message', async () => {
  await openForeground();
  mockSetRect.mockClear();
  await act(async () => {
    await nativeListeners.get('messageFromWebview')?.({
      id: 'origin',
      detail: { __midenInternal: 'title', title: 'Updated title' }
    });
  });
  expect(control().session?.title).toBe('Updated title');
  expect(mockSetRect).not.toHaveBeenCalled();
  expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
});

it('retains in-flight positioning through a production title message', async () => {
  await openForeground();
  let finish = () => {};
  mockSetRect.mockClear();
  mockSetRect.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  act(() => control().setSlotRect({ x: 0, y: 0, width: 600, height: 375 }));
  await act(async () => {
    await nativeListeners.get('messageFromWebview')?.({
      id: 'origin',
      detail: { __midenInternal: 'title', title: 'Loading title' }
    });
  });
  try {
    expect(control().session?.title).toBe('Loading title');
    expect(mockSetRect).toHaveBeenCalledTimes(1);
    expect(mockSetVisible).not.toHaveBeenCalledWith('origin', true);
  } finally {
    await act(async () => {
      finish();
    });
  }
  expect(mockSetVisible.mock.calls.filter(call => call[0] === 'origin' && call[1])).toHaveLength(1);
});

it('does not restart the foreground reveal when an unrelated native session closes', async () => {
  await openForeground();
  act(() => control().open(session('replacement')));
  await waitFor(() => expect(lastVisibility('replacement')).toBe(true));
  mockSetRect.mockClear();
  mockSetVisible.mockClear();
  await act(async () => {
    await control().close('origin');
  });
  expect(control().session?.id).toBe('replacement');
  expect(mockSetRect).not.toHaveBeenCalledWith('replacement', expect.anything());
  expect(mockSetVisible).not.toHaveBeenCalledWith('replacement', true);
});

it('removes managed-close authority before waiting for the host reset and destination commit', async () => {
  await openForeground();
  let resetFinished = () => {};
  mockResetViewport.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        resetFinished = resolve;
      })
  );
  const token = mockOpen.mock.calls[0]?.[0].managedHostClose?.token;
  expect(typeof token).toBe('string');
  act(() => nativeListeners.get('hostCloseRequested')?.({ id: 'origin', token, requestId: 'close-1', visible: true }));
  expect(control().sessionStates).toHaveLength(0);
  expect(control().mode).toBe('launcher');
  expect(mockCompleteClose).not.toHaveBeenCalled();
  // This harness has no BrowserScreen, so a launcher receipt must not be invented.
  await act(async () => resetFinished());
  expect(mockCompleteClose).not.toHaveBeenCalled();
  mockPath = '/settings';
  currentTree?.rerender(<Tree />);
  await settle();
  expect(mockCompleteClose).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'origin', token, requestId: 'close-1' })
  );
});

it('does not reset the unrelated foreground viewport when a hidden origin closes', async () => {
  await openForeground();
  const token = mockOpen.mock.calls[0]?.[0].managedHostClose?.token;
  expect(typeof token).toBe('string');
  await act(async () => control().park('origin'));
  mockResetViewport.mockClear();
  act(() =>
    nativeListeners.get('hostCloseRequested')?.({ id: 'origin', token, requestId: 'hidden-close', visible: false })
  );
  await settle();
  expect(control().sessionStates).toHaveLength(0);
  expect(mockResetViewport).not.toHaveBeenCalled();
  expect(mockCompleteClose).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'hidden-close' }));
});

it('joins an already pending native close and ignores terminal events from an old lifetime', async () => {
  await openForeground({ held: true });
  const token = mockOpen.mock.calls[0]?.[0].managedHostClose?.token;
  act(() =>
    nativeListeners.get('hostCloseRequested')?.({ id: 'origin', token, requestId: 'close-join', visible: false })
  );
  await settle();
  let settled = false;
  const joined = control()
    .close('origin')
    .then(() => {
      settled = true;
    });
  await settle();
  expect(settled).toBe(false);
  await act(async () => {
    nativeListeners.get('closeEvent')?.({ id: 'origin', managedHostCloseToken: 'old-lifetime' });
  });
  expect(settled).toBe(false);
  await act(async () => {
    nativeListeners.get('closeEvent')?.({ id: 'origin', managedHostCloseToken: token });
    await joined;
  });
  expect(settled).toBe(true);
  expect(control().sessionStates).toHaveLength(0);
});

it('reserves a managed id until the retained native close reaches terminal', async () => {
  await openForeground({ held: true });
  const token = mockOpen.mock.calls[0]?.[0].managedHostClose?.token;
  act(() =>
    nativeListeners.get('hostCloseRequested')?.({ id: 'origin', token, requestId: 'reserved', visible: false })
  );
  await settle();
  act(() => control().open(session('origin')));
  await settle();
  expect(control().sessionStates).toHaveLength(0);
  expect(mockOpen).toHaveBeenCalledTimes(1);
  await act(async () => nativeListeners.get('closeEvent')?.({ id: 'origin', managedHostCloseToken: token }));
  act(() => control().open(session('origin')));
  await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2));
});

it('holds the id through persistence after native terminal without parking another foreground', async () => {
  await openForeground({ held: true });
  const token = mockOpen.mock.calls[0]?.[0].managedHostClose?.token;
  let finishStorage = () => {};
  mockRemoveSession.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finishStorage = resolve;
      })
  );
  act(() => nativeListeners.get('hostCloseRequested')?.({ id: 'origin', token, requestId: 'storage', visible: false }));
  act(() => control().open(session('other')));
  await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2));
  let joined = false;
  const close = control()
    .close('origin')
    .then(() => {
      joined = true;
    });
  const terminal = nativeListeners.get('closeEvent')?.({ id: 'origin', managedHostCloseToken: token });
  act(() => control().open(session('origin')));
  await settle();
  expect(control().session?.id).toBe('other');
  expect(control().sessionStates.map(s => s.session.id)).toEqual(['other']);
  expect(joined).toBe(false);
  await act(async () => {
    finishStorage();
    await terminal;
    await close;
  });
  expect(joined).toBe(true);
  act(() => control().open(session('origin')));
  await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(3));
});

it.each(['native-first', 'cleanup-first', 'cleanup-rejected'] as const)(
  'dispatches current host paint before storage cleanup and joins close completion in %s order',
  async order => {
    let finishOpen = () => {};
    let finishSession = () => {};
    let finishSnapshot = () => {};
    let finishReset = () => {};
    const cleanupFailed = order === 'cleanup-rejected';
    const warnings = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockOpen.mockImplementationOnce(() => new Promise<void>(resolve => (finishOpen = resolve)));
    mockRemoveSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          finishSession = () => (cleanupFailed ? reject(new Error('session cleanup rejected')) : resolve());
        })
    );
    mockRemoveSnapshot.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          finishSnapshot = () => (cleanupFailed ? reject(new Error('snapshot cleanup rejected')) : resolve());
        })
    );
    mockResetViewport.mockImplementationOnce(() => new Promise<void>(resolve => (finishReset = resolve)));
    currentTree = render(<Tree screen />);
    await waitFor(() => expect(nativeListeners.has('hostCloseRequested')).toBe(true));
    const launcher = screen.getByTestId('retained-launcher');
    act(() => control().open(session('cleanup')));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    const token = mockOpen.mock.calls[0]?.[0].managedHostClose?.token;
    act(() =>
      nativeListeners.get('presentationChanged')?.({
        id: 'cleanup',
        display: 'browser',
        policyResolved: true,
        policyRevision: 2,
        managedHostCloseToken: token
      })
    );
    await settle();
    expect(launcher).not.toBeVisible();
    act(() =>
      nativeListeners.get('hostCloseRequested')?.({ id: 'cleanup', token, requestId: 'old-request', visible: true })
    );
    expect(control().sessionStates).toHaveLength(0);
    expect(control().mode).toBe('launcher');
    await settle();
    expect(screen.getByTestId('retained-launcher')).toBe(launcher);
    expect(launcher).toBeVisible();
    expect(launcher.parentElement?.inert).toBe(false);
    expect(control().slotRect).toBeNull();
    expect(mockCompleteClose).not.toHaveBeenCalled();
    act(() => {
      nativeListeners.get('hostCloseRequested')?.({
        id: 'cleanup',
        token: 'stale-lifetime',
        requestId: 'stale',
        visible: true
      });
      nativeListeners.get('hostCloseRequested')?.({
        id: 'cleanup',
        token,
        requestId: 'current-request',
        visible: true
      });
    });
    let completed = 0;
    const close = control()
      .close('cleanup')
      .then(() => completed++);
    await act(async () => finishReset());
    expect(mockCompleteClose).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'cleanup',
        token,
        requestId: 'current-request',
        hostCommitGeneration: expect.any(Number)
      })
    );
    expect(mockCompleteClose).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 'old-request' }));
    expect(completed).toBe(0);
    act(() => control().open(session('cleanup')));
    await settle();
    expect(mockOpen).toHaveBeenCalledTimes(1);
    await act(async () => finishOpen());
    expect(control().sessionStates).toHaveLength(0);
    let terminal: void | Promise<void> = undefined;
    if (order === 'native-first') {
      terminal = nativeListeners.get('closeEvent')?.({ id: 'cleanup', managedHostCloseToken: token });
    }
    await settle();
    expect(completed).toBe(0);
    act(() => control().open(session('cleanup')));
    await settle();
    expect(mockOpen).toHaveBeenCalledTimes(1);
    await act(async () => finishSession());
    expect(completed).toBe(0);
    await act(async () => finishSnapshot());
    await settle();
    expect(completed).toBe(order === 'native-first' ? 1 : 0);
    if (order !== 'native-first') {
      terminal = nativeListeners.get('closeEvent')?.({ id: 'cleanup', managedHostCloseToken: token });
    }
    await act(async () => {
      await terminal;
      await close;
    });
    expect(completed).toBe(1);
    expect(warnings).toHaveBeenCalledTimes(cleanupFailed ? 2 : 0);
    act(() => control().open(session('cleanup')));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2));
  }
);

it('waits for the actual Launcher activation and outstanding slot before host paint', async () => {
  currentTree = render(<Tree screen />);
  await waitFor(() => expect(nativeListeners.has('hostCloseRequested')).toBe(true));
  act(() => control().open(session('delayed-launcher')));
  await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
  const token = mockOpen.mock.calls[0]?.[0].managedHostClose?.token;
  currentTree.rerender(<Tree screen onScreen={false} />);
  act(() =>
    nativeListeners.get('hostCloseRequested')?.({
      id: 'delayed-launcher',
      token,
      requestId: 'delayed',
      visible: true
    })
  );
  await settle();
  const launcher = screen.getByTestId('retained-launcher');
  expect(launcher.parentElement?.inert).toBe(true);
  expect(launcher.parentElement).toHaveAttribute('aria-hidden', 'true');
  expect(mockCompleteClose).not.toHaveBeenCalled();
  act(() => control().setSlotRect(RECT));
  currentTree.rerender(<Tree screen />);
  await settle();
  expect(launcher.parentElement?.inert).toBe(false);
  expect(mockCompleteClose).not.toHaveBeenCalled();
  currentTree.rerender(<Tree screen onScreen={false} />);
  act(() => control().setSlotRect(null));
  await settle();
  expect(mockCompleteClose).not.toHaveBeenCalled();
  currentTree.rerender(<Tree screen />);
  await settle();
  expect(launcher.parentElement?.inert).toBe(false);
  expect(mockCompleteClose).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'delayed-launcher',
      token,
      requestId: 'delayed',
      hostCommitGeneration: expect.any(Number)
    })
  );
  const receipts = mockCompleteClose.mock.calls.length;
  currentTree.rerender(<Tree screen />);
  await settle();
  currentTree.rerender(<Tree screen />);
  await settle();
  expect(mockCompleteClose).toHaveBeenCalledTimes(receipts);
});

it('keeps the managed reservation when its pending open rejects during the retained hold', async () => {
  let rejectOpen: (error: Error) => void = () => {};
  mockOpen.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectOpen = reject;
      })
  );
  currentTree = render(<Tree held />);
  await waitFor(() => expect(nativeListeners.has('presentationChanged')).toBe(true));
  act(() => {
    control().open(session('origin'));
    control().setSlotRect(RECT);
  });
  await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
  const token = mockOpen.mock.calls[0]?.[0].managedHostClose?.token;
  act(() =>
    nativeListeners.get('hostCloseRequested')?.({ id: 'origin', token, requestId: 'reject-held', visible: false })
  );
  await settle();
  await act(async () => rejectOpen(new Error('retired open rejected')));
  act(() => control().open(session('origin')));
  await settle();
  expect(control().sessionStates).toHaveLength(0);
  expect(mockOpen).toHaveBeenCalledTimes(1);
  await act(async () => nativeListeners.get('closeEvent')?.({ id: 'origin', managedHostCloseToken: token }));
  act(() => control().open(session('origin')));
  await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2));
});

it('commits the same measurable host surface before acknowledging browser policy and rejects old receipts', async () => {
  currentTree = render(<Tree screen />);
  await waitFor(() => expect(nativeListeners.has('presentationChanged')).toBe(true));
  const launcher = screen.getByTestId('retained-launcher');
  act(() => control().open(session('policy')));
  await waitFor(() => expect(control().sessionStates[0]?.instance).not.toBeNull());
  const active = screen.getByTestId('dapp-active');
  const lifetime = mockOpen.mock.calls[0]![0].managedHostClose!.token;
  expect(launcher).toBeVisible();
  expect(active).not.toBeVisible();
  expect(active.inert).toBe(true);
  expect(control().slotRect).toMatchObject({ width: 375, height: 600 });
  expect(mockSetVisible.mock.calls.some(call => call[2] !== undefined)).toBe(false);
  const pendingBounds: Array<() => void> = [];
  mockSetRect.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        pendingBounds.push(resolve);
      })
  );
  act(() =>
    nativeListeners.get('presentationChanged')?.({
      id: 'policy',
      display: 'browser',
      policyResolved: true,
      policyRevision: 2,
      managedHostCloseToken: lifetime
    })
  );
  await settle();
  expect(screen.getByTestId('dapp-active')).toBe(active);
  expect(active).toBeVisible();
  expect(active.inert).toBe(false);
  expect(launcher).not.toBeVisible();
  expect(mockSetVisible.mock.calls.some(call => call[2] === 2)).toBe(false);
  mockSetRect.mockImplementation(async () => {});
  await act(async () => {
    pendingBounds.forEach(resolve => resolve());
  });
  await waitFor(() => expect(mockSetVisible).toHaveBeenCalledWith('policy', true, 2));
  mockSetVisible.mockClear();
  mockSetRect.mockClear();
  act(() =>
    nativeListeners.get('presentationChanged')?.({
      id: 'policy',
      display: 'browser',
      policyResolved: true,
      policyRevision: 2,
      managedHostCloseToken: lifetime
    })
  );
  await settle();
  expect(mockSetVisible).not.toHaveBeenCalled();
  expect(mockSetRect).not.toHaveBeenCalled();
  act(() =>
    nativeListeners.get('presentationChanged')?.({
      id: 'policy',
      display: 'browser',
      policyResolved: false,
      policyRevision: 3,
      managedHostCloseToken: lifetime
    })
  );
  await settle();
  expect(launcher).toBeVisible();
  expect(active).not.toBeVisible();
  mockSetVisible.mockClear();
  act(() => {
    control().reportPresentationLayout('policy', lifetime, 2, RECT);
    nativeListeners.get('presentationChanged')?.({
      id: 'policy',
      display: 'fullscreen',
      policyResolved: true,
      policyRevision: 2,
      managedHostCloseToken: lifetime
    });
    nativeListeners.get('presentationChanged')?.({
      id: 'policy',
      display: 'fullscreen',
      policyResolved: true,
      policyRevision: 99,
      managedHostCloseToken: 'outgoing-lifetime'
    });
  });
  await settle();
  expect(control().policyPending).toBe(true);
  expect(mockSetVisible.mock.calls.some(call => call[2] !== undefined)).toBe(false);
  expect(screen.getByTestId('retained-launcher')).toBe(launcher);
});

it('cancels a resolved-policy acknowledgement while host bounds are pending under a popup', async () => {
  currentTree = render(<Tree screen />);
  await waitFor(() => expect(nativeListeners.has('presentationChanged')).toBe(true));
  act(() => control().open(session('policy-popup')));
  await waitFor(() => expect(control().sessionStates[0]?.instance).not.toBeNull());
  const lifetime = mockOpen.mock.calls[0]![0].managedHostClose!.token;
  const queuedBounds: Array<() => void> = [];
  mockSetRect.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        queuedBounds.push(resolve);
      })
  );
  act(() =>
    nativeListeners.get('presentationChanged')?.({
      id: 'policy-popup',
      display: 'fullscreen',
      policyResolved: true,
      policyRevision: 2,
      managedHostCloseToken: lifetime
    })
  );
  await settle();
  expect(screen.getByTestId('retained-launcher')).toBeVisible();
  expect(screen.getByTestId('dapp-active')).not.toBeVisible();
  act(() => externalPageFailed());
  await settle();
  mockSetVisible.mockClear();
  await act(async () => {
    queuedBounds.forEach(resolve => resolve());
  });
  expect(mockSetVisible.mock.calls.some(call => call[1] === true)).toBe(false);
  mockSetRect.mockImplementation(async () => {});
  await closeAlert();
  await waitFor(() => expect(mockSetVisible).toHaveBeenCalledWith('policy-popup', true, 2));
});

describe('public approval reopening through real AnimatePresence', () => {
  async function reopen(settled: boolean) {
    mockRealApproval = true;
    await openForeground();
    const first = { ...approval(), id: 'approval-a', type: 'sign' as const, transactionMessages: ['Request A'] };
    let firstAnswer: Promise<unknown> | undefined;
    act(() => {
      firstAnswer = dappConfirmationStore.requestConfirmation(first);
    });
    const oldDialog = screen.getByText('Request A').closest('[role="dialog"]') as HTMLElement;
    await waitFor(() => expect(oldDialog).toHaveStyle({ opacity: '1' }));
    act(() => externalPageFailed());
    const alert = screen.getByRole('alertdialog', { name: en.error });
    await waitFor(() => expect(alert).toContainElement(document.activeElement as HTMLElement));
    await act(async () => {
      expect(dappConfirmationStore.resolveConfirmation('origin', { confirmed: false }, first.id)).toBe(true);
      await expect(firstAnswer).resolves.toEqual({ confirmed: false });
    });
    expect(dappConfirmationStore.getAllPendingRequests()).toHaveLength(0);
    expect(oldDialog.isConnected).toBe(true);
    expect(lastVisibility()).toBe(false);
    if (settled) await waitFor(() => expect(oldDialog.isConnected).toBe(false));
    const second = { ...first, id: 'approval-b', origin: 'https://second.test', transactionMessages: ['Request B'] };
    const secondResult = jest.fn();
    act(() => {
      void dappConfirmationStore.requestConfirmation(second).then(secondResult);
    });
    const newDialog = screen.getByText('Request B').closest('[role="dialog"]') as HTMLElement;
    expect(dappConfirmationStore.resolveConfirmation('origin', { confirmed: true }, first.id)).toBe(false);
    expect(secondResult).not.toHaveBeenCalled();
    expect(dappConfirmationStore.getPendingRequest('origin')?.id).toBe(second.id);
    expect(lastVisibility()).toBe(false);
    return { oldDialog, newDialog, alert, secondResult };
  }

  it('keeps retained A actions bound to A while B is pending', async () => {
    const { oldDialog, newDialog, secondResult } = await reopen(false);
    expect(oldDialog.isConnected).toBe(true);
    expect(oldDialog).toHaveTextContent('Request A');
    expect(newDialog).toHaveTextContent('Request B');
    for (const button of Array.from(oldDialog.querySelectorAll('button'))) fireEvent.click(button);
    await settle();
    expect(secondResult).not.toHaveBeenCalled();
    expect(dappConfirmationStore.getPendingRequest('origin')?.id).toBe('approval-b');
    expect(lastVisibility()).toBe(false);
    fireEvent.click(within(newDialog).getByRole('button', { name: en.deny }));
    await waitFor(() => expect(secondResult).toHaveBeenCalledWith({ confirmed: false }));
    expect(secondResult).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct title associations for retained A and current B', async () => {
    const { oldDialog, newDialog } = await reopen(false);
    expect(oldDialog.isConnected).toBe(true);
    const oldTitle = oldDialog.querySelector('h2')!;
    const newTitle = newDialog.querySelector('h2')!;
    expect(oldTitle.id).not.toBe(newTitle.id);
    expect(oldDialog).toHaveAttribute('aria-labelledby', oldTitle.id);
    expect(newDialog).toHaveAttribute('aria-labelledby', newTitle.id);
    expect(oldDialog).toHaveAttribute('aria-hidden', 'true');
    expect(oldTitle).toHaveTextContent('https://origin.test');
    expect(newDialog).toHaveAccessibleName('https:// second.test');
  });

  it.each([false, true])('renews focus and pointer ownership after prior exit settled=%s', async settled => {
    const { oldDialog, newDialog, alert } = await reopen(settled);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const layers = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    expect({
      reusedPriorDialog: newDialog === oldDialog,
      ownsFocus: newDialog.contains(document.activeElement),
      pointerEvents: newDialog.style.pointerEvents,
      underlyingPointerEvents: alert.style.pointerEvents,
      portalAfterAlert: layers.indexOf(newDialog) > layers.indexOf(alert)
    }).toEqual({
      reusedPriorDialog: false,
      ownsFocus: true,
      pointerEvents: 'auto',
      underlyingPointerEvents: 'none',
      portalAfterAlert: true
    });
    const buttons = within(newDialog).getAllByRole('button');
    buttons.at(-1)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(buttons[0]).toHaveFocus();
  });

  it.each([
    [false, 'Escape'],
    [false, 'Back'],
    [true, 'Escape'],
    [true, 'Back']
  ] as const)('dismisses only B and keeps the remaining alert hold, settled=%s via %s', async (settled, method) => {
    const { newDialog, alert, secondResult } = await reopen(settled);
    if (method === 'Escape') fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    else {
      act(() => {
        for (const overlay of [true, false]) {
          const handlers = mockBackHandlers.filter(entry => entry.active && entry.overlay === overlay).reverse();
          for (const entry of handlers) if (entry.handler() === true) return;
        }
      });
    }
    await waitFor(() => expect(secondResult).toHaveBeenCalledWith({ confirmed: false }));
    expect(secondResult).toHaveBeenCalledTimes(1);
    expect(dappConfirmationStore.getAllPendingRequests()).toHaveLength(0);
    expect(alert).toHaveAttribute('data-state', 'open');
    expect(lastVisibility()).toBe(false);
    await waitFor(() => expect(newDialog.isConnected).toBe(false));
    await waitFor(() => expect(alert).toContainElement(document.activeElement as HTMLElement));
    await closeAlert();
    await waitFor(() => expect(lastVisibility()).toBe(true));
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });
});

const CARD = { x: 282, y: 650, width: 104, height: 132, cornerRadius: 16 };
const UUID = /^[0-9a-f-]{36}$/;
const lifetime = () => mockOpen.mock.calls[0]![0].managedHostClose!.token;
const morphRequests = () => mockMorph.mock.calls.map(([, request]) => request);
function lastMorphId() {
  const request = mockMorph.mock.calls.at(-1)?.[1];
  if (!request || typeof request !== 'object' || !('morphId' in request) || typeof request.morphId !== 'string')
    throw new Error('No morph was sent');
  return request.morphId;
}
function emitMorphForSession(
  sessionId: string,
  phase: string,
  target: string,
  morphId = lastMorphId(),
  extra: { tracking?: boolean } = {}
) {
  act(() =>
    nativeListeners.get('presentationMorph')?.({
      id: sessionId,
      morphId,
      phase,
      target,
      progress: target === 'collapsed' ? 0 : 1,
      velocity: 0,
      tracking: extra.tracking ?? false,
      visibilitySequence: 0,
      managedHostCloseToken: managedTokenFor(sessionId)
    })
  );
}
function emitMorph(phase: string, target: string, morphId = lastMorphId(), extra: { tracking?: boolean } = {}) {
  emitMorphForSession('origin', phase, target, morphId, extra);
}
const parked = () => control().parkedSessions.map(state => state.session.id);

// Capacitor hands a plugin call to native one microtask after it is made, as React flushes a tap's updates, so a morph
// sent after the tap's first update reaches native only once React has rendered.
async function renderedWhenMorphSent(start: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  mockMorph.mockImplementation(() =>
    Promise.resolve().then(() => {
      seen.push(control().motion);
      return { accepted: true };
    })
  );
  const actEnvironment: unknown = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false);
  driverAction = start;
  try {
    // Dispatched directly: RTL's fireEvent renders inside act, before any microtask.
    screen.getByTestId('driver-action').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    driverAction = undefined;
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment);
  }
  return seen;
}

describe('native morph collapse', () => {
  afterEach(() => jest.useRealTimers());

  async function startCollapse() {
    await openForeground();
    mockMorph.mockResolvedValue({ accepted: true });
    act(() => control().reportLandingCard(CARD));
    let parking: Promise<void> = Promise.resolve();
    act(() => {
      parking = control().park('origin');
    });
    await settle();
    // Wrapped: an async function returning the pending park would wait for it.
    return { parking };
  }

  it('collapses through morph and commits the park only on settled', async () => {
    const { parking } = await startCollapse();

    expect(mockSetMorphTarget).toHaveBeenCalledWith(CARD);
    expect(morphRequests()).toEqual([{ to: 'collapsed', card: CARD, morphId: expect.stringMatching(UUID) }]);
    expect(control().motion).toMatchObject({ id: 'origin', target: 'collapsed', morphId: lastMorphId() });
    emitMorph('started', 'collapsed');
    await settle();
    expect(control().mode).toBe('active');
    expect(lastVisibility()).toBeUndefined();

    emitMorph('settled', 'collapsed');
    await act(async () => parking);
    expect(parked()).toEqual(['origin']);
    expect(control().mode).toBe('launcher');
    expect(mockUpsertSession).toHaveBeenCalledTimes(1);
  });

  it('acknowledges with a hide after two frames', async () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback));
    await startCollapse();

    emitMorph('settled', 'collapsed');
    await settle();
    expect(lastVisibility()).toBeUndefined();
    act(() => frames.splice(0).forEach(frame => frame(0)));
    expect(lastVisibility()).toBeUndefined();
    act(() => frames.splice(0).forEach(frame => frame(0)));
    await settle();

    expect(lastVisibility()).toBe(false);
    expect(control().motion).toBeNull();
  });

  it('acknowledges within 300 ms when frames stall', async () => {
    await startCollapse();
    jest.useFakeTimers();
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);

    emitMorph('settled', 'collapsed');
    await settle();
    act(() => jest.advanceTimersByTime(299));
    expect(lastVisibility()).toBeUndefined();
    act(() => jest.advanceTimersByTime(1));

    expect(lastVisibility()).toBe(false);
  });

  it('keeps the session foreground when the collapse is reversed', async () => {
    const { parking } = await startCollapse();

    emitMorph('retargeted', 'expanded');
    emitMorph('settled', 'expanded');
    await act(async () => parking);

    expect(control().mode).toBe('active');
    expect(parked()).toEqual([]);
    expect(mockUpsertSession).not.toHaveBeenCalled();
    expect(control().motion).toBeNull();
    expect(mockSetVisible).not.toHaveBeenCalledWith('origin', false);
  });

  it('leaves the session active when the collapse is cancelled', async () => {
    const { parking } = await startCollapse();

    emitMorph('cancelled', 'collapsed');
    await act(async () => parking);

    expect(control().mode).toBe('active');
    expect(control().session?.id).toBe('origin');
    expect(parked()).toEqual([]);
    expect(control().motion).toBeNull();
  });

  it('a confirmation arriving mid-collapse cancels the collapse and keeps the dApp foreground', async () => {
    mockRealApproval = true;
    const { parking } = await startCollapse();
    let answer: Promise<unknown> | undefined;

    act(() => {
      answer = dappConfirmationStore.requestConfirmation({ ...approval(), type: 'sign', transactionMessages: ['Mid'] });
    });
    expect(lastVisibility()).toBe(false);
    emitMorph('cancelled', 'collapsed');
    await act(async () => parking);

    expect(control().mode).toBe('active');
    expect(parked()).toEqual([]);
    await waitFor(() => expect(screen.getByText('Mid').closest('[role="dialog"]')).toBeVisible());
    act(() => dappConfirmationStore.resolveConfirmation('origin', { confirmed: false }));
    await answer;
  });

  it('a settled event at the nearest end after backgrounding commits that end', async () => {
    const { parking } = await startCollapse();

    emitMorph('settled', 'collapsed');
    await act(async () => parking);

    expect(parked()).toEqual(['origin']);
  });

  it('sends the collapse before the motion it follows renders', async () => {
    await openForeground();
    act(() => control().reportLandingCard(CARD));
    let parking: Promise<void> = Promise.resolve();

    const seen = await renderedWhenMorphSent(() => {
      parking = control().park('origin');
    });

    expect(seen).toEqual([null]);
    await settle();
    expect(control().motion).toMatchObject({ id: 'origin', target: 'collapsed', morphId: lastMorphId() });
    emitMorph('settled', 'collapsed');
    await act(async () => parking);
    expect(parked()).toEqual(['origin']);
  });

  it('falls back to the legacy park when native does not accept the morph', async () => {
    await openForeground();
    await act(async () => control().park('origin'));

    expect(morphRequests()).toHaveLength(1);
    expect(mockCaptureSnapshot).toHaveBeenCalledWith('origin', 0.5, 0.7);
    expect(mockCaptureSnapshot.mock.invocationCallOrder[0]).toBeLessThan(mockSetVisible.mock.invocationCallOrder[0]!);
    expect(lastVisibility()).toBe(false);
    expect(parked()).toEqual(['origin']);
    expect(control().mode).toBe('launcher');
    expect(control().motion).toBeNull();
  });

  it('requests the snapshot after the morph is accepted without awaiting it', async () => {
    mockCaptureSnapshot.mockImplementation(() => new Promise(() => {}));
    const { parking } = await startCollapse();

    expect(mockCaptureSnapshot).toHaveBeenCalledWith('origin', 0.5, 0.7);
    expect(mockMorph.mock.invocationCallOrder[0]).toBeLessThan(mockCaptureSnapshot.mock.invocationCallOrder[0]!);
    emitMorph('settled', 'collapsed');
    await act(async () => parking);

    expect(parked()).toEqual(['origin']);
  });
});

describe('native morph expand', () => {
  const VELOCITY = { x: 0, y: -900 };

  async function parkedForeground() {
    await openForeground();
    await act(async () => control().park('origin'));
    mockSetVisible.mockClear();
    mockMorph.mockReset().mockResolvedValue({ accepted: true });
  }

  it('restores through morph with the card rect and release velocity, committing the foreground at once', async () => {
    await parkedForeground();
    let moved: Promise<boolean> = Promise.resolve(false);

    act(() => {
      moved = control().restore('origin', { card: CARD, velocity: VELOCITY });
    });
    expect(control().mode).toBe('active');
    expect(control().session?.id).toBe('origin');
    expect(control().motion).toMatchObject({ id: 'origin', target: 'expanded', outgoingId: null });

    let accepted = false;
    await act(async () => {
      accepted = await moved;
    });
    expect(accepted).toBe(true);
    expect(morphRequests()).toEqual([
      { to: 'expanded', card: CARD, morphId: expect.stringMatching(UUID), velocity: VELOCITY }
    ]);
    emitMorph('started', 'expanded');
    expect(mockSetVisible).not.toHaveBeenCalled();
    emitMorph('settled', 'expanded');
    await settle();
    expect(control().motion).toBeNull();
    expect(lastVisibility()).toBe(true);
  });

  it('sends the expand before the foreground it commits renders', async () => {
    await parkedForeground();
    let moved: Promise<boolean> = Promise.resolve(false);

    const seen = await renderedWhenMorphSent(() => {
      moved = control().restore('origin', { card: CARD, velocity: VELOCITY });
    });

    expect(seen).toEqual([null]);
    let accepted = false;
    await act(async () => {
      accepted = await moved;
    });
    expect(accepted).toBe(true);
    expect(control().mode).toBe('active');
    expect(control().motion).toMatchObject({ id: 'origin', target: 'expanded', morphId: lastMorphId() });
  });

  it('re-runs the injection of a warm restore once its expand settles, not in flight', async () => {
    await openForeground();
    await act(async () => nativeListeners.get('browserPageLoaded')?.({ id: 'origin' }));
    await act(async () => control().park('origin'));
    mockMorph.mockReset().mockResolvedValue({ accepted: true });
    mockExecuteScript.mockClear();
    const injections = () => mockExecuteScript.mock.calls.filter(([, code]) => code === 'INJECTED;').length;

    await act(async () => {
      await control().restore('origin', { card: CARD, velocity: VELOCITY });
    });
    emitMorph('started', 'expanded');
    await settle();
    expect(injections()).toBe(0);
    emitMorph('settled', 'expanded');
    await settle();
    expect(injections()).toBe(1);
  });

  it('restores without a card from the switcher after it closes', async () => {
    await parkedForeground();
    act(() => control().openSwitcher());

    await act(async () => control().restore('origin'));
    expect(mockMorph).not.toHaveBeenCalled();
    await act(async () => control().park('origin'));
    act(() => control().closeSwitcher());
    await act(async () => control().restore('origin'));

    expect(morphRequests()).toEqual([{ to: 'expanded', card: null, morphId: expect.stringMatching(UUID) }]);
  });

  it('keeps the outgoing foreground visible until the new one settles, then parks it', async () => {
    await parkedForeground();
    act(() => control().open(session('second')));
    await waitFor(() => expect(control().sessionStates[1]?.instance).not.toBeNull());
    mockSetVisible.mockClear();

    await act(async () => control().restore('origin', { card: CARD }));
    emitMorph('started', 'expanded');
    await settle();
    expect(control().motion?.outgoingId).toBe('second');
    expect(mockSetVisible).not.toHaveBeenCalledWith('second', false);
    expect(control().sessionStates.find(state => state.session.id === 'second')?.status).toBe('active');

    emitMorph('settled', 'expanded');
    await waitFor(() => expect(parked()).toEqual(['second']));
    expect(lastVisibility('second')).toBe(false);
    expect(control().session?.id).toBe('origin');
  });

  it('a host overlay mid-expand hides at once and re-shows without motion on release', async () => {
    await parkedForeground();
    await act(async () => control().restore('origin', { card: CARD }));
    emitMorph('started', 'expanded');

    currentTree!.rerender(<Tree held />);
    expect(lastVisibility()).toBe(false);
    emitMorph('cancelled', 'expanded');
    expect(control().motion).toBeNull();
    currentTree!.rerender(<Tree />);

    await waitFor(() => expect(lastVisibility()).toBe(true));
    expect(mockMorph).toHaveBeenCalledTimes(1);
    expect(control().mode).toBe('active');
  });

  it('an unaccepted expand shows the page through the position effect', async () => {
    await parkedForeground();
    mockMorph.mockResolvedValue({ accepted: false });

    let accepted = true;
    await act(async () => {
      accepted = await control().restore('origin', { card: CARD });
    });

    expect(accepted).toBe(false);
    await waitFor(() => expect(lastVisibility()).toBe(true));
    expect(control().motion).toBeNull();
    expect(control().session?.id).toBe('origin');
  });

  it('never morphs a cold session', async () => {
    mockLoadPersisted.mockResolvedValue([{ ...session('cold'), parkedAt: 1 }]);
    currentTree = render(<Tree />);
    await waitFor(() => expect(control().parkedSessions.map(state => state.session.id)).toEqual(['cold']));
    mockMorph.mockResolvedValue({ accepted: true });

    let accepted = true;
    await act(async () => {
      accepted = await control().restore('cold', { card: CARD });
    });

    expect(accepted).toBe(false);
    expect(mockMorph).not.toHaveBeenCalled();
    expect(control().sessionStates[0]?.status).toBe('loading');
  });
});

describe('native morph adoption', () => {
  afterEach(() => jest.useRealTimers());

  function minimizeEvent(extra: { morphId?: string | null; policyRevision?: number } = {}) {
    return {
      id: 'origin',
      managedHostCloseToken: lifetime(),
      policyRevision: 2,
      visibilitySequence: control().sessionStates[0]?.instance?.currentVisibilitySequence,
      ...extra
    };
  }

  it('adopts a native minimize carrying a morphId and parks on settled', async () => {
    await openForeground();

    act(() => nativeListeners.get('presentationMinimizeRequested')?.(minimizeEvent({ morphId: 'native-1' })));
    expect(mockMorph).not.toHaveBeenCalled();
    expect(control().motion).toMatchObject({ id: 'origin', morphId: 'native-1', target: 'collapsed' });
    expect(mockCaptureSnapshot).toHaveBeenCalledWith('origin', 0.5, 0.7);
    emitMorph('started', 'collapsed', 'native-1');
    emitMorph('settled', 'collapsed', 'native-1');
    await settle();

    expect(parked()).toEqual(['origin']);
    expect(control().mode).toBe('launcher');
  });

  it('adopts an expansion id from a capsule minimize and parks only after its collapsed terminal', async () => {
    await openForeground();
    mockMorph.mockResolvedValue({ accepted: true });
    act(() => control().reportLandingCard(CARD));
    let firstParking: Promise<void> = Promise.resolve();
    act(() => {
      firstParking = control().park('origin');
    });
    await settle();
    const firstId = lastMorphId();
    emitMorph('started', 'collapsed', firstId);
    emitMorph('settled', 'collapsed', firstId);
    await act(async () => firstParking);
    expect(parked()).toEqual(['origin']);

    await act(async () => void control().restore('origin', { card: CARD }));
    await settle();
    const expansionId = lastMorphId();
    emitMorph('started', 'expanded', expansionId);
    emitMorph('retargeted', 'collapsed', expansionId);
    const callsBeforeMinimize = mockMorph.mock.calls.length;
    act(() => nativeListeners.get('presentationMinimizeRequested')?.(minimizeEvent({ morphId: expansionId })));

    expect(control().motion).toMatchObject({ id: 'origin', morphId: expansionId, target: 'collapsed' });
    expect(mockMorph).toHaveBeenCalledTimes(callsBeforeMinimize);
    expect(parked()).toEqual([]);
    emitMorph('settled', 'collapsed', expansionId);
    await settle();
    expect(parked()).toEqual(['origin']);

    await act(async () => void control().restore('origin', { card: CARD }));
    await settle();
    const unsettledExpansionId = lastMorphId();
    emitMorph('started', 'expanded', unsettledExpansionId);
    act(() => nativeListeners.get('presentationMinimizeRequested')?.(minimizeEvent({ morphId: unsettledExpansionId })));
    expect(control().motion).toMatchObject({ id: 'origin', morphId: unsettledExpansionId, target: 'collapsed' });
    emitMorph('settled', 'expanded', unsettledExpansionId);
    await settle();
    expect(parked()).toEqual([]);
  });

  it('parks a null-id native minimize through the guarded route without a morph wait', async () => {
    await openForeground();
    jest.useFakeTimers();
    act(() => nativeListeners.get('presentationMinimizeRequested')?.(minimizeEvent({ morphId: null })));
    await settle();

    expect(control().motion).toBeNull();
    expect(mockMorph).not.toHaveBeenCalled();
    expect(parked()).toEqual(['origin']);
    expect(control().mode).toBe('launcher');
  });

  it('follows an adopted native collapse as started when its started event came first', async () => {
    await openForeground();

    emitMorph('started', 'collapsed', 'native-1');
    act(() => nativeListeners.get('presentationMinimizeRequested')?.(minimizeEvent({ morphId: 'native-1' })));
    expect(control().motion).toMatchObject({ morphId: 'native-1', target: 'collapsed', started: true });
    emitMorph('settled', 'collapsed', 'native-1');
    await settle();

    expect(parked()).toEqual(['origin']);
  });

  it('keeps a JS collapse on its morph id when a native minimize crossed it', async () => {
    await openForeground();
    mockMorph.mockResolvedValue({ accepted: true });
    const staleSequence = control().sessionStates[0]?.instance?.currentVisibilitySequence;
    let parking: Promise<void> = Promise.resolve();
    act(() => {
      parking = control().park('origin');
    });
    await settle();
    const jsId = lastMorphId();

    act(() =>
      nativeListeners.get('presentationMinimizeRequested')?.({
        ...minimizeEvent({ morphId: 'native-stale' }),
        visibilitySequence: staleSequence
      })
    );
    expect(control().motion?.morphId).toBe(jsId);
    act(() =>
      nativeListeners.get('presentationMinimizeRequested')?.({
        ...minimizeEvent({ morphId: 'native-foreign' }),
        managedHostCloseToken: 'another-lifetime'
      })
    );
    expect(control().motion?.morphId).toBe(jsId);
    expect(morphRequests()).toHaveLength(1);

    emitMorph('settled', 'collapsed', jsId);
    await act(async () => parking);
    expect(parked()).toEqual(['origin']);
  });

  it('retargets a JS collapse to a current native minimize', async () => {
    await openForeground();
    mockMorph.mockResolvedValue({ accepted: true });
    act(() => void control().park('origin'));
    await settle();

    act(() => nativeListeners.get('presentationMinimizeRequested')?.(minimizeEvent({ morphId: 'native-2' })));
    expect(control().motion).toMatchObject({ morphId: 'native-2', target: 'collapsed' });
    expect(morphRequests()).toHaveLength(1);

    emitMorph('settled', 'collapsed', 'native-2');
    await settle();
    expect(parked()).toEqual(['origin']);
  });

  it('settles an adopted collapse it drops when native rejects the expand that replaced it', async () => {
    await openForeground();
    act(() => control().open(session('second')));
    await waitFor(() => expect(control().sessionStates[1]?.instance).not.toBeNull());
    await act(async () => control().park('second'));
    await act(async () => void control().restore('origin'));
    await settle();
    expect(control().mode).toBe('active');

    act(() => nativeListeners.get('presentationMinimizeRequested')?.(minimizeEvent({ morphId: 'native-1' })));
    expect(control().motion).toMatchObject({ id: 'origin', morphId: 'native-1' });
    await act(async () => void control().restore('second', { card: CARD }));
    await settle();
    expect(parked()).toContain('origin');

    await act(async () => void control().restore('origin'));
    await settle();
    const sent = mockMorph.mock.calls.length;
    act(() => nativeListeners.get('presentationMinimizeRequested')?.(minimizeEvent({ morphId: 'native-2' })));
    await settle();
    expect(control().motion).toMatchObject({ id: 'origin', morphId: 'native-2' });
    expect(mockMorph.mock.calls.length).toBe(sent);
  });

  it('settles a collapse whose replacing expand was itself replaced before native rejected it', async () => {
    await openForeground();
    let answerExpand: (result: { accepted: boolean }) => void = () => undefined;
    mockMorph
      .mockResolvedValueOnce({ accepted: true })
      .mockImplementationOnce(
        () =>
          new Promise<{ accepted: boolean }>(resolve => {
            answerExpand = resolve;
          })
      )
      .mockResolvedValueOnce({ accepted: true });
    let firstParkSettled = false;
    act(() => {
      void control()
        .park('origin')
        .then(() => {
          firstParkSettled = true;
        });
    });
    await settle();
    act(() => void control().restore('origin', { card: CARD }));
    await settle();
    act(() => void control().park('origin'));
    await settle();

    await act(async () => answerExpand({ accepted: false }));
    await settle();
    expect(firstParkSettled).toBe(true);
  });

  it('does not park the replaced foreground again when a rejected restore of it drops the settled collapse', async () => {
    await openForeground();
    act(() => control().open(session('second')));
    await waitFor(() => expect(control().sessionStates[1]?.instance).not.toBeNull());
    mockMorph.mockResolvedValueOnce({ accepted: true });
    await act(async () => void control().restore('origin', { card: CARD }));
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    jest.useFakeTimers();
    emitMorph('retargeted', 'collapsed');
    emitMorph('settled', 'collapsed');
    await act(async () => {
      await Promise.resolve();
    });
    expect(control().motion).toMatchObject({ id: 'origin', acknowledging: true });
    expect(parked().sort()).toEqual(['origin', 'second']);

    await act(async () => void control().restore('second', { card: CARD }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(control().mode).toBe('active');
    expect(parked()).toEqual(['origin']);
  });

  it('keeps following an expand when native rejects the collapse sent over it', async () => {
    await openForeground();
    await act(async () => control().park('origin'));
    mockMorph.mockResolvedValueOnce({ accepted: true });
    await act(async () => void control().restore('origin', { card: CARD }));
    const expandId = lastMorphId();

    await act(async () => void control().park('origin'));
    await settle();
    expect(lastMorphId()).not.toBe(expandId);
    expect(control().motion).toMatchObject({ id: 'origin', target: 'expanded', morphId: expandId });

    emitMorph('settled', 'expanded', expandId);
    await settle();
    expect(control().motion).toBeNull();
  });

  it('keeps a session restored while the watchdog park of its lost collapse captures its snapshot', async () => {
    await openForeground();
    mockMorph.mockResolvedValue({ accepted: true });
    act(() => void control().park('origin'));
    await settle();
    let release: (snapshot: string | null) => void = () => undefined;
    mockCaptureSnapshot.mockImplementationOnce(
      () =>
        new Promise<string | null>(resolve => {
          release = resolve;
        })
    );
    jest.useFakeTimers();
    emitMorph('started', 'collapsed');
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    jest.useRealTimers();
    expect(control().motion).toBeNull();

    await act(async () => void control().restore('origin'));
    await settle();
    await act(async () => release(null));
    await settle();

    expect(control().mode).toBe('active');
    expect(parked()).not.toContain('origin');
  });

  it('keeps an outgoing session restored while its outgoing park captures its snapshot', async () => {
    await openForeground();
    act(() => control().open(session('second')));
    await waitFor(() => expect(control().sessionStates[1]?.instance).not.toBeNull());
    mockMorph.mockResolvedValueOnce({ accepted: true });
    await act(async () => void control().restore('origin', { card: CARD }));
    let release: (snapshot: string | null) => void = () => undefined;
    mockCaptureSnapshot.mockImplementationOnce(
      () =>
        new Promise<string | null>(resolve => {
          release = resolve;
        })
    );
    emitMorph('settled', 'expanded');
    await settle();

    await act(async () => void control().restore('second'));
    await settle();
    expect(parked()).toEqual(['origin']);
    await act(async () => release(null));
    await settle();

    expect(control().sessionStates.find(state => state.session.id === 'second')?.status).toBe('active');
    expect(parked()).toEqual(['origin']);
  });

  it('parks an outgoing session when a host alert opens while its outgoing park captures its snapshot', async () => {
    await openForeground();
    act(() => control().open(session('second')));
    await waitFor(() => expect(control().sessionStates[1]?.instance).not.toBeNull());
    mockMorph.mockResolvedValueOnce({ accepted: true });
    await act(async () => void control().restore('origin', { card: CARD }));
    let release: (snapshot: string | null) => void = () => undefined;
    mockCaptureSnapshot.mockImplementationOnce(
      () =>
        new Promise<string | null>(resolve => {
          release = resolve;
        })
    );
    emitMorph('settled', 'expanded');
    await settle();

    act(() => externalPageFailed());
    await settle();
    await act(async () => release(null));
    await settle();

    expect(control().sessionStates.find(state => state.session.id === 'second')?.status).toBe('parked');
    expect(parked()).toContain('second');
  });

  describe('a legacy park that a newer restore of its session overtakes', () => {
    const statusOf = (id: string) => control().sessionStates.find(state => state.session.id === id)?.status;
    function holdSnapshot() {
      let release: (snapshot: string | null) => void = () => undefined;
      mockCaptureSnapshot.mockImplementationOnce(
        () =>
          new Promise<string | null>(resolve => {
            release = resolve;
          })
      );
      return (snapshot: string | null) => release(snapshot);
    }
    function holdMorph() {
      let answer: (result: { accepted: boolean }) => void = () => undefined;
      mockMorph.mockImplementationOnce(
        () =>
          new Promise<{ accepted: boolean }>(resolve => {
            answer = resolve;
          })
      );
      return (result: { accepted: boolean }) => answer(result);
    }

    it('keeps a reopened foreground when the park of it that open started lands late', async () => {
      await openForeground();
      const release = holdSnapshot();
      act(() => control().open(session('fresh')));
      await settle();
      act(() => control().open(session('origin')));
      await settle();
      await act(async () => release(null));
      await settle();

      expect(statusOf('origin')).toBe('active');
      expect(parked()).not.toContain('origin');
    });

    it('one snapshot while a later open joins a pending park of the same session', async () => {
      await openForeground();
      const release = holdSnapshot();
      try {
        act(() => control().open(session('second')));
        await waitFor(() => expect(mockCaptureSnapshot).toHaveBeenCalledWith('origin', 0.5, 0.7));
        act(() => control().open(session('third')));
        await settle();

        expect(mockCaptureSnapshot.mock.calls.filter(([id]) => id === 'origin')).toHaveLength(1);
        await act(async () => release(null));
        await settle();
        expect(statusOf('origin')).toBe('parked');
        expect(parked()).toContain('origin');
      } finally {
        await act(async () => release(null));
      }
    });

    it('parks a reopened session while the closed snapshot is still held', async () => {
      await openForeground();
      const previousInstance = control().sessionStates.find(state => state.session.id === 'origin')?.instance;
      const releases = holdSnapshotsFor('origin');
      const originCaptures = () => mockCaptureSnapshot.mock.calls.filter(([id]) => id === 'origin').length;
      try {
        act(() => control().open(session('second')));
        await waitFor(() => expect(originCaptures()).toBe(1));
        await finishManagedClose('origin');
        expect(statusOf('origin')).toBeUndefined();
        act(() => control().open(session('origin')));
        await waitFor(() => {
          const instance = control().sessionStates.find(state => state.session.id === 'origin')?.instance;
          expect(instance).toBeTruthy();
          expect(instance).not.toBe(previousInstance);
        });
        expect(originCaptures()).toBe(1);
        act(() => control().open(session('third')));
        await settle();
        expect(originCaptures()).toBe(2);
        act(() => control().open(session('fourth')));
        await settle();
        expect(originCaptures()).toBe(2);

        await act(async () => releases[0]?.(null));
        await settle();
        expect(statusOf('origin')).toBe('active');
        act(() => control().open(session('fifth')));
        await settle();
        expect(originCaptures()).toBe(2);
        await act(async () => releases[1]?.(null));
        await settle();
        expect(statusOf('origin')).toBe('parked');
        expect(parked()).toContain('origin');
      } finally {
        await act(async () => releases.forEach(release => release(null)));
      }
    });

    it('still parks the foreground open replaced when a host alert opens meanwhile', async () => {
      await openForeground();
      const release = holdSnapshot();
      act(() => control().open(session('fresh')));
      await settle();
      act(() => externalPageFailed());
      await settle();
      await act(async () => release(null));
      await settle();

      expect(statusOf('origin')).toBe('parked');
    });

    it('keeps a session restored while native was answering its collapse with a rejection', async () => {
      await openForeground();
      const answer = holdMorph();
      act(() => void control().park('origin'));
      await settle();
      await act(async () => void control().restore('origin', { card: CARD }));
      await settle();
      await act(async () => answer({ accepted: false }));
      await settle();

      expect(control().mode).toBe('active');
      expect(parked()).not.toContain('origin');
    });

    it('keeps a session restored while native was answering the collapse a slot removal sent', async () => {
      await openForeground();
      const answer = holdMorph();
      act(() => control().setSlotRect(null));
      await settle();
      await act(async () => void control().restore('origin', { card: CARD }));
      await settle();
      await act(async () => answer({ accepted: false }));
      await settle();

      expect(control().mode).toBe('active');
      expect(parked()).not.toContain('origin');
    });

    it('keeps a session restored while the legacy park a slot removal started captures its snapshot', async () => {
      await openForeground();
      const release = holdSnapshot();
      act(() => control().setSlotRect(null));
      await settle();
      await act(async () => void control().restore('origin'));
      await settle();
      await act(async () => release(null));
      await settle();

      expect(statusOf('origin')).toBe('active');
    });

    it('follows no flight after native rejects two overlapping collapses in order', async () => {
      await openForeground();
      const answerFirst = holdMorph();
      const answerSecond = holdMorph();
      act(() => void control().park('origin'));
      await settle();
      act(() => void control().park('origin'));
      await settle();
      await act(async () => answerFirst({ accepted: false }));
      await settle();
      await act(async () => answerSecond({ accepted: false }));
      await settle();

      expect(control().motion).toBeNull();
      expect(control().mode).toBe('launcher');
      expect(parked()).toEqual(['origin']);

      await act(async () => void control().restore('origin', { card: CARD }));
      await settle();
      expect(control().mode).toBe('active');
      expect(lastVisibility()).toBe(true);
      expect(control().motion).toBeNull();
    });

    it('still parks the outgoing session when the expand target is restored again', async () => {
      await openForeground();
      await act(async () => control().park('origin'));
      act(() => control().open(session('second')));
      await waitFor(() => expect(control().sessionStates[1]?.instance).not.toBeNull());
      const answer = holdMorph();
      act(() => void control().restore('origin', { card: CARD }));
      await settle();

      await act(async () => void control().restore('origin'));
      await settle();
      await act(async () => answer({ accepted: true }));
      emitMorph('settled', 'expanded');
      await settle();

      expect(statusOf('second')).toBe('parked');
      expect(parked()).toContain('second');
    });

    it('requests one park snapshot when the settle overtakes the accepted collapse', async () => {
      await openForeground();
      jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
      const answer = holdMorph();
      act(() => void control().park('origin'));
      await settle();
      expect(mockCaptureSnapshot).not.toHaveBeenCalled();

      emitMorph('settled', 'collapsed');
      await settle();
      await act(async () => answer({ accepted: true }));
      await settle();

      expect(mockCaptureSnapshot).toHaveBeenCalledTimes(1);
      expect(mockCaptureSnapshot).toHaveBeenCalledWith('origin', 0.5, 0.7);
      expect(parked()).toEqual(['origin']);
    });
  });

  it('springs a rejected native minimize back', async () => {
    await openForeground();

    act(() =>
      nativeListeners.get('presentationMinimizeRequested')?.(minimizeEvent({ morphId: 'native-1', policyRevision: 1 }))
    );
    await settle();

    expect(morphRequests()).toEqual([{ to: 'expanded', card: null, morphId: expect.stringMatching(UUID) }]);
    expect(control().motion).toBeNull();
    expect(control().mode).toBe('active');
  });

  it('ignores late events from a superseded morph after rapid alternation', async () => {
    await openForeground();
    mockMorph.mockResolvedValue({ accepted: true });
    act(() => void control().park('origin'));
    await settle();
    const first = lastMorphId();
    await act(async () => void control().restore('origin', { card: CARD }));
    act(() => void control().park('origin'));
    await settle();
    const third = lastMorphId();

    emitMorph('retargeted', 'collapsed', third);
    emitMorph('settled', 'collapsed', first);
    await settle();
    expect(control().motion).toMatchObject({ morphId: third, target: 'collapsed', started: true });
    expect(parked()).toEqual([]);
    expect(
      morphRequests().map(request => (typeof request === 'object' && request && 'to' in request ? request.to : null))
    ).toEqual(['collapsed', 'expanded', 'collapsed']);

    emitMorph('settled', 'collapsed', third);
    await settle();
    expect(parked()).toEqual(['origin']);
  });

  it('closing the session mid-flight clears the motion without parking', async () => {
    await openForeground();
    mockMorph.mockResolvedValue({ accepted: true });
    let parking: Promise<void> = Promise.resolve();
    act(() => {
      parking = control().park('origin');
    });
    await settle();

    await act(async () => control().close('origin'));
    await act(async () => parking);

    expect(control().motion).toBeNull();
    expect(control().sessionStates).toEqual([]);
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });

  it('resolves a lost terminal event through the watchdog', async () => {
    await openForeground();
    mockMorph.mockResolvedValue({ accepted: true });
    act(() => void control().park('origin'));
    await settle();
    jest.useFakeTimers();

    emitMorph('started', 'collapsed');
    act(() => jest.advanceTimersByTime(1999));
    expect(parked()).toEqual([]);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    jest.useRealTimers();

    await waitFor(() => expect(parked()).toEqual(['origin']));
    expect(lastVisibility()).toBe(false);
    expect(control().motion).toBeNull();
  });

  it('parks the replaced foreground too when the watchdog ends a reversed expand', async () => {
    await openForeground();
    await act(async () => control().park('origin'));
    act(() => control().open(session('second')));
    await waitFor(() => expect(control().sessionStates[1]?.instance).not.toBeNull());
    mockMorph.mockResolvedValue({ accepted: true });
    await act(async () => void control().restore('origin', { card: CARD }));
    jest.useFakeTimers();

    emitMorph('retargeted', 'collapsed');
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    jest.useRealTimers();

    await waitFor(() => expect(parked().sort()).toEqual(['origin', 'second']));
  });

  it('does not fire the watchdog while a finger holds the page', async () => {
    await openForeground();
    mockMorph.mockResolvedValue({ accepted: true });
    act(() => void control().park('origin'));
    await settle();
    jest.useFakeTimers();

    emitMorph('retargeted', 'collapsed', lastMorphId(), { tracking: true });
    act(() => jest.advanceTimersByTime(10000));

    expect(control().motion).toMatchObject({ tracking: true });
    expect(parked()).toEqual([]);
    expect(lastVisibility()).toBeUndefined();
  });
});

describe('latest foreground intent across sessions', () => {
  const statusOf = (id: string) => control().sessionStates.find(state => state.session.id === id)?.status;

  async function openForegroundWithColdSession() {
    mockLoadPersisted.mockResolvedValue([{ ...session('cold'), parkedAt: 1 }]);
    currentTree = render(<Tree />);
    await waitFor(() => expect(parked()).toEqual(['cold']));
    await openManagedSession('origin');
  }

  async function openSecondFromParkedOrigin() {
    await openForeground();
    await act(async () => control().park('origin'));
    await openManagedSession('second');
  }

  interface RoundTripRecord {
    id: string;
    url?: string;
    origin?: string;
    title?: string;
    favicon?: string | null;
    openedAt?: number;
    status?: string;
    parkedAt?: number;
  }

  function isRoundTripRecord(value: unknown): value is RoundTripRecord {
    return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string';
  }

  function installPersistedRoundTrip(seed: RoundTripRecord[] = []) {
    const stored = seed.map(entry => ({ ...entry }));
    mockUpsertSession.mockImplementation(session => {
      if (!isRoundTripRecord(session)) return Promise.resolve();
      const copy = { ...session };
      const index = stored.findIndex(entry => entry.id === copy.id);
      if (index === -1) stored.push(copy);
      else stored[index] = copy;
      return Promise.resolve();
    });
    mockLoadPersisted.mockImplementation(() => Promise.resolve(stored.map(entry => ({ ...entry }))));
    return () => {
      mockUpsertSession.mockImplementation(async () => {});
    };
  }

  it('parks a slotless open when a second open supersedes it', async () => {
    currentTree = render(<Tree />);
    await waitFor(() => expect(nativeListeners.has('presentationChanged')).toBe(true));
    act(() => {
      control().open(session('first'));
      control().open(session('second'));
    });
    await settle();

    expect(statusOf('first')).toBe('parked');
    expect(control().sessionStates.find(state => state.session.id === 'first')?.isLoading).toBe(false);
    expect(parked()).toContain('first');
    expect(control().session?.id).toBe('second');
    expect(statusOf('second')).toBe('loading');
  });

  it('returns a superseded cold restore to the parked list', async () => {
    mockLoadPersisted.mockResolvedValue([{ ...session('cold'), parkedAt: 1 }]);
    currentTree = render(<Tree />);
    await waitFor(() => expect(parked()).toEqual(['cold']));
    await act(async () => control().restore('cold'));
    act(() => control().open(session('second')));
    await settle();

    expect(statusOf('cold')).toBe('parked');
    expect(parked()).toContain('cold');
    expect(control().session?.id).toBe('second');
  });

  it('parks a slotless loading session when a cold session is restored', async () => {
    mockLoadPersisted.mockResolvedValue([{ ...session('cold'), parkedAt: 1 }]);
    currentTree = render(<Tree />);
    await waitFor(() => expect(parked()).toEqual(['cold']));
    act(() => control().open(session('first')));
    await settle();
    expect(statusOf('first')).toBe('loading');
    await act(async () => control().restore('cold'));

    expect(statusOf('first')).toBe('parked');
    expect(parked()).toContain('first');
    expect(control().session?.id).toBe('cold');
    expect(statusOf('cold')).toBe('loading');
  });

  it('parks a slotless loading session when a warm session is restored', async () => {
    await openForeground();
    await act(async () => control().park('origin'));
    act(() => control().setSlotRect(null));
    act(() => control().open(session('second')));
    await settle();
    expect(statusOf('second')).toBe('loading');
    await act(async () => control().restore('origin'));

    expect(statusOf('second')).toBe('parked');
    expect(parked()).toContain('second');
    expect(control().session?.id).toBe('origin');
  });

  it('remounts a slotless open that a second open parked', async () => {
    const restoreStore = installPersistedRoundTrip();
    const tree = render(<Tree />);
    currentTree = tree;
    try {
      await waitFor(() => expect(nativeListeners.has('presentationChanged')).toBe(true));
      act(() => {
        control().open(session('first'));
        control().open(session('second'));
      });
      await settle();
      expect(statusOf('first')).toBe('parked');
      expect(statusOf('second')).toBe('loading');
      await settle();
      tree.unmount();
      currentTree = render(<Tree />);
      await waitFor(() => expect(parked()).toEqual(['first']));
    } finally {
      restoreStore();
    }
  });

  it('remounts a slotless session that a cold restore parked', async () => {
    const restoreStore = installPersistedRoundTrip([{ ...session('cold'), parkedAt: 1 }]);
    const tree = render(<Tree />);
    currentTree = tree;
    try {
      await waitFor(() => expect(parked()).toEqual(['cold']));
      act(() => control().open(session('first')));
      await settle();
      await act(async () => control().restore('cold'));
      expect(statusOf('first')).toBe('parked');
      await settle();
      tree.unmount();
      currentTree = render(<Tree />);
      await waitFor(() => {
        expect(parked()).toContain('first');
        expect(parked()).toContain('cold');
      });
    } finally {
      restoreStore();
    }
  });

  it('remounts a slotless session that a warm restore parked', async () => {
    const restoreStore = installPersistedRoundTrip();
    try {
      const tree = await openForeground();
      await act(async () => control().park('origin'));
      act(() => control().setSlotRect(null));
      act(() => control().open(session('second')));
      await settle();
      await act(async () => control().restore('origin'));
      expect(statusOf('second')).toBe('parked');
      await settle();
      tree.unmount();
      currentTree = render(<Tree />);
      await waitFor(() => expect(parked()).toContain('second'));
    } finally {
      restoreStore();
    }
  });

  it('remounts a session whose open finished after the user left', async () => {
    const restoreStore = installPersistedRoundTrip();
    let releaseOpen: () => void = () => undefined;
    mockOpen.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseOpen = resolve;
        })
    );
    const tree = render(<Tree />);
    currentTree = tree;
    try {
      act(() => {
        control().open(session('first'));
        control().setSlotRect(RECT);
      });
      await waitFor(() => expect(mockOpen).toHaveBeenCalled());
      act(() => control().setSlotRect(null));
      await waitFor(() => expect(control().session).toBeNull());
      await act(async () => {
        releaseOpen();
      });
      await waitFor(() => expect(statusOf('first')).toBe('parked'));
      await settle();
      tree.unmount();
      currentTree = render(<Tree />);
      await waitFor(() => expect(parked()).toContain('first'));
    } finally {
      await act(async () => {
        releaseOpen();
      });
      restoreStore();
      mockOpen.mockReset();
      mockOpen.mockImplementation(async () => {});
    }
  });

  it('parks the foreground after a superseded park once the slot leaves', async () => {
    await openForegroundWithColdSession();
    let releaseSnapshot: (snapshot: string | null) => void = () => undefined;
    mockCaptureSnapshot.mockImplementationOnce(
      () => new Promise<string | null>(resolve => (releaseSnapshot = resolve))
    );
    let restoringCold = Promise.resolve(false);
    try {
      act(() => {
        restoringCold = control().restore('cold');
      });
      await waitFor(() => expect(mockCaptureSnapshot).toHaveBeenCalledWith('origin', 0.5, 0.7));
      await act(async () => control().restore('origin'));
      await act(async () => {
        releaseSnapshot(null);
        await restoringCold;
      });
      expect(statusOf('origin')).toBe('active');
      expect(control().session?.id).toBe('origin');
      act(() => control().setSlotRect(null));
      await settle();

      expect(statusOf('origin')).toBe('parked');
      expect(parked()).toContain('origin');
      expect(control().session).toBeNull();
    } finally {
      await act(async () => {
        releaseSnapshot(null);
        await restoringCold;
      });
    }
  });

  it('route-away during a held park after the same foreground is restored parks that foreground', async () => {
    await openForegroundWithColdSession();
    const previousHash = window.location.hash;
    let releaseSnapshot: (snapshot: string | null) => void = () => undefined;
    mockCaptureSnapshot.mockImplementationOnce(
      () => new Promise<string | null>(resolve => (releaseSnapshot = resolve))
    );
    let restoringCold = Promise.resolve(false);
    try {
      window.location.hash = '#/activity';
      const { navigate } = jest.requireMock<typeof import('lib/woozie')>('lib/woozie');
      jest.mocked(navigate).mockClear();
      act(() => {
        restoringCold = control().restore('cold');
      });
      await waitFor(() => expect(mockCaptureSnapshot.mock.calls.filter(([id]) => id === 'origin')).toHaveLength(1));
      await act(async () => control().restore('origin'));
      await settle();

      expect(statusOf('origin')).toBe('active');
      expect(control().session?.id).toBe('origin');
      expect(mockCaptureSnapshot.mock.calls.filter(([id]) => id === 'origin')).toHaveLength(1);

      jest.mocked(navigate).mockClear();
      act(() => control().setSlotRect(null));
      await settle();
      await act(async () => {
        releaseSnapshot(null);
        await restoringCold;
      });
      await settle();

      expect(statusOf('origin')).toBe('parked');
      expect(parked()).toContain('origin');
      expect(lastVisibility('origin')).toBe(false);
      expect(control().session).toBeNull();
      expect(statusOf('cold')).toBe('parked');
      expect(navigate).not.toHaveBeenCalledWith('/browser');
      expect(mockCaptureSnapshot.mock.calls.filter(([id]) => id === 'origin')).toHaveLength(1);
    } finally {
      await act(async () => {
        releaseSnapshot(null);
        await restoringCold;
      });
      window.location.hash = previousHash;
    }
  });

  it('route-away keeps an earlier background park current', async () => {
    await openForeground();
    const releases = holdSnapshotsFor('origin');
    try {
      await openManagedSession('second');
      await waitFor(() => expect(releases).toHaveLength(1));
      act(() => control().setSlotRect(null));
      await waitFor(() => expect(statusOf('second')).toBe('parked'));
      await act(async () => releases[0]?.(null));
      await settle();

      expect(statusOf('origin')).toBe('parked');
      expect(parked().sort()).toEqual(['origin', 'second']);
      expect(control().session).toBeNull();
      expect(mockCaptureSnapshot.mock.calls.filter(([id]) => id === 'origin')).toHaveLength(1);
    } finally {
      await act(async () => releases.forEach(release => release(null)));
    }
  });

  it.each(['snapshot', 'hide'])('route-away during a cold restore %s beats that restore', async phase => {
    await openForegroundWithColdSession();
    const previousHash = window.location.hash;
    const releases: (() => void)[] = [];
    if (phase === 'snapshot') {
      mockCaptureSnapshot.mockImplementationOnce(
        () => new Promise<string | null>(resolve => releases.push(() => resolve(null)))
      );
    } else {
      mockSetVisible.mockImplementation((id, visible) =>
        id === 'origin' && !visible ? new Promise<void>(resolve => releases.push(resolve)) : Promise.resolve()
      );
    }
    let restoringCold = Promise.resolve(false);
    try {
      window.location.hash = '#/activity';
      const { navigate } = jest.requireMock<typeof import('lib/woozie')>('lib/woozie');
      jest.mocked(navigate).mockClear();
      act(() => {
        restoringCold = control().restore('cold');
      });
      await waitFor(() => expect(releases.length).toBeGreaterThan(0));
      act(() => control().setSlotRect(null));
      await settle();
      await act(async () => {
        releases.forEach(release => release());
        await restoringCold;
      });
      await settle();

      expect(statusOf('cold')).toBe('parked');
      expect(parked()).toContain('cold');
      expect(control().session?.id).not.toBe('cold');
      expect(navigate).not.toHaveBeenCalledWith('/browser');
    } finally {
      mockSetVisible.mockReset().mockResolvedValue(undefined);
      await act(async () => {
        releases.forEach(release => release());
        await restoringCold;
      });
      window.location.hash = previousHash;
    }
  });

  it('a slot clear during the reopened session held park beats the cold restore after the closed capture finishes', async () => {
    await openForegroundWithColdSession();
    const previousHash = window.location.hash;
    const previousInstance = control().sessionStates.find(state => state.session.id === 'origin')?.instance;
    const releases = holdSnapshotsFor('origin');
    let firstRestore = Promise.resolve(false);
    let secondRestore = Promise.resolve(false);
    try {
      window.location.hash = '#/activity';
      act(() => {
        firstRestore = control().restore('cold');
      });
      await waitFor(() => expect(releases).toHaveLength(1));
      await finishManagedClose('origin');
      expect(statusOf('origin')).toBeUndefined();
      act(() => control().open(session('origin')));
      await waitFor(() => {
        const instance = control().sessionStates.find(state => state.session.id === 'origin')?.instance;
        expect(instance).toBeTruthy();
        expect(instance).not.toBe(previousInstance);
      });
      act(() => {
        secondRestore = control().restore('cold');
      });
      await waitFor(() => expect(releases).toHaveLength(2));
      await act(async () => {
        releases[0]?.(null);
        await firstRestore;
      });
      expect(statusOf('origin')).toBe('active');
      expect(control().session?.id).toBe('origin');
      const { navigate } = jest.requireMock<typeof import('lib/woozie')>('lib/woozie');
      jest.mocked(navigate).mockClear();
      act(() => control().setSlotRect(null));
      await settle();
      expect(mockCaptureSnapshot.mock.calls.filter(([id]) => id === 'origin')).toHaveLength(2);
      await act(async () => {
        releases[1]?.(null);
        await secondRestore;
      });
      await settle();

      expect(statusOf('cold')).toBe('parked');
      expect(parked()).toContain('cold');
      expect(statusOf('origin')).toBe('parked');
      expect(control().session).toBeNull();
      expect(navigate).not.toHaveBeenCalledWith('/browser');
    } finally {
      mockCaptureSnapshot.mockReset().mockResolvedValue(null);
      await act(async () => releases.forEach(release => release(null)));
      window.location.hash = previousHash;
    }
  });

  it('a closed capture leaves the reopened session foreground when the slot is null', async () => {
    await openForegroundWithColdSession();
    const previousHash = window.location.hash;
    const releases = holdSnapshotsFor('origin');
    let firstRestore = Promise.resolve(false);
    try {
      window.location.hash = '#/activity';
      act(() => {
        firstRestore = control().restore('cold');
      });
      await waitFor(() => expect(releases).toHaveLength(1));
      await finishManagedClose('origin');
      act(() => control().setSlotRect(null));
      await settle();
      act(() => control().open(session('origin')));
      await settle();
      expect(control().session?.id).toBe('origin');
      expect(statusOf('origin')).toBe('loading');
      expect(control().sessionStates.find(state => state.session.id === 'origin')?.instance).toBeNull();
      await act(async () => {
        releases[0]?.(null);
        await firstRestore;
      });
      act(() => control().open(session('second')));
      await settle();
      await act(async () => control().restore('origin'));
      await settle();

      expect(control().session?.id).toBe('origin');
      expect(statusOf('origin')).toBe('loading');
    } finally {
      await act(async () => releases.forEach(release => release(null)));
      window.location.hash = previousHash;
    }
  });

  it('keeps the later legacy restore foreground when the earlier park resolves last', async () => {
    await openForegroundWithColdSession();
    let releaseSnapshot: (snapshot: string | null) => void = () => undefined;
    mockCaptureSnapshot.mockImplementationOnce(
      () =>
        new Promise<string | null>(resolve => {
          releaseSnapshot = resolve;
        })
    );

    let restoringCold: Promise<boolean> = Promise.resolve(false);
    act(() => {
      restoringCold = control().restore('cold');
    });
    await waitFor(() => expect(mockCaptureSnapshot).toHaveBeenCalledWith('origin', 0.5, 0.7));

    await act(async () => control().restore('origin'));
    expect(control().session?.id).toBe('origin');
    await act(async () => {
      releaseSnapshot(null);
      await restoringCold;
    });
    await settle();

    expect(control().session?.id).toBe('origin');
    expect(statusOf('origin')).toBe('active');
    expect(statusOf('cold')).toBe('parked');
    expect(parked()).toEqual(['cold']);
    expect(lastVisibility('origin')).toBe(true);
  });

  it('does not hide a session restored while an older park is waiting', async () => {
    await openForeground();
    let nativeVisible = true;
    let releaseHide: (() => void) | undefined;
    let hideReleased = false;
    mockSetVisible.mockImplementation((id, visible) => {
      if (id !== 'origin') return Promise.resolve();
      if (visible) {
        nativeVisible = true;
        return Promise.resolve();
      }
      return new Promise<void>(resolve => {
        releaseHide = () => {
          hideReleased = true;
          nativeVisible = false;
          resolve();
        };
      });
    });

    let parking: Promise<void> = Promise.resolve();
    try {
      act(() => {
        parking = control().park('origin');
      });
      await waitFor(() => expect(releaseHide).toBeDefined());
      expect(mockSetVisible).toHaveBeenCalledWith('origin', false);

      await act(async () => control().restore('origin'));
      await waitFor(() => expect(lastVisibility('origin')).toBe(true));
      expect(nativeVisible).toBe(true);

      await act(async () => {
        releaseHide?.();
        await parking;
      });
      expect(statusOf('origin')).toBe('active');
      expect(lastVisibility('origin')).toBe(true);
      expect(nativeVisible).toBe(true);
    } finally {
      if (!hideReleased && releaseHide) {
        await act(async () => {
          releaseHide?.();
          await parking;
        });
      }
      mockSetVisible.mockReset().mockResolvedValue(undefined);
    }
  });

  it('does not park a restored outgoing session when an older expansion settles', async () => {
    await openSecondFromParkedOrigin();
    let acceptExpansion: (result: { accepted: boolean }) => void = () => undefined;
    mockMorph.mockImplementationOnce(
      () =>
        new Promise<{ accepted: boolean }>(resolve => {
          acceptExpansion = resolve;
        })
    );

    let expandingOrigin: Promise<boolean> = Promise.resolve(false);
    act(() => {
      expandingOrigin = control().restore('origin', { card: CARD });
    });
    await waitFor(() => expect(mockMorph).toHaveBeenCalled());
    emitMorphForSession('origin', 'started', 'expanded');
    await act(async () => control().restore('second'));
    expect(control().session?.id).toBe('second');

    await act(async () => {
      acceptExpansion({ accepted: true });
      await expandingOrigin;
    });
    emitMorphForSession('origin', 'settled', 'expanded');
    await settle();

    expect(statusOf('origin')).toBe('parked');
    expect(parked()).toContain('origin');
    expect(lastVisibility('origin')).toBe(false);
    expect(control().session?.id).toBe('second');
    expect(statusOf('second')).toBe('active');
    expect(parked()).not.toContain('second');
    expect(lastVisibility('second')).toBe(true);
  });

  it('ignores a stale collapse terminal event after a newer foreground intent', async () => {
    await openSecondFromParkedOrigin();
    let acceptExpansion: (result: { accepted: boolean }) => void = () => undefined;
    mockMorph.mockImplementationOnce(
      () =>
        new Promise<{ accepted: boolean }>(resolve => {
          acceptExpansion = resolve;
        })
    );

    let expandingOrigin: Promise<boolean> = Promise.resolve(false);
    act(() => {
      expandingOrigin = control().restore('origin', { card: CARD });
    });
    await waitFor(() => expect(mockMorph).toHaveBeenCalled());
    emitMorphForSession('origin', 'started', 'expanded');
    await act(async () => control().restore('second'));
    expect(control().session?.id).toBe('second');

    expect(control().motion).toMatchObject({ id: 'origin', target: 'expanded' });
    emitMorphForSession('origin', 'retargeted', 'collapsed');
    emitMorphForSession('origin', 'settled', 'collapsed');
    await settle();
    expect(control().motion).toBeNull();

    await act(async () => {
      acceptExpansion({ accepted: true });
      await expandingOrigin;
    });
    emitMorphForSession('origin', 'retargeted', 'collapsed');
    emitMorphForSession('origin', 'settled', 'collapsed');
    await settle();

    expect(statusOf('origin')).toBe('parked');
    expect(parked()).toContain('origin');
    expect(lastVisibility('origin')).toBe(false);
    expect(control().session?.id).toBe('second');
    expect(statusOf('second')).toBe('active');
    expect(parked()).not.toContain('second');
    expect(lastVisibility('second')).toBe(true);
  });

  it('keeps the confirmation owner reachable after a stale collapse settles', async () => {
    mockRealApproval = true;
    await openSecondFromParkedOrigin();
    let acceptExpansion: (result: { accepted: boolean }) => void = () => undefined;
    mockMorph.mockImplementationOnce(
      () =>
        new Promise<{ accepted: boolean }>(resolve => {
          acceptExpansion = resolve;
        })
    );

    let expandingOrigin: Promise<boolean> = Promise.resolve(false);
    act(() => {
      expandingOrigin = control().restore('origin', { card: CARD });
    });
    await waitFor(() => expect(mockMorph).toHaveBeenCalled());
    emitMorphForSession('origin', 'started', 'expanded');

    let confirmation: Promise<unknown> | undefined;
    act(() => {
      confirmation = dappConfirmationStore.requestConfirmation({
        ...approval(),
        id: 'confirmation-second',
        sessionId: 'second',
        origin: 'https://second.test',
        type: 'sign',
        transactionMessages: ['Confirmation owner']
      });
    });
    await screen.findByText('Confirmation owner');
    await waitFor(() => expect(control().session?.id).toBe('second'));

    expect(control().motion).toMatchObject({ id: 'origin', target: 'expanded' });
    emitMorphForSession('origin', 'retargeted', 'collapsed');
    emitMorphForSession('origin', 'settled', 'collapsed');
    await settle();
    expect(control().motion).toBeNull();

    await act(async () => {
      acceptExpansion({ accepted: true });
      await expandingOrigin;
    });
    emitMorphForSession('origin', 'retargeted', 'collapsed');
    emitMorphForSession('origin', 'settled', 'collapsed');
    await settle();

    expect(statusOf('origin')).toBe('parked');
    expect(parked()).toContain('origin');
    expect(lastVisibility('origin')).toBe(false);
    expect(control().session?.id).toBe('second');
    expect(statusOf('second')).toBe('active');
    expect(parked()).not.toContain('second');
    expect(lastVisibility('second')).toBe(false);
    expect(dappConfirmationStore.getPendingRequest('second')).toMatchObject({ id: 'confirmation-second' });
    await waitFor(() => expect(screen.getByText('Confirmation owner').closest('[role="dialog"]')).toBeVisible());

    await act(async () => {
      dappConfirmationStore.resolveConfirmation('second', { confirmed: false }, 'confirmation-second');
      await confirmation;
    });
    await waitFor(() => expect(lastVisibility('second')).toBe(true));
    expect(control().session?.id).toBe('second');
    expect(statusOf('second')).toBe('active');
  });
});
