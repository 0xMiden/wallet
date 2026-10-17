/* eslint-disable import/first */

import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('lib/platform', () => ({
  isExtension: () => false,
  isMobile: () => false
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn(async () => ({}))
}));

jest.mock('lib/store/WalletStoreProvider', () => ({
  WalletStoreProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

jest.mock('lib/miden/front/client', () => ({
  MidenContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useMidenContext: () => ({ ready: false })
}));

jest.mock('./assets', () => ({
  ALL_TOKENS_BASE_METADATA_STORAGE_KEY: 'tokens_base_metadata',
  TokensMetadataProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

jest.mock('lib/fiat-currency', () => ({
  FIAT_CURRENCY_STORAGE_KEY: 'fiat_currency',
  FiatCurrencyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

jest.mock('./storage', () => ({
  preloadStorage: jest.fn(() => Promise.resolve())
}));

jest.mock('lib/prices', () => ({ PriceProvider: () => null }));
jest.mock('components/NoteToastProvider', () => ({ NoteToastProvider: () => null }));
jest.mock('./useSyncTrigger', () => ({ useSyncTrigger: jest.fn() }));
jest.mock('./NativeNoteAutoConsumeManager', () => ({ NativeNoteAutoConsumeManager: () => null }));
jest.mock('lib/badges/BadgeIssuanceManager', () => ({ BadgeIssuanceManager: () => null }));
jest.mock('lib/miden-chain/native-asset', () => ({ primeNativeAssetId: jest.fn() }));
jest.mock('lib/remote-config/runtime', () => ({ followEffectiveNetwork: jest.fn() }));

jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  ensureSdkWasmReady: jest.fn(() => Promise.resolve())
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  loadEndpointOverrides: jest.fn(() => Promise.resolve())
}));

// The app's own boot boundary, with its screen's leaf UI stubbed as in ErrorBoundary.test.tsx.
jest.mock('lib/telemetry/crash', () => ({ captureCrash: jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/Button', () => ({
  Button: ({ title, onClick }: { title: string; onClick: () => void }) => <button onClick={onClick}>{title}</button>,
  ButtonVariant: { Primary: 'primary' }
}));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: { Frown: 'frown' } }));
jest.mock('app/env', () => ({
  ...jest.requireActual('app/env'),
  reloadPage: jest.fn()
}));

import { reloadPage } from 'app/env';
import ErrorBoundary from 'app/ErrorBoundary';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';
import { captureCrash } from 'lib/telemetry/crash';

import { MidenProvider } from './provider';

const startFailure = new Error('wasm start trapped');

const renderWallet = () =>
  render(
    <ErrorBoundary whileMessage="booting a wallet">
      <MidenProvider>
        <div>wallet</div>
      </MidenProvider>
    </ErrorBoundary>
  );

describe('MidenProvider when the wallet fails to start', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.mocked(captureCrash).mockClear();
    jest.mocked(reloadPage).mockClear();
    jest.mocked(ensureSdkWasmReady).mockReset().mockResolvedValue(undefined);
    jest.mocked(loadEndpointOverrides).mockReset().mockResolvedValue(undefined);
    // React and the boundary log the error they catch.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => consoleError.mockRestore());

  it('shows the boot error screen instead of nothing when the SDK fails to start', async () => {
    // The SDK keeps a failed start, so every call in the page rejects the same way.
    jest.mocked(ensureSdkWasmReady).mockRejectedValue(startFailure);
    renderWallet();
    expect(await screen.findByText('tryAgain')).toBeInTheDocument();
    expect(screen.queryByText('wallet')).toBeNull();
  });

  it('reports the failed start once, as the very error the SDK rejected with', async () => {
    jest.mocked(ensureSdkWasmReady).mockRejectedValue(startFailure);
    renderWallet();
    await screen.findByText('tryAgain');
    expect(captureCrash).toHaveBeenCalledTimes(1);
    expect(jest.mocked(captureCrash).mock.calls[0]?.[0]).toBe(startFailure);
    expect(jest.mocked(captureCrash).mock.calls[0]?.[1]).toBe('react');
  });

  it('shows the same screen when loading the endpoint override fails', async () => {
    jest.mocked(loadEndpointOverrides).mockRejectedValue(startFailure);
    renderWallet();
    expect(await screen.findByText('tryAgain')).toBeInTheDocument();
    expect(captureCrash).toHaveBeenCalledTimes(1);
    expect(jest.mocked(captureCrash).mock.calls[0]?.[0]).toBe(startFailure);
    expect(ensureSdkWasmReady).not.toHaveBeenCalled();
  });

  it('reloads the page on Try Again rather than starting the SDK again in it', async () => {
    jest.mocked(ensureSdkWasmReady).mockRejectedValue(startFailure);
    renderWallet();
    const tryAgain = await screen.findByText('tryAgain');
    await act(async () => {
      fireEvent.click(tryAgain);
    });
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(ensureSdkWasmReady).toHaveBeenCalledTimes(1);
    expect(screen.getByText('tryAgain')).toBeInTheDocument();
  });

  it.each([
    ['a string', 'wasm start trapped'],
    ['undefined', undefined]
  ])('shows the screen for a start rejecting with %s, and Try Again only reloads', async (_, value) => {
    jest.mocked(ensureSdkWasmReady).mockRejectedValue(value);
    renderWallet();
    const tryAgain = await screen.findByText('tryAgain');
    await act(async () => {
      fireEvent.click(tryAgain);
    });
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(ensureSdkWasmReady).toHaveBeenCalledTimes(1);
  });

  // Jest fails a test that leaves a rejection unhandled, so the catch is checked without a listener.
  it('leaves no unhandled rejection and no report when the start fails after the provider unmounted', async () => {
    let failStart!: (error: Error) => void;
    jest.mocked(ensureSdkWasmReady).mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        failStart = reject;
      })
    );
    const { unmount } = renderWallet();
    await waitFor(() => expect(ensureSdkWasmReady).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => failStart(startFailure));
    expect(captureCrash).not.toHaveBeenCalled();
  });
});
