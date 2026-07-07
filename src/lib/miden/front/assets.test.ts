/* eslint-disable import/first */

const _g = globalThis as any;
_g.__assetsTest = {
  storage: {} as Record<string, any>
};

const mockSetAssetsMetadata = jest.fn();
const mockFetchAssetMetadata = jest.fn();
const walletStoreState = {
  assetsMetadata: {} as Record<string, any>,
  setAssetsMetadata: mockSetAssetsMetadata,
  fetchAssetMetadata: mockFetchAssetMetadata
};

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys)
        if (k in (globalThis as any).__assetsTest.storage) {
          out[k] = (globalThis as any).__assetsTest.storage[k];
        }
      return out;
    },
    set: async (items: Record<string, any>) => {
      Object.assign((globalThis as any).__assetsTest.storage, items);
    }
  })
}));

jest.mock('lib/store', () => ({
  useWalletStore: jest.fn()
}));

jest.mock('lib/swr', () => ({
  useRetryableSWR: jest.fn(() => ({ data: null, mutate: jest.fn() }))
}));

jest.mock('lib/miden/front', () => ({
  fetchFromStorage: async (key: string) => (globalThis as any).__assetsTest.storage[key],
  putToStorage: async (key: string, value: any) => {
    (globalThis as any).__assetsTest.storage[key] = value;
  },
  fetchTokenMetadata: jest.fn(),
  onStorageChanged: jest.fn(() => () => {}),
  usePassiveStorage: jest.fn(() => [{}, jest.fn()]),
  isMidenAsset: (slug: string | object) => slug === 'miden',
  MIDEN_METADATA: { decimals: 6, symbol: 'MIDEN', name: 'Miden', thumbnailUri: '' }
}));

jest.mock('app/hooks/useGasToken', () => ({
  useGasToken: () => ({ metadata: { decimals: 6, symbol: 'MIDEN', name: 'Miden' } })
}));

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: jest.fn(() => 'miden-faucet-id')
}));

import {
  ALL_TOKENS_BASE_METADATA_STORAGE_KEY,
  TokensMetadataProvider,
  getTokensBaseMetadata,
  searchAssets,
  setTokensBaseMetadata,
  useAllAssetMetadata,
  useAllTokensBaseMetadata,
  useAssetMetadata,
  useDetailedAssetMetadata,
  useGetTokenMetadata,
  useTokensMetadata
} from './assets';
import React from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { fetchTokenMetadata, onStorageChanged, usePassiveStorage } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

const mockUseWalletStore = useWalletStore as jest.Mock;
const mockUseRetryableSWR = useRetryableSWR as jest.Mock;
const mockFetchTokenMetadata = fetchTokenMetadata as jest.Mock;
const mockOnStorageChanged = onStorageChanged as jest.Mock;
const mockUsePassiveStorage = usePassiveStorage as jest.Mock;

beforeEach(() => {
  for (const k of Object.keys(_g.__assetsTest.storage)) delete _g.__assetsTest.storage[k];
  jest.clearAllMocks();
  walletStoreState.assetsMetadata = {};
  mockUseWalletStore.mockImplementation((selector: any) => selector(walletStoreState));
  mockUseRetryableSWR.mockReturnValue({ data: null, mutate: jest.fn() });
  mockOnStorageChanged.mockReturnValue(() => {});
  mockUsePassiveStorage.mockReturnValue([{}, jest.fn()]);
});

describe('setTokensBaseMetadata', () => {
  it('persists new metadata merged with the existing entry', async () => {
    _g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY] = {
      a: { decimals: 6, symbol: 'A', name: 'A' }
    };
    await setTokensBaseMetadata({ b: { decimals: 8, symbol: 'B', name: 'B' } as any });
    // Wait for the queue to drain
    await new Promise(r => setTimeout(r, 0));
    const stored = _g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY];
    expect(stored.a).toBeDefined();
    expect(stored.b).toBeDefined();
  });

  it('initializes the storage when nothing is set', async () => {
    await setTokensBaseMetadata({ first: { decimals: 6, symbol: 'F', name: 'First' } as any });
    await new Promise(r => setTimeout(r, 0));
    const stored = _g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY];
    expect(stored?.first).toBeDefined();
  });
});

describe('getTokensBaseMetadata', () => {
  it('returns the stored metadata for the given asset id', async () => {
    _g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY] = {
      'asset-1': { decimals: 6, symbol: 'A1', name: 'Asset 1' }
    };
    const result = await getTokensBaseMetadata('asset-1');
    expect(result?.symbol).toBe('A1');
  });

  it('returns undefined when the asset is missing', async () => {
    expect(await getTokensBaseMetadata('missing')).toBeUndefined();
  });

  it('uses the empty default when nothing is stored', async () => {
    expect(await getTokensBaseMetadata('any')).toBeUndefined();
  });
});

describe('useAllAssetMetadata (async helper)', () => {
  it('returns the stored map when present', async () => {
    _g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY] = { x: { symbol: 'X' } };
    const result = await useAllAssetMetadata();
    expect(result).toEqual({ x: { symbol: 'X' } });
  });

  it('returns the empty default when nothing is stored', async () => {
    const result = await useAllAssetMetadata();
    expect(result).toEqual({});
  });
});

describe('metadata hooks and provider', () => {
  const baseMetadata = { decimals: 8, symbol: 'TOK', name: 'Token' };
  const detailedMetadata = { decimals: 8, symbol: 'TOK', name: 'Token', description: 'Detailed token' };

  it('returns gas token metadata for the configured miden faucet', () => {
    const { result } = renderHook(() => useAssetMetadata('miden', 'miden-faucet-id'));

    expect(result.current).toEqual({ decimals: 6, symbol: 'MIDEN', name: 'Miden' });
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();
  });

  it('returns cached metadata for a known token asset', () => {
    walletStoreState.assetsMetadata = {
      'asset-1': baseMetadata
    };

    const { result } = renderHook(() => useAssetMetadata('token', 'asset-1'));

    expect(result.current).toEqual(baseMetadata);
  });

  it('auto-fetches and persists metadata for a missing non-miden asset', async () => {
    mockFetchTokenMetadata.mockResolvedValue({
      base: baseMetadata,
      detailed: detailedMetadata
    });

    renderHook(() => useAssetMetadata('token', 'asset-missing'));

    await waitFor(() => {
      expect(mockSetAssetsMetadata).toHaveBeenCalledWith({ 'asset-missing': baseMetadata });
    });

    await waitFor(() => {
      expect(_g.__assetsTest.storage['detailed_asset_metadata_asset-missing']).toEqual(detailedMetadata);
    });
  });

  it('syncs initial token metadata into the wallet store', async () => {
    mockUsePassiveStorage.mockReturnValue([{ 'asset-1': baseMetadata }, jest.fn()]);

    render(
      React.createElement(
        TokensMetadataProvider,
        null,
        React.createElement('span', null, 'metadata child')
      )
    );

    expect(screen.getByText('metadata child')).toBeInTheDocument();
    await waitFor(() => {
      expect(mockSetAssetsMetadata).toHaveBeenCalledWith({ 'asset-1': baseMetadata });
    });
  });

  it('listens for storage changes and cleans up the listener', () => {
    const cleanup = jest.fn();
    mockOnStorageChanged.mockImplementation((_key: string, callback: (value: any) => void) => {
      callback({ 'asset-2': detailedMetadata });
      return cleanup;
    });

    const { unmount } = render(
      React.createElement(
        TokensMetadataProvider,
        null,
        React.createElement('span', null, 'metadata child')
      )
    );

    expect(mockOnStorageChanged).toHaveBeenCalledWith(ALL_TOKENS_BASE_METADATA_STORAGE_KEY, expect.any(Function));
    expect(mockSetAssetsMetadata).toHaveBeenCalledWith({ 'asset-2': detailedMetadata });

    unmount();

    expect(cleanup).toHaveBeenCalled();
  });

  it('returns a metadata lookup callback that handles miden and token assets', () => {
    walletStoreState.assetsMetadata = {
      'asset-1': baseMetadata
    };

    const { result } = renderHook(() => useGetTokenMetadata());

    expect(result.current('miden', 'miden-faucet-id')).toEqual({ decimals: 6, symbol: 'MIDEN', name: 'Miden' });
    expect(result.current('token', 'asset-1')).toEqual(baseMetadata);
  });

  it('returns detailed metadata when available and subscribes to storage changes', () => {
    const mutate = jest.fn();
    walletStoreState.assetsMetadata = {
      'asset-1': baseMetadata
    };
    mockUseRetryableSWR.mockReturnValue({ data: detailedMetadata, mutate });

    const { result } = renderHook(() => useDetailedAssetMetadata('token', 'asset-1'));

    expect(result.current).toEqual(detailedMetadata);
    expect(mockOnStorageChanged).toHaveBeenCalledWith('detailed_asset_metadata_asset-1', mutate);
  });

  it('falls back to base metadata when detailed metadata is missing', () => {
    walletStoreState.assetsMetadata = {
      'asset-1': baseMetadata
    };
    mockUseRetryableSWR.mockReturnValue({ data: null, mutate: jest.fn() });

    const { result } = renderHook(() => useDetailedAssetMetadata('token', 'asset-1'));

    expect(result.current).toEqual(baseMetadata);
  });

  it('returns all base metadata from the wallet store', () => {
    walletStoreState.assetsMetadata = {
      'asset-1': baseMetadata
    };

    const { result } = renderHook(() => useAllTokensBaseMetadata());

    expect(result.current).toEqual({ 'asset-1': baseMetadata });
  });

  it('returns token metadata helpers backed by a ref and persistence', async () => {
    const nextMetadata = { decimals: 9, symbol: 'NEXT', name: 'Next token' };
    walletStoreState.assetsMetadata = {
      'asset-1': baseMetadata
    };
    mockFetchTokenMetadata.mockResolvedValue({
      base: nextMetadata,
      detailed: { ...nextMetadata, description: 'Detailed next token' }
    });

    const { result } = renderHook(() => useTokensMetadata());

    expect(result.current.allTokensBaseMetadataRef.current).toEqual({ 'asset-1': baseMetadata });
    await expect(result.current.fetchMetadata('asset-next')).resolves.toEqual({
      base: nextMetadata,
      detailed: { ...nextMetadata, description: 'Detailed next token' }
    });
    expect(mockFetchTokenMetadata).toHaveBeenCalledWith('asset-next');

    await act(async () => {
      await result.current.setTokensBaseMetadata({ 'asset-next': nextMetadata });
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockSetAssetsMetadata).toHaveBeenCalledWith({ 'asset-next': nextMetadata });
    expect(_g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY]).toEqual({ 'asset-next': nextMetadata });
  });
});

describe('searchAssets', () => {
  const meta: Record<string, any> = {
    'id-eth': { name: 'Ether', symbol: 'ETH' },
    'id-btc': { name: 'Bitcoin', symbol: 'BTC' }
  };
  const assets = [
    { slug: 'token-eth', id: 'id-eth' },
    { slug: 'token-btc', id: 'id-btc' }
  ];

  it('returns all assets when search value is empty', () => {
    expect(searchAssets('', assets, meta)).toEqual(assets);
  });

  it('returns an array when searching for a name', () => {
    const result = searchAssets('Bitcoin', assets, meta);
    // Fuse uses fuzzy matching with threshold:1 so the result might include
    // multiple assets — we just verify the more-relevant one is first.
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.id).toBe('id-btc');
  });

  it('returns an array when searching for a symbol', () => {
    const result = searchAssets('ETH', assets, meta);
    expect(result.some(r => r.id === 'id-eth')).toBe(true);
  });

  it('handles miden asset via MIDEN_METADATA', () => {
    const midenAssets = [{ slug: 'miden', id: 'miden-id' }];
    const result = searchAssets('Miden', midenAssets, {});
    expect(result).toEqual([{ slug: 'miden', id: 'miden-id' }]);
  });
});
