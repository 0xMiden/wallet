/* eslint-disable import/first */

import React from 'react';

import { render, waitFor } from '@testing-library/react';

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
  TokensMetadataProvider: ({ children }: any) => <>{children}</>
}));

jest.mock('lib/fiat-currency', () => ({
  FiatCurrencyProvider: ({ children }: any) => <>{children}</>
}));

jest.mock('lib/prices', () => ({
  PriceProvider: () => null
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
});
