/* eslint-disable import/first */
import React from 'react';

import { render, screen, waitFor } from '@testing-library/react';

const loadEndpointOverrides = jest.fn().mockResolvedValue(undefined);
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  loadEndpointOverrides: () => loadEndpointOverrides(),
  getEffectiveRpcUrl: () => 'https://rpc.test',
  getEffectiveProverUrl: () => 'https://prover.test',
  getEffectiveNoteTransportUrl: () => 'https://ntl.test'
}));

const ensureSdkWasmReady = jest.fn().mockResolvedValue(undefined);
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: () => ensureSdkWasmReady() }));

jest.mock('lib/platform', () => ({ isExtension: () => true, isMobile: () => false }));
jest.mock('lib/store/WalletStoreProvider', () => ({ WalletStoreProvider: ({ children }: any) => <>{children}</> }));
jest.mock('lib/miden/front/client', () => ({
  MidenContextProvider: ({ children }: any) => <>{children}</>,
  useMidenContext: () => ({ ready: true })
}));
jest.mock('@miden-sdk/react/lazy', () => ({ MidenProvider: ({ children }: any) => <>{children}</> }));
jest.mock('../sdk/miden-client', () => ({ getMidenClient: jest.fn().mockResolvedValue({}) }));
jest.mock('lib/miden-chain/native-asset', () => ({ primeNativeAssetId: jest.fn() }));
jest.mock('lib/settings/helpers', () => ({ mirrorBackgroundSettings: jest.fn() }));
jest.mock('./useSyncTrigger', () => ({ useSyncTrigger: jest.fn() }));
jest.mock('./assets', () => ({
  ALL_TOKENS_BASE_METADATA_STORAGE_KEY: 'tokens_base_metadata',
  TokensMetadataProvider: ({ children }: any) => <>{children}</>
}));
const preloadStorage = jest.fn(() => Promise.resolve());
jest.mock('./storage', () => ({ preloadStorage: () => preloadStorage() }));
jest.mock('lib/fiat-currency', () => ({
  FIAT_CURRENCY_STORAGE_KEY: 'fiat_currency',
  FiatCurrencyProvider: ({ children }: any) => <>{children}</>
}));
const preloadTokenPrices = jest.fn();
jest.mock('lib/prices', () => ({ PriceProvider: () => null, preloadTokenPrices: () => preloadTokenPrices() }));
jest.mock('components/NoteToastProvider', () => ({ NoteToastProvider: () => null }));
jest.mock('./NativeNoteAutoConsumeManager', () => ({ NativeNoteAutoConsumeManager: () => null }));
jest.mock('./SwapSettlementManager', () => ({ SwapSettlementManager: () => null }));

import { primeNativeAssetId } from 'lib/miden-chain/native-asset';

import { MidenProvider } from './provider';

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  loadEndpointOverrides.mockResolvedValue(undefined);
  ensureSdkWasmReady.mockResolvedValue(undefined);
});

afterEach(() => {
  warn.mockRestore();
});

it('starts the price fetch before endpoint overrides, WASM and the storage preload', () => {
  loadEndpointOverrides.mockReturnValue(new Promise(() => {}));
  ensureSdkWasmReady.mockReturnValue(new Promise(() => {}));
  render(
    <MidenProvider>
      <div data-testid="child" />
    </MidenProvider>
  );
  expect(preloadTokenPrices).toHaveBeenCalledTimes(1);
  expect(preloadTokenPrices.mock.invocationCallOrder[0]!).toBeLessThan(
    loadEndpointOverrides.mock.invocationCallOrder[0]!
  );
  expect(preloadTokenPrices.mock.invocationCallOrder[0]!).toBeLessThan(preloadStorage.mock.invocationCallOrder[0]!);
  expect(warn).not.toHaveBeenCalled();
});

it('loads endpoint overrides before rendering children', async () => {
  render(
    <MidenProvider>
      <div data-testid="child" />
    </MidenProvider>
  );
  await waitFor(() => expect(screen.getByTestId('child')).toBeInTheDocument());
  expect(loadEndpointOverrides).toHaveBeenCalledTimes(1);
  expect(ensureSdkWasmReady).toHaveBeenCalledTimes(1);
  // Guards against a regression where `ready` starts `true` with no real gate:
  // overrides must load BEFORE the SDK's WASM module is considered ready.
  expect(loadEndpointOverrides.mock.invocationCallOrder[0]!).toBeLessThan(
    ensureSdkWasmReady.mock.invocationCallOrder[0]!
  );
  // Nothing here should reach a failure path the preload, or anything else, logs.
  expect(warn).not.toHaveBeenCalled();
});

it('primes native-asset discovery only AFTER endpoint overrides resolve (not against the build default)', async () => {
  // Hold the override load open so we can observe what runs before it resolves.
  let resolveLoad!: () => void;
  loadEndpointOverrides.mockImplementationOnce(() => new Promise<void>(res => (resolveLoad = () => res())));

  render(
    <MidenProvider>
      <div data-testid="child" />
    </MidenProvider>
  );

  // Overrides haven't resolved yet — discovery must NOT have been primed
  // (priming here would target the build-default node, caching the wrong
  // network's native faucet id on a custom dev-settings network).
  await Promise.resolve();
  expect(primeNativeAssetId).not.toHaveBeenCalled();

  // Once overrides resolve, priming runs against the now-current endpoint.
  resolveLoad();
  await waitFor(() => expect(primeNativeAssetId).toHaveBeenCalledTimes(1));
  // Nothing here should reach a failure path the preload, or anything else, logs.
  expect(warn).not.toHaveBeenCalled();
});
