import { isMidenAsset } from 'lib/miden/assets';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import {
  getNativeAssetMetadata,
  getNativeAssetMetadataSync,
  getSdkSyncedNativeAssetIdSync,
  getVerificationBaseFee,
  resetNativeAssetCache
} from 'lib/miden-chain/native-asset';

import { DEFAULT_TOKEN_METADATA } from './defaults';
import {
  FAUCET_PROOF_WORDS,
  FaucetProofWords,
  rawFieldWords,
  TEST_NAME_BYTES,
  TEST_DESCRIPTION_BYTES,
  MULTILINGUAL_NAME_BYTES
} from './faucet-proof.fixtures';
import { fetchTokenMetadata, NotFoundTokenMetadata } from './fetch';
import { getNativeDisplayMetadataSync } from './native';
import type { ensureTokensMetadataSchema } from './storage';
import { AssetMetadata } from './types';

jest.mock('webextension-polyfill', () => ({
  runtime: {
    getURL: jest.fn((path: string) => `chrome-extension://test-id/${path}`)
  }
}));

jest.mock('lib/miden/assets', () => ({
  isMidenAsset: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true)
}));

// Mock the public SDK RPC boundary while keeping the metadata reader real.
const mockGetAccountDetails = jest.fn();
const mockGetAccountProof = jest.fn();
const mockSyncStorageMaps = jest.fn();
const mockGetBlockHeaderByNumber = jest.fn();
const mockRpcClient = jest.fn(() => ({
  getAccountDetails: mockGetAccountDetails,
  getAccountProof: mockGetAccountProof,
  syncStorageMaps: mockSyncStorageMaps,
  getBlockHeaderByNumber: mockGetBlockHeaderByNumber
}));
const mockFromBech32 = jest.fn();
const mockFromHex = jest.fn((id: string) => {
  if (!id.startsWith('0x')) throw new Error(`Invalid hex account: ${id}`);
  return { toString: () => id.toLowerCase(), isPublic: () => true };
});
const mockFromAccountStorage = jest.fn();

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  RpcClient: function (..._args: unknown[]) {
    return mockRpcClient();
  },
  Address: {
    fromBech32: (id: string) => {
      if (id.includes('_') || /^0x/i.test(id)) throw new Error(`Invalid bech32 account: ${id}`);
      return mockFromBech32(id);
    }
  },
  AccountId: { fromHex: (id: string) => mockFromHex(id) },
  BasicFungibleFaucetComponent: {
    fromAccountStorage: (storage: unknown) => mockFromAccountStorage(storage)
  }
}));

jest.mock('lib/miden-chain/constants', () => ({
  getRpcEndpoint: jest.fn(() => 'mock-endpoint'),
  ensureSdkWasmReady: jest.fn(() => Promise.resolve())
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => 'rpc-bootstrap',
  getEffectiveNetworkName: () => 'devnet',
  getEffectiveFeeFaucetId: () => undefined
}));

jest.mock('lib/miden/front', () => ({}));

jest.mock('lib/miden/metadata', () => jest.requireActual('./fetch'));

const mockFetchFromStorage = jest.fn();
const mockPutToStorage = jest.fn();
jest.mock('lib/miden/front/storage', () => ({
  onStorageChanged: () => Object.assign(() => {}, { attached: Promise.resolve() }),
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args),
  putToStorage: (...args: unknown[]) => mockPutToStorage(...args)
}));

// The shape check has its own tests in storage.test.ts. Here it only must run before the cache read.
const mockEnsureTokensMetadataSchema = jest.fn();
jest.mock('./storage', () => ({
  ...jest.requireActual('./storage'),
  ensureTokensMetadataSchema: (...args: Parameters<typeof ensureTokensMetadataSchema>) =>
    mockEnsureTokensMetadataSchema(...args)
}));

const mockIsMidenAsset = isMidenAsset as unknown as jest.Mock;

function parsedId(id: string, isPublic = true) {
  return { toString: () => id, isPublic: () => isPublic };
}

function faucetProof(words: FaucetProofWords = FAUCET_PROOF_WORDS, hasHeader = true) {
  return {
    accountHeader: () => (hasHeader ? { id: () => parsedId('test-account') } : undefined),
    getStorageSlotValue: (name: string) => {
      const word = words[name];
      return word && { toU64s: () => BigUint64Array.from(word) };
    }
  };
}

function metadataProof(symbol = 8765514n, decimals = 8n, name = [0], description = [0]) {
  return faucetProof({
    ...FAUCET_PROOF_WORDS,
    'miden::standards::faucets::fungible::token_config': [1000n, 1000000n, decimals, symbol],
    ...rawFieldWords('token_name', name),
    ...rawFieldWords('token_description', description)
  });
}

function expectNoFullAccountRequests() {
  expect(mockGetAccountDetails).not.toHaveBeenCalled();
  expect(mockFromAccountStorage).not.toHaveBeenCalled();
  expect(mockSyncStorageMaps).not.toHaveBeenCalled();
}

describe('metadata/fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccountDetails.mockReset();
    mockGetAccountProof.mockReset();
    mockSyncStorageMaps.mockReset();
    mockFromBech32.mockReset();
    mockFromAccountStorage.mockReset();
    jest.mocked(ensureSdkWasmReady).mockReset().mockResolvedValue(undefined);
    mockFetchFromStorage.mockResolvedValue(null);
    mockPutToStorage.mockResolvedValue(undefined);
    mockEnsureTokensMetadataSchema.mockReset().mockResolvedValue(undefined);
  });

  afterEach(expectNoFullAccountRequests);

  describe('fetchTokenMetadata', () => {
    it('reads proof metadata when an unrelated nonce map prevents full account loading', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        mockIsMidenAsset.mockReturnValue(false);
        const parsedAccountId = { toString: () => 'mtst1proof', isPublic: () => true };
        mockFromBech32.mockReturnValue({ accountId: () => parsedAccountId });
        mockGetAccountDetails.mockRejectedValue(
          new Error('Full account reconstruction failed: unrelated nonce map has too many entries to return inline')
        );
        const slots = new Map(
          Object.entries(FAUCET_PROOF_WORDS).map(([name, limbs]) => [
            name,
            { toU64s: () => BigUint64Array.from(limbs) }
          ])
        );
        const getStorageMapEntries = jest.fn();
        const getStorageMapSlotNames = jest.fn();
        const vaultFungibleAssets = jest.fn();
        mockGetAccountProof.mockResolvedValue({
          accountId: () => parsedAccountId,
          accountHeader: () => ({ id: () => parsedAccountId }),
          getStorageSlotValue: (name: string) => slots.get(name),
          numStorageSlots: () => slots.size,
          getStorageMapEntries,
          getStorageMapSlotNames,
          vaultFungibleAssets
        });

        await expect(fetchTokenMetadata('mtst1proof_qruqqypuyph')).resolves.toStrictEqual({
          symbol: 'TEST',
          name: 'Proof Token',
          decimals: 8,
          description: 'Metadata without nonce map',
          scaleIsUnknown: false
        });
        expect(mockGetAccountProof.mock.calls).toEqual([[parsedAccountId]]);
        expect(mockFromBech32).toHaveBeenCalledWith('mtst1proof');
        expect(mockGetAccountDetails).not.toHaveBeenCalled();
        expect(mockFromAccountStorage).not.toHaveBeenCalled();
        expect(mockSyncStorageMaps).not.toHaveBeenCalled();
        expect(getStorageMapEntries).not.toHaveBeenCalled();
        expect(getStorageMapSlotNames).not.toHaveBeenCalled();
        expect(vaultFungibleAssets).not.toHaveBeenCalled();
        expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
          mtst1proof_qruqqypuyph: {
            symbol: 'TEST',
            name: 'Proof Token',
            decimals: 8,
            description: 'Metadata without nonce map',
            scaleIsUnknown: false
          }
        });
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it.each([
      { assetId: '0xfaucet', parsed: '0xfaucet', bech32Calls: [], hexCalls: [['0xfaucet']] },
      {
        assetId: 'mtst1faucet_qruqqypuyph',
        parsed: 'mtst1faucet',
        bech32Calls: [['mtst1faucet']],
        hexCalls: []
      }
    ])(
      'reads chain metadata for $assetId with the parsed account id',
      async ({ assetId, parsed, bech32Calls, hexCalls }) => {
        mockIsMidenAsset.mockReturnValue(false);
        mockFromBech32.mockImplementation((id: string) => ({ accountId: () => parsedId(id) }));
        mockGetAccountProof.mockResolvedValue(metadataProof());

        await expect(fetchTokenMetadata(assetId)).resolves.toMatchObject({ symbol: 'TEST', decimals: 8 });
        expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
        expect(mockGetAccountProof.mock.calls[0][0].toString()).toBe(parsed);
        expect(mockFromHex.mock.calls).toEqual(hexCalls);
        expect(mockFromBech32.mock.calls).toEqual(bech32Calls);
      }
    );

    it('returns provisional USDCX for the native asset alias', async () => {
      mockIsMidenAsset.mockReturnValue(true);

      const result = await fetchTokenMetadata('miden');

      expect(result).toEqual(expect.objectContaining({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: true }));
      // Should not call any RPC methods for miden asset
      expect(mockGetAccountProof).not.toHaveBeenCalled();
    });

    it('returns cached metadata when available in storage', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      const cachedMeta = { decimals: 6, symbol: 'CACHED', name: 'Cached' };
      mockFetchFromStorage.mockResolvedValueOnce({ 'cached-asset': cachedMeta });

      const result = await fetchTokenMetadata('cached-asset');

      expect(result).toEqual(cachedMeta);
      expect(mockGetAccountProof).not.toHaveBeenCalled();
    });

    it('runs the cache shape check before it reads the cache', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      const order: string[] = [];
      mockEnsureTokensMetadataSchema.mockImplementation(async () => {
        order.push('check');
      });
      mockFetchFromStorage.mockImplementation(async () => {
        order.push('read');
        return { 'cached-asset': { decimals: 6, symbol: 'CACHED', name: 'Cached' } };
      });

      await fetchTokenMetadata('cached-asset');

      expect(mockEnsureTokensMetadataSchema).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
      expect(order).toEqual(['check', 'read']);
    });

    it('fetches metadata via RpcClient for non-miden assets', async () => {
      mockIsMidenAsset.mockReturnValue(false);

      const mockAccountId = parsedId('account-id-123');
      mockFromBech32.mockReturnValue({ accountId: () => mockAccountId });

      mockGetAccountProof.mockResolvedValue(metadataProof(8765514n, 8n, TEST_NAME_BYTES, TEST_DESCRIPTION_BYTES));

      const result = await fetchTokenMetadata('test-asset-id');

      expect(mockFromBech32).toHaveBeenCalledWith('test-asset-id');
      expect(mockGetAccountProof).toHaveBeenCalledWith(mockAccountId);
      expect(mockGetAccountDetails).not.toHaveBeenCalled();
      expect(result).toEqual({
        decimals: 8,
        symbol: 'TEST',
        name: 'Test Token',
        description: 'A token for tests',
        // The faucet answered, so the scale is a fact - and saying so is what
        // stops the placeholder shape test from mistaking a token that happens
        // to look like the placeholder for one.
        scaleIsUnknown: false
      });
    });

    it('uses the symbol as the name when the faucet name is empty', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => parsedId('account-id-123') });
      mockGetAccountProof.mockResolvedValue(metadataProof());

      const result = await fetchTokenMetadata('test-asset-id');

      expect(result.name).toBe('TEST');
    });

    it.each([
      ['absent', undefined],
      ['empty', '']
    ])('leaves the description out when the faucet description is %s', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => parsedId('account-id-123') });
      mockGetAccountProof.mockResolvedValue(metadataProof(8765514n, 8n, TEST_NAME_BYTES, [0]));

      const result = await fetchTokenMetadata('test-asset-id');

      expect(result).toStrictEqual({ decimals: 8, symbol: 'TEST', name: 'Test Token', scaleIsUnknown: false });
      expect('description' in result).toBe(false);
    });

    it('persists RPC metadata so later fetches use the existing storage cache', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      const storedMetadata: Record<string, AssetMetadata> = {};
      mockFetchFromStorage.mockImplementation(async () => storedMetadata);
      mockPutToStorage.mockImplementation(async (_key: string, value: Record<string, AssetMetadata>) => {
        Object.assign(storedMetadata, value);
      });
      mockFromBech32.mockReturnValue({ accountId: () => parsedId('account-id-123') });
      mockGetAccountProof.mockResolvedValue(metadataProof());

      const first = await fetchTokenMetadata('test-asset-id');
      const second = await fetchTokenMetadata('test-asset-id');

      expect(second).toEqual(first);
      expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'test-asset-id': first
      });
    });

    it('serializes concurrent metadata writes so neither asset is lost', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      let storedMetadata: Record<string, AssetMetadata> = {};
      mockFetchFromStorage.mockImplementation(async () => storedMetadata);
      mockPutToStorage.mockImplementation(async (_key: string, value: Record<string, AssetMetadata>) => {
        storedMetadata = value;
      });
      mockFromBech32.mockImplementation((assetId: string) => ({ accountId: () => parsedId(assetId) }));
      mockGetAccountProof.mockImplementation(async (accountId: ReturnType<typeof parsedId>) =>
        metadataProof(accountId.toString() === 'asset-a' ? 1n : 27n)
      );

      const [assetA, assetB] = await Promise.all([fetchTokenMetadata('asset-a'), fetchTokenMetadata('asset-b')]);

      expect(mockPutToStorage).toHaveBeenCalledTimes(2);
      expect(storedMetadata).toEqual({
        'asset-a': assetA,
        'asset-b': assetB
      });
    });

    it('returns fetched metadata when persisting it fails', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => parsedId('account-id-123') });
      mockGetAccountProof.mockResolvedValue(metadataProof());
      mockPutToStorage.mockRejectedValue(new Error('storage unavailable'));

      await expect(fetchTokenMetadata('test-asset-id')).resolves.toMatchObject({
        decimals: 8,
        symbol: 'TEST',
        name: 'TEST'
      });
    });

    it('returns DEFAULT_TOKEN_METADATA when standard slots are absent (pre-0.15 faucet)', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => parsedId('acc-id') });
      mockGetAccountProof.mockResolvedValue(faucetProof({}));

      const result = await fetchTokenMetadata('old-faucet-asset-id');

      expect(result).toEqual(DEFAULT_TOKEN_METADATA);
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'old-faucet-asset-id': DEFAULT_TOKEN_METADATA
      });
      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });

    it('returns DEFAULT_TOKEN_METADATA when RPC returns no underlying account (private)', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => parsedId('acc-id', false) });
      mockGetAccountProof.mockResolvedValue(faucetProof(FAUCET_PROOF_WORDS, false));

      const result = await fetchTokenMetadata('private-asset-id');

      expect(result).toEqual(DEFAULT_TOKEN_METADATA);
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'private-asset-id': DEFAULT_TOKEN_METADATA
      });
      mockFetchFromStorage.mockResolvedValue({ 'private-asset-id': DEFAULT_TOKEN_METADATA });
      await expect(fetchTokenMetadata('private-asset-id')).resolves.toEqual(DEFAULT_TOKEN_METADATA);
      expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
    });

    it('does not cache a transient missing public account and retries on the next fetch', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      const storedMetadata: Record<string, AssetMetadata> = {};
      mockFetchFromStorage.mockImplementation(async () => storedMetadata);
      mockPutToStorage.mockImplementation(async (_key: string, value: Record<string, AssetMetadata>) => {
        Object.assign(storedMetadata, value);
      });
      mockFromBech32.mockReturnValue({ accountId: () => parsedId('acc-id') });
      mockGetAccountProof
        .mockResolvedValueOnce(faucetProof(FAUCET_PROOF_WORDS, false))
        .mockResolvedValueOnce(metadataProof());

      const first = await fetchTokenMetadata('public-missing-asset-id');
      const second = await fetchTokenMetadata('public-missing-asset-id');

      expect(first).toEqual(DEFAULT_TOKEN_METADATA);
      expect(second).toMatchObject({ decimals: 8, symbol: 'TEST', name: 'TEST' });
      expect(mockGetAccountProof).toHaveBeenCalledTimes(2);
      expect(mockPutToStorage).toHaveBeenCalledTimes(1);
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'public-missing-asset-id': second
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to fetch metadata from chain for',
        'public-missing-asset-id',
        'Using default metadata'
      );
      consoleWarnSpy.mockRestore();
    });

    it('throws NotFoundTokenMetadata when RPC call fails', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => parsedId('acc-id') });
      mockGetAccountProof.mockRejectedValue(new Error('RPC error'));

      await expect(fetchTokenMetadata('rpc-fail-asset-id')).rejects.toThrow(NotFoundTokenMetadata);
      consoleErrorSpy.mockRestore();
    });

    it('throws NotFoundTokenMetadata on unexpected error', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      // Simulate an error that bypasses the inner try/catch (e.g. Address.fromBech32 throws)
      mockFromBech32.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      await expect(fetchTokenMetadata('bad-asset-id')).rejects.toThrow(NotFoundTokenMetadata);
      consoleErrorSpy.mockRestore();
    });
  });

  describe('standard proof acceptance boundaries', () => {
    const config = 'miden::standards::faucets::fungible::token_config';
    const expected = {
      symbol: 'TEST',
      name: 'Proof Token',
      decimals: 8,
      description: 'Metadata without nonce map',
      scaleIsUnknown: false
    };

    beforeEach(() => {
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockImplementation((id: string) => ({ accountId: () => parsedId(id) }));
    });

    it.each<{ label: string; changes: FaucetProofWords; metadata: Partial<AssetMetadata> }>([
      { label: 'decimals 12', changes: { [config]: [1000n, 1000000n, 12n, 8765514n] }, metadata: { decimals: 12 } },
      { label: 'zero supply and max', changes: { [config]: [0n, 0n, 8n, 8765514n] }, metadata: {} },
      {
        label: 'inclusive amount maximum',
        changes: { [config]: [9223372034707292160n, 9223372034707292160n, 8n, 8765514n] },
        metadata: {}
      },
      { label: 'minimum symbol A', changes: { [config]: [0n, 0n, 8n, 1n] }, metadata: { symbol: 'A' } },
      { label: 'leading A symbol AB', changes: { [config]: [0n, 0n, 8n, 28n] }, metadata: { symbol: 'AB' } },
      {
        label: '12 leading A characters',
        changes: { [config]: [0n, 0n, 8n, 12n] },
        metadata: { symbol: 'AAAAAAAAAAAA' }
      },
      {
        label: 'maximum 12-character symbol',
        changes: { [config]: [0n, 0n, 8n, 2481152873203736562n] },
        metadata: { symbol: 'ZZZZZZZZZZZZ' }
      },
      {
        label: '32-byte multilingual name',
        changes: rawFieldWords('token_name', MULTILINGUAL_NAME_BYTES),
        metadata: { name: '猫猫猫猫猫猫猫猫猫猫é' }
      },
      {
        label: '195-byte description',
        changes: rawFieldWords('token_description', [195, ...Array(195).fill(0x78)]),
        metadata: { description: 'x'.repeat(195) }
      },
      {
        label: 'BOM name',
        changes: rawFieldWords('token_name', [4, 0xef, 0xbb, 0xbf, 0x78]),
        metadata: { name: '\ufeffx' }
      },
      {
        label: 'embedded zero name',
        changes: rawFieldWords('token_name', [3, 0x41, 0, 0x42]),
        metadata: { name: 'A\0B' }
      },
      {
        label: 'nonzero unused bytes in used felt',
        changes: { 'miden::standards::faucets::token_name_0': [0x00ffffffffff4101n, 0n, 0n, 0n] },
        metadata: { name: 'A' }
      },
      {
        label: 'nonzero unused tail felt',
        changes: { 'miden::standards::faucets::token_name_1': [0n, 0n, 0n, 0x00ffffffffffffffn] },
        metadata: {}
      },
      {
        label: 'all boolean flags true',
        changes: { 'miden::standards::faucets::mutability_config': [1n, 1n, 1n, 1n] },
        metadata: {}
      },
      {
        label: 'non-URL unused fields at capacity',
        changes: {
          ...rawFieldWords('logo_uri', [195, ...Array(195).fill(0x78)]),
          ...rawFieldWords('external_link', [195, ...Array(195).fill(0x79)])
        },
        metadata: {}
      }
    ])('accepts $label', async ({ changes, metadata }) => {
      mockGetAccountProof.mockResolvedValue(faucetProof({ ...FAUCET_PROOF_WORDS, ...changes }));

      await expect(fetchTokenMetadata('boundary-asset')).resolves.toStrictEqual({ ...expected, ...metadata });
      expect(mockGetAccountProof.mock.calls).toEqual([[expect.objectContaining({ isPublic: expect.any(Function) })]]);
      expect(mockGetAccountDetails).not.toHaveBeenCalled();
      expect(mockFromAccountStorage).not.toHaveBeenCalled();
    });

    it('accepts custom component storage without an isFaucet marker', async () => {
      const accountId = { toString: () => 'custom-account', isPublic: () => true };
      mockFromBech32.mockReturnValue({ accountId: () => accountId });
      const proof = faucetProof();
      expect('isFaucet' in accountId).toBe(false);
      expect('isFaucet' in proof.accountHeader()!).toBe(false);
      mockGetAccountProof.mockResolvedValue(proof);

      await expect(fetchTokenMetadata('custom-component')).resolves.toStrictEqual(expected);
    });
  });

  describe('invalid standard proof caching', () => {
    const config = 'miden::standards::faucets::fungible::token_config';
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockImplementation((id: string) => ({ accountId: () => parsedId(id) }));
    });

    afterEach(() => warn.mockRestore());

    async function expectCachedUnknown(words: FaucetProofWords) {
      mockGetAccountProof.mockResolvedValue(faucetProof(words));
      await expect(fetchTokenMetadata('invalid-asset')).resolves.toEqual(DEFAULT_TOKEN_METADATA);
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'invalid-asset': DEFAULT_TOKEN_METADATA
      });
      mockFetchFromStorage.mockResolvedValue({ 'invalid-asset': DEFAULT_TOKEN_METADATA });
      await expect(fetchTokenMetadata('invalid-asset')).resolves.toEqual(DEFAULT_TOKEN_METADATA);
      expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
      expect(mockGetAccountDetails).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    }

    it.each(Object.keys(FAUCET_PROOF_WORDS))('requires slot %s', async slot => {
      expect.hasAssertions();
      const words = { ...FAUCET_PROOF_WORDS };
      delete words[slot];
      await expectCachedUnknown(words);
    });

    it.each<{ label: string; word: readonly [bigint, bigint, bigint, bigint] }>([
      { label: 'decimals 13', word: [0n, 0n, 13n, 8765514n] },
      { label: 'decimals above u8', word: [0n, 0n, 256n, 8765514n] },
      { label: 'supply above amount maximum', word: [9223372034707292161n, 9223372034707292160n, 8n, 8765514n] },
      { label: 'max supply above amount maximum', word: [0n, 9223372034707292161n, 8n, 8765514n] },
      { label: 'supply greater than max', word: [1n, 0n, 8n, 8765514n] },
      { label: 'zero symbol', word: [0n, 0n, 8n, 0n] },
      { label: 'symbol above maximum', word: [0n, 0n, 8n, 2481152873203736563n] },
      { label: 'symbol length zero', word: [0n, 0n, 8n, 26n] },
      { label: 'symbol length 13', word: [0n, 0n, 8n, 13n] },
      { label: 'symbol nonzero remainder', word: [0n, 0n, 8n, 677n] }
    ])('caches unknown for $label', async ({ word }) => {
      expect.hasAssertions();
      await expectCachedUnknown({ ...FAUCET_PROOF_WORDS, [config]: word });
    });

    it.each(['token_name', 'token_description', 'logo_uri', 'external_link'])(
      'rejects malformed UTF8 in %s',
      async field => {
        expect.hasAssertions();
        await expectCachedUnknown({ ...FAUCET_PROOF_WORDS, ...rawFieldWords(field, [2, 0xc3, 0x28]) });
      }
    );

    it.each(['token_name', 'token_description', 'logo_uri', 'external_link'])(
      'rejects oversized byte length in %s',
      async field => {
        expect.hasAssertions();
        const bytes = field === 'token_name' ? [33, ...Array(11).fill([0xe7, 0x8c, 0xab]).flat()] : [196];
        await expectCachedUnknown({ ...FAUCET_PROOF_WORDS, ...rawFieldWords(field, bytes) });
      }
    );

    it.each(
      ['token_name', 'token_description', 'logo_uri', 'external_link'].flatMap(field =>
        [false, true].map(unused => ({ field, unused }))
      )
    )('rejects high byte in $field unused=$unused', async ({ field, unused }) => {
      expect.hasAssertions();
      const index = unused ? (field === 'token_name' ? 1 : 6) : 0;
      const slot = `miden::standards::faucets::${field}_${index}`;
      const word: [bigint, bigint, bigint, bigint] = [...FAUCET_PROOF_WORDS[slot]!];
      word[unused ? 3 : 0] |= 1n << 56n;
      await expectCachedUnknown({ ...FAUCET_PROOF_WORDS, [slot]: word });
    });

    it.each([0, 1, 2, 3])('rejects nonboolean mutability flag %s', async index => {
      expect.hasAssertions();
      const word: [bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n];
      word[index] = 2n;
      await expectCachedUnknown({ ...FAUCET_PROOF_WORDS, 'miden::standards::faucets::mutability_config': word });
    });
  });

  describe('uncached chain failures', () => {
    let error: jest.SpyInstance;
    beforeEach(() => {
      error = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockImplementation((id: string) => ({ accountId: () => parsedId(id) }));
      mockGetAccountProof.mockResolvedValue(faucetProof());
    });
    afterEach(() => error.mockRestore());

    it('does not construct RPC before SDK readiness and does not cache readiness rejection', async () => {
      jest.mocked(ensureSdkWasmReady).mockImplementation(async () => {
        expect(mockRpcClient).not.toHaveBeenCalled();
        expect(mockFromBech32).not.toHaveBeenCalled();
        throw new Error('WASM unavailable');
      });
      await expect(fetchTokenMetadata('not-ready')).rejects.toThrow(NotFoundTokenMetadata);
      expect(mockRpcClient).not.toHaveBeenCalled();
      expect(mockGetAccountProof).not.toHaveBeenCalled();
      expect(mockPutToStorage).not.toHaveBeenCalled();
    });

    it('waits for SDK readiness before parsing and requesting a proof', async () => {
      let release!: () => void;
      jest.mocked(ensureSdkWasmReady).mockReturnValue(
        new Promise<void>(resolve => {
          release = resolve;
        })
      );
      const pending = fetchTokenMetadata('wait-for-wasm');
      await Promise.resolve();
      expect(mockGetAccountProof).not.toHaveBeenCalled();
      expect(mockFromBech32).not.toHaveBeenCalled();
      release();
      await expect(pending).resolves.toMatchObject({ symbol: 'TEST', decimals: 8, scaleIsUnknown: false });
      expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
    });

    it('does not cache RPC rejection and retries the next fetch', async () => {
      mockGetAccountProof.mockRejectedValueOnce(new Error('RPC unavailable'));
      await expect(fetchTokenMetadata('retry-rpc')).rejects.toThrow(NotFoundTokenMetadata);
      expect(mockPutToStorage).not.toHaveBeenCalled();
      await expect(fetchTokenMetadata('retry-rpc')).resolves.toMatchObject({ symbol: 'TEST', decimals: 8 });
      expect(mockGetAccountProof).toHaveBeenCalledTimes(2);
    });

    it('does not request or cache a proof after invalid address parsing', async () => {
      mockFromBech32.mockImplementation(() => {
        throw new Error('Invalid address');
      });
      await expect(fetchTokenMetadata('invalid-address')).rejects.toThrow(NotFoundTokenMetadata);
      expect(mockGetAccountProof).not.toHaveBeenCalled();
      expect(mockPutToStorage).not.toHaveBeenCalled();
    });
  });

  describe('native bootstrap through actual metadata fetching', () => {
    const nativeId = 'native-A';
    const foreignId = 'foreign-B';
    const proofKey = 'native_asset_synced_id:v1:rpc-bootstrap|devnet';
    const nativeMetadataKey = 'native_asset_meta:v5:rpc-bootstrap|devnet';
    const foreignMetadata = { symbol: 'BRAND', name: 'Legacy branding', decimals: 4, scaleIsUnknown: false };
    let storage: Record<string, any>;

    beforeEach(async () => {
      storage = {};
      mockFetchFromStorage.mockImplementation(async (key: string) => storage[key] ?? null);
      mockPutToStorage.mockImplementation(async (key: string, value: unknown) => {
        storage[key] = value;
      });
      await resetNativeAssetCache();
      storage[proofKey] = nativeId;
      storage.tokens_base_metadata = { [foreignId]: foreignMetadata };
      mockIsMidenAsset.mockImplementation(jest.requireActual('lib/miden/assets/utils').isMidenAsset);
      mockFromBech32.mockImplementation((id: string) => ({ accountId: () => parsedId(id) }));
      mockGetAccountProof.mockResolvedValue(metadataProof(245907771n, 6n));
      mockGetBlockHeaderByNumber.mockReset().mockResolvedValue({ verificationBaseFee: () => 7 });
    });

    afterEach(async () => {
      await resetNativeAssetCache();
    });

    it('preserves genuine chain MIDEN for the native alias', async () => {
      mockGetAccountProof.mockResolvedValue(metadataProof(146288095n, 6n));
      await expect(getNativeAssetMetadata()).resolves.toEqual({ symbol: 'MIDEN', decimals: 6 });
      await expect(fetchTokenMetadata('miden')).resolves.toEqual(
        expect.objectContaining({ symbol: 'MIDEN', name: 'Miden', decimals: 6, scaleIsUnknown: false })
      );
    });

    it.each([false, true])(
      'reads native chain scale and preserves foreign cache, stale native cache=%s',
      async stale => {
        if (stale)
          storage.tokens_base_metadata[nativeId] = {
            symbol: 'USDCX',
            name: 'USDCX',
            decimals: 8,
            scaleIsUnknown: false
          };
        expect(isMidenAsset(nativeId)).toBe(false);
        await expect(fetchTokenMetadata(foreignId)).resolves.toEqual(foreignMetadata);
        const expectedCachedNative = stale
          ? { symbol: 'USDCX', name: 'USDCX', decimals: 8, scaleIsUnknown: false }
          : undefined;
        const cachedNative = stale ? await fetchTokenMetadata(nativeId) : undefined;
        expect(cachedNative).toEqual(expectedCachedNative);
        expect(mockGetAccountProof).not.toHaveBeenCalled();

        await expect(getNativeAssetMetadata()).resolves.toEqual({ symbol: 'USDCX', decimals: 6 });
        expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'USDCX', decimals: 6 });
        await expect(fetchTokenMetadata('miden')).resolves.toEqual(
          expect.objectContaining({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: false })
        );
        expect(getSdkSyncedNativeAssetIdSync()).toBe(nativeId);
        expect(storage[nativeMetadataKey]).toEqual({ faucetId: nativeId, symbol: 'USDCX', decimals: 6 });
        expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
        expect(mockGetAccountProof.mock.calls[0][0].toString()).toBe(nativeId);
        expect(mockGetAccountDetails).not.toHaveBeenCalled();
        expect(getNativeDisplayMetadataSync(undefined, nativeId)).toMatchObject({
          symbol: 'USDCX',
          decimals: 6,
          scaleIsUnknown: false
        });
        expect(getNativeDisplayMetadataSync(foreignMetadata, foreignId)).toEqual(foreignMetadata);
        expect(storage.tokens_base_metadata[foreignId]).toEqual(foreignMetadata);
        await expect(fetchTokenMetadata(foreignId)).resolves.toEqual(foreignMetadata);
        expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
        await expect(getVerificationBaseFee()).resolves.toBe(7);
        expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(1);
      }
    );

    it.each(['RPC rejection', 'unknown chain scale'])(
      'does not promote stale generic native metadata after %s',
      async failure => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
          storage.tokens_base_metadata[nativeId] = {
            symbol: 'USDCX',
            name: 'USDCX',
            decimals: 8,
            scaleIsUnknown: false
          };
          if (failure === 'RPC rejection') mockGetAccountProof.mockRejectedValue(new Error('RPC unavailable'));
          else mockGetAccountProof.mockResolvedValue(faucetProof({}));
          await expect(getNativeAssetMetadata()).resolves.toBeNull();
          expect(getNativeAssetMetadataSync()).toBeNull();
          expect(storage[nativeMetadataKey]).toBeNull();
          expect(getSdkSyncedNativeAssetIdSync()).toBe(nativeId);
          expect(mockGetAccountProof.mock.calls[0][0].toString()).toBe(nativeId);
          expect(mockGetAccountDetails).not.toHaveBeenCalled();
          expect(storage.tokens_base_metadata[foreignId]).toEqual(foreignMetadata);
        } finally {
          warn.mockRestore();
          error.mockRestore();
        }
      }
    );
  });

  describe('NotFoundTokenMetadata', () => {
    it('has correct name and message', () => {
      const error = new NotFoundTokenMetadata();

      expect(error.name).toBe('NotFoundTokenMetadata');
      expect(error.message).toBe('Metadata for token not found');
      expect(error).toBeInstanceOf(Error);
    });
  });
});
