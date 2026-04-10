import '../../../test/jest-mocks';

import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { useWalletStore, selectIsReady, selectIsLocked, selectIsIdle, getIntercom } from './index';

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
        accounts: [{ publicKey: 'pk1', name: 'Account 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 }],
        currentAccount: { publicKey: 'pk1', name: 'Account 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 },
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

  describe('editAccountName', () => {
    const mockAccounts = [
      { publicKey: 'pk1', name: 'Account 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 },
      { publicKey: 'pk2', name: 'Account 2', isPublic: false, type: WalletType.OnChain, hdIndex: 1 }
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
      { publicKey: 'pk1', name: 'Account 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 },
      { publicKey: 'pk2', name: 'Account 2', isPublic: false, type: WalletType.OnChain, hdIndex: 1 }
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
      await registerWallet('password123', 'mnemonic words', true);

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.NewWalletRequest,
        password: 'password123',
        mnemonic: 'mnemonic words',
        ownMnemonic: true
      });
    });

    it('importWalletFromClient sends correct request', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.ImportFromClientResponse });

      const { importWalletFromClient } = useWalletStore.getState();
      await importWalletFromClient('password123', 'mnemonic words');

      expect(mockRequest).toHaveBeenCalledWith({
        type: WalletMessageType.ImportFromClientRequest,
        password: 'password123',
        mnemonic: 'mnemonic words'
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
  });

  describe('Asset actions', () => {
    it('fetchAssetMetadata fetches and stores metadata', async () => {
      const { fetchTokenMetadata } = jest.requireMock('lib/miden/metadata');
      fetchTokenMetadata.mockResolvedValueOnce({
        base: { name: 'New Token', symbol: 'NEW', decimals: 6 }
      });

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

    it('confirmDAppTransaction sends correct request with delegate', async () => {
      mockRequest.mockResolvedValueOnce({
        type: MidenMessageType.DAppTransactionConfirmationResponse
      });

      const { confirmDAppTransaction } = useWalletStore.getState();
      await confirmDAppTransaction('req-id', true, true);

      expect(mockRequest).toHaveBeenCalledWith({
        type: MidenMessageType.DAppTransactionConfirmationRequest,
        id: 'req-id',
        confirmed: true,
        delegate: true
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

  // ── Additional coverage for action methods ────────────────────────

  describe('registerWallet / importWalletFromClient / unlock', () => {
    it('registerWallet sends NewWalletRequest', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.NewWalletResponse });
      await useWalletStore.getState().registerWallet('pw', 'mnemonic-12', false);
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ type: WalletMessageType.NewWalletRequest, password: 'pw' })
      );
    });

    it('registerWallet throws on invalid response', async () => {
      mockRequest.mockResolvedValueOnce({ type: 'wrong' });
      await expect(useWalletStore.getState().registerWallet('pw', 'm', false)).rejects.toThrow();
    });

    it('importWalletFromClient sends ImportFromClientRequest', async () => {
      mockRequest.mockResolvedValueOnce({ type: WalletMessageType.ImportFromClientResponse });
      await useWalletStore.getState().importWalletFromClient('pw', 'm');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ type: WalletMessageType.ImportFromClientRequest })
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
      await useWalletStore.getState().confirmDAppPermission('id-1', true, 'acc-1', 'AUTO', 1);
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
      await useWalletStore.getState().confirmDAppPermission('id-1', false, 'acc-1', 'AUTO', 1);
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
      useWalletStore.getState().setConfirmation({ id: 'c1', payload: {} as any });
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

    it('fetchAssetMetadata persists base metadata when fetch succeeds', async () => {
      const fetchTokenMetadata = require('lib/miden/metadata').fetchTokenMetadata;
      fetchTokenMetadata.mockResolvedValueOnce({ base: { decimals: 8, symbol: 'X' } });
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
      useWalletStore.getState().setSelectedFiatCurrency('USD');
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

  describe('fetchBalances', () => {
    it('skips if already loading for that address', async () => {
      useWalletStore.setState({ balancesLoading: { 'addr-1': true } });
      await useWalletStore.getState().fetchBalances('addr-1', {});
      // Should not have changed anything (no-op)
      expect(useWalletStore.getState().balancesLoading['addr-1']).toBe(true);
    });
  });

  describe('sync + transaction modal actions', () => {
    it('setSyncStatus marks initial sync done when transitioning to false', () => {
      useWalletStore.getState().setSyncStatus(true);
      expect(useWalletStore.getState().isSyncing).toBe(true);
      useWalletStore.getState().setSyncStatus(false);
      expect(useWalletStore.getState().isSyncing).toBe(false);
      expect(useWalletStore.getState().hasCompletedInitialSync).toBe(true);
    });

    it('open/closeTransactionModal toggles flag and resets dismiss flag', () => {
      useWalletStore.getState().openTransactionModal();
      expect(useWalletStore.getState().isTransactionModalOpen).toBe(true);
      useWalletStore.getState().closeTransactionModal(true);
      expect(useWalletStore.getState().isTransactionModalOpen).toBe(false);
      expect(useWalletStore.getState().isTransactionModalDismissedByUser).toBe(true);
      useWalletStore.getState().resetTransactionModalDismiss();
      expect(useWalletStore.getState().isTransactionModalDismissedByUser).toBe(false);
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
  });

  describe('extension claimable notes', () => {
    it('setExtensionClaimableNotes / addExtensionClaimingNoteId / clearExtensionClaimingNoteIds', () => {
      useWalletStore
        .getState()
        .setExtensionClaimableNotes([
          { id: 'n1', faucetId: 'f', amountBaseUnits: '1', senderAddress: 's', noteType: 'public' } as any
        ]);
      expect(useWalletStore.getState().extensionClaimableNotes).toHaveLength(1);
      useWalletStore.getState().addExtensionClaimingNoteId('n1');
      expect(useWalletStore.getState().extensionClaimingNoteIds.has('n1')).toBe(true);
      useWalletStore.getState().clearExtensionClaimingNoteIds();
      expect(useWalletStore.getState().extensionClaimingNoteIds.size).toBe(0);
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

    it('skips when balancesLoading[accountAddress] is already true', async () => {
      useWalletStore.setState({ balancesLoading: { 'addr-1': true } });
      const before = useWalletStore.getState().balances['addr-1'];
      await useWalletStore.getState().fetchBalances('addr-1', {});
      expect(useWalletStore.getState().balances['addr-1']).toBe(before);
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
