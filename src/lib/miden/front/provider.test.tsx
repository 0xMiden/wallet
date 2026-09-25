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

type PreloadOptions = { onSettled?: (key: string) => void };
const mockPreloadStorage = jest.fn((_keys: string[], _options?: PreloadOptions) => Promise.resolve());
jest.mock('./storage', () => ({
  preloadStorage: (keys: string[], options?: PreloadOptions) => mockPreloadStorage(keys, options)
}));

jest.mock('lib/prices', () => ({
  PriceProvider: () => <div data-testid="price-provider" />,
  preloadTokenPrices: jest.fn()
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

import { MidenProvider, STORAGE_PRELOAD_BUDGET_MS } from './provider';

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
    expect(mockPreloadStorage).toHaveBeenCalledWith(
      ['tokens_base_metadata', 'fiat_currency', 'last_shown_changelog_version', 'network_id'],
      expect.objectContaining({ onSettled: expect.any(Function) })
    );
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

  it('warns about no budget when the preload settles in time', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { getByText } = render(
        <MidenProvider>
          <div>x</div>
        </MidenProvider>
      );
      await act(() => jest.advanceTimersByTimeAsync(STORAGE_PRELOAD_BUDGET_MS));
      expect(getByText('x')).toBeDefined();
      expect(warn.mock.calls.filter(([message]) => String(message).includes('still pending'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  describe('when the storage preload never settles', () => {
    let warn: jest.SpyInstance;
    const budgetWarnings = () => warn.mock.calls.filter(([message]) => String(message).includes('still pending'));

    beforeEach(() => {
      jest.useFakeTimers();
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockPreloadStorage.mockImplementationOnce(() => new Promise<void>(() => {}));
    });

    afterEach(() => {
      warn.mockRestore();
      jest.useRealTimers();
    });

    it('names the keys still pending when the budget runs out', async () => {
      // Every key but the network id settles; the budget warning names only that one.
      // Replace the never-settling preload queued above, keeping the default for later tests.
      mockPreloadStorage.mockReset();
      mockPreloadStorage.mockImplementation(() => Promise.resolve());
      mockPreloadStorage.mockImplementationOnce((keys, options) => {
        keys.filter(key => key !== 'network_id').forEach(key => options?.onSettled?.(key));
        return new Promise<void>(() => {});
      });
      render(
        <MidenProvider>
          <div>x</div>
        </MidenProvider>
      );
      await act(() => jest.advanceTimersByTimeAsync(STORAGE_PRELOAD_BUDGET_MS));
      expect(budgetWarnings()).toEqual([[expect.stringMatching(/still pending .*: network_id$/)]]);
    });

    it('renders after the preload budget, and says so', async () => {
      const { queryByText, getByText } = render(
        <MidenProvider>
          <div>x</div>
        </MidenProvider>
      );
      await act(() => jest.advanceTimersByTimeAsync(STORAGE_PRELOAD_BUDGET_MS - 1));
      expect(queryByText('x')).toBeNull();
      await act(() => jest.advanceTimersByTimeAsync(1));
      expect(getByText('x')).toBeDefined();
      expect(budgetWarnings()).toHaveLength(1);
    });

    it('leaves no budget warning behind once unmounted', async () => {
      const { unmount } = render(
        <MidenProvider>
          <div>x</div>
        </MidenProvider>
      );
      unmount();
      await act(() => jest.advanceTimersByTimeAsync(STORAGE_PRELOAD_BUDGET_MS));
      expect(budgetWarnings()).toHaveLength(0);
    });
  });

  it('still renders when the storage preload fails, and logs the failure', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failure = new Error('storage unavailable');
      mockPreloadStorage.mockImplementationOnce(() => Promise.reject(failure));
      const { findByText } = render(
        <MidenProvider>
          <div>x</div>
        </MidenProvider>
      );
      expect(await findByText('x')).toBeDefined();
      expect(warn).toHaveBeenCalledWith('[MidenProvider] storage preload failed:', failure);
    } finally {
      warn.mockRestore();
    }
  });

  it('mounts PriceProvider while the wallet is still locked, so its fetch starts before unlock', async () => {
    _g.__providerTest.ready = false;
    const { findByTestId } = render(
      <MidenProvider>
        <div>x</div>
      </MidenProvider>
    );
    expect(await findByTestId('price-provider')).toBeDefined();
  });
});
