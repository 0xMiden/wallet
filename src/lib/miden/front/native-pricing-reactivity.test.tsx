import React, { useMemo } from 'react';

import { act, render, screen } from '@testing-library/react';
import BigNumber from 'bignumber.js';
import { create } from 'zustand';

import type { AssetMetadata } from 'lib/miden/metadata/types';
import { tokenQuote } from 'lib/miden/swap/tokens';
import { pricesLoaded, type TokenPrices } from 'lib/prices/binance';

import { TokensMetadataProvider } from './assets';
import type { TokenBalanceData } from './balance';

type NativeState = {
  tokenPrices: TokenPrices;
  assetsMetadata: Record<string, AssetMetadata>;
  balances: Record<string, TokenBalanceData[]>;
  tokenMetadataOverrides: Record<string, never>;
  setAssetsMetadata(metadata: Record<string, AssetMetadata>): void;
};
const mockStore = create<NativeState>((set, get) => ({
  tokenPrices: {},
  assetsMetadata: {},
  balances: {
    account: [
      {
        tokenId: 'native-fixed',
        tokenSlug: 'MIDEN',
        balance: 1,
        fiatPrice: 0,
        change24h: 0,
        metadata: { symbol: 'MIDEN', name: 'Miden', decimals: 6, scaleIsUnknown: true }
      }
    ]
  },
  tokenMetadataOverrides: {},
  setAssetsMetadata: metadata => set({ assetsMetadata: { ...get().assetsMetadata, ...metadata } })
}));
let mockNativeMetadata: { symbol: string; decimals: number } | null = null;
let mockNativeChanged: ((id: string) => void) | undefined;

beforeEach(() => {
  mockNativeMetadata = null;
  mockStore.setState({ tokenPrices: {}, assetsMetadata: {} });
});

jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(<T,>(select: (state: NativeState) => T) => mockStore(select), {
    getState: () => mockStore.getState(),
    subscribe: () => () => {},
    setState: (update: (state: NativeState) => Partial<NativeState>) => mockStore.setState(update)
  })
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => 'native-fixed',
  getNativeAssetMetadataSync: () => mockNativeMetadata,
  getSdkSyncedNativeAssetIdSync: () => 'native-fixed',
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

let priceComputations = 0;

function MemoizedPrice() {
  const prices = mockStore(state => state.tokenPrices);
  const row = mockStore(state => state.balances.account?.[0]);
  const id = 'native-fixed';
  const price = useMemo(() => {
    priceComputations += 1;
    return tokenQuote(prices, id, 'USDCX')?.price;
  }, [prices, id]);
  return (
    <div>
      <span data-testid="memo-price">{price ?? 'waiting'}</span>
      <span data-testid="balance-fiat">{row?.fiatPrice}</span>
      <span data-testid="ready">{String(pricesLoaded(prices, ['USDCX']))}</span>
    </div>
  );
}

it('re-evaluates memoized prices and stored balances after metadata completes at the same ID with an unchanged empty feed', () => {
  render(
    <TokensMetadataProvider>
      <MemoizedPrice />
    </TokensMetadataProvider>
  );
  expect(screen.getByTestId('memo-price')).toHaveTextContent('1');
  const initialComputations = priceComputations;
  expect(screen.getByTestId('balance-fiat')).toHaveTextContent('0');
  const initialFeed = mockStore.getState().tokenPrices;
  act(() => {
    mockNativeMetadata = { symbol: 'USDCX', decimals: 6 };
    mockNativeChanged?.('native-fixed');
  });
  expect(mockStore.getState().tokenPrices).toEqual({});
  expect(mockStore.getState().tokenPrices).not.toBe(initialFeed);
  expect(priceComputations).toBeGreaterThan(initialComputations);
  expect(screen.getByTestId('memo-price')).toHaveTextContent('1');
  expect(screen.getByTestId('balance-fiat')).toHaveTextContent('1');
  expect(screen.getByTestId('ready')).toHaveTextContent('true');
});

it('projects native decimals exactly within the existing Number balance contract', () => {
  const original = mockStore.getState().balances.account![0]!;
  mockStore.setState({
    balances: { account: [{ ...original, balance: 0.29, metadata: { symbol: 'USDCX', name: 'USDCX', decimals: 2 } }] }
  });
  render(
    <TokensMetadataProvider>
      <MemoizedPrice />
    </TokensMetadataProvider>
  );
  act(() => {
    mockNativeMetadata = { symbol: 'USDCX', decimals: 0 };
    mockNativeChanged?.('native-fixed');
  });
  const directlyDecoded = new BigNumber('29').shiftedBy(0).toNumber();
  expect(directlyDecoded).toBe(29);
  expect(mockStore.getState().balances.account![0]!.balance).toBe(directlyDecoded);
  expect(screen.getByTestId('balance-fiat')).toHaveTextContent('1');
});
