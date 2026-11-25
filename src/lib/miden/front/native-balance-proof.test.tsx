import React from 'react';

import { act, render } from '@testing-library/react';
import { create } from 'zustand';

import { readBalanceSnapshot, tagBalanceSnapshot } from 'lib/miden/balance-snapshot';
import type { AssetMetadata } from 'lib/miden/metadata/types';
import type { TokenPrices } from 'lib/prices/binance';

import { TokensMetadataProvider } from './assets';
import type { TokenBalanceData } from './balance';

type NativeState = {
  tokenPrices: TokenPrices;
  assetsMetadata: Record<string, AssetMetadata>;
  balances: Record<string, TokenBalanceData[]>;
  tokenMetadataOverrides: Record<string, never>;
  setAssetsMetadata(metadata: Record<string, AssetMetadata>): void;
};
const scope = { accountId: 'account', network: 'mainnet', rpcUrl: 'https://node' };
const row = (tokenId: string, decimals: number): TokenBalanceData => ({
  tokenId,
  tokenSlug: tokenId,
  balance: 3,
  fiatPrice: 0,
  change24h: 0,
  metadata: { symbol: tokenId, name: tokenId, decimals }
});
const mockStore = create<NativeState>((set, get) => ({
  tokenPrices: {},
  assetsMetadata: {},
  balances: {},
  tokenMetadataOverrides: {},
  setAssetsMetadata: metadata => set({ assetsMetadata: { ...get().assetsMetadata, ...metadata } })
}));
let mockNativeChanged: ((id: string) => void) | undefined;

jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(<T,>(select: (state: NativeState) => T) => mockStore(select), {
    getState: () => mockStore.getState(),
    subscribe: () => () => {},
    setState: (update: (state: NativeState) => Partial<NativeState>) => mockStore.setState(update)
  })
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => 'native',
  getNativeAssetMetadataSync: () => ({ symbol: 'MIDEN', decimals: 6 }),
  getSdkSyncedNativeAssetIdSync: () => 'native',
  onNativeAssetChanged: (listener: (id: string) => void) => {
    mockNativeChanged = listener;
    return () => {
      mockNativeChanged = undefined;
    };
  }
}));
jest.mock('lib/miden/front', () => ({
  usePassiveStorage: () => [{}],
  onStorageChanged: () => () => {},
  isMidenAsset: () => false
}));
jest.mock('lib/platform', () => ({ isExtension: () => false, isMobile: () => false }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => 'mainnet',
  getEffectiveRpcUrl: () => 'https://node',
  getActiveOverride: () => null,
  isNetworkChoiceOverride: () => false
}));

const proof = { network: 'mainnet', effectiveNetwork: 'mainnet', rpcUrl: scope.rpcUrl, accountNonce: '1' };

function landRows(rows: TokenBalanceData[]) {
  tagBalanceSnapshot(rows, { ...proof, capturedAt: Date.now() }, scope.accountId);
  mockStore.setState({ balances: { [scope.accountId]: rows } });
}

it('keeps the vault read proof of landed rows when the native asset is learned afterwards', () => {
  landRows([row('native', 6), row('other', 6)]);
  render(
    <TokensMetadataProvider>
      <span />
    </TokensMetadataProvider>
  );
  act(() => mockNativeChanged?.('native'));
  expect(readBalanceSnapshot(mockStore.getState().balances[scope.accountId]!, scope)).not.toBeNull();
});

it('keeps the vault read proof when the native asset is learned with a different scale', () => {
  landRows([row('native', 8), row('other', 6)]);
  render(
    <TokensMetadataProvider>
      <span />
    </TokensMetadataProvider>
  );
  act(() => mockNativeChanged?.('native'));
  const rows = mockStore.getState().balances[scope.accountId]!;
  expect(rows[0]!.metadata.decimals).toBe(6);
  expect(readBalanceSnapshot(rows, scope)).not.toBeNull();
});
