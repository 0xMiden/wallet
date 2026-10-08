import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { TOKEN_IETH } from 'lib/miden/swap/tokens';

import { DEFAULT_TOKEN_METADATA } from './defaults';
import {
  applyMetadataOverride,
  applyOverrideFor,
  canOverrideMetadata,
  getTokenMetadataOverrides,
  overrideFor,
  parseTokenMetadataOverrides,
  TOKENS_METADATA_OVERRIDES_STORAGE_KEY,
  writeTokenMetadataOverride
} from './overrides';
import { hasKnownScale } from './scale';
import type { AssetMetadata } from './types';

const NATIVE_ID = 'mtst1native';
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => 'mtst1native'
}));

// An in-memory store under the two storage calls the module uses.
const mockItems = new Map<string, unknown>();
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(async (key: string) => (mockItems.has(key) ? mockItems.get(key) : null)),
  putToStorage: jest.fn(async (key: string, value: unknown) => {
    mockItems.set(key, value);
  })
}));
// The build's network unless a case names another.
let mockTestNetworkKey: 'testnet' | 'devnet' | undefined;
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const actual = jest.requireActual<typeof import('lib/miden-chain/effective-endpoints')>(
    'lib/miden-chain/effective-endpoints'
  );
  return { ...actual, getTestNetworkNameKey: () => mockTestNetworkKey ?? actual.getTestNetworkNameKey() };
});
const mockRead = jest.mocked(fetchFromStorage);
const mockWrite = jest.mocked(putToStorage);

const FAUCET: AssetMetadata = { name: 'Faucet Token', symbol: 'FCT', decimals: 8, description: 'From the faucet' };

beforeEach(() => {
  mockItems.clear();
  mockTestNetworkKey = undefined;
  jest.clearAllMocks();
});

describe('applyMetadataOverride', () => {
  it('returns the base unchanged without an override', () => {
    expect(applyMetadataOverride(FAUCET)).toBe(FAUCET);
  });

  it('replaces the name and symbol, and keeps the faucet description', () => {
    expect(applyMetadataOverride(FAUCET, { name: 'My token', symbol: 'MINE' })).toStrictEqual({
      ...FAUCET,
      name: 'My token',
      symbol: 'MINE'
    });
  });

  it("keeps a known-scale faucet's decimals and sets no mark when the override carries decimals", () => {
    expect(applyMetadataOverride(FAUCET, { name: 'My token', symbol: 'MINE', decimals: 2 })).toStrictEqual({
      ...FAUCET,
      name: 'My token',
      symbol: 'MINE'
    });
  });

  it('applies the decimals to the unknown-token placeholder, and marks them as the user set them', () => {
    expect(applyMetadataOverride(DEFAULT_TOKEN_METADATA, { name: 'Mine', symbol: 'MN', decimals: 4 })).toStrictEqual({
      ...DEFAULT_TOKEN_METADATA,
      name: 'Mine',
      symbol: 'MN',
      decimals: 4,
      scaleIsUnknown: false,
      scaleFromOverride: true
    });
  });

  it('makes the unknown-token placeholder quantifiable only when the override states decimals', () => {
    expect(hasKnownScale(applyMetadataOverride(DEFAULT_TOKEN_METADATA, { name: 'Mine', symbol: 'MN' }))).toBe(false);
    const stated = applyMetadataOverride(DEFAULT_TOKEN_METADATA, { name: 'Mine', symbol: 'MN', decimals: 6 });
    expect(stated.scaleIsUnknown).toBe(false);
    expect(hasKnownScale(stated)).toBe(true);
  });

  it('gives the same result when applied again to its own result', () => {
    const override = { name: 'Mine', symbol: 'MN', decimals: 4 };
    for (const base of [FAUCET, DEFAULT_TOKEN_METADATA]) {
      const once = applyMetadataOverride(base, override);
      expect(applyMetadataOverride(once, override)).toStrictEqual(once);
    }
  });

  it('does not change the base record', () => {
    const base = { ...FAUCET };
    applyMetadataOverride(base, { name: 'Mine', symbol: 'MN', decimals: 0 });
    expect(base).toEqual(FAUCET);
  });
});

describe('the native token', () => {
  it('can never be overridden', () => {
    expect(canOverrideMetadata(NATIVE_ID)).toBe(false);
    expect(canOverrideMetadata('mtst1other')).toBe(true);
    expect(canOverrideMetadata('')).toBe(false);
  });

  it('ignores a stored override of the native id', () => {
    const overrides = {
      [NATIVE_ID]: { name: 'Fake', symbol: 'FAKE', decimals: 18 },
      mtst1other: { name: 'Other', symbol: 'OTH', decimals: 2 }
    };
    expect(overrideFor(overrides, NATIVE_ID)).toBeUndefined();
    expect(applyOverrideFor(NATIVE_ID, FAUCET, overrides)).toBe(FAUCET);
    expect(applyOverrideFor('mtst1other', FAUCET, overrides).symbol).toBe('OTH');
  });

  it('refuses a write for the native id', async () => {
    await expect(
      writeTokenMetadataOverride(NATIVE_ID, { name: 'Fake', symbol: 'FAKE', decimals: 2 })
    ).rejects.toThrow();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('a token the wallet names itself (#477)', () => {
  const IETH = TOKEN_IETH.faucetId;
  const overrides = { [IETH]: { name: 'Mine', symbol: 'MINE', decimals: 2 } };

  it('cannot be overridden on testnet, where the wallet calls it Test iETH, and can be elsewhere', () => {
    expect(canOverrideMetadata(IETH)).toBe(false);
    mockTestNetworkKey = 'devnet';
    expect(canOverrideMetadata(IETH)).toBe(true);
  });

  it('keeps its own metadata on testnet when an override was stored for it', () => {
    expect(overrideFor(overrides, IETH)).toBeUndefined();
    expect(applyOverrideFor(IETH, FAUCET, overrides)).toBe(FAUCET);
  });

  it('refuses a write on testnet', async () => {
    await expect(writeTokenMetadataOverride(IETH, { name: 'Mine', symbol: 'MINE' })).rejects.toThrow(
      'The metadata of this token cannot be overridden'
    );
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('parseTokenMetadataOverrides', () => {
  it('gives an empty map for a missing or malformed value', () => {
    expect(parseTokenMetadataOverrides(null)).toEqual({});
    expect(parseTokenMetadataOverrides(undefined)).toEqual({});
    expect(parseTokenMetadataOverrides('text')).toEqual({});
  });

  it('keeps a record with a valid name and symbol, and its decimals only when they are valid', () => {
    expect(
      parseTokenMetadataOverrides({
        a: { name: 'Mine', symbol: 'MN', decimals: 4 },
        b: { name: 'Two', symbol: 'TWO', decimals: 1.5 },
        c: { name: 'Three', symbol: 'THR', decimals: 0, extra: true },
        d: { name: 'Four', symbol: 'FOUR' },
        e: 'not an object'
      })
    ).toStrictEqual({
      a: { name: 'Mine', symbol: 'MN', decimals: 4 },
      b: { name: 'Two', symbol: 'TWO' },
      c: { name: 'Three', symbol: 'THR', decimals: 0 },
      d: { name: 'Four', symbol: 'FOUR' }
    });
  });

  it('drops a record without a valid name or symbol', () => {
    expect(
      parseTokenMetadataOverrides({
        nameOnly: { name: 'Mine', decimals: 4 },
        symbolOnly: { symbol: 'MN' },
        badName: { name: '', symbol: 'MN' },
        badSymbol: { name: 'Mine', symbol: 'WAY-TOO-LONG-SYMBOL' },
        decimalsOnly: { decimals: 0 }
      })
    ).toEqual({});
  });
});

describe('persistence', () => {
  it('stores an override under its own key and reads it back', async () => {
    await writeTokenMetadataOverride('mtst1a', { name: 'Mine', symbol: 'MN', decimals: 4 });

    expect(mockWrite).toHaveBeenCalledWith(TOKENS_METADATA_OVERRIDES_STORAGE_KEY, {
      mtst1a: { name: 'Mine', symbol: 'MN', decimals: 4 }
    });
    expect(await getTokenMetadataOverrides()).toEqual({ mtst1a: { name: 'Mine', symbol: 'MN', decimals: 4 } });
  });

  it('removes an override and keeps the others', async () => {
    const b = { name: 'B', symbol: 'BBB', decimals: 2 };
    mockItems.set(TOKENS_METADATA_OVERRIDES_STORAGE_KEY, {
      mtst1a: { name: 'A', symbol: 'AAA', decimals: 1 },
      mtst1b: b
    });

    expect(await writeTokenMetadataOverride('mtst1a', undefined)).toEqual({ mtst1b: b });
    expect(mockItems.get(TOKENS_METADATA_OVERRIDES_STORAGE_KEY)).toEqual({ mtst1b: b });
  });

  it('runs concurrent writes one after the other, so no write is lost', async () => {
    // Each read waits a turn, so two writes not in a queue would both read the empty map.
    mockRead.mockImplementation(async (key: string) => {
      await new Promise(resolve => setTimeout(resolve, 0));
      return mockItems.has(key) ? mockItems.get(key) : null;
    });

    await Promise.all([
      writeTokenMetadataOverride('mtst1a', { name: 'A', symbol: 'AAA' }),
      writeTokenMetadataOverride('mtst1b', { name: 'B', symbol: 'BBB' }),
      writeTokenMetadataOverride('mtst1c', { name: 'C', symbol: 'CCC' })
    ]);

    expect(await getTokenMetadataOverrides()).toEqual({
      mtst1a: { name: 'A', symbol: 'AAA' },
      mtst1b: { name: 'B', symbol: 'BBB' },
      mtst1c: { name: 'C', symbol: 'CCC' }
    });
  });

  it('lets a later write run after a failed one', async () => {
    mockWrite.mockRejectedValueOnce(new Error('storage full'));

    await expect(writeTokenMetadataOverride('mtst1a', { name: 'A', symbol: 'AAA' })).rejects.toThrow('storage full');
    await writeTokenMetadataOverride('mtst1b', { name: 'B', symbol: 'BBB' });

    expect(await getTokenMetadataOverrides()).toEqual({ mtst1b: { name: 'B', symbol: 'BBB' } });
  });

  it('never writes into the cached chain metadata key', async () => {
    await writeTokenMetadataOverride('mtst1a', { name: 'A', symbol: 'AAA', decimals: 3 });
    expect(mockWrite.mock.calls.every(([key]) => key === TOKENS_METADATA_OVERRIDES_STORAGE_KEY)).toBe(true);
  });
});
