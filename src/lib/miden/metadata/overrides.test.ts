import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

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
const mockRead = jest.mocked(fetchFromStorage);
const mockWrite = jest.mocked(putToStorage);

const FAUCET: AssetMetadata = { name: 'Faucet Token', symbol: 'FCT', decimals: 8, description: 'From the faucet' };

beforeEach(() => {
  mockItems.clear();
  jest.clearAllMocks();
});

describe('applyMetadataOverride', () => {
  it('returns the base unchanged without an override', () => {
    expect(applyMetadataOverride(FAUCET)).toBe(FAUCET);
  });

  it('replaces only the fields the override sets', () => {
    expect(applyMetadataOverride(FAUCET, { symbol: 'MINE' })).toEqual({ ...FAUCET, symbol: 'MINE' });
    expect(applyMetadataOverride(FAUCET, { name: 'My token' })).toEqual({ ...FAUCET, name: 'My token' });
  });

  it('marks the scale as known when the override sets decimals', () => {
    expect(applyMetadataOverride(FAUCET, { decimals: 2 })).toEqual({ ...FAUCET, decimals: 2, scaleIsUnknown: false });
  });

  it('makes the unknown-token placeholder quantifiable only when the override states decimals', () => {
    expect(hasKnownScale(applyMetadataOverride(DEFAULT_TOKEN_METADATA, { name: 'Mine', symbol: 'MN' }))).toBe(false);
    const stated = applyMetadataOverride(DEFAULT_TOKEN_METADATA, { decimals: 6 });
    expect(stated.scaleIsUnknown).toBe(false);
    expect(hasKnownScale(stated)).toBe(true);
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
    const overrides = { [NATIVE_ID]: { decimals: 18 }, mtst1other: { decimals: 2 } };
    expect(overrideFor(overrides, NATIVE_ID)).toBeUndefined();
    expect(applyOverrideFor(NATIVE_ID, FAUCET, overrides)).toBe(FAUCET);
    expect(applyOverrideFor('mtst1other', FAUCET, overrides).decimals).toBe(2);
  });

  it('refuses a write for the native id', async () => {
    await expect(writeTokenMetadataOverride(NATIVE_ID, { decimals: 2 })).rejects.toThrow();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('parseTokenMetadataOverrides', () => {
  it('gives an empty map for a missing or malformed value', () => {
    expect(parseTokenMetadataOverrides(null)).toEqual({});
    expect(parseTokenMetadataOverrides(undefined)).toEqual({});
    expect(parseTokenMetadataOverrides('text')).toEqual({});
  });

  it('keeps the valid fields and drops the rest', () => {
    expect(
      parseTokenMetadataOverrides({
        a: { name: 'Mine', symbol: 'MN', decimals: 4 },
        b: { name: '', symbol: 'WAY-TOO-LONG-SYMBOL', decimals: 1.5 },
        c: { decimals: 19 },
        d: { decimals: 0, extra: true },
        e: 'not an object'
      })
    ).toEqual({ a: { name: 'Mine', symbol: 'MN', decimals: 4 }, d: { decimals: 0 } });
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
    mockItems.set(TOKENS_METADATA_OVERRIDES_STORAGE_KEY, { mtst1a: { decimals: 1 }, mtst1b: { decimals: 2 } });

    expect(await writeTokenMetadataOverride('mtst1a', undefined)).toEqual({ mtst1b: { decimals: 2 } });
    expect(mockItems.get(TOKENS_METADATA_OVERRIDES_STORAGE_KEY)).toEqual({ mtst1b: { decimals: 2 } });
  });

  it('runs concurrent writes one after the other, so no write is lost', async () => {
    // Each read waits a turn, so two writes not in a queue would both read the empty map.
    mockRead.mockImplementation(async (key: string) => {
      await new Promise(resolve => setTimeout(resolve, 0));
      return mockItems.has(key) ? mockItems.get(key) : null;
    });

    await Promise.all([
      writeTokenMetadataOverride('mtst1a', { symbol: 'AAA' }),
      writeTokenMetadataOverride('mtst1b', { symbol: 'BBB' }),
      writeTokenMetadataOverride('mtst1c', { symbol: 'CCC' })
    ]);

    expect(await getTokenMetadataOverrides()).toEqual({
      mtst1a: { symbol: 'AAA' },
      mtst1b: { symbol: 'BBB' },
      mtst1c: { symbol: 'CCC' }
    });
  });

  it('lets a later write run after a failed one', async () => {
    mockWrite.mockRejectedValueOnce(new Error('storage full'));

    await expect(writeTokenMetadataOverride('mtst1a', { symbol: 'AAA' })).rejects.toThrow('storage full');
    await writeTokenMetadataOverride('mtst1b', { symbol: 'BBB' });

    expect(await getTokenMetadataOverrides()).toEqual({ mtst1b: { symbol: 'BBB' } });
  });

  it('never writes into the cached chain metadata key', async () => {
    await writeTokenMetadataOverride('mtst1a', { decimals: 3 });
    expect(mockWrite.mock.calls.every(([key]) => key === TOKENS_METADATA_OVERRIDES_STORAGE_KEY)).toBe(true);
  });
});
