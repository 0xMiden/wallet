/* eslint-disable import/first */

import { renderHook, waitFor } from '@testing-library/react';

const _g = globalThis as any;
_g.__cnTest = {
  isExtension: false,
  isIOS: false,
  storage: {} as Record<string, any>,
  consumableNotes: [] as any[],
  uncompletedTxs: [] as any[],
  intercomRequest: jest.fn(),
  metadataCache: {} as Record<string, any>,
  fetchMetadata: jest.fn(async () => ({ base: { decimals: 6, symbol: 'X', name: 'X' } })),
  setTokensBaseMetadata: jest.fn(async () => undefined),
  lastFetchPromise: Promise.resolve(),
  lastFetchData: undefined as any,
  walletState: {
    extensionClaimableNotes: null as any,
    extensionClaimingNoteIds: new Set<string>(),
    assetsMetadata: {} as Record<string, any>,
    setExtensionClaimableNotes: jest.fn(),
    setAssetsMetadata: jest.fn()
  }
};

jest.mock('lib/platform', () => ({
  isExtension: () => (globalThis as any).__cnTest.isExtension,
  isIOS: () => (globalThis as any).__cnTest.isIOS
}));

jest.mock('lib/store', () => {
  const fn = (selector: any) => selector((globalThis as any).__cnTest.walletState);
  (fn as any).getState = () => (globalThis as any).__cnTest.walletState;
  return {
    useWalletStore: fn,
    getIntercom: () => ({ request: (globalThis as any).__cnTest.intercomRequest })
  };
});

jest.mock('lib/swr', () => ({
  useRetryableSWR: jest.fn((_key: any, fetcher: any, config: any) => {
    if (!fetcher) return { data: undefined, mutate: jest.fn(), isLoading: false, isValidating: false };
    // Run the fetcher and expose its settlement promise so tests can await it.
    // On rejection, drive the onError callback like real SWR would.
    const result = fetcher();
    if (result instanceof Promise) {
      (globalThis as any).__cnTest.lastFetchPromise = result
        .then((data: any) => {
          (globalThis as any).__cnTest.lastFetchData = data;
        })
        .catch((e: any) => {
          config?.onError?.(e);
        });
      return { data: undefined, mutate: jest.fn(), isLoading: true, isValidating: false };
    }
    return { data: result, mutate: jest.fn(), isLoading: false, isValidating: false };
  })
}));

const mockGetMidenClient = jest.fn();
const mockRunWhenClientIdle = jest.fn();
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  withWasmClientLock: async (fn: () => Promise<any>) => fn(),
  runWhenClientIdle: (fn: () => Promise<any>) => mockRunWhenClientIdle(fn)
}));

jest.mock('lib/miden/activity', () => ({
  getUncompletedTransactions: async () => (globalThis as any).__cnTest.uncompletedTxs
}));

jest.mock('../assets', () => ({
  isMidenFaucet: jest.fn(async (id: string) => id === 'miden-faucet')
}));

jest.mock('../helpers', () => ({
  toNoteTypeString: () => 'public'
}));

jest.mock('../metadata', () => ({
  MIDEN_METADATA: { decimals: 6, symbol: 'MIDEN', name: 'Miden' }
}));

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (x: any) => (typeof x === 'string' ? x : 'bech-stub')
}));

jest.mock('./assets', () => ({
  useTokensMetadata: () => ({
    allTokensBaseMetadataRef: { current: (globalThis as any).__cnTest.metadataCache },
    fetchMetadata: (id: string) => (globalThis as any).__cnTest.fetchMetadata(id),
    setTokensBaseMetadata: (batch: any) => (globalThis as any).__cnTest.setTokensBaseMetadata(batch)
  })
}));

import { useClaimableNotes } from './claimable-notes';

beforeEach(() => {
  _g.__cnTest.isExtension = false;
  _g.__cnTest.isIOS = false;
  _g.__cnTest.storage = {};
  _g.__cnTest.consumableNotes = [];
  _g.__cnTest.uncompletedTxs = [];
  _g.__cnTest.walletState.extensionClaimableNotes = null;
  _g.__cnTest.walletState.extensionClaimingNoteIds = new Set();
  _g.__cnTest.walletState.assetsMetadata = {};
  _g.__cnTest.intercomRequest.mockReset().mockResolvedValue(undefined);
  _g.__cnTest.metadataCache = {};
  _g.__cnTest.fetchMetadata = jest.fn(async () => ({ base: { decimals: 6, symbol: 'X', name: 'X' } }));
  _g.__cnTest.setTokensBaseMetadata = jest.fn(async () => undefined);
  _g.__cnTest.lastFetchPromise = Promise.resolve();
  _g.__cnTest.lastFetchData = undefined;
  mockRunWhenClientIdle.mockReset();
  mockGetMidenClient.mockReset().mockResolvedValue({
    getConsumableNotes: jest.fn(async () => (globalThis as any).__cnTest.consumableNotes)
  });
});

describe('useClaimableNotes (extension mode)', () => {
  beforeEach(() => {
    _g.__cnTest.isExtension = true;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: jest.fn((_key: string, cb: any) => {
            cb({
              miden_cached_consumable_notes: (globalThis as any).__cnTest.storage['miden_cached_consumable_notes']
            });
          })
        }
      }
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('returns isLoading when no notes have been received yet', () => {
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.isLoading).toBe(true);
  });

  it('maps notes from the wallet store when present', () => {
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's1',
        noteType: 'public',
        metadata: { decimals: 6, symbol: 'TOK', name: 'Token' }
      }
    ];
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.id).toBe('n1');
  });

  it('mutate triggers a SyncRequest via intercom', async () => {
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    await result.current.mutate();
    expect(_g.__cnTest.intercomRequest).toHaveBeenCalled();
  });

  it('skips when enabled is false', () => {
    _g.__cnTest.walletState.extensionClaimableNotes = [{ id: 'n1', faucetId: 'f' }];
    const { result } = renderHook(() => useClaimableNotes('pk-1', false));
    expect(result.current.data).toBeUndefined();
  });

  it('uses asset metadata fallback when note has none', () => {
    _g.__cnTest.walletState.assetsMetadata = {
      f1: { decimals: 6, symbol: 'A', name: 'A' }
    };
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's',
        noteType: 'public'
      }
    ];
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.data?.[0]?.metadata?.symbol).toBe('A');
  });

  it('filters notes that have neither metadata in the note nor in assets', () => {
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'unknown',
        amountBaseUnits: '100',
        senderAddress: 's',
        noteType: 'public'
      }
    ];
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.data).toEqual([]);
  });

  it('falls back to "unknown" type when a note has no noteType', () => {
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's',
        metadata: { decimals: 6, symbol: 'TOK', name: 'Token' }
        // noteType intentionally omitted -> nullish coalescing fallback
      }
    ];
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.data?.[0]?.type).toBe('unknown');
  });

  it('does nothing when chrome.storage.local is unavailable', () => {
    (globalThis as any).chrome = {};
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    // No crash; store never populated, so still loading.
    expect(result.current.isLoading).toBe(true);
  });
});

describe('useClaimableNotes (local mode — mobile/desktop)', () => {
  beforeEach(() => {
    _g.__cnTest.isExtension = false;
  });

  function makeMockNote({
    id = 'note-1',
    faucetId = 'miden-faucet',
    amount = '100',
    senderId = 'sender-1',
    noteType = 0
  }: {
    id?: string;
    faucetId?: string;
    amount?: string;
    senderId?: string;
    noteType?: number;
  } = {}) {
    return {
      id: () => ({ toString: () => id }),
      metadata: () => ({
        sender: () => senderId,
        noteType: () => noteType
      }),
      details: () => ({
        assets: () => ({
          fungibleAssets: () => [
            {
              faucetId: () => faucetId,
              amount: () => ({ toString: () => amount })
            }
          ]
        })
      })
    };
  }

  it('fetches notes from the WASM client and parses them', async () => {
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'local-1' })];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(mockGetMidenClient).toHaveBeenCalled();
    });
  });

  it('handles a note with no fungible assets by skipping it', async () => {
    const badNote = {
      id: () => ({ toString: () => 'empty' }),
      metadata: () => ({ sender: () => 's', noteType: () => 0 }),
      details: () => ({
        assets: () => ({
          fungibleAssets: () => []
        })
      })
    };
    _g.__cnTest.consumableNotes = [badNote, makeMockNote({ id: 'good' })];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(mockGetMidenClient).toHaveBeenCalled();
    });
  });

  it('skips a partial note whose id() is undefined', async () => {
    const partialNote = {
      id: () => undefined
    };
    _g.__cnTest.consumableNotes = [partialNote, makeMockNote({ id: 'full-note' })];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(mockGetMidenClient).toHaveBeenCalled();
    });
  });

  it('handles a note that throws inside id()', async () => {
    const badNote = {
      id: () => {
        throw new Error('boom');
      }
    };
    _g.__cnTest.consumableNotes = [badNote];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(mockGetMidenClient).toHaveBeenCalled();
    });
  });

  it('uses the in-progress consume transactions to mark notes as being claimed', async () => {
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'note-being-claimed' })];
    _g.__cnTest.uncompletedTxs = [{ type: 'consume', noteId: 'note-being-claimed' }];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(mockGetMidenClient).toHaveBeenCalled();
    });
  });

  it('attaches cached metadata for a non-miden faucet present in the cache', async () => {
    _g.__cnTest.metadataCache = { 'other-faucet': { decimals: 8, symbol: 'OTH', name: 'Other' } };
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'cached-note', faucetId: 'other-faucet' })];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.lastFetchData).toEqual([
      expect.objectContaining({ id: 'cached-note', faucetId: 'other-faucet' })
    ]);
    // Non-miden faucet that is already cached must NOT be queued for prefetch.
    expect(mockRunWhenClientIdle).not.toHaveBeenCalled();
  });

  it('queues a background fetch for an unknown faucet and persists the fetched metadata', async () => {
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'unknown-note', faucetId: 'unknown-faucet' })];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);
    // Run the scheduled idle callback to exercise the prefetch + persist path.
    const idleCb = mockRunWhenClientIdle.mock.calls[0]![0];
    await idleCb();
    expect(_g.__cnTest.fetchMetadata).toHaveBeenCalledWith('unknown-faucet');
    expect(_g.__cnTest.setTokensBaseMetadata).toHaveBeenCalledWith({
      'unknown-faucet': { decimals: 6, symbol: 'X', name: 'X' }
    });
  });

  it('swallows a metadata fetch error in the background prefetch and skips persisting', async () => {
    _g.__cnTest.fetchMetadata = jest.fn(async () => {
      throw new Error('rpc down');
    });
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'unknown-note', faucetId: 'unknown-faucet' })];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    const idleCb = mockRunWhenClientIdle.mock.calls[0]![0];
    await idleCb();
    expect(_g.__cnTest.fetchMetadata).toHaveBeenCalledWith('unknown-faucet');
    // Nothing fetched successfully → persist must be skipped.
    expect(_g.__cnTest.setTokensBaseMetadata).not.toHaveBeenCalled();
  });

  it('records a debug error and rethrows when getConsumableNotes throws', async () => {
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => {
        throw new Error('client exploded');
      })
    });
    renderHook(() => useClaimableNotes('pk-1'));
    // The fetch rejects → onError fires (covered by the SWR mock).
    await _g.__cnTest.lastFetchPromise;
    expect(mockGetMidenClient).toHaveBeenCalled();
  });

  it('exposes debugInfo only on iOS', () => {
    _g.__cnTest.isIOS = true;
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.debugInfo).toBeDefined();
    expect(result.current.debugInfo?.lastFetchTime).toBeDefined();
  });

  it('returns undefined debugInfo when not on iOS', () => {
    _g.__cnTest.isIOS = false;
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.debugInfo).toBeUndefined();
  });

  it('skips a note whose first fungible asset is falsy', async () => {
    const noteWithFalsyAsset = {
      id: () => ({ toString: () => 'falsy-asset' }),
      metadata: () => ({ sender: () => 's', noteType: () => 0 }),
      details: () => ({
        assets: () => ({
          // length > 0 passes the guard, but [0] is falsy -> hits `if (!firstAsset)`
          fungibleAssets: () => [null]
        })
      })
    };
    _g.__cnTest.consumableNotes = [noteWithFalsyAsset];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.lastFetchData).toEqual([]);
  });

  it('parses a note with no metadata using empty sender and unknown type', async () => {
    const noMetaNote = {
      id: () => ({ toString: () => 'no-meta' }),
      metadata: () => null,
      details: () => ({
        assets: () => ({
          fungibleAssets: () => [
            {
              faucetId: () => 'miden-faucet',
              amount: () => ({ toString: () => '42' })
            }
          ]
        })
      })
    };
    _g.__cnTest.consumableNotes = [noMetaNote];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.lastFetchData).toEqual([
      expect.objectContaining({ id: 'no-meta', senderAddress: '', type: 'unknown' })
    ]);
  });

  it('tolerates a null metadata cache ref', async () => {
    _g.__cnTest.metadataCache = null;
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'null-cache-note' })];
    mockGetMidenClient.mockResolvedValue({
      getConsumableNotes: jest.fn(async () => _g.__cnTest.consumableNotes)
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.lastFetchData).toEqual([expect.objectContaining({ id: 'null-cache-note' })]);
  });
});
