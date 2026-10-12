import React from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { ExternalPageFailedNotice } from 'app/ExternalPageFailedNotice';
import Dialogs from 'app/layouts/Dialogs';
import { BrowserScreen } from 'app/pages/Browser/BrowserScreen';
import { DappActive } from 'app/pages/Browser/DappActive';
import { dappConfirmationStore, type DAppConfirmationRequest } from 'lib/dapp-browser/confirmation-store';
import { externalPageFailed } from 'lib/mobile/external-page-failed';
import { WalletStatus } from 'lib/shared/types';
import { DialogsProvider, dispatchAlertClose, dispatchConfirmClose, useConfirm } from 'lib/ui/dialog';

import { DappBrowserProvider, useDappBrowser, useHideForegroundDappWhileOpen } from './DappBrowserProvider';
import en from '../../../public/_locales/en/en.json';

const mockSetVisible = jest.fn(async (_id: string, _visible: boolean, _revision?: number) => {});
const mockSetRect = jest.fn(async (_id: string, _rect: unknown) => {});
const mockOpen = jest.fn(
  async (_options: { id: string; initiallyVisible?: boolean; managedHostClose?: { token: string } }) => {}
);
const mockCompleteClose = jest.fn(async (_options: unknown) => {});
const mockRemoveSession = jest.fn(async () => {});
const mockResetViewport = jest.fn(async () => {});
const mockClose = jest.fn(async (_id: string) => {});
const nativeListeners = new Map<
  string,
  (event: {
    id: string;
    display?: 'fullscreen' | 'browser';
    policyResolved?: boolean;
    policyRevision?: number;
    detail?: unknown;
    token?: string;
    requestId?: string;
    visible?: boolean;
    managedHostCloseToken?: string;
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
    open: async (options: { id: string; initiallyVisible?: boolean }) => {
      await mockOpen(options);
      return {
        id: options.id,
        setRect: (rect: unknown) => mockSetRect(options.id, rect),
        setVisible: (visible: boolean, revision?: number) =>
          revision === undefined ? mockSetVisible(options.id, visible) : mockSetVisible(options.id, visible, revision),
        executeScript: async () => {},
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
  captureSnapshot: async () => null,
  clearSnapshot: () => {},
  getSnapshot: () => undefined,
  snapshotStoreInternals: { setRaw: () => {} }
}));
jest.mock('lib/dapp-browser', () => ({
  INJECTION_SCRIPT: 'INJECTED;',
  parseOrigin: (url: string) => new URL(url).origin,
  loadPersistedSessions: async () => [],
  readSnapshotFromDisk: async () => null,
  removePersistedSession: () => mockRemoveSession(),
  removeSnapshotFromDisk: async () => {},
  upsertPersistedSession: async () => {},
  writeSnapshotToDisk: async () => {},
  toPersisted: (session: unknown) => session,
  fromPersisted: (session: unknown) => session,
  getRecentDapps: async () => [],
  getDappDisplayName: () => 'Test app',
  createDappSession: jest.fn(),
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
  DappLauncher: () => <div data-testid="retained-launcher">Launcher</div>
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

function Driver() {
  browser = useDappBrowser();
  confirm = useConfirm();
  return null;
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
  screen = false
}: {
  held?: boolean;
  actions?: boolean;
  screen?: boolean;
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
          {screen && <BrowserScreen />}
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
  mockSetVisible.mockClear();
  return currentTree;
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
  mockClose.mockClear();
  mockCompleteClose.mockClear();
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
