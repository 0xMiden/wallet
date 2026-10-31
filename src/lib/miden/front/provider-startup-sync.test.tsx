/* eslint-disable import/first */

import React from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';

import { resolveRootView } from 'app/root-view';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => false),
  isMobile: () => false,
  hasExtensionRuntime: () => true
}));
jest.mock('../sdk/miden-client', () => ({ getMidenClient: jest.fn().mockResolvedValue({}) }));

jest.mock('lib/store', () => {
  const { create } = jest.requireActual('zustand');
  const store = create((set: (value: object) => void) => ({
    status: null,
    isInitialized: false,
    currentAccount: null,
    networks: [],
    syncFromBackend: (state: object) => set({ ...state, isInitialized: true }),
    setSyncStatus: jest.fn()
  }));
  const intercom = { request: jest.fn(), subscribe: jest.fn(() => jest.fn()) };
  return { useWalletStore: store, getIntercom: () => intercom, startupIntercom: intercom };
});
jest.mock('lib/store/utils/updateBalancesFromSyncData', () => ({
  updateBalancesFromSyncData: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('lib/settings/helpers', () => ({ mirrorBackgroundSettings: jest.fn() }));

jest.mock('lib/miden/front/client', () => ({
  MidenContextProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useMidenContext: () => ({ ready: true })
}));

jest.mock('./assets', () => ({
  ALL_TOKENS_BASE_METADATA_STORAGE_KEY: 'tokens_base_metadata',
  TokensMetadataProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

jest.mock('lib/fiat-currency', () => ({
  FIAT_CURRENCY_STORAGE_KEY: 'fiat_currency',
  FiatCurrencyProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

type PreloadOptions = { onSettled?: (key: string) => void };
const mockPreloadStorage = jest.fn((_keys: string[], _options?: PreloadOptions) => Promise.resolve());
jest.mock('./storage', () => ({
  preloadStorage: (keys: string[], options?: PreloadOptions) => mockPreloadStorage(keys, options)
}));

jest.mock('lib/prices', () => ({
  PriceProvider: () => <div data-testid="price-provider" />
}));

jest.mock('components/NoteToastProvider', () => ({
  NoteToastProvider: () => null
}));

jest.mock('./useSyncTrigger', () => ({
  useSyncTrigger: jest.fn()
}));

jest.mock('./NativeNoteAutoConsumeManager', () => ({
  NativeNoteAutoConsumeManager: () => null
}));
jest.mock('lib/badges/BadgeIssuanceManager', () => ({ BadgeIssuanceManager: () => null }));
jest.mock('lib/epoch/EarnIntentWatcher', () => ({ EarnIntentWatcher: () => null }));
jest.mock('lib/miden/activity/BridgeIntentWatcher', () => ({ BridgeIntentWatcher: () => null }));
jest.mock('./SwapSettlementManager', () => ({ SwapSettlementManager: () => null }));
jest.mock('./SwapOrderTrackingManager', () => ({ SwapOrderTrackingManager: () => null }));
jest.mock('./OrphanedTransactionRecovery', () => ({ OrphanedTransactionRecovery: () => null }));
jest.mock('./useForegroundRefresh', () => ({ useForegroundRefresh: jest.fn() }));

jest.mock('lib/miden-chain/native-asset', () => ({
  primeNativeAssetId: jest.fn()
}));

jest.mock('lib/remote-config/runtime', () => ({ followEffectiveNetwork: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  loadEndpointOverrides: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  ensureSdkWasmReady: jest.fn(() => Promise.resolve())
}));

import { MidenProvider } from './provider';

const startupStore = jest.requireMock('lib/store').useWalletStore;
const startupIntercom = jest.requireMock('lib/store').startupIntercom;
const startupEndpoints = jest.requireMock('lib/miden-chain/effective-endpoints');
const views: string[] = [];
const readyState = {
  status: WalletStatus.Ready,
  accounts: [],
  currentAccount: null,
  networks: [],
  settings: null,
  ownMnemonic: null
};
function WalletView() {
  const status: WalletStatus = startupStore((state: { status: WalletStatus }) => state.status);
  const hydrated: boolean = startupStore((state: { isInitialized: boolean }) => state.isInitialized);
  const account: { publicKey: string } | null = startupStore(
    (state: { currentAccount: { publicKey: string } | null }) => state.currentAccount
  );
  const networks: { id: string }[] = startupStore((state: { networks: { id: string }[] }) => state.networks);
  const view = resolveRootView({
    ready: status === WalletStatus.Ready,
    locked: status === WalletStatus.Locked,
    hydrated
  });
  views.push(view);
  return <div data-testid="boot-view">{`${view}:${account?.publicKey ?? ''}:${networks[0]?.id ?? ''}`}</div>;
}
function holdLocalStartup() {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {
    finish = resolve;
  });
  jest.requireMock('lib/miden-chain/constants').ensureSdkWasmReady.mockReturnValueOnce(pending);
  return finish;
}
function stateResponse(state: object) {
  return { type: WalletMessageType.GetStateResponse, state };
}
beforeEach(() => {
  jest.requireMock('lib/platform').isExtension.mockReturnValue(true);
  mockPreloadStorage.mockClear();
  startupEndpoints.loadEndpointOverrides.mockReset().mockResolvedValue(undefined);
  startupStore.setState({ status: WalletStatus.Idle, isInitialized: false, currentAccount: null, networks: [] });
  startupIntercom.request.mockReset();
  startupIntercom.subscribe.mockReset().mockReturnValue(jest.fn());
  views.length = 0;
});

it('hydrates the live extension backend during local startup so its first wallet view is ready', async () => {
  const finish = holdLocalStartup();
  startupIntercom.request.mockResolvedValue(stateResponse(readyState));
  render(
    <MidenProvider>
      <WalletView />
    </MidenProvider>
  );
  await waitFor(() =>
    expect(startupIntercom.request).toHaveBeenCalledWith(
      { type: WalletMessageType.GetStateRequest },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  );
  await waitFor(() => expect(startupStore.getState().isInitialized).toBe(true));
  expect(screen.queryByTestId('boot-view')).toBeNull();
  await act(async () => finish());
  expect(screen.getByTestId('boot-view')).toHaveTextContent('app:');
  expect(views).toEqual(['app']);
});

it('keeps genuine cold backend startup loading until the authoritative response arrives', async () => {
  const finish = holdLocalStartup();
  let reply!: (value: object) => void;
  startupIntercom.request.mockImplementation(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  render(
    <MidenProvider>
      <WalletView />
    </MidenProvider>
  );
  await act(async () => finish());
  expect(screen.getByTestId('boot-view')).toHaveTextContent('loading:');
  await act(async () => reply(stateResponse(readyState)));
  expect(screen.getByTestId('boot-view')).toHaveTextContent('app:');
});

it('uses a lock notification received during local startup instead of flashing the old ready wallet', async () => {
  const finish = holdLocalStartup();
  let notify: (value: { type: WalletMessageType.StateUpdated }) => void = () => {};
  startupIntercom.subscribe.mockImplementation((listener: typeof notify) => {
    notify = listener;
    return jest.fn();
  });
  startupIntercom.request.mockResolvedValue(stateResponse(readyState));
  render(
    <MidenProvider>
      <WalletView />
    </MidenProvider>
  );
  await waitFor(() => expect(startupStore.getState().status).toBe(WalletStatus.Ready));
  startupIntercom.request.mockResolvedValue(stateResponse({ ...readyState, status: WalletStatus.Locked }));
  await act(async () => notify({ type: WalletMessageType.StateUpdated }));
  await waitFor(() => expect(startupStore.getState().status).toBe(WalletStatus.Locked));
  await act(async () => finish());
  expect(screen.getByTestId('boot-view')).toHaveTextContent('unlock:');
  expect(views).toEqual(['unlock']);
});

it('uses the latest account and network before revealing the reopened extension', async () => {
  const finish = holdLocalStartup();
  let notify: (value: { type: WalletMessageType.StateUpdated }) => void = () => {};
  startupIntercom.subscribe.mockImplementation((listener: typeof notify) => {
    notify = listener;
    return jest.fn();
  });
  startupIntercom.request.mockResolvedValue(
    stateResponse({ ...readyState, currentAccount: { publicKey: 'fixture-first' }, networks: [{ id: 'testnet' }] })
  );
  render(
    <MidenProvider>
      <WalletView />
    </MidenProvider>
  );
  await waitFor(() => expect(startupStore.getState().isInitialized).toBe(true));
  startupIntercom.request.mockResolvedValue(
    stateResponse({ ...readyState, currentAccount: { publicKey: 'fixture-latest' }, networks: [{ id: 'mainnet' }] })
  );
  await act(async () => notify({ type: WalletMessageType.StateUpdated }));
  await waitFor(() => expect(startupStore.getState().currentAccount?.publicKey).toBe('fixture-latest'));
  await act(async () => finish());
  expect(screen.getByTestId('boot-view')).toHaveTextContent('app:fixture-latest:mainnet');
  expect(views).toEqual(['app']);
});

it('preserves non-extension startup ordering while local SDK initialization is pending', async () => {
  jest.requireMock('lib/platform').isExtension.mockReturnValue(false);
  const finish = holdLocalStartup();
  startupIntercom.request.mockResolvedValue(stateResponse(readyState));
  render(
    <MidenProvider>
      <WalletView />
    </MidenProvider>
  );
  await act(async () => {});
  expect(startupIntercom.request).not.toHaveBeenCalled();
  expect(screen.queryByTestId('boot-view')).toBeNull();
  await act(async () => finish());
  await waitFor(() => expect(screen.getByTestId('boot-view')).toHaveTextContent('app:'));
});

it('waits for endpoint overrides before starting extension synchronization', async () => {
  const finish = holdLocalStartup();
  let overridesLoaded!: () => void;
  const overrides = new Promise<void>(resolve => {
    overridesLoaded = resolve;
  });
  startupEndpoints.loadEndpointOverrides.mockReturnValueOnce(overrides);
  startupIntercom.request.mockResolvedValue(stateResponse(readyState));
  render(
    <MidenProvider>
      <WalletView />
    </MidenProvider>
  );
  await act(async () => {});
  expect(startupIntercom.request).not.toHaveBeenCalled();
  expect(screen.queryByTestId('boot-view')).toBeNull();
  await act(async () => overridesLoaded());
  await waitFor(() => expect(startupStore.getState().isInitialized).toBe(true));
  expect(screen.queryByTestId('boot-view')).toBeNull();
  await act(async () => finish());
  expect(screen.getByTestId('boot-view')).toHaveTextContent('app:');
});

it('keeps the temporary empty backend snapshot unhydrated until the vault state is known', async () => {
  const finish = holdLocalStartup();
  startupIntercom.request
    .mockResolvedValueOnce(stateResponse({ ...readyState, status: WalletStatus.Idle, backendInitialized: false }))
    .mockResolvedValue(stateResponse({ ...readyState, backendInitialized: true }));
  render(
    <MidenProvider>
      <WalletView />
    </MidenProvider>
  );
  await act(async () => finish());
  expect(screen.getByTestId('boot-view')).toHaveTextContent('loading:');
  expect(startupStore.getState().isInitialized).toBe(false);
  await waitFor(() => expect(screen.getByTestId('boot-view')).toHaveTextContent('app:'));
  expect(views).not.toContain('welcome');
});
