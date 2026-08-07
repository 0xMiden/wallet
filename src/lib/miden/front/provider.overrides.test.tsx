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
jest.mock('./assets', () => ({ TokensMetadataProvider: ({ children }: any) => <>{children}</> }));
jest.mock('lib/fiat-curency', () => ({ FiatCurrencyProvider: ({ children }: any) => <>{children}</> }));
jest.mock('lib/prices', () => ({ PriceProvider: () => null }));
jest.mock('components/NoteToastProvider', () => ({ NoteToastProvider: () => null }));
jest.mock('./NativeNoteAutoConsumeManager', () => ({ NativeNoteAutoConsumeManager: () => null }));
jest.mock('./SwapSettlementManager', () => ({ SwapSettlementManager: () => null }));

import { MidenProvider } from './provider';

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
});
