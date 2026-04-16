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

jest.mock('lib/prices', () => ({
  getTokenPrice: jest.fn(() => ({ price: 1, change24h: 0, percentageChange24h: 0 }))
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
    const balances = state.balances['account-1']!;
    expect(balances).toBeDefined();
    expect(balances.length).toBe(1);
    expect(balances[0]!.tokenId).toBe(MOCK_MIDEN_FAUCET_ID);
    expect(balances[0]!.tokenSlug).toBe('MIDEN');
    expect(balances[0]!.balance).toBe(5000); // 5000000000 / 10^6
    expect(state.balancesLoading['account-1']).toBe(false);
    expect(state.balancesLastFetched['account-1']).toBeGreaterThan(0);
  });

  it('always includes MIDEN token even when vault is empty', async () => {
    await updateBalancesFromSyncData('account-1', []);

    const balances = useWalletStore.getState().balances['account-1']!;
    expect(balances.length).toBe(1);
    expect(balances[0]!.tokenId).toBe(MOCK_MIDEN_FAUCET_ID);
    expect(balances[0]!.balance).toBe(0);
  });

  it('uses pre-fetched metadata from sync data for unknown tokens', async () => {
    const customFaucetId = 'custom-faucet-456';

    const vaultAssets: SerializedVaultAsset[] = [
      {
        faucetId: customFaucetId,
        amountBaseUnits: '2000000',
        metadata: { name: 'CustomToken', symbol: 'CTK', decimals: 6, thumbnailUri: '' }
      }
    ];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    // Should NOT fetch via RPC — metadata comes from sync data
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();

    const balances = useWalletStore.getState().balances['account-1']!;
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

    const balances = useWalletStore.getState().balances['account-1']!;
    const cachedBalance = balances.find(b => b.tokenId === customFaucetId);
    expect(cachedBalance!.balance).toBe(1); // 100000000 / 10^8
  });

  it('uses existing tokenPrices from store (non-nullish tokenPrices branch)', async () => {
    useWalletStore.setState({
      tokenPrices: { MIDEN: { price: 2.5, change24h: 0.1, percentageChange24h: 5 } }
    });

    const vaultAssets: SerializedVaultAsset[] = [{ faucetId: MOCK_MIDEN_FAUCET_ID, amountBaseUnits: '1000000' }];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    const balances = useWalletStore.getState().balances['account-1'];
    expect(balances).toBeDefined();
    expect(balances!.length).toBe(1);
    expect(balances![0]!.tokenId).toBe(MOCK_MIDEN_FAUCET_ID);
  });

  it('uses default metadata when sync data has no metadata for a token', async () => {
    const unknownFaucetId = 'unknown-faucet';

    // No metadata field — simulates SW metadata fetch failure
    const vaultAssets: SerializedVaultAsset[] = [{ faucetId: unknownFaucetId, amountBaseUnits: '1000' }];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    const balances = useWalletStore.getState().balances['account-1']!;
    // Should still have the token (with default metadata) + MIDEN
    expect(balances.length).toBe(2);
    const unknownBalance = balances.find(b => b.tokenId === unknownFaucetId);
    expect(unknownBalance).toBeDefined();
    expect(unknownBalance!.tokenSlug).toBe('Unknown');
  });
});
