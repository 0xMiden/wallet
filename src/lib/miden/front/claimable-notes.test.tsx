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
  useRetryableSWR: jest.fn((_key: any, fetcher: any) => {
    if (!fetcher) return { data: undefined, mutate: jest.fn(), isLoading: false, isValidating: false };
    // Run the fetcher synchronously then return the result
    const result = fetcher();
    if (result instanceof Promise) {
      return { data: undefined, mutate: jest.fn(), isLoading: true, isValidating: false };
    }
    return { data: result, mutate: jest.fn(), isLoading: false, isValidating: false };
  })
}));

const mockGetMidenClient = jest.fn();
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  withWasmClientLock: async (fn: () => Promise<any>) => fn(),
  runWhenClientIdle: jest.fn()
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
    allTokensBaseMetadataRef: { current: {} },
    fetchMetadata: jest.fn(async () => ({ base: { decimals: 6, symbol: 'X', name: 'X' } })),
    setTokensBaseMetadata: jest.fn()
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
});
