import '../../../../test/jest-mocks';

import { SerializedVaultAsset } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

import { updateBalancesFromSyncData } from './updateBalancesFromSyncData';

const MOCK_MIDEN_FAUCET_ID = 'miden-faucet-123';

jest.mock('lib/miden/assets', () => ({
  ...jest.requireActual('lib/miden/assets'),
  getFaucetIdSetting: jest.fn(async () => 'miden-faucet-123')
}));

const mockFetchTokenMetadata = jest.fn();
jest.mock('lib/miden/metadata', () => ({
  ...jest.requireActual('lib/miden/metadata'),
  fetchTokenMetadata: (...args: any[]) => mockFetchTokenMetadata(...args)
}));

jest.mock('../../miden/front/assets', () => ({
  setTokensBaseMetadata: jest.fn(async () => {})
}));

describe('updateBalancesFromSyncData', () => {
  beforeEach(() => {
    useWalletStore.setState({
      balances: {},
      balancesLoading: {},
      balancesLastFetched: {},
      assetsMetadata: {}
    });
    jest.clearAllMocks();
  });

  it('converts vault assets to balances with MIDEN token', async () => {
    const vaultAssets: SerializedVaultAsset[] = [{ faucetId: MOCK_MIDEN_FAUCET_ID, amountBaseUnits: '5000000000' }];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    const state = useWalletStore.getState();
    const balances = state.balances['account-1'];
    expect(balances).toBeDefined();
    expect(balances.length).toBe(1);
    expect(balances[0].tokenId).toBe(MOCK_MIDEN_FAUCET_ID);
    expect(balances[0].tokenSlug).toBe('MIDEN');
    expect(balances[0].balance).toBe(5000); // 5000000000 / 10^6
    expect(state.balancesLoading['account-1']).toBe(false);
    expect(state.balancesLastFetched['account-1']).toBeGreaterThan(0);
  });

  it('always includes MIDEN token even when vault is empty', async () => {
    await updateBalancesFromSyncData('account-1', []);

    const balances = useWalletStore.getState().balances['account-1'];
    expect(balances.length).toBe(1);
    expect(balances[0].tokenId).toBe(MOCK_MIDEN_FAUCET_ID);
    expect(balances[0].balance).toBe(0);
  });

  it('fetches metadata for unknown tokens and includes them', async () => {
    const customFaucetId = 'custom-faucet-456';
    mockFetchTokenMetadata.mockResolvedValueOnce({
      base: { name: 'CustomToken', symbol: 'CTK', decimals: 6, thumbnailUri: '' }
    });

    const vaultAssets: SerializedVaultAsset[] = [{ faucetId: customFaucetId, amountBaseUnits: '2000000' }];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    expect(mockFetchTokenMetadata).toHaveBeenCalledWith(customFaucetId);

    const balances = useWalletStore.getState().balances['account-1'];
    // Custom token + default MIDEN (0 balance)
    expect(balances.length).toBe(2);
    const customBalance = balances.find(b => b.tokenId === customFaucetId);
    expect(customBalance).toBeDefined();
    expect(customBalance!.tokenSlug).toBe('CTK');
    expect(customBalance!.balance).toBe(2); // 2000000 / 10^6
  });

  it('uses cached metadata from Zustand store instead of fetching', async () => {
    const customFaucetId = 'cached-faucet-789';
    useWalletStore.setState({
      assetsMetadata: {
        [customFaucetId]: { name: 'CachedToken', symbol: 'CACHE', decimals: 8, thumbnailUri: '' }
      }
    });

    const vaultAssets: SerializedVaultAsset[] = [{ faucetId: customFaucetId, amountBaseUnits: '100000000' }];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    // Should not fetch — metadata was already in the store
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();

    const balances = useWalletStore.getState().balances['account-1'];
    const cachedBalance = balances.find(b => b.tokenId === customFaucetId);
    expect(cachedBalance!.balance).toBe(1); // 100000000 / 10^8
  });

  it('handles metadata fetch failure gracefully with default metadata', async () => {
    const failingFaucetId = 'failing-faucet';
    mockFetchTokenMetadata.mockRejectedValueOnce(new Error('RPC error'));

    const vaultAssets: SerializedVaultAsset[] = [{ faucetId: failingFaucetId, amountBaseUnits: '1000' }];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    const balances = useWalletStore.getState().balances['account-1'];
    // Should still have the token (with default metadata) + MIDEN
    expect(balances.length).toBe(2);
    const failedBalance = balances.find(b => b.tokenId === failingFaucetId);
    expect(failedBalance).toBeDefined();
  });
});
