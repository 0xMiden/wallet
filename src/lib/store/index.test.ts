import '../../../test/jest-mocks';

import axios from 'axios';

import type * as FaucetIdSettingModule from 'lib/miden/assets/faucet-id-setting';
import { DEFAULT_TOKEN_METADATA } from 'lib/miden/metadata/defaults';
import { getNativeDisplayMetadataSync } from 'lib/miden/metadata/native';
import { MidenMessageType } from 'lib/miden/types';
import { CARD_COLOR_STORAGE_KEY, NOMINAL_UNQUOTED_PRICE_STORAGE_KEY } from 'lib/settings/constants';
import { setNominalUnquotedPriceSetting } from 'lib/settings/nominal-price';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import {
  useWalletStore,
  selectIsReady,
  selectIsLocked,
  selectIsIdle,
  getIntercom,
  reloadEndpointOverridesInSW,
  __resetFaucetAssetsMetadataForTest,
  faucetMetadataOf
} from './index';
import { fetchingAddresses } from './utils/fetchBalances';
import type * as FetchBalancesModule from './utils/fetchBalances';

// A balance read a case holds open. Every other case reads through the real module, which is
// reached lazily: the module is part of an import cycle, so its exports are not ready at mock time.
let mockHeldBalanceRead: (() => Promise<unknown>) | null = null;
jest.mock('./utils/fetchBalances', () => {
  const actual = jest.requireActual<typeof FetchBalancesModule>('./utils/fetchBalances');
  return {
    get fetchingAddresses() {
      return actual.fetchingAddresses;
    },
    fetchBalances: (...args: Parameters<typeof actual.fetchBalances>) =>
      mockHeldBalanceRead ? mockHeldBalanceRead() : actual.fetchBalances(...args)
  };
});

let mockFaucetIdSetting: string | null | undefined;
jest.mock('lib/miden/assets/faucet-id-setting', () => {
  const actual = jest.requireActual<typeof FaucetIdSettingModule>('lib/miden/assets/faucet-id-setting');
  return {
    getFaucetIdSetting: () =>
      mockFaucetIdSetting === undefined ? actual.getFaucetIdSetting() : Promise.resolve(mockFaucetIdSetting)
  };
});

// The override write is the storage boundary of the override actions. The apply logic is the real one.
const mockWriteTokenMetadataOverride = jest.fn();
jest.mock('lib/miden/metadata/overrides', () => ({
  ...jest.requireActual('lib/miden/metadata/overrides'),
  writeTokenMetadataOverride: (...args: unknown[]) => mockWriteTokenMetadataOverride(...args)
}));

let mockNativeAssetId: string | null = null;
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getNativeAssetIdSync: () => mockNativeAssetId
}));

// Mock the intercom module
const mockRequest = jest.fn();
const mockIntercomClient = {
  request: mockRequest,
  subscribe: jest.fn(() => () => {})
};
jest.mock('lib/intercom/client', () => ({
  createIntercomClient: jest.fn(() => mockIntercomClient),
  IntercomClient: jest.fn().mockImplementation(() => mockIntercomClient)
}));

// Mock fetchTokenMetadata
jest.mock('lib/miden/metadata', () => ({
  fetchTokenMetadata: jest.fn(),
  MIDEN_METADATA: { name: 'Miden', symbol: 'MIDEN', decimals: 8 }
}));

describe('useWalletStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useWalletStore.setState({
      status: WalletStatus.Idle,
      accounts: [],
      currentAccount: null,
      networks: [],
      settings: null,
      ownMnemonic: null,
      assetsMetadata: {},
      selectedNetworkId: null,
      confirmation: null,
      isInitialized: false,
      isSyncing: false,
      lastSyncedAt: null
    });
    mockRequest.mockReset();
  });

  describe('syncFromBackend', () => {
    it('updates store state from backend', () => {
      const { syncFromBackend } = useWalletStore.getState();

      syncFromBackend({
        status: WalletStatus.Ready,
        accounts: [
          {
            publicKey: 'pk1',
            name: 'Account 1',
            isPublic: true,
            type: WalletType.OnChain,
            hdIndex: 0,
            authScheme: 'ecdsa'
          }
        ],
        currentAccount: {
          publicKey: 'pk1',
          name: 'Account 1',
          isPublic: true,
          type: WalletType.OnChain,
          hdIndex: 0,
          authScheme: 'ecdsa'
        },
        networks: [],
        settings: { contacts: [] },
        ownMnemonic: true
      });

      const state = useWalletStore.getState();
      expect(state.status).toBe(WalletStatus.Ready);
      expect(state.accounts).toHaveLength(1);
      expect(state.currentAccount?.publicKey).toBe('pk1');
      expect(state.isInitialized).toBe(true);
      expect(state.lastSyncedAt).toBeGreaterThan(0);
    });
  });

  // The Guardian cold key has no import path, so nothing may request it: the
  // reveal screen is gone and so is the action behind it.
  it('exposes no Guardian cold-key reveal action', () => {
    expect(useWalletStore.getState()).not.toHaveProperty('revealGuardianKeys');
  });

  describe('editAccountName', () => {
    const mockAccounts = [
      {
        publicKey: 'pk1',
        name: 'Account 1',
        isPublic: true,
        type: WalletType.OnChain,
        hdIndex: 0,
        authScheme: 'ecdsa' as const
      },
      {
        publicKey: 'pk2',
        name: 'Account 2',
        isPublic: false,
        type: WalletType.OnChain,
        hdIndex: 1,
        authScheme: 'ecdsa' as const
      }
    ];

    beforeEach(() => {
      useWalletStore.setState({ accounts: mockAccounts });
    });

    it('optimistically updates account name', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.EditAccountResponse });

      const { editAccountName } = useWalletStore.getState();
      const promise = editAccountName('pk1', 'New Name');

      // Check optimistic update happened immediately
      const stateAfterOptimistic = useWalletStore.getState();
      expect(stateAfterOptimistic.accounts[0]!.name).toBe('New Name');

      await promise;

      // Verify request was made
      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.EditAccountRequest,
        accountPublicKey: 'pk1',
        name: 'New Name'
      });
    });

    it('trims whitespace from account name', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.EditAccountResponse });

      const { editAccountName } = useWalletStore.getState();
      await editAccountName('pk1', '  Trimmed Name  ');

      const state = useWalletStore.getState();
      expect(state.accounts[0]!.name).toBe('Trimmed Name');
    });

    it('rolls back on error', async () => {
      mockRequest.mockRejectedValueOnce(new Error('Network error'));

      const { editAccountName } = useWalletStore.getState();

      await expect(editAccountName('pk1', 'Failed Name')).rejects.toThrow('Network error');

      // Verify rollback happened
      const state = useWalletStore.getState();
      expect(state.accounts[0]!.name).toBe('Account 1');
    });

    it('rolls back on invalid response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'WrongResponseType' });

      const { editAccountName } = useWalletStore.getState();

      await expect(editAccountName('pk1', 'Failed Name')).rejects.toThrow('Invalid response');

      // Verify rollback happened
      const state = useWalletStore.getState();
      expect(state.accounts[0]!.name).toBe('Account 1');
    });
  });

  describe('updateCurrentAccount', () => {
    const mockAccounts = [
      {
        publicKey: 'pk1',
        name: 'Account 1',
        isPublic: true,
        type: WalletType.OnChain,
        hdIndex: 0,
        authScheme: 'ecdsa' as const
      },
      {
        publicKey: 'pk2',
        name: 'Account 2',
        isPublic: false,
        type: WalletType.OnChain,
        hdIndex: 1,
        authScheme: 'ecdsa' as const
      }
    ];

    beforeEach(() => {
      useWalletStore.setState({
        accounts: mockAccounts,
        currentAccount: mockAccounts[0]
      });
    });

    it('optimistically updates current account', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.UpdateCurrentAccountResponse });

      const { updateCurrentAccount } = useWalletStore.getState();
      const promise = updateCurrentAccount('pk2');

      // Check optimistic update happened immediately
      const stateAfterOptimistic = useWalletStore.getState();
      expect(stateAfterOptimistic.currentAccount?.publicKey).toBe('pk2');

      await promise;

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.UpdateCurrentAccountRequest,
        accountPublicKey: 'pk2'
      });
    });

    it('rolls back on error', async () => {
      mockRequest.mockRejectedValueOnce(new Error('Network error'));

      const { updateCurrentAccount } = useWalletStore.getState();

      await expect(updateCurrentAccount('pk2')).rejects.toThrow('Network error');

      // Verify rollback happened
      const state = useWalletStore.getState();
      expect(state.currentAccount?.publicKey).toBe('pk1');
    });

    it('does not update if account not found', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.UpdateCurrentAccountResponse });

      const { updateCurrentAccount } = useWalletStore.getState();
      await updateCurrentAccount('nonexistent');

      // Current account should remain unchanged (optimistic update skipped)
      const state = useWalletStore.getState();
      expect(state.currentAccount?.publicKey).toBe('pk1');
    });
  });

  describe('updateSettings', () => {
    const mockContact = { name: 'Alice', address: 'addr1' };
    const mockSettings = { contacts: [mockContact] };

    beforeEach(() => {
      useWalletStore.setState({ settings: mockSettings });
    });

    it('optimistically updates settings', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.UpdateSettingsResponse });
      const newContact = { name: 'Bob', address: 'addr2' };

      const { updateSettings } = useWalletStore.getState();
      const promise = updateSettings({ contacts: [mockContact, newContact] });

      // Check optimistic update happened immediately
      const stateAfterOptimistic = useWalletStore.getState();
      expect(stateAfterOptimistic.settings?.contacts).toHaveLength(2);

      await promise;

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.UpdateSettingsRequest,
        settings: { contacts: [mockContact, newContact] }
      });
    });

    it('merges partial settings', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.UpdateSettingsResponse });
      const newContacts = [{ name: 'Charlie', address: 'addr3' }];

      const { updateSettings } = useWalletStore.getState();
      await updateSettings({ contacts: newContacts });

      const state = useWalletStore.getState();
      // Note: contacts get replaced, not merged (that's expected behavior)
      expect(state.settings?.contacts).toEqual(newContacts);
    });

    it('rolls back on error', async () => {
      mockRequest.mockRejectedValueOnce(new Error('Network error'));
      const newContacts = [{ name: 'Dave', address: 'addr4' }];

      const { updateSettings } = useWalletStore.getState();

      await expect(updateSettings({ contacts: newContacts })).rejects.toThrow('Network error');

      // Verify rollback happened
      const state = useWalletStore.getState();
      expect(state.settings?.contacts).toEqual([mockContact]);
    });
  });

  describe('spending-limit actions', () => {
    const draft = { accountId: 'account-a', limit: 90n };

    it('reads the one configuration through a serializable transport response', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.GetSpendingLimitResponse,
        configuration: {
          accountId: 'account-a',
          limit: '90',
          revision: 'revision-1',
          createdAt: 1,
          updatedAt: 2
        }
      });

      await expect(useWalletStore.getState().readSpendingLimit('account-a')).resolves.toEqual({
        accountId: 'account-a',
        limit: 90n,
        revision: 'revision-1',
        createdAt: 1,
        updatedAt: 2
      });
      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.GetSpendingLimitRequest,
        accountId: 'account-a'
      });
    });

    it('reports no configuration for an account with none', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.GetSpendingLimitResponse });

      await expect(useWalletStore.getState().readSpendingLimit('account-a')).resolves.toBeUndefined();
    });

    it('serializes a bigint limit and parses the saved response', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.SaveSpendingLimitResponse,
        configuration: {
          accountId: 'account-a',
          limit: '90',
          revision: 'revision-2',
          createdAt: 1,
          updatedAt: 2
        }
      });

      await expect(useWalletStore.getState().saveSpendingLimit(draft, 'revision-1', false)).resolves.toMatchObject({
        limit: 90n,
        revision: 'revision-2'
      });
      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.SaveSpendingLimitRequest,
        draft: { accountId: 'account-a', limit: '90' },
        observedRevision: 'revision-1',
        strictlyAuthenticated: false
      });
    });

    it('serializes a spend list and parses its structured preflight assessment', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.AssessSpendingLimitResponse,
        assessment: {
          accountId: 'account-a',
          usdAmount: '20',
          revision: 'revision-1',
          assessedAt: 100,
          breach: {
            spent: '90',
            proposedTotal: '110',
            limit: '100',
            overBy: '10',
            resetAt: 200
          }
        }
      });

      await expect(
        useWalletStore.getState().assessSpendingLimit('account-a', [{ faucetId: 'faucet-a', amount: 20n }])
      ).resolves.toMatchObject({
        usdAmount: 20n,
        breach: { overBy: 10n }
      });
      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.AssessSpendingLimitRequest,
        accountId: 'account-a',
        spends: [{ faucetId: 'faucet-a', amount: '20' }]
      });
    });
  });

  describe('strict authentication actions', () => {
    it('loads protectors and verifies a credential', async () => {
      mockRequest
        .mockResolvedValueOnce({
          type: WalletMessageType.GetStrictAuthenticationProtectorsResponse,
          protectors: { hardware: false, password: true }
        })
        .mockResolvedValueOnce({ type: WalletMessageType.VerifyStrictActionAuthenticationResponse });

      await expect(useWalletStore.getState().getStrictAuthenticationProtectors()).resolves.toEqual({
        hardware: false,
        password: true
      });
      await expect(useWalletStore.getState().verifyStrictActionAuthentication('secret')).resolves.toBeUndefined();
      expect(mockRequest).toHaveBeenNthCalledWith(1, {
        type: WalletMessageType.GetStrictAuthenticationProtectorsRequest
      });
      expect(mockRequest).toHaveBeenNthCalledWith(2, {
        type: WalletMessageType.VerifyStrictActionAuthenticationRequest,
        credential: 'secret'
      });
    });
  });

  describe('setAssetsMetadata', () => {
    it('merges new metadata with existing', () => {
      useWalletStore.setState({
        assetsMetadata: { asset1: { name: 'Token 1', symbol: 'TK1', decimals: 8 } }
      });

      const { setAssetsMetadata } = useWalletStore.getState();
      setAssetsMetadata({ asset2: { name: 'Token 2', symbol: 'TK2', decimals: 6 } });

      const state = useWalletStore.getState();
      expect(state.assetsMetadata).toEqual({
        asset1: { name: 'Token 1', symbol: 'TK1', decimals: 8 },
        asset2: { name: 'Token 2', symbol: 'TK2', decimals: 6 }
      });
    });
  });

  describe('token metadata overrides', () => {
    const FAUCET = 'mtst1faucet';
    const OTHER = 'mtst1other';
    const NATIVE = 'mtst1native';
    const faucetMetadata = { name: 'Faucet Token', symbol: 'FCT', decimals: 8 };
    const row = (tokenId: string, balance: number, metadata: { name: string; symbol: string; decimals: number }) => ({
      tokenId,
      tokenSlug: metadata.symbol,
      metadata,
      balance,
      fiatPrice: 0,
      change24h: 0
    });

    beforeEach(() => {
      __resetFaucetAssetsMetadataForTest();
      mockWriteTokenMetadataOverride.mockReset().mockResolvedValue({});
      mockNativeAssetId = NATIVE;
      useWalletStore.setState({ tokenMetadataOverrides: {}, balances: {}, tokenPrices: {} });
      useWalletStore.getState().setAssetsMetadata({ [FAUCET]: faucetMetadata, [OTHER]: faucetMetadata });
    });

    afterEach(() => {
      mockNativeAssetId = null;
    });

    it('applies the override to the shown metadata and stores it', async () => {
      await useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Mine', symbol: 'MN' });

      const state = useWalletStore.getState();
      expect(state.assetsMetadata[FAUCET]).toEqual({ name: 'Mine', symbol: 'MN', decimals: 8 });
      expect(state.assetsMetadata[OTHER]).toEqual(faucetMetadata);
      expect(state.tokenMetadataOverrides).toEqual({ [FAUCET]: { name: 'Mine', symbol: 'MN' } });
      expect(mockWriteTokenMetadataOverride).toHaveBeenCalledWith(FAUCET, { name: 'Mine', symbol: 'MN' });
    });

    it("keeps the override when the faucet metadata comes again, on the faucet's scale", async () => {
      await useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Mine', symbol: 'MN', decimals: 2 });

      useWalletStore
        .getState()
        .setAssetsMetadata({ [FAUCET]: { ...faucetMetadata, description: 'Described by faucet' } });

      expect(useWalletStore.getState().assetsMetadata[FAUCET]).toStrictEqual({
        name: 'Mine',
        symbol: 'MN',
        decimals: 8,
        description: 'Described by faucet'
      });
    });

    it('shows the faucet values again after a clear', async () => {
      await useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Mine', symbol: 'MN', decimals: 2 });
      await useWalletStore.getState().clearTokenMetadataOverride(FAUCET);

      const state = useWalletStore.getState();
      expect(state.assetsMetadata[FAUCET]).toEqual(faucetMetadata);
      expect(state.tokenMetadataOverrides).toEqual({});
      expect(mockWriteTokenMetadataOverride).toHaveBeenLastCalledWith(FAUCET, undefined);
    });

    it('does nothing on a clear when no override is set', async () => {
      await useWalletStore.getState().clearTokenMetadataOverride(FAUCET);

      expect(mockWriteTokenMetadataOverride).not.toHaveBeenCalled();
      expect(useWalletStore.getState().assetsMetadata[FAUCET]).toEqual(faucetMetadata);
    });

    it("rescales the balance rows of every account when the user states an unknown-scale token's decimals, and back on a clear", async () => {
      const unknown = { name: 'Unknown', symbol: 'Unknown', decimals: 6, scaleIsUnknown: true };
      useWalletStore.getState().setAssetsMetadata({ [FAUCET]: unknown });
      // 1.5 at the placeholder's guessed 6 decimals is 1500000 base units.
      useWalletStore.setState({
        balances: {
          'account-1': [row(FAUCET, 1.5, unknown), row(OTHER, 3, faucetMetadata)],
          'account-2': [row(FAUCET, 0.25, unknown)]
        }
      });

      await useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Mine', symbol: 'MN', decimals: 4 });

      let balances = useWalletStore.getState().balances;
      expect(balances['account-1']![0]).toMatchObject({
        tokenId: FAUCET,
        tokenSlug: 'MN',
        balance: 150,
        metadata: { symbol: 'MN', decimals: 4, scaleIsUnknown: false, scaleFromOverride: true }
      });
      expect(balances['account-1']![1]).toMatchObject({ tokenId: OTHER, balance: 3, metadata: faucetMetadata });
      expect(balances['account-2']![0]).toMatchObject({ tokenId: FAUCET, balance: 25 });

      await useWalletStore.getState().clearTokenMetadataOverride(FAUCET);

      balances = useWalletStore.getState().balances;
      expect(balances['account-1']![0]).toMatchObject({ tokenSlug: 'Unknown', balance: 1.5, metadata: unknown });
      expect(balances['account-2']![0]).toMatchObject({ balance: 0.25 });
    });

    it("keeps a known-scale token's balance rows and entry on the faucet's scale when the override carries decimals", async () => {
      useWalletStore.setState({ balances: { 'account-1': [row(FAUCET, 1.5, faucetMetadata)] } });

      await useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Mine', symbol: 'MN', decimals: 2 });

      const state = useWalletStore.getState();
      expect(state.balances['account-1']![0]).toMatchObject({ tokenSlug: 'MN', balance: 1.5 });
      expect(state.balances['account-1']![0]!.metadata).toStrictEqual({ name: 'Mine', symbol: 'MN', decimals: 8 });
      expect(state.assetsMetadata[FAUCET]).toStrictEqual({ name: 'Mine', symbol: 'MN', decimals: 8 });
    });

    it('makes an unknown-scale token quantifiable when the user states its decimals', async () => {
      const unknown = { name: 'Unknown', symbol: 'Unknown', decimals: 6, scaleIsUnknown: true };
      useWalletStore.getState().setAssetsMetadata({ [FAUCET]: unknown });
      // 2000 base units, divided by the placeholder's guessed 6 decimals.
      useWalletStore.setState({ balances: { 'account-1': [row(FAUCET, 0.002, unknown)] } });

      await useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Mine', symbol: 'MN', decimals: 3 });

      const state = useWalletStore.getState();
      expect(state.assetsMetadata[FAUCET]).toMatchObject({
        decimals: 3,
        scaleIsUnknown: false,
        scaleFromOverride: true
      });
      expect(state.balances['account-1']![0]).toMatchObject({ balance: 2, metadata: { scaleIsUnknown: false } });
    });

    it('shows the change before the write lands', async () => {
      let finishWrite: () => void = () => {};
      mockWriteTokenMetadataOverride.mockImplementation(
        () =>
          new Promise(resolve => {
            finishWrite = () => resolve({});
          })
      );

      const saved = useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Mine', symbol: 'MN' });

      expect(useWalletStore.getState().assetsMetadata[FAUCET]!.symbol).toBe('MN');
      finishWrite();
      await saved;
    });

    it('rolls back the metadata and the balances when the write fails', async () => {
      useWalletStore.setState({ balances: { 'account-1': [row(FAUCET, 1.5, faucetMetadata)] } });
      await useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Old', symbol: 'OLD' });
      mockWriteTokenMetadataOverride.mockRejectedValueOnce(new Error('storage full'));

      await expect(
        useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'New', symbol: 'NEW', decimals: 2 })
      ).rejects.toThrow('storage full');

      const state = useWalletStore.getState();
      expect(state.tokenMetadataOverrides).toEqual({ [FAUCET]: { name: 'Old', symbol: 'OLD' } });
      expect(state.assetsMetadata[FAUCET]).toEqual({ ...faucetMetadata, name: 'Old', symbol: 'OLD' });
      expect(state.balances['account-1']![0]).toMatchObject({ tokenSlug: 'OLD', balance: 1.5 });
    });

    it('rolls back a failed clear', async () => {
      await useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Mine', symbol: 'MN' });
      mockWriteTokenMetadataOverride.mockRejectedValueOnce(new Error('storage full'));

      await expect(useWalletStore.getState().clearTokenMetadataOverride(FAUCET)).rejects.toThrow('storage full');

      expect(useWalletStore.getState().tokenMetadataOverrides).toEqual({ [FAUCET]: { name: 'Mine', symbol: 'MN' } });
      expect(useWalletStore.getState().assetsMetadata[FAUCET]!.name).toBe('Mine');
    });

    it('refuses an override of the native token', async () => {
      const native = { name: 'Miden', symbol: 'MIDEN', decimals: 6 };
      useWalletStore.getState().setAssetsMetadata({ [NATIVE]: native });

      await expect(
        useWalletStore.getState().setTokenMetadataOverride(NATIVE, { name: 'Fake', symbol: 'FAKE', decimals: 2 })
      ).rejects.toThrow();

      expect(mockWriteTokenMetadataOverride).not.toHaveBeenCalled();
      expect(useWalletStore.getState().assetsMetadata[NATIVE]).toEqual(native);
    });

    it("gives the faucet's own record through faucetMetadataOf, never an entry an override made", async () => {
      await useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Mine', symbol: 'MN' });
      expect(faucetMetadataOf(FAUCET)).toEqual(faucetMetadata);

      // A faucet with no record: the hydration writes the placeholder with the override on top.
      useWalletStore
        .getState()
        .hydrateTokenMetadataOverrides({ mtst1fresh: { name: 'Fresh', symbol: 'FRS', decimals: 3 } });
      expect(useWalletStore.getState().assetsMetadata.mtst1fresh).toMatchObject({ symbol: 'FRS', decimals: 3 });
      expect(faucetMetadataOf('mtst1fresh')).toBeUndefined();

      useWalletStore.setState(state => ({ assetsMetadata: { ...state.assetsMetadata, mtst1plain: faucetMetadata } }));
      expect(faucetMetadataOf('mtst1plain')).toEqual(faucetMetadata);
    });

    it('applies the stored overrides on hydrate and removes the ones storage no longer has', async () => {
      await useWalletStore.getState().setTokenMetadataOverride(FAUCET, { name: 'Mine', symbol: 'MN' });

      useWalletStore.getState().hydrateTokenMetadataOverrides({
        [OTHER]: { name: 'Other', symbol: 'OTH' },
        [NATIVE]: { name: 'Fake', symbol: 'FAKE', decimals: 1 }
      });

      const state = useWalletStore.getState();
      expect(state.assetsMetadata[FAUCET]).toEqual(faucetMetadata);
      expect(state.assetsMetadata[OTHER]).toEqual({ ...faucetMetadata, name: 'Other', symbol: 'OTH' });
      expect(state.assetsMetadata[NATIVE]).toBeUndefined();
    });

    describe('a balance read that lands after an override change', () => {
      const HELD = 'mtst1held';
      const LEGACY = 'mtst1legacy';
      let landRead: (rows: unknown[]) => void = () => {};

      beforeEach(() => {
        mockHeldBalanceRead = () =>
          new Promise(resolve => {
            landRead = resolve;
          });
        mockFaucetIdSetting = LEGACY;
      });

      afterEach(() => {
        mockHeldBalanceRead = null;
        mockFaucetIdSetting = undefined;
      });

      it('shows the override saved while it was in flight, scaled by its decimals', async () => {
        const previous = { name: 'Old', symbol: 'OLD', decimals: 2 };
        useWalletStore.getState().hydrateTokenMetadataOverrides({ [HELD]: previous });
        // What the read built: the placeholder with the override it read, 150000 base units at 2 decimals.
        const builtWith = { ...DEFAULT_TOKEN_METADATA, ...previous, scaleIsUnknown: false, scaleFromOverride: true };
        const read = useWalletStore.getState().fetchBalances('account-1', useWalletStore.getState().assetsMetadata);

        await useWalletStore.getState().setTokenMetadataOverride(HELD, { name: 'New', symbol: 'NEW', decimals: 4 });
        landRead([row(HELD, 1500, builtWith)]);
        await read;

        const landed = useWalletStore.getState().balances['account-1']![0]!;
        expect(landed.tokenSlug).toBe('NEW');
        expect(landed.balance).toBe(15);
        expect(landed.metadata).toMatchObject({ symbol: 'NEW', decimals: 4 });
        expect(useWalletStore.getState().balancesLoading['account-1']).toBe(false);
      });

      it('leaves the display row of a legacy faucet setting as the read built it', async () => {
        useWalletStore.getState().setAssetsMetadata({ [LEGACY]: { name: 'Legacy', symbol: 'LEGACY', decimals: 2 } });
        // The read built the display row before the legacy record reached it: the native display metadata.
        const display = getNativeDisplayMetadataSync(undefined, LEGACY);
        const read = useWalletStore.getState().fetchBalances('account-1', {});

        landRead([row(LEGACY, 5, display), row(FAUCET, 1.5, faucetMetadata)]);
        await read;

        const rows = useWalletStore.getState().balances['account-1']!;
        expect(rows[0]).toMatchObject({ tokenSlug: display.symbol, balance: 5, metadata: display });
        expect(rows[1]).toMatchObject({ tokenSlug: 'FCT', balance: 1.5, metadata: faucetMetadata });
      });
    });

    describe("the display row of the faucet-id setting's legacy faucet", () => {
      const LEGACY = 'mtst1legacy';
      const legacyRecord = { name: 'Legacy', symbol: 'LEGACY', decimals: 2 };
      const override = { name: 'Mine', symbol: 'MINE' };
      // The read built the display row before the legacy record reached it: the native display metadata.
      const display = getNativeDisplayMetadataSync(undefined, LEGACY);
      let landRead: (rows: unknown[]) => void = () => {};
      const land = async (account: string, rows: unknown[]) => {
        const read = useWalletStore.getState().fetchBalances(account, {});
        landRead(rows);
        await read;
      };
      const displayRow = (account: string) =>
        useWalletStore.getState().balances[account]!.find(entry => entry.tokenId === LEGACY)!;
      const expectAsBuilt = (account: string) => {
        expect(displayRow(account).tokenSlug).toBe(display.symbol);
        expect(displayRow(account)).toMatchObject({ balance: 5, metadata: display });
      };

      beforeEach(() => {
        useWalletStore.setState({ balancesDisplayFaucetId: {} });
        mockHeldBalanceRead = () =>
          new Promise(resolve => {
            landRead = resolve;
          });
        mockFaucetIdSetting = LEGACY;
        useWalletStore.getState().setAssetsMetadata({ [LEGACY]: legacyRecord });
      });

      afterEach(() => {
        mockHeldBalanceRead = null;
        mockFaucetIdSetting = undefined;
      });

      it("keeps the reader's build when the hydrate brings an override for that faucet", async () => {
        await land('account-1', [row(LEGACY, 5, display)]);

        useWalletStore.getState().hydrateTokenMetadataOverrides({ [LEGACY]: override });

        expectAsBuilt('account-1');
        expect(useWalletStore.getState().assetsMetadata[LEGACY]).toEqual({ ...legacyRecord, ...override });
      });

      it("keeps the reader's build when the user saves an override for that faucet", async () => {
        await land('account-1', [row(LEGACY, 5, display)]);

        await useWalletStore.getState().setTokenMetadataOverride(LEGACY, override);

        expectAsBuilt('account-1');
        expect(useWalletStore.getState().assetsMetadata[LEGACY]).toEqual({ ...legacyRecord, ...override });
      });

      it("keeps the reader's build when the user clears the override of that faucet", async () => {
        useWalletStore.getState().hydrateTokenMetadataOverrides({ [LEGACY]: override });
        await land('account-1', [row(LEGACY, 5, display)]);

        await useWalletStore.getState().clearTokenMetadataOverride(LEGACY);

        expectAsBuilt('account-1');
        expect(useWalletStore.getState().assetsMetadata[LEGACY]).toEqual(legacyRecord);
      });

      it('exempts no row before any read has landed', () => {
        useWalletStore.setState({ balances: { 'account-1': [row(LEGACY, 5, display)] } });

        useWalletStore.getState().hydrateTokenMetadataOverrides({ [LEGACY]: override });

        expect(displayRow('account-1').tokenSlug).toBe('MINE');
      });

      it('still applies the override to the row of an account whose read used no display faucet', async () => {
        await land('account-1', [row(LEGACY, 5, display)]);
        mockFaucetIdSetting = null;
        await land('account-2', [row(LEGACY, 1.25, legacyRecord)]);

        useWalletStore.getState().hydrateTokenMetadataOverrides({ [LEGACY]: override });

        expect(displayRow('account-2').tokenSlug).toBe('MINE');
        expect(displayRow('account-2')).toMatchObject({ balance: 1.25, metadata: { ...legacyRecord, ...override } });
      });

      it('lifts the exemption when a later read of that account used no display faucet', async () => {
        await land('account-1', [row(LEGACY, 5, display)]);
        mockFaucetIdSetting = null;
        await land('account-1', [row(LEGACY, 1.25, legacyRecord)]);

        useWalletStore.getState().hydrateTokenMetadataOverrides({ [LEGACY]: override });

        expect(displayRow('account-1').tokenSlug).toBe('MINE');
      });
    });

    describe('decimals the user stated while the scale was unknown', () => {
      const FRESH = 'mtst1fresh';
      const stated = { name: 'Mine', symbol: 'MN', decimals: 3 };
      const unknown = { name: 'Unknown', symbol: 'Unknown', decimals: 6, scaleIsUnknown: true };
      const retiredOverride = { name: 'Mine', symbol: 'MN' };

      it('are dropped when the faucet record with a known scale arrives through setAssetsMetadata', async () => {
        useWalletStore.getState().hydrateTokenMetadataOverrides({ [FRESH]: stated });

        useWalletStore.getState().setAssetsMetadata({ [FRESH]: faucetMetadata });
        await Promise.resolve();

        expect(mockWriteTokenMetadataOverride.mock.calls).toStrictEqual([[FRESH, retiredOverride]]);
        expect(useWalletStore.getState().tokenMetadataOverrides[FRESH]).toStrictEqual(retiredOverride);
        expect(useWalletStore.getState().assetsMetadata[FRESH]).toStrictEqual({
          name: 'Mine',
          symbol: 'MN',
          decimals: 8
        });
      });

      it('are dropped when the faucet record with a known scale arrives through fetchAssetMetadata', async () => {
        const { fetchTokenMetadata } = jest.requireMock('lib/miden/metadata');
        fetchTokenMetadata.mockResolvedValueOnce(faucetMetadata);
        useWalletStore.getState().hydrateTokenMetadataOverrides({ [FRESH]: stated });

        await useWalletStore.getState().fetchAssetMetadata(FRESH);

        expect(mockWriteTokenMetadataOverride.mock.calls).toStrictEqual([[FRESH, retiredOverride]]);
        expect(useWalletStore.getState().tokenMetadataOverrides[FRESH]).toStrictEqual(retiredOverride);
      });

      it('are dropped when the override arrives after the known record, and never for the native token', async () => {
        const native = { name: 'Miden', symbol: 'MIDEN', decimals: 6 };
        useWalletStore.getState().setAssetsMetadata({ [FRESH]: faucetMetadata, [NATIVE]: native });

        useWalletStore
          .getState()
          .hydrateTokenMetadataOverrides({ [FRESH]: stated, [NATIVE]: { name: 'Fake', symbol: 'FAKE', decimals: 1 } });
        await Promise.resolve();

        expect(mockWriteTokenMetadataOverride.mock.calls).toStrictEqual([[FRESH, retiredOverride]]);
        expect(useWalletStore.getState().tokenMetadataOverrides[FRESH]).toStrictEqual(retiredOverride);
      });

      it('stay while the faucet record arriving has an unknown scale', async () => {
        useWalletStore.getState().hydrateTokenMetadataOverrides({ [FRESH]: stated });

        useWalletStore.getState().setAssetsMetadata({ [FRESH]: unknown });
        await Promise.resolve();

        expect(mockWriteTokenMetadataOverride).not.toHaveBeenCalled();
        expect(useWalletStore.getState().tokenMetadataOverrides[FRESH]).toStrictEqual(stated);
        expect(useWalletStore.getState().assetsMetadata[FRESH]).toMatchObject({ decimals: 3, scaleFromOverride: true });
      });
    });
  });

  describe('UI actions', () => {
    it('setSelectedNetworkId updates network', () => {
      const { setSelectedNetworkId } = useWalletStore.getState();
      setSelectedNetworkId('network-1');

      expect(useWalletStore.getState().selectedNetworkId).toBe('network-1');
    });

    it('setConfirmation and resetConfirmation work correctly', () => {
      const { setConfirmation, resetConfirmation } = useWalletStore.getState();

      setConfirmation({ id: 'confirm-1', error: null });
      expect(useWalletStore.getState().confirmation).toEqual({ id: 'confirm-1', error: null });

      resetConfirmation();
      expect(useWalletStore.getState().confirmation).toBeNull();
    });
  });

  describe('Auth actions', () => {
    it('registerWallet sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.NewWalletResponse });

      const { registerWallet } = useWalletStore.getState();
      await registerWallet(WalletType.Guardian, 'password123', 'mnemonic words', true);

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.NewWalletRequest,
        walletType: WalletType.Guardian,
        password: 'password123',
        mnemonic: 'mnemonic words',
        ownMnemonic: true
      });
    });

    it('importWalletFromClient sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.ImportFromClientResponse });
      const importedAccounts = [
        { accountId: 'account-id', publicKeyCommitment: 'a1b2', authScheme: 'falcon' as const, secretKeyHex: '0102' }
      ];

      const { importWalletFromClient } = useWalletStore.getState();
      await importWalletFromClient('password123', 'mnemonic words', [], importedAccounts);

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.ImportFromClientRequest,
        password: 'password123',
        mnemonic: 'mnemonic words',
        walletAccounts: [],
        importedAccounts
      });
    });

    it('unlock sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.UnlockResponse });

      const { unlock } = useWalletStore.getState();
      await unlock('password123');

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.UnlockRequest,
        password: 'password123'
      });
    });

    it('unlock throws on invalid response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'WrongType' });

      const { unlock } = useWalletStore.getState();
      await expect(unlock('password123')).rejects.toThrow('Invalid response');
    });
  });

  describe('Account actions', () => {
    it('createAccount sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.CreateAccountResponse });
      // createAccount now pulls fresh state right after the create response lands.
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.GetStateResponse,
        state: { status: WalletStatus.Idle, accounts: [], networks: {}, settings: {}, ownMnemonic: false }
      });

      const { createAccount } = useWalletStore.getState();
      await createAccount(WalletType.OnChain, 'My Account');

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.CreateAccountRequest,
        walletType: WalletType.OnChain,
        name: 'My Account'
      });
    });

    it('revealMnemonic returns mnemonic from response', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.RevealMnemonicResponse,
        mnemonic: 'word1 word2 word3'
      });

      const { revealMnemonic } = useWalletStore.getState();
      const result = await revealMnemonic('password123');

      expect(result).toBe('word1 word2 word3');
      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.RevealMnemonicRequest,
        password: 'password123'
      });
    });

    it('revealPrivateKey returns hex secret from response', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.RevealPrivateKeyResponse,
        privateKey: 'aabbccdd'
      });

      const { revealPrivateKey } = useWalletStore.getState();
      const result = await revealPrivateKey('pk1', 'password123');

      expect(result).toBe('aabbccdd');
      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.RevealPrivateKeyRequest,
        accountPublicKey: 'pk1',
        password: 'password123'
      });
    });

    it('exportAccountFile decodes through the imported Buffer, not a broken global one', async () => {
      // A global Buffer whose from() ignores the encoding argument (public/globals.js once installed
      // one on every extension page) returns an EMPTY array for a bare global decode, so the user is
      // handed a 0-byte account file with a success message. Jest runs on Node, where the real global
      // hides that entirely.
      const realBuffer = (globalThis as any).Buffer;
      (globalThis as any).Buffer = { isBuffer: () => false, from: (a: unknown) => new Uint8Array(a as number) };
      try {
        mockRequest.mockResolvedValueOnce({
          type: WalletMessageType.ExportAccountFileResponse,
          accountFileBase64: 'BAUG'
        });

        const { exportAccountFile } = useWalletStore.getState();

        await expect(exportAccountFile('mtst1account', 'password123')).resolves.toEqual(new Uint8Array([4, 5, 6]));
      } finally {
        (globalThis as any).Buffer = realBuffer;
      }
    });

    it('exportAccountFile decodes the base64 response into bytes', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.ExportAccountFileResponse,
        accountFileBase64: 'BAUG'
      });

      const { exportAccountFile } = useWalletStore.getState();
      const result = await exportAccountFile('mtst1account', 'password123');

      expect(result).toEqual(new Uint8Array([4, 5, 6]));
      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.ExportAccountFileRequest,
        accountPublicKey: 'mtst1account',
        password: 'password123'
      });
    });

    it('exportWalletBackupMaterial returns the dedicated snapshot response', async () => {
      const material = { seedPhrase: 'seed', accounts: [], midenClientDbContent: 'db', importedAccounts: [] };
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.ExportWalletBackupMaterialResponse,
        material
      });

      const result = await useWalletStore.getState().exportWalletBackupMaterial('password123');

      expect(result).toBe(material);
      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.ExportWalletBackupMaterialRequest,
        password: 'password123'
      });
    });

    it('importAccount returns new account public key from response', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.ImportAccountResponse,
        accountPublicKey: 'imported-pk'
      });

      const { importAccount } = useWalletStore.getState();
      const result = await importAccount('aabbccdd', 'My Imported');

      expect(result).toBe('imported-pk');
      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.ImportAccountRequest,
        privateKey: 'aabbccdd',
        name: 'My Imported'
      });
    });
  });

  describe('Signing actions', () => {
    it('signData returns signature', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.SignDataResponse,
        signature: 'sig123'
      });

      const { signData } = useWalletStore.getState();
      const result = await signData('pk1', 'data-to-sign');

      expect(result).toBe('sig123');
    });

    it('signTransaction returns Uint8Array from hex', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.SignTransactionResponse,
        signature: 'abcd'
      });

      const { signTransaction } = useWalletStore.getState();
      const result = await signTransaction('pk1', 'tx-data');

      expect(result).toEqual(new Uint8Array([0xab, 0xcd]));
    });

    it('getAuthSecretKey returns key', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.GetAuthSecretKeyResponse,
        key: 'secret-key-123'
      });

      const { getAuthSecretKey } = useWalletStore.getState();
      const result = await getAuthSecretKey('key-id');

      expect(result).toBe('secret-key-123');
    });

    it('signWord posts a SignWordRequest and returns the signature string', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.SignWordResponse,
        signature: '0xword-sig'
      });

      const { signWord } = useWalletStore.getState();
      const result = await signWord('pub-key', '0xword-hex');

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.SignWordRequest,
        publicKey: 'pub-key',
        wordHex: '0xword-hex'
      });
      expect(result).toBe('0xword-sig');
    });

    it('signWord throws on a type-mismatched response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'WrongType' });

      const { signWord } = useWalletStore.getState();
      await expect(signWord('pk', 'word')).rejects.toThrow('Invalid response');
    });

    it('getPublicKeyForCommitment posts a GetPublicKeyForCommitmentRequest and returns the pubkey', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.GetPublicKeyForCommitmentResponse,
        publicKey: 'derived-pub-key'
      });

      const { getPublicKeyForCommitment } = useWalletStore.getState();
      const result = await getPublicKeyForCommitment('commit-hash');

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.GetPublicKeyForCommitmentRequest,
        commitment: 'commit-hash'
      });
      expect(result).toBe('derived-pub-key');
    });

    it('getPublicKeyForCommitment throws on a type-mismatched response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'WrongType' });

      const { getPublicKeyForCommitment } = useWalletStore.getState();
      await expect(getPublicKeyForCommitment('x')).rejects.toThrow('Invalid response');
    });

    it('swapHotKey posts a SwapHotKeyRequest carrying the expectation (#1233)', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.SwapHotKeyResponse });

      const { swapHotKey } = useWalletStore.getState();
      await swapHotKey('acc', 'new-pub', null);

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.SwapHotKeyRequest,
        accountPublicKey: 'acc',
        newHotPubKey: 'new-pub',
        expectedHotPubKey: null
      });
    });

    // A completion passes no expectation, and a null one would refuse every keyed swap (#1233).
    it('swapHotKey posts no expectation when the caller passes none (#1233)', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.SwapHotKeyResponse });

      const { swapHotKey } = useWalletStore.getState();
      await swapHotKey('acc', 'new-pub');

      expect(mockRequest.mock.calls[0]?.[0]).toEqual({
        type: WalletMessageType.SwapHotKeyRequest,
        accountPublicKey: 'acc',
        newHotPubKey: 'new-pub'
      });
    });

    it('setGuardianOperatorCommitment posts a SetGuardianOperatorCommitmentRequest', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.SetGuardianOperatorCommitmentResponse });

      const { setGuardianOperatorCommitment } = useWalletStore.getState();
      await setGuardianOperatorCommitment('pub-key', 'commitment-hex');

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.SetGuardianOperatorCommitmentRequest,
        accountPublicKey: 'pub-key',
        guardianOperatorCommitment: 'commitment-hex'
      });
    });

    it('setGuardianOperatorCommitment throws on a type-mismatched response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'WrongType' });

      const { setGuardianOperatorCommitment } = useWalletStore.getState();
      await expect(setGuardianOperatorCommitment('pk', 'commitment-hex')).rejects.toThrow('Invalid response');
    });

    it('setGuardianSyncStatus posts a SetGuardianSyncStatusRequest', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.SetGuardianSyncStatusResponse });

      const { setGuardianSyncStatus } = useWalletStore.getState();
      await setGuardianSyncStatus('pub-key', 'needs-user-input');

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.SetGuardianSyncStatusRequest,
        accountPublicKey: 'pub-key',
        guardianSyncStatus: 'needs-user-input'
      });
    });

    it('setGuardianSyncStatus throws on a type-mismatched response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'WrongType' });

      const { setGuardianSyncStatus } = useWalletStore.getState();
      await expect(setGuardianSyncStatus('pk', 'needs-user-input')).rejects.toThrow('Invalid response');
    });

    it('checkGuardianDrift posts a CheckGuardianDriftRequest and returns the resolved status', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.CheckGuardianDriftResponse,
        guardianSyncStatus: 'needs-user-input'
      });

      const { checkGuardianDrift } = useWalletStore.getState();
      const status = await checkGuardianDrift('pub-key');

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.CheckGuardianDriftRequest,
        accountPublicKey: 'pub-key'
      });
      expect(status).toBe('needs-user-input');
    });

    it('checkGuardianDrift throws on a type-mismatched response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'WrongType' });

      const { checkGuardianDrift } = useWalletStore.getState();
      await expect(checkGuardianDrift('pk')).rejects.toThrow('Invalid response');
    });

    it('applyUserGuardianEndpoint posts an ApplyUserGuardianEndpointRequest and returns the outcome', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.ApplyUserGuardianEndpointResponse,
        outcome: 'applied'
      });

      const { applyUserGuardianEndpoint } = useWalletStore.getState();
      const outcome = await applyUserGuardianEndpoint('pub-key', 'https://mine');

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.ApplyUserGuardianEndpointRequest,
        accountPublicKey: 'pub-key',
        guardianEndpoint: 'https://mine'
      });
      expect(outcome).toBe('applied');
    });

    it('applyUserGuardianEndpoint throws on a type-mismatched response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'WrongType' });

      const { applyUserGuardianEndpoint } = useWalletStore.getState();
      await expect(applyUserGuardianEndpoint('pk', 'https://mine')).rejects.toThrow('Invalid response');
    });
  });

  describe('Asset actions', () => {
    it('fetchAssetMetadata fetches and stores metadata', async () => {
      const { fetchTokenMetadata } = jest.requireMock('lib/miden/metadata');
      fetchTokenMetadata.mockResolvedValueOnce({ name: 'New Token', symbol: 'NEW', decimals: 6 });

      const { fetchAssetMetadata } = useWalletStore.getState();
      const result = await fetchAssetMetadata('asset-id');

      expect(result).toEqual({ name: 'New Token', symbol: 'NEW', decimals: 6 });
      expect(useWalletStore.getState().assetsMetadata['asset-id']).toEqual({
        name: 'New Token',
        symbol: 'NEW',
        decimals: 6
      });
    });

    it('fetchAssetMetadata returns null on error', async () => {
      const { fetchTokenMetadata } = jest.requireMock('lib/miden/metadata');
      fetchTokenMetadata.mockRejectedValueOnce(new Error('Not found'));

      const { fetchAssetMetadata } = useWalletStore.getState();
      const result = await fetchAssetMetadata('unknown-asset');

      expect(result).toBeNull();
    });
  });

  describe('DApp actions', () => {
    it('getDAppPayload returns payload from response', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppGetPayloadResponse,
        payload: { someData: 'test' }
      });

      const { getDAppPayload } = useWalletStore.getState();
      const result = await getDAppPayload('request-id');

      expect(result).toEqual({ someData: 'test' });
      expect(mockRequest).toHaveBeenCalledWith({
        type: MidenMessageType.DAppGetPayloadRequest,
        id: 'request-id'
      });
    });

    it('confirmDAppPermission sends correct request when confirmed', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppPermConfirmationResponse
      });

      const { confirmDAppPermission } = useWalletStore.getState();
      await confirmDAppPermission('req-id', true, 'account-123', 'none' as any, {} as any);

      expect(mockRequest).toHaveBeenCalledWith({
        type: MidenMessageType.DAppPermConfirmationRequest,
        id: 'req-id',
        confirmed: true,
        accountPublicKey: 'account-123',
        privateDataPermission: 'none',
        allowedPrivateData: {}
      });
    });

    it('confirmDAppPermission sends empty account when not confirmed', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppPermConfirmationResponse
      });

      const { confirmDAppPermission } = useWalletStore.getState();
      await confirmDAppPermission('req-id', false, 'account-123', 'none' as any, {} as any);

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmed: false,
          accountPublicKey: ''
        })
      );
    });

    it('confirmDAppSign sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppSignConfirmationResponse
      });

      const { confirmDAppSign } = useWalletStore.getState();
      await confirmDAppSign('req-id', true);

      expect(mockRequest).toHaveBeenCalledWith({
        type: MidenMessageType.DAppSignConfirmationRequest,
        id: 'req-id',
        confirmed: true
      });
    });

    it('confirmDAppPrivateNotes sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppPrivateNotesConfirmationResponse
      });

      const { confirmDAppPrivateNotes } = useWalletStore.getState();
      await confirmDAppPrivateNotes('req-id', true);

      expect(mockRequest).toHaveBeenCalledWith({
        type: MidenMessageType.DAppPrivateNotesConfirmationRequest,
        id: 'req-id',
        confirmed: true
      });
    });

    it('confirmDAppAssets sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppAssetsConfirmationResponse
      });

      const { confirmDAppAssets } = useWalletStore.getState();
      await confirmDAppAssets('req-id', false);

      expect(mockRequest).toHaveBeenCalledWith({
        type: MidenMessageType.DAppAssetsConfirmationRequest,
        id: 'req-id',
        confirmed: false
      });
    });

    it('confirmDAppImportPrivateNote sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppImportPrivateNoteConfirmationResponse
      });

      const { confirmDAppImportPrivateNote } = useWalletStore.getState();
      await confirmDAppImportPrivateNote('req-id', true);

      expect(mockRequest).toHaveBeenCalledWith({
        type: MidenMessageType.DAppImportPrivateNoteConfirmationRequest,
        id: 'req-id',
        confirmed: true
      });
    });

    it('confirmDAppConsumableNotes sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppConsumableNotesConfirmationResponse
      });

      const { confirmDAppConsumableNotes } = useWalletStore.getState();
      await confirmDAppConsumableNotes('req-id', true);

      expect(mockRequest).toHaveBeenCalledWith({
        type: MidenMessageType.DAppConsumableNotesConfirmationRequest,
        id: 'req-id',
        confirmed: true
      });
    });

    it('confirmDAppTransaction sends strict-authentication success only when supplied', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppTransactionConfirmationResponse
      });

      const { confirmDAppTransaction } = useWalletStore.getState();
      await confirmDAppTransaction('req-id', true, true, true);

      expect(mockRequest).toHaveBeenCalledWith({
        type: MidenMessageType.DAppTransactionConfirmationRequest,
        id: 'req-id',
        confirmed: true,
        delegate: true,
        spendingLimitAuthenticated: true
      });
    });

    it('getAllDAppSessions returns sessions from response', async () => {
      const mockSessions = { 'https://example.com': [{ accountId: 'acc1' }] };
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppGetAllSessionsResponse,
        sessions: mockSessions
      });

      const { getAllDAppSessions } = useWalletStore.getState();
      const result = await getAllDAppSessions();

      expect(result).toEqual(mockSessions);
    });

    it('removeDAppSession sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppRemoveSessionResponse
      });

      const { removeDAppSession } = useWalletStore.getState();
      await removeDAppSession('https://example.com');

      expect(mockRequest).toHaveBeenCalledWith({
        type: MidenMessageType.DAppRemoveSessionRequest,
        origin: 'https://example.com'
      });
    });
  });

  describe('Fiat currency actions', () => {
    it('setSelectedFiatCurrency updates currency', () => {
      const { setSelectedFiatCurrency } = useWalletStore.getState();
      const eurCurrency = { name: 'EUR' as any, fullname: 'Euro', apiLabel: 'eur', symbol: '€' };
      setSelectedFiatCurrency(eurCurrency);

      expect(useWalletStore.getState().selectedFiatCurrency).toEqual(eurCurrency);
    });

    it('setFiatRates updates rates', () => {
      const { setFiatRates } = useWalletStore.getState();
      const rates = { usd: 1.5, eur: 1.3 };
      setFiatRates(rates);

      expect(useWalletStore.getState().fiatRates).toEqual(rates);
    });

    it('fetchFiatRates fetches and sets rates', async () => {
      const { fetchFiatRates } = useWalletStore.getState();
      await fetchFiatRates();

      const state = useWalletStore.getState();
      expect(state.fiatRates).toEqual({ usd: 1 });
      expect(state.fiatRatesLoading).toBe(false);
    });

    it('fetchFiatRates skips if already loading', async () => {
      useWalletStore.setState({ fiatRatesLoading: true });

      const { fetchFiatRates } = useWalletStore.getState();
      await fetchFiatRates();

      // Should not change anything since it's already loading
      expect(useWalletStore.getState().fiatRatesLoading).toBe(true);
    });
  });

  describe('Request error handling', () => {
    it('throws when response has no type property', async () => {
      // Return a response without 'type' property
      mockRequest.mockResolvedValueOnce({ data: 'no type field' });

      const { unlock } = useWalletStore.getState();
      await expect(unlock('password123')).rejects.toThrow('Invalid response received.');
    });
  });

  describe('Selectors', () => {
    it('selectIsReady returns true when status is Ready', () => {
      const state = { status: WalletStatus.Ready } as any;
      expect(selectIsReady(state)).toBe(true);
    });

    it('selectIsReady returns false for other statuses', () => {
      expect(selectIsReady({ status: WalletStatus.Locked } as any)).toBe(false);
      expect(selectIsReady({ status: WalletStatus.Idle } as any)).toBe(false);
    });

    it('selectIsLocked returns true when status is Locked', () => {
      const state = { status: WalletStatus.Locked } as any;
      expect(selectIsLocked(state)).toBe(true);
    });

    it('selectIsLocked returns false for other statuses', () => {
      expect(selectIsLocked({ status: WalletStatus.Ready } as any)).toBe(false);
      expect(selectIsLocked({ status: WalletStatus.Idle } as any)).toBe(false);
    });

    it('selectIsIdle returns true when status is Idle', () => {
      const state = { status: WalletStatus.Idle } as any;
      expect(selectIsIdle(state)).toBe(true);
    });

    it('selectIsIdle returns false for other statuses', () => {
      expect(selectIsIdle({ status: WalletStatus.Ready } as any)).toBe(false);
      expect(selectIsIdle({ status: WalletStatus.Locked } as any)).toBe(false);
    });
  });

  describe('getIntercom', () => {
    it('returns singleton IntercomClient', () => {
      const client1 = getIntercom();
      const client2 = getIntercom();
      expect(client1).toBe(client2);
    });
  });

  describe('reloadEndpointOverridesInSW', () => {
    it('sends a ReloadEndpointOverridesRequest and resolves on completion', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.ReloadEndpointOverridesResponse });
      await expect(reloadEndpointOverridesInSW()).resolves.toBeUndefined();
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ type: WalletMessageType.ReloadEndpointOverridesRequest })
      );
    });

    it('swallows a failed request instead of rejecting', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockRequest.mockRejectedValueOnce(new Error('port disconnected'));

      await expect(reloadEndpointOverridesInSW()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith('[reloadEndpointOverridesInSW] failed to nudge SW:', expect.any(Error));

      warnSpy.mockRestore();
    });

    it('resolves after a bounded timeout instead of hanging forever when the request never settles (e.g. the SW port disconnects mid-request, which IntercomClient does not surface as a rejection)', async () => {
      jest.useFakeTimers();
      try {
        mockRequest.mockImplementationOnce(() => new Promise(() => {})); // never settles

        const settled = jest.fn();
        reloadEndpointOverridesInSW().then(settled);

        // Still pending well before the timeout — proves this isn't just a same-tick resolve.
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(4000);
        expect(settled).toHaveBeenCalledTimes(1);
        expect(settled).toHaveBeenCalledWith(undefined);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ── Additional coverage for action methods ────────────────────────

  describe('registerWallet / importWalletFromClient / unlock', () => {
    it('registerWallet sends NewWalletRequest', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.NewWalletResponse });
      await useWalletStore.getState().registerWallet(WalletType.Guardian, 'pw', 'mnemonic-12', false);
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ type: WalletMessageType.NewWalletRequest, password: 'pw' })
      );
    });

    it('registerWallet throws on invalid response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'wrong' });
      await expect(useWalletStore.getState().registerWallet(WalletType.Guardian, 'pw', 'm', false)).rejects.toThrow();
    });

    it('importWalletFromClient sends ImportFromClientRequest', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.ImportFromClientResponse });
      const importedAccounts = [
        { accountId: 'account-id', publicKeyCommitment: 'a1b2', authScheme: 'falcon' as const, secretKeyHex: '0102' }
      ];
      await useWalletStore.getState().importWalletFromClient('pw', 'm', [], importedAccounts);
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          type: WalletMessageType.ImportFromClientRequest,
          importedAccounts
        })
      );
    });

    it('unlock sends UnlockRequest', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.UnlockResponse });
      await useWalletStore.getState().unlock('pw');
      expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ type: WalletMessageType.UnlockRequest }));
    });
  });

  describe('createAccount', () => {
    it('sends CreateAccountRequest with walletType and name', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.CreateAccountResponse });
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.GetStateResponse,
        state: { status: WalletStatus.Idle, accounts: [], networks: {}, settings: {}, ownMnemonic: false }
      });
      await useWalletStore.getState().createAccount(WalletType.OnChain, 'My Account');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          type: WalletMessageType.CreateAccountRequest,
          walletType: WalletType.OnChain,
          name: 'My Account'
        })
      );
    });

    it('throws on invalid response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'wrong' });
      await expect(useWalletStore.getState().createAccount(WalletType.OnChain, 'x')).rejects.toThrow();
    });
  });

  describe('revealMnemonic', () => {
    it('returns the mnemonic from the response', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.RevealMnemonicResponse,
        mnemonic: 'twelve words go here'
      });
      const result = await useWalletStore.getState().revealMnemonic('pw');
      expect(result).toBe('twelve words go here');
    });
  });

  describe('signing actions', () => {
    it('signData returns signature', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.SignDataResponse,
        signature: 'sig-base64'
      });
      const sig = await useWalletStore.getState().signData('pk', 'inputs');
      expect(sig).toBe('sig-base64');
    });

    it('signTransaction returns signature as Uint8Array from hex', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.SignTransactionResponse,
        signature: 'deadbeef'
      });
      const result = await useWalletStore.getState().signTransaction('pk', 'inputs');
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it('getAuthSecretKey returns key from response', async () => {
      mockRequest.mockResolvedValueOnce({
        type: WalletMessageType.GetAuthSecretKeyResponse,
        key: 'secret-key-bytes'
      });
      const k = await useWalletStore.getState().getAuthSecretKey('pk');
      expect(k).toBe('secret-key-bytes');
    });
  });

  describe('dApp actions', () => {
    it('getDAppPayload returns payload', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppGetPayloadResponse,
        payload: { foo: 'bar' }
      });
      const p = await useWalletStore.getState().getDAppPayload('id-1');
      expect(p).toEqual({ foo: 'bar' });
    });

    it('confirmDAppPermission sends with confirmed=true and account', async () => {
      mockRequest.mockResolvedValueOnce({ type: MidenMessageType.DAppPermConfirmationResponse });
      await useWalletStore.getState().confirmDAppPermission('id-1', true, 'acc-1', 'AUTO' as any, 1);
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MidenMessageType.DAppPermConfirmationRequest,
          confirmed: true,
          accountPublicKey: 'acc-1'
        })
      );
    });

    it('confirmDAppPermission with confirmed=false sends empty accountPublicKey', async () => {
      mockRequest.mockResolvedValueOnce({ type: MidenMessageType.DAppPermConfirmationResponse });
      await useWalletStore.getState().confirmDAppPermission('id-1', false, 'acc-1', 'AUTO' as any, 1);
      expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ accountPublicKey: '' }));
    });

    it('confirmDAppSign / confirmDAppPrivateNotes / confirmDAppAssets / confirmDAppImportPrivateNote / confirmDAppConsumableNotes / confirmDAppTransaction send their respective request types', async () => {
      const cases: Array<[string, () => Promise<void>, MidenMessageType]> = [
        [
          'sign',
          () => useWalletStore.getState().confirmDAppSign('id', true),
          MidenMessageType.DAppSignConfirmationResponse
        ],
        [
          'private notes',
          () => useWalletStore.getState().confirmDAppPrivateNotes('id', true),
          MidenMessageType.DAppPrivateNotesConfirmationResponse
        ],
        [
          'assets',
          () => useWalletStore.getState().confirmDAppAssets('id', true),
          MidenMessageType.DAppAssetsConfirmationResponse
        ],
        [
          'import note',
          () => useWalletStore.getState().confirmDAppImportPrivateNote('id', true),
          MidenMessageType.DAppImportPrivateNoteConfirmationResponse
        ],
        [
          'consumable notes',
          () => useWalletStore.getState().confirmDAppConsumableNotes('id', true),
          MidenMessageType.DAppConsumableNotesConfirmationResponse
        ],
        [
          'transaction',
          () => useWalletStore.getState().confirmDAppTransaction('id', true, true),
          MidenMessageType.DAppTransactionConfirmationResponse
        ]
      ];
      for (const [, fn, responseType] of cases) {
        mockRequest.mockResolvedValueOnce({ type: responseType });
        await fn();
      }
      expect(mockRequest).toHaveBeenCalledTimes(cases.length);
    });

    it('getAllDAppSessions returns sessions map', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppGetAllSessionsResponse,
        sessions: { 'origin.xyz': [] }
      });
      const sessions = await useWalletStore.getState().getAllDAppSessions();
      expect(sessions).toEqual({ 'origin.xyz': [] });
    });

    it('removeDAppSession sends DAppRemoveSessionRequest', async () => {
      mockRequest.mockResolvedValueOnce({ type: MidenMessageType.DAppRemoveSessionResponse });
      await useWalletStore.getState().removeDAppSession('origin.xyz');
      expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ origin: 'origin.xyz' }));
    });
  });

  describe('UI actions (network, confirmation)', () => {
    it('setSelectedNetworkId / setConfirmation / resetConfirmation', () => {
      useWalletStore.getState().setSelectedNetworkId('n1');
      expect(useWalletStore.getState().selectedNetworkId).toBe('n1');
      useWalletStore.getState().setConfirmation({ id: 'c1' } as any);
      expect(useWalletStore.getState().confirmation?.id).toBe('c1');
      useWalletStore.getState().resetConfirmation();
      expect(useWalletStore.getState().confirmation).toBeNull();
    });
  });

  describe('balance + asset actions', () => {
    it('setBalancesLoading flips the per-account flag', () => {
      useWalletStore.getState().setBalancesLoading('addr-1', true);
      expect(useWalletStore.getState().balancesLoading['addr-1']).toBe(true);
      useWalletStore.getState().setBalancesLoading('addr-1', false);
      expect(useWalletStore.getState().balancesLoading['addr-1']).toBe(false);
    });

    it('setAssetsMetadata merges new metadata', () => {
      useWalletStore.getState().setAssetsMetadata({ 'asset-1': { decimals: 6, symbol: 'A' } as any });
      expect(useWalletStore.getState().assetsMetadata['asset-1']).toBeDefined();
    });

    it('fetchAssetMetadata persists metadata when fetch succeeds', async () => {
      const fetchTokenMetadata = require('lib/miden/metadata').fetchTokenMetadata;
      fetchTokenMetadata.mockResolvedValueOnce({ decimals: 8, symbol: 'X' });
      const result = await useWalletStore.getState().fetchAssetMetadata('asset-x');
      expect(result).toEqual({ decimals: 8, symbol: 'X' });
      expect(useWalletStore.getState().assetsMetadata['asset-x']).toEqual({ decimals: 8, symbol: 'X' });
    });

    it('fetchAssetMetadata returns null on fetch error', async () => {
      const fetchTokenMetadata = require('lib/miden/metadata').fetchTokenMetadata;
      fetchTokenMetadata.mockRejectedValueOnce(new Error('rpc down'));
      expect(await useWalletStore.getState().fetchAssetMetadata('asset-y')).toBeNull();
    });
  });

  describe('fiat currency actions', () => {
    it('setSelectedFiatCurrency / setFiatRates / setTokenPrices', () => {
      useWalletStore.getState().setSelectedFiatCurrency('USD' as any);
      expect(useWalletStore.getState().selectedFiatCurrency).toBe('USD');
      useWalletStore.getState().setFiatRates({ usd: 1 });
      expect(useWalletStore.getState().fiatRates).toEqual({ usd: 1 });
      useWalletStore.getState().setTokenPrices({ ETH: { price: 3000, change24h: 1, percentageChange24h: 0.1 } });
      expect(useWalletStore.getState().tokenPrices.ETH?.price).toBe(3000);
    });

    it('fetchFiatRates resolves with placeholder rates', async () => {
      useWalletStore.setState({ fiatRatesLoading: false });
      await useWalletStore.getState().fetchFiatRates();
      expect(useWalletStore.getState().fiatRates).toEqual({ usd: 1 });
      expect(useWalletStore.getState().fiatRatesLoading).toBe(false);
    });

    it('fetchFiatRates is a no-op when already loading', async () => {
      useWalletStore.setState({ fiatRatesLoading: true, fiatRates: { usd: 99 } });
      await useWalletStore.getState().fetchFiatRates();
      expect(useWalletStore.getState().fiatRates?.usd).toBe(99);
    });
  });

  // Price helpers read the switch outside React, so a memo keyed on tokenPrices recomputes only when
  // the switch hands it a new object.
  describe('nominal unquoted price switch', () => {
    const prices = { ETH: { price: 3000, change24h: 1, percentageChange24h: 0.1 } };

    beforeEach(() => {
      useWalletStore.getState().setTokenPrices(prices);
    });

    afterEach(() => {
      localStorage.removeItem(NOMINAL_UNQUOTED_PRICE_STORAGE_KEY);
    });

    it('republishes tokenPrices as a new object with the same entries when the switch is toggled', () => {
      setNominalUnquotedPriceSetting(true);
      expect(useWalletStore.getState().tokenPrices).not.toBe(prices);
      expect(useWalletStore.getState().tokenPrices).toEqual(prices);
    });

    it('republishes tokenPrices when another window toggles the switch, and fetches no prices', () => {
      const priceFetch = jest.spyOn(axios, 'get');
      localStorage.setItem(NOMINAL_UNQUOTED_PRICE_STORAGE_KEY, 'on');
      window.dispatchEvent(new StorageEvent('storage', { key: NOMINAL_UNQUOTED_PRICE_STORAGE_KEY, newValue: 'on' }));
      expect(useWalletStore.getState().tokenPrices).not.toBe(prices);
      expect(useWalletStore.getState().tokenPrices).toEqual(prices);
      expect(priceFetch).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
      priceFetch.mockRestore();
    });

    it('keeps tokenPrices identity on a storage event for another key', () => {
      window.dispatchEvent(new StorageEvent('storage', { key: CARD_COLOR_STORAGE_KEY, newValue: 'blue' }));
      expect(useWalletStore.getState().tokenPrices).toBe(prices);
    });
  });

  describe('fetchBalances', () => {
    it('skips while another reader has that address in flight', async () => {
      useWalletStore.setState({ balances: {}, balancesLoading: {} });
      fetchingAddresses.add('addr-1');
      try {
        await useWalletStore.getState().fetchBalances('addr-1', {});
        // No read started, so nothing changed (no-op)
        expect(useWalletStore.getState().balancesLoading['addr-1']).toBeUndefined();
        expect(useWalletStore.getState().balances['addr-1']).toBeUndefined();
      } finally {
        fetchingAddresses.clear();
      }
    });
  });

  describe('sync + transaction UI actions', () => {
    it('setSyncStatus marks initial sync done when transitioning to false', () => {
      useWalletStore.getState().setSyncStatus(true);
      expect(useWalletStore.getState().isSyncing).toBe(true);
      useWalletStore.getState().setSyncStatus(false);
      expect(useWalletStore.getState().isSyncing).toBe(false);
      expect(useWalletStore.getState().hasCompletedInitialSync).toBe(true);
    });

    it('setLastCompletedTxHash stores and clears the hash', () => {
      useWalletStore.getState().setLastCompletedTxHash('0xabc');
      expect(useWalletStore.getState().lastCompletedTxHash).toBe('0xabc');
      useWalletStore.getState().setLastCompletedTxHash(null);
      expect(useWalletStore.getState().lastCompletedTxHash).toBeNull();
    });
  });

  describe('dApp browser state', () => {
    it('setDappBrowserOpen + setActiveDappSession transition correctly', () => {
      useWalletStore.getState().setActiveDappSession('session-1');
      expect(useWalletStore.getState().activeDappSessionId).toBe('session-1');
      expect(useWalletStore.getState().isDappBrowserOpen).toBe(true);
      useWalletStore.getState().setDappBrowserOpen(false);
      expect(useWalletStore.getState().isDappBrowserOpen).toBe(false);
      expect(useWalletStore.getState().activeDappSessionId).toBeNull();
    });

    it('setDappBrowserOpen(true) preserves existing activeDappSessionId', () => {
      useWalletStore.setState({ activeDappSessionId: 'pre-existing' });
      useWalletStore.getState().setDappBrowserOpen(true);
      expect(useWalletStore.getState().activeDappSessionId).toBe('pre-existing');
    });
  });

  describe('note toast actions', () => {
    beforeEach(() => {
      useWalletStore.setState({
        seenNoteIds: new Set<string>(),
        isNoteToastVisible: false,
        noteToastShownAt: null
      });
    });

    it('checkForNewNotes shows toast when new notes arrive', () => {
      useWalletStore.getState().checkForNewNotes(['n1', 'n2']);
      const state = useWalletStore.getState();
      expect(state.isNoteToastVisible).toBe(true);
      expect(state.seenNoteIds.has('n1')).toBe(true);
      expect(state.seenNoteIds.has('n2')).toBe(true);
    });

    it('checkForNewNotes does not show toast when nothing is new', () => {
      useWalletStore.setState({ seenNoteIds: new Set(['n1']) });
      useWalletStore.getState().checkForNewNotes(['n1']);
      expect(useWalletStore.getState().isNoteToastVisible).toBe(false);
    });

    it('checkForNewNotes records every new note as seen and toasts for a notifiable one', () => {
      useWalletStore.getState().checkForNewNotes(['auto', 'manual'], ['manual']);
      const state = useWalletStore.getState();
      expect(state.isNoteToastVisible).toBe(true);
      expect(state.seenNoteIds.has('auto')).toBe(true);
      expect(state.seenNoteIds.has('manual')).toBe(true);
    });

    it('checkForNewNotes records a new note outside the notifiable set without a toast', () => {
      useWalletStore.getState().checkForNewNotes(['auto'], []);
      const state = useWalletStore.getState();
      expect(state.isNoteToastVisible).toBe(false);
      expect(state.noteToastShownAt).toBeNull();
      expect(state.seenNoteIds.has('auto')).toBe(true);
    });

    it('checkForNewNotes does not toast when the only notifiable id was already seen', () => {
      useWalletStore.setState({ seenNoteIds: new Set(['manual']) });
      useWalletStore.getState().checkForNewNotes(['manual', 'auto'], ['manual']);
      const state = useWalletStore.getState();
      expect(state.isNoteToastVisible).toBe(false);
      expect(state.noteToastShownAt).toBeNull();
      expect(state.seenNoteIds.has('auto')).toBe(true);
    });

    it('dismissNoteToast hides the toast', () => {
      useWalletStore.setState({ isNoteToastVisible: true });
      useWalletStore.getState().dismissNoteToast();
      expect(useWalletStore.getState().isNoteToastVisible).toBe(false);
    });

    it('resetSeenNotes clears the set and visible flag', () => {
      useWalletStore.setState({
        seenNoteIds: new Set(['a']),
        isNoteToastVisible: true,
        noteToastShownAt: 123
      });
      useWalletStore.getState().resetSeenNotes();
      const s = useWalletStore.getState();
      expect(s.seenNoteIds.size).toBe(0);
      expect(s.isNoteToastVisible).toBe(false);
      expect(s.noteToastShownAt).toBeNull();
    });

    it('resetSeenNotes clears stale extension claimable notes', () => {
      useWalletStore
        .getState()
        .setExtensionClaimableNotes([
          { id: 'a', faucetId: 'f', amountBaseUnits: '1', senderAddress: 's', noteType: 'public' } as any
        ]);
      useWalletStore.getState().resetSeenNotes();
      expect(useWalletStore.getState().extensionClaimableNotes).toBeNull();
    });
  });

  describe('extension claimable notes', () => {
    it('setExtensionClaimableNotes replaces the cached note list', () => {
      useWalletStore
        .getState()
        .setExtensionClaimableNotes([
          { id: 'n1', faucetId: 'f', amountBaseUnits: '1', senderAddress: 's', noteType: 'public' } as any
        ]);
      expect(useWalletStore.getState().extensionClaimableNotes).toHaveLength(1);
    });
  });

  describe('fetchBalances action (skip guard)', () => {
    beforeEach(() => {
      useWalletStore.setState({
        balances: {},
        balancesLoading: {},
        balancesLastFetched: {}
      });
    });

    it('skips when the address is already in flight', async () => {
      fetchingAddresses.add('addr-1');
      try {
        const before = useWalletStore.getState().balances['addr-1'];
        await useWalletStore.getState().fetchBalances('addr-1', {});
        expect(useWalletStore.getState().balances['addr-1']).toBe(before);
      } finally {
        fetchingAddresses.clear();
      }
    });
  });

  describe('updateSettings with null initial settings', () => {
    it('uses newSettings directly when current settings is null', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.UpdateSettingsResponse });
      useWalletStore.setState({ settings: null });

      const { updateSettings } = useWalletStore.getState();
      await updateSettings({ contacts: [{ name: 'Alice', address: 'addr1' }] });

      // When settings was null, the new settings should be applied directly
      const state = useWalletStore.getState();
      expect(state.settings?.contacts).toEqual([{ name: 'Alice', address: 'addr1' }]);
    });
  });
});
