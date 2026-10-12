import React from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { ExternalPageFailedNotice } from 'app/ExternalPageFailedNotice';
import Dialogs from 'app/layouts/Dialogs';
import { DappActive } from 'app/pages/Browser/DappActive';
import { dappConfirmationStore, type DAppConfirmationRequest } from 'lib/dapp-browser/confirmation-store';
import { externalPageFailed } from 'lib/mobile/external-page-failed';
import { WalletStatus } from 'lib/shared/types';
import { DialogsProvider, dispatchAlertClose, dispatchConfirmClose, useConfirm } from 'lib/ui/dialog';

import { DappBrowserProvider, useDappBrowser, useHideForegroundDappWhileOpen } from './DappBrowserProvider';
import en from '../../../public/_locales/en/en.json';

const mockSetVisible = jest.fn(async (_id: string, _visible: boolean) => {});
const mockSetRect = jest.fn(async (_id: string, _rect: unknown) => {});
const mockOpen = jest.fn(async (_options: { id: string }) => {});
const mockClose = jest.fn(async (_id: string) => {});
const nativeListeners = new Map<string, (event: { id: string; display: 'fullscreen' }) => void>();
jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    addListener: async (event: string, listener: (event: { id: string; display: 'fullscreen' }) => void) => {
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
    open: async (options: { id: string }) => {
      await mockOpen(options);
      return {
        id: options.id,
        setRect: (rect: unknown) => mockSetRect(options.id, rect),
        setVisible: (visible: boolean) => mockSetVisible(options.id, visible),
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
jest.mock('lib/mobile/viewport-reset', () => ({ resetViewportAfterWebview: async () => {} }));
jest.mock('lib/mobile/webview-state', () => ({ markReturningFromWebview: () => {} }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: () => {} }));
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
  removePersistedSession: async () => {},
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
// Approval data/hook are real; the approval modal's rendering is a separate native acceptance gate.
jest.mock('app/pages/Browser/DappConfirmationModal', () => ({ DappConfirmationModal: () => null }));
// Only the capsule trigger is adapted; DappActive and its actions Drawer remain production components.
jest.mock('app/pages/Browser/CapsuleBar', () => ({
  CapsuleBar: ({ onOpenActions }: { onOpenActions: () => void }) => (
    <button data-testid="actions-trigger" onClick={onOpenActions}>
      Actions
    </button>
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
function Tree({ held = false, actions = false }: { held?: boolean; actions?: boolean }) {
  return (
    <I18nextProvider i18n={testI18n}>
      <DialogsProvider>
        <Dialogs />
        <ExternalPageFailedNotice />
        <DappBrowserProvider>
          <Driver />
          {held && <HeldOverlay />}
          {actions && <DappActive />}
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
  act(() => nativeListeners.get('presentationChanged')?.({ id: 'origin', display: 'fullscreen' }));
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
  mockSetVisible.mockClear();
  mockSetRect.mockClear();
  mockOpen.mockClear();
  mockClose.mockClear();
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
  act(() => nativeListeners.get('presentationChanged')?.({ id: 'origin', display: 'fullscreen' }));
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
