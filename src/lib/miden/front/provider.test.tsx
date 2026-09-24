/* eslint-disable import/first */

import React from 'react';

import { act, render, waitFor } from '@testing-library/react';

const _g = globalThis as any;
_g.__providerTest = {
  isExtension: false,
  ready: true,
  getMidenClientCalls: 0
};

jest.mock('lib/platform', () => ({
  isExtension: () => (globalThis as any).__providerTest.isExtension,
  isMobile: () => (globalThis as any).__providerTest.isMobile ?? false
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => {
    (globalThis as any).__providerTest.getMidenClientCalls++;
    return {};
  }
}));

jest.mock('lib/store/WalletStoreProvider', () => ({
  WalletStoreProvider: ({ children }: any) => <>{children}</>
}));

jest.mock('lib/miden/front/client', () => ({
  MidenContextProvider: ({ children }: any) => <>{children}</>,
  useMidenContext: () => ({ ready: (globalThis as any).__providerTest.ready })
}));

jest.mock('./assets', () => ({
  ALL_TOKENS_BASE_METADATA_STORAGE_KEY: 'tokens_base_metadata',
  TokensMetadataProvider: ({ children }: any) => <>{children}</>
}));

jest.mock('lib/fiat-currency', () => ({
  FIAT_CURRENCY_STORAGE_KEY: 'fiat_currency',
  FiatCurrencyProvider: ({ children }: any) => <>{children}</>
}));

const mockPreloadStorage = jest.fn((_keys: string[]) => Promise.resolve());
jest.mock('./storage', () => ({
  preloadStorage: (keys: string[]) => mockPreloadStorage(keys)
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

jest.mock('lib/miden-chain/native-asset', () => ({
  primeNativeAssetId: jest.fn()
}));

// The provider gates SdkMidenProvider on WASM readiness via
// ensureSdkWasmReady(); resolve immediately in jsdom (no WASM here),
// keep the real constants for everything else.
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  ensureSdkWasmReady: jest.fn(() => Promise.resolve())
}));

import { MidenProvider } from './provider';

beforeEach(() => {
  _g.__providerTest.isExtension = false;
  _g.__providerTest.ready = true;
  _g.__providerTest.getMidenClientCalls = 0;
  mockPreloadStorage.mockClear();
});

describe('MidenProvider', () => {
  it('renders children inside the provider tree (ready)', async () => {
    const { findByText } = render(
      <MidenProvider>
        <div>child-content</div>
      </MidenProvider>
    );
    // The provider renders null until the ensureSdkWasmReady() gate
    // resolves (one microtask with the mock) — await the appearance.
    expect(await findByText('child-content')).toBeDefined();
  });

  it('renders children when not ready (skips token providers)', async () => {
    _g.__providerTest.ready = false;
    const { findByText } = render(
      <MidenProvider>
        <div>child-not-ready</div>
      </MidenProvider>
    );
    expect(await findByText('child-not-ready')).toBeDefined();
  });

  it('eagerly initializes the Miden client on non-extension', async () => {
    _g.__providerTest.isExtension = false;
    render(
      <MidenProvider>
        <div>x</div>
      </MidenProvider>
    );
    // Wait for the readiness gate (loadEndpointOverrides + ensureSdkWasmReady)
    // to resolve and the dependent getMidenClient() effect to fire.
    await waitFor(() => expect(_g.__providerTest.getMidenClientCalls).toBeGreaterThan(0));
  });

  it('skips Miden client initialization on extension', async () => {
    _g.__providerTest.isExtension = true;
    const { findByText } = render(
      <MidenProvider>
        <div>x</div>
      </MidenProvider>
    );
    // Wait for the readiness gate to resolve (children render) before
    // asserting the client was never initialized.
    await findByText('x');
    expect(_g.__providerTest.getMidenClientCalls).toBe(0);
  });

  it('preloads the storage keys the ready-only providers read, before the wallet is ready', () => {
    _g.__providerTest.ready = false;
    render(
      <MidenProvider>
        <div>x</div>
      </MidenProvider>
    );
    expect(mockPreloadStorage).toHaveBeenCalledTimes(1);
    expect(mockPreloadStorage).toHaveBeenCalledWith(['tokens_base_metadata', 'fiat_currency']);
  });

  it('renders nothing until the storage preload settles', async () => {
    const { ensureSdkWasmReady } = jest.requireMock('lib/miden-chain/constants');
    let settle!: () => void;
    mockPreloadStorage.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          settle = resolve;
        })
    );
    const { queryByText, findByText } = render(
      <MidenProvider>
        <div>x</div>
      </MidenProvider>
    );
    await waitFor(() => expect(ensureSdkWasmReady).toHaveBeenCalled());
    // The WASM gate has resolved; only the pending preload can still hold the tree back.
    await act(async () => {});
    expect(queryByText('x')).toBeNull();
    settle();
    expect(await findByText('x')).toBeDefined();
  });

  it('still renders when the storage preload fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPreloadStorage.mockImplementationOnce(() => Promise.reject(new Error('storage unavailable')));
    const { findByText } = render(
      <MidenProvider>
        <div>x</div>
      </MidenProvider>
    );
    expect(await findByText('x')).toBeDefined();
    warn.mockRestore();
  });

  it('fetches prices while the wallet is still locked, so Home has them on its first frame', async () => {
    _g.__providerTest.ready = false;
    const { findByTestId } = render(
      <MidenProvider>
        <div>x</div>
      </MidenProvider>
    );
    expect(await findByTestId('price-provider')).toBeDefined();
  });
});
