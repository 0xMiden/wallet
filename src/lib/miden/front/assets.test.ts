/* eslint-disable import/first */

const _g = globalThis as any;
_g.__assetsTest = {
  storage: {} as Record<string, any>
};

const mockSetAssetsMetadata = jest.fn();
const mockFetchAssetMetadata = jest.fn();
const mockWalletStoreState = {
  tokenPrices: {},
  balances: {},
  assetsMetadata: {} as Record<string, any>,
  setAssetsMetadata: mockSetAssetsMetadata,
  fetchAssetMetadata: mockFetchAssetMetadata
};

let mockActualNativeId = 'miden-faucet-id';
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => mockActualNativeId,
  getNativeAssetMetadataSync: jest.fn(() => ({ symbol: 'MIDEN', decimals: 6 })),
  onNativeAssetChanged: jest.fn(() => () => {})
}));

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
  useWalletStore: Object.assign(jest.fn(), {
    setState: jest.fn((update: (state: typeof mockWalletStoreState) => Partial<typeof mockWalletStoreState>) =>
      Object.assign(mockWalletStoreState, update(mockWalletStoreState))
    )
  })
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

import React from 'react';

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';

import { fetchTokenMetadata, onStorageChanged, usePassiveStorage } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

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

const mockUseWalletStore = useWalletStore as unknown as jest.Mock;
const mockUseRetryableSWR = useRetryableSWR as jest.Mock;
const mockFetchTokenMetadata = fetchTokenMetadata as jest.Mock;
const mockOnStorageChanged = onStorageChanged as jest.Mock;
const mockUsePassiveStorage = usePassiveStorage as jest.Mock;

beforeEach(() => {
  for (const k of Object.keys(_g.__assetsTest.storage)) delete _g.__assetsTest.storage[k];
  jest.clearAllMocks();
  mockActualNativeId = 'miden-faucet-id';
  jest.requireMock('app/hooks/useMidenFaucetId').default.mockReturnValue('miden-faucet-id');
  jest
    .requireMock('lib/miden-chain/native-asset')
    .getNativeAssetMetadataSync.mockReturnValue({ symbol: 'MIDEN', decimals: 6 });
  mockFetchTokenMetadata.mockReset();
  mockSetAssetsMetadata.mockReset();

  mockWalletStoreState.assetsMetadata = {};
  mockUseWalletStore.mockImplementation((selector: any) => selector(mockWalletStoreState));
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

    expect(result.current).toEqual(
      expect.objectContaining({ decimals: 6, symbol: 'MIDEN', name: 'Miden', scaleIsUnknown: false })
    );
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();
  });

  it('returns cached metadata for a known token asset', () => {
    mockWalletStoreState.assetsMetadata = {
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

  it('fetches missing foreign legacy display metadata and exposes its known scale', async () => {
    mockActualNativeId = 'actual-A';
    jest.requireMock('app/hooks/useMidenFaucetId').default.mockReturnValue('legacy-B');
    jest
      .requireMock('lib/miden-chain/native-asset')
      .getNativeAssetMetadataSync.mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    const legacyMetadata = { symbol: 'LEGACY', name: 'Legacy', decimals: 2 };
    mockFetchTokenMetadata.mockResolvedValue({ base: legacyMetadata, detailed: legacyMetadata });
    mockSetAssetsMetadata.mockImplementation(metadata => Object.assign(mockWalletStoreState.assetsMetadata, metadata));
    const { result, rerender } = renderHook(() => useAssetMetadata('miden', 'legacy-B'));
    await waitFor(() => expect(mockFetchTokenMetadata).toHaveBeenCalledWith('legacy-B'));
    await waitFor(() => expect(_g.__assetsTest.storage['detailed_asset_metadata_legacy-B']).toEqual(legacyMetadata));
    rerender();
    expect(result.current).toEqual(legacyMetadata);
    expect(result.current?.scaleIsUnknown).not.toBe(true);
  });

  it.each([false, true])(
    'uses actual native chain metadata under a foreign legacy display override, cached=%s',
    cached => {
      mockActualNativeId = 'actual-A';
      jest.requireMock('app/hooks/useMidenFaucetId').default.mockReturnValue('legacy-B');
      jest
        .requireMock('lib/miden-chain/native-asset')
        .getNativeAssetMetadataSync.mockReturnValue({ symbol: 'USDCX', decimals: 6 });
      if (cached) mockWalletStoreState.assetsMetadata['actual-A'] = { symbol: 'MIDEN', name: 'Miden', decimals: 8 };
      const { result } = renderHook(() => useAssetMetadata('token', 'actual-A'));
      expect(result.current).toMatchObject({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: false });
      expect(mockFetchTokenMetadata).not.toHaveBeenCalled();
    }
  );

  it('preserves cached foreign legacy display metadata without fetching it', () => {
    mockActualNativeId = 'actual-A';
    jest.requireMock('app/hooks/useMidenFaucetId').default.mockReturnValue('legacy-B');
    const legacyMetadata = { symbol: 'LEGACY', name: 'Legacy', decimals: 2 };
    mockWalletStoreState.assetsMetadata['legacy-B'] = legacyMetadata;
    const { result } = renderHook(() => useAssetMetadata('miden', 'legacy-B'));
    expect(result.current).toEqual(legacyMetadata);
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();
  });

  it('syncs initial token metadata into the wallet store', async () => {
    mockUsePassiveStorage.mockReturnValue([{ 'asset-1': baseMetadata }, jest.fn()]);

    render(React.createElement(TokensMetadataProvider, null, React.createElement('span', null, 'metadata child')));

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
      React.createElement(TokensMetadataProvider, null, React.createElement('span', null, 'metadata child'))
    );

    expect(mockOnStorageChanged).toHaveBeenCalledWith(ALL_TOKENS_BASE_METADATA_STORAGE_KEY, expect.any(Function));
    expect(mockSetAssetsMetadata).toHaveBeenCalledWith({ 'asset-2': detailedMetadata });

    unmount();

    expect(cleanup).toHaveBeenCalled();
  });

  it('returns a metadata lookup callback that handles miden and token assets', () => {
    mockWalletStoreState.assetsMetadata = {
      'asset-1': baseMetadata
    };

    const { result } = renderHook(() => useGetTokenMetadata());

    expect(result.current('miden', 'miden-faucet-id')).toEqual(
      expect.objectContaining({ decimals: 6, symbol: 'MIDEN', name: 'Miden', scaleIsUnknown: false })
    );
    expect(result.current('token', 'asset-1')).toEqual(baseMetadata);
  });

  it.each([false, true])(
    'looks up actual native chain metadata with a divergent legacy selector, cached=%s',
    cached => {
      mockActualNativeId = 'actual-A';
      jest.requireMock('app/hooks/useMidenFaucetId').default.mockReturnValue('legacy-B');
      jest
        .requireMock('lib/miden-chain/native-asset')
        .getNativeAssetMetadataSync.mockReturnValue({ symbol: 'USDCX', decimals: 6 });
      if (cached) mockWalletStoreState.assetsMetadata['actual-A'] = { symbol: 'MIDEN', name: 'Miden', decimals: 8 };
      const legacyMetadata = { symbol: 'LEGACY', name: 'Legacy', decimals: 2 };
      mockWalletStoreState.assetsMetadata['legacy-B'] = legacyMetadata;
      const { result } = renderHook(() => useGetTokenMetadata());
      expect(result.current('token', 'actual-A')).toMatchObject({
        symbol: 'USDCX',
        decimals: 6,
        scaleIsUnknown: false
      });
      expect(result.current('miden', 'legacy-B')).toEqual(legacyMetadata);
    }
  );

  it('keeps native chain symbol and scale ahead of stale detailed metadata', () => {
    mockActualNativeId = 'actual-A';
    jest.requireMock('app/hooks/useMidenFaucetId').default.mockReturnValue('legacy-B');
    jest
      .requireMock('lib/miden-chain/native-asset')
      .getNativeAssetMetadataSync.mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    mockWalletStoreState.assetsMetadata['actual-A'] = { symbol: 'MIDEN', name: 'Miden', decimals: 8 };
    mockUseRetryableSWR.mockReturnValue({
      data: { symbol: 'MIDEN', name: 'Miden', decimals: 8, description: 'Native description' },
      mutate: jest.fn()
    });
    const { result } = renderHook(() => useDetailedAssetMetadata('token', 'actual-A'));
    expect(result.current).toMatchObject({
      symbol: 'USDCX',
      decimals: 6,
      description: 'Native description',
      scaleIsUnknown: false
    });
  });

  it('preserves detailed metadata for a foreign legacy display selection', () => {
    mockActualNativeId = 'actual-A';
    jest.requireMock('app/hooks/useMidenFaucetId').default.mockReturnValue('legacy-B');
    mockWalletStoreState.assetsMetadata['legacy-B'] = { symbol: 'LEGACY', name: 'Legacy', decimals: 2 };
    const details = { symbol: 'DETAIL', name: 'Detailed legacy', decimals: 3, description: 'Foreign description' };
    mockUseRetryableSWR.mockReturnValue({ data: details, mutate: jest.fn() });
    const { result } = renderHook(() => useDetailedAssetMetadata('miden', 'legacy-B'));
    expect(result.current).toEqual(details);
  });

  it('returns detailed metadata when available and subscribes to storage changes', () => {
    const mutate = jest.fn();
    mockWalletStoreState.assetsMetadata = {
      'asset-1': baseMetadata
    };
    mockUseRetryableSWR.mockReturnValue({ data: detailedMetadata, mutate });

    const { result } = renderHook(() => useDetailedAssetMetadata('token', 'asset-1'));

    expect(result.current).toEqual(detailedMetadata);
    expect(mockOnStorageChanged).toHaveBeenCalledWith('detailed_asset_metadata_asset-1', mutate);
  });

  it('falls back to base metadata when detailed metadata is missing', () => {
    mockWalletStoreState.assetsMetadata = {
      'asset-1': baseMetadata
    };
    mockUseRetryableSWR.mockReturnValue({ data: null, mutate: jest.fn() });

    const { result } = renderHook(() => useDetailedAssetMetadata('token', 'asset-1'));

    expect(result.current).toEqual(baseMetadata);
  });

  it('returns all base metadata from the wallet store', () => {
    mockWalletStoreState.assetsMetadata = {
      'asset-1': baseMetadata
    };

    const { result } = renderHook(() => useAllTokensBaseMetadata());

    expect(result.current).toEqual({ 'asset-1': baseMetadata });
  });

  it('returns token metadata helpers backed by a ref and persistence', async () => {
    const nextMetadata = { decimals: 9, symbol: 'NEXT', name: 'Next token' };
    mockWalletStoreState.assetsMetadata = {
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

  it.each([false, true])(
    'searches actual native chain metadata under a divergent legacy selector, cached=%s',
    cached => {
      mockActualNativeId = 'actual-A';
      jest.requireMock('app/hooks/useMidenFaucetId').default.mockReturnValue('legacy-B');
      jest
        .requireMock('lib/miden-chain/native-asset')
        .getNativeAssetMetadataSync.mockReturnValue({ symbol: 'USDCX', decimals: 6 });
      const candidates = [
        { slug: 'token', id: 'actual-A' },
        { slug: 'token', id: 'foreign-C' }
      ];
      const metadata = {
        'foreign-C': { symbol: 'USDCX', name: 'USDCX', decimals: 2 },
        ...(cached ? { 'actual-A': { symbol: 'MIDEN', name: 'Miden', decimals: 8 } } : {})
      };
      expect(searchAssets('USDCX', candidates, metadata)[0]).toEqual(candidates[0]);
    }
  );

  it('searches cached foreign legacy display metadata without native substitution', () => {
    mockActualNativeId = 'actual-A';
    const candidates = [{ slug: 'miden', id: 'legacy-B' }];
    expect(
      searchAssets('LEGACY', candidates, { 'legacy-B': { symbol: 'LEGACY', name: 'Legacy', decimals: 2 } })
    ).toEqual(candidates);
  });

  it('handles miden asset via MIDEN_METADATA', () => {
    const midenAssets = [{ slug: 'miden', id: 'miden-id' }];
    const result = searchAssets('Miden', midenAssets, {});
    expect(result).toEqual([{ slug: 'miden', id: 'miden-id' }]);
  });
});

it('labels fresh actual native metadata as USDCX without trusting a provisional scale', () => {
  mockActualNativeId = 'actual-A';
  jest.requireMock('app/hooks/useMidenFaucetId').default.mockReturnValue('legacy-B');
  const chainMetadata = jest.requireMock('lib/miden-chain/native-asset').getNativeAssetMetadataSync;
  chainMetadata.mockReturnValue(null);
  const { result, rerender } = renderHook(() => useAssetMetadata('token', 'actual-A'));
  expect(result.current).toMatchObject({ symbol: 'USDCX', name: 'USDCX', decimals: 6, scaleIsUnknown: true });
  expect(mockFetchTokenMetadata).not.toHaveBeenCalled();
  chainMetadata.mockReturnValue({ symbol: 'USDCX', decimals: 6 });
  rerender();
  expect(result.current).toMatchObject({ symbol: 'USDCX', name: 'USDCX', decimals: 6, scaleIsUnknown: false });
});
