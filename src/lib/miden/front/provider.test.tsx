/* eslint-disable import/first */

import React from 'react';

import { render } from '@testing-library/react';

const _g = globalThis as any;
_g.__providerTest = {
  isExtension: false,
  ready: true,
  getMidenClientCalls: 0
};

jest.mock('lib/platform', () => ({
  isExtension: () => (globalThis as any).__providerTest.isExtension
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

jest.mock('lib/fiat-curency', () => ({
  FiatCurrencyProvider: ({ children }: any) => <>{children}</>
}));

jest.mock('lib/prices', () => ({
  PriceProvider: () => null
}));

jest.mock('components/NoteToastProvider', () => ({
  NoteToastProvider: () => null
}));

jest.mock('components/TransactionProgressModal', () => ({
  TransactionProgressModal: () => null
}));

jest.mock('./useSyncTrigger', () => ({
  useSyncTrigger: jest.fn()
}));

jest.mock('lib/miden-chain/native-asset', () => ({
  primeNativeAssetId: jest.fn()
}));

import { MidenProvider } from './provider';

beforeEach(() => {
  _g.__providerTest.isExtension = false;
  _g.__providerTest.ready = true;
  _g.__providerTest.getMidenClientCalls = 0;
});

describe('MidenProvider', () => {
  it('renders children inside the provider tree (ready)', async () => {
    const { getByText } = render(
      <MidenProvider>
        <div>child-content</div>
      </MidenProvider>
    );
    expect(getByText('child-content')).toBeDefined();
  });

  it('renders children when not ready (skips token providers)', () => {
    _g.__providerTest.ready = false;
    const { getByText } = render(
      <MidenProvider>
        <div>child-not-ready</div>
      </MidenProvider>
    );
    expect(getByText('child-not-ready')).toBeDefined();
  });

  it('eagerly initializes the Miden client on non-extension', async () => {
    _g.__providerTest.isExtension = false;
    render(
      <MidenProvider>
        <div>x</div>
      </MidenProvider>
    );
    // Wait for the useEffect to fire
    await new Promise(r => setTimeout(r, 0));
    expect(_g.__providerTest.getMidenClientCalls).toBeGreaterThan(0);
  });

  it('skips Miden client initialization on extension', async () => {
    _g.__providerTest.isExtension = true;
    render(
      <MidenProvider>
        <div>x</div>
      </MidenProvider>
    );
    await new Promise(r => setTimeout(r, 0));
    expect(_g.__providerTest.getMidenClientCalls).toBe(0);
  });
});
