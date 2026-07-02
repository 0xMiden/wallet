/**
 * Coverage tests for `lib/miden/back/safe-network.ts` — the stored-id →
 * default-network fallback chain in `getCurrentMidenNetwork`.
 */
import { DEFAULT_NETWORK, NETWORK_STORAGE_ID } from 'lib/miden-chain/constants';

import { NETWORKS } from '../networks';

const mockGet = jest.fn();
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({ get: (keys: string[]) => mockGet(keys) })
}));

import { getCurrentMidenNetwork } from './safe-network';

describe('getCurrentMidenNetwork', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('returns the stored network when the saved id matches a known network', async () => {
    const target = NETWORKS[NETWORKS.length - 1]!;
    mockGet.mockResolvedValue({ [NETWORK_STORAGE_ID]: target.id, custom_networks_snapshot: undefined });
    await expect(getCurrentMidenNetwork()).resolves.toEqual(target);
  });

  it('falls back to the default network when no id is stored', async () => {
    mockGet.mockResolvedValue({ [NETWORK_STORAGE_ID]: undefined, custom_networks_snapshot: undefined });
    const result = await getCurrentMidenNetwork();
    expect(result.id).toBe(DEFAULT_NETWORK);
  });
});
