import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { preferredRouteKey, readPreferredRoute, readPreferredRoutes, writePreferredRoute } from './preferred-route';

jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn()
}));

const fetchMock = jest.mocked(fetchFromStorage);
const putMock = jest.mocked(putToStorage);

const ADDRESS_A = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa';
const ADDRESS_B = '0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb';

describe('preferred-route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockResolvedValue(null);
    putMock.mockResolvedValue(undefined);
  });

  it('keys records by lowercased address + token', () => {
    expect(preferredRouteKey(ADDRESS_A, 'ETH')).toBe(`${ADDRESS_A.toLowerCase()}:ETH`);
    expect(preferredRouteKey(`  ${ADDRESS_A}  `, 'USDC')).toBe(`${ADDRESS_A.toLowerCase()}:USDC`);
  });

  it('falls back to the token default when nothing is stored', async () => {
    await expect(readPreferredRoute(ADDRESS_A, 'ETH')).resolves.toBe('agglayer');
    await expect(readPreferredRoute(ADDRESS_A, 'USDC')).resolves.toBe('epoch');
  });

  it('round-trips a choice, scoped to the address that made it', async () => {
    await writePreferredRoute(ADDRESS_A, 'ETH', 'epoch');
    expect(putMock).toHaveBeenCalledWith('deposit_preferred_routes_v1', {
      [preferredRouteKey(ADDRESS_A, 'ETH')]: 'epoch'
    });

    fetchMock.mockResolvedValue({ [preferredRouteKey(ADDRESS_A, 'ETH')]: 'epoch' });
    await expect(readPreferredRoute(ADDRESS_A, 'ETH')).resolves.toBe('epoch');
    // A different deposit address never inherits it.
    await expect(readPreferredRoute(ADDRESS_B, 'ETH')).resolves.toBe('agglayer');
  });

  it('preserves other entries when one is rewritten', async () => {
    fetchMock.mockResolvedValue({ [preferredRouteKey(ADDRESS_B, 'ETH')]: 'epoch' });
    await writePreferredRoute(ADDRESS_A, 'ETH', 'epoch');
    expect(putMock).toHaveBeenCalledWith('deposit_preferred_routes_v1', {
      [preferredRouteKey(ADDRESS_B, 'ETH')]: 'epoch',
      [preferredRouteKey(ADDRESS_A, 'ETH')]: 'epoch'
    });
  });

  it('refuses to store a route the token cannot take', async () => {
    // USDC is Epoch-only — AggLayer USDC needs a relayer that has not shipped.
    await writePreferredRoute(ADDRESS_A, 'USDC', 'agglayer');
    expect(putMock).not.toHaveBeenCalled();
  });

  it('ignores stored entries that are unusable rather than throwing', async () => {
    fetchMock.mockResolvedValue({
      [preferredRouteKey(ADDRESS_A, 'ETH')]: 'teleport',
      [preferredRouteKey(ADDRESS_A, 'USDC')]: 'agglayer',
      'not-a-key': 'epoch',
      [`${ADDRESS_B.toLowerCase()}:DOGE`]: 'epoch'
    });
    await expect(readPreferredRoutes()).resolves.toEqual({});
    // …and the caller still gets a route it can act on.
    await expect(readPreferredRoute(ADDRESS_A, 'USDC')).resolves.toBe('epoch');
  });

  it('survives a corrupt store', async () => {
    fetchMock.mockResolvedValue('not an object');
    await expect(readPreferredRoutes()).resolves.toEqual({});
  });
});
