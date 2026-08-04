import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { patchWatermark, readWatermark, readWatermarks, watermarkKey } from './watermarks';

jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn()
}));

const fetchMock = jest.mocked(fetchFromStorage);
const putMock = jest.mocked(putToStorage);

const ADDRESS_A = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa';
const ADDRESS_B = '0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb';

describe('watermarks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockResolvedValue(null);
    putMock.mockResolvedValue(undefined);
  });

  it('keys records by lowercased address + token', () => {
    expect(watermarkKey(ADDRESS_A, 'ETH')).toBe(`${ADDRESS_A.toLowerCase()}:ETH`);
    expect(watermarkKey(`  ${ADDRESS_A}  `, 'USDC')).toBe(`${ADDRESS_A.toLowerCase()}:USDC`);
  });

  it('returns an empty store when nothing is persisted', async () => {
    await expect(readWatermarks()).resolves.toEqual({});
  });

  it('drops garbage entries and repairs partial ones', async () => {
    const key = watermarkKey(ADDRESS_A, 'ETH');
    fetchMock.mockResolvedValue({
      [key]: { acknowledged: '10' },
      [`${ADDRESS_A.toLowerCase()}:DOGE`]: { acknowledged: '1', drawerShown: '1', updatedAt: 1 },
      [`${ADDRESS_A.toLowerCase()}:USDC`]: { acknowledged: 12, drawerShown: '1', updatedAt: 1 },
      'no-token-suffix': { acknowledged: '1', drawerShown: '1', updatedAt: 1 },
      [`${ADDRESS_B.toLowerCase()}:ETH`]: null
    });

    const store = await readWatermarks();

    // Only the repairable record survives: drawerShown defaults to acknowledged,
    // updatedAt to 0. Unknown tokens, non-string amounts, and malformed keys go.
    expect(store).toEqual({ [key]: { acknowledged: '10', drawerShown: '10', updatedAt: 0 } });
  });

  it('tolerates a non-object stored blob', async () => {
    fetchMock.mockResolvedValue('corrupted');
    await expect(readWatermarks()).resolves.toEqual({});
  });

  it('reads a single address+token record', async () => {
    fetchMock.mockResolvedValue({
      [watermarkKey(ADDRESS_A, 'USDC')]: { acknowledged: '7', drawerShown: '9', updatedAt: 3 }
    });

    await expect(readWatermark(ADDRESS_A, 'USDC')).resolves.toEqual({
      acknowledged: '7',
      drawerShown: '9',
      updatedAt: 3
    });
    await expect(readWatermark(ADDRESS_A, 'ETH')).resolves.toBeUndefined();
  });

  it('writes bigints as decimal strings and defaults drawerShown to acknowledged', async () => {
    const next = await patchWatermark(ADDRESS_A, 'ETH', { acknowledged: 10n ** 18n });

    expect(putMock).toHaveBeenCalledTimes(1);
    const record = next[watermarkKey(ADDRESS_A, 'ETH')];
    expect(record?.acknowledged).toBe('1000000000000000000');
    expect(record?.drawerShown).toBe('1000000000000000000');
    expect(typeof record?.updatedAt).toBe('number');
  });

  it('keeps the untouched mark when only one side is patched', async () => {
    fetchMock.mockResolvedValue({
      [watermarkKey(ADDRESS_A, 'ETH')]: { acknowledged: '5', drawerShown: '5', updatedAt: 1 }
    });

    const next = await patchWatermark(ADDRESS_A, 'ETH', { drawerShown: 8n });

    expect(next[watermarkKey(ADDRESS_A, 'ETH')]).toMatchObject({ acknowledged: '5', drawerShown: '8' });
  });

  it('isolates records per address and per token, re-reading the store before writing', async () => {
    fetchMock.mockResolvedValue({
      [watermarkKey(ADDRESS_B, 'ETH')]: { acknowledged: '1', drawerShown: '1', updatedAt: 1 },
      [watermarkKey(ADDRESS_A, 'USDC')]: { acknowledged: '2', drawerShown: '2', updatedAt: 1 }
    });

    const next = await patchWatermark(ADDRESS_A, 'ETH', { acknowledged: 3n });

    // The concurrent-write guard: the patch re-reads, so the other address's and
    // the other token's records survive untouched.
    expect(next[watermarkKey(ADDRESS_B, 'ETH')]).toMatchObject({ acknowledged: '1' });
    expect(next[watermarkKey(ADDRESS_A, 'USDC')]).toMatchObject({ acknowledged: '2' });
    expect(next[watermarkKey(ADDRESS_A, 'ETH')]).toMatchObject({ acknowledged: '3' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
