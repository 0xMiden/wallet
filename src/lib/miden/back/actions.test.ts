import { MidenDAppMessageType } from 'lib/adapter/types';
import { WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import {
  getFrontState,
  lock,
  unlock,
  registerNewWallet,
  registerImportedWallet,
  updateCurrentAccount,
  editAccount,
  updateSettings,
  signTransaction,
  getAuthSecretKey,
  getAllDAppSessions,
  getCurrentAccount,
  createHDAccount,
  processDApp,
  init,
  isDAppEnabled,
  revealMnemonic,
  removeDAppSession,
  decryptCiphertexts,
  revealViewKey,
  revealPrivateKey,
  revealPublicKey,
  removeAccount,
  importAccount,
  importMnemonicAccount,
  importFundraiserAccount,
  importWatchOnlyAccount
} from './actions';

// Create mock vault instance
const mockVault = {
  fetchAccounts: jest.fn(),
  fetchSettings: jest.fn(),
  getCurrentAccount: jest.fn(),
  setCurrentAccount: jest.fn(),
  isOwnMnemonic: jest.fn(),
  createHDAccount: jest.fn(),
  editAccountName: jest.fn(),
  updateSettings: jest.fn(),
  signTransaction: jest.fn(),
  getAuthSecretKey: jest.fn()
};

// Mock store callbacks
const mockInited = jest.fn();
const mockLocked = jest.fn();
const mockAccountsUpdated = jest.fn();
const mockSettingsUpdated = jest.fn();
const mockCurrentAccountUpdated = jest.fn();

// Mock store state
let mockStoreState = {
  inited: true,
  status: WalletStatus.Ready,
  accounts: [],
  currentAccount: null,
  networks: [],
  settings: null,
  ownMnemonic: null
};

jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    isExist: jest.fn(),
    spawn: jest.fn(),
    setup: jest.fn(),
    revealMnemonic: jest.fn(),
    spawnFromMidenClient: jest.fn(),
    getCurrentAccountPublicKey: jest.fn()
  }
}));

const mockUnlocked = jest.fn();

jest.mock('./store', () => ({
  store: {
    getState: jest.fn(() => mockStoreState)
  },
  toFront: jest.fn(state => state),
  inited: jest.fn((...args: any[]) => mockInited(...args)),
  locked: jest.fn((...args: any[]) => mockLocked(...args)),
  unlocked: jest.fn((...args: any[]) => mockUnlocked(...args)),
  accountsUpdated: jest.fn((...args: any[]) => mockAccountsUpdated(...args)),
  settingsUpdated: jest.fn((...args: any[]) => mockSettingsUpdated(...args)),
  currentAccountUpdated: jest.fn((...args: any[]) => mockCurrentAccountUpdated(...args)),
  withInited: jest.fn(async fn => fn()),
  withUnlocked: jest.fn(async fn => fn({ vault: mockVault }))
}));

jest.mock('./dapp', () => ({
  dappDebug: jest.fn(),
  getAllDApps: jest.fn(),
  removeDApp: jest.fn(),
  getCurrentPermission: jest.fn(),
  requestPermission: jest.fn(),
  requestDisconnect: jest.fn(),
  requestTransaction: jest.fn(),
  requestSendTransaction: jest.fn(),
  requestConsumeTransaction: jest.fn(),
  requestPrivateNotes: jest.fn(),
  requestSign: jest.fn(),
  requestAssets: jest.fn(),
  requestImportPrivateNote: jest.fn(),
  requestConsumableNotes: jest.fn(),
  waitForTransaction: jest.fn()
}));

jest.mock('webextension-polyfill', () => ({
  storage: {
    local: {
      get: jest.fn().mockResolvedValue({ DAppEnabled: true })
    }
  }
}));

describe('actions', () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    // Reset only the mocks we care about, not the module mocks
    mockInited.mockClear();
    mockLocked.mockClear();
    mockUnlocked.mockClear();
    mockAccountsUpdated.mockClear();
    mockSettingsUpdated.mockClear();
    mockCurrentAccountUpdated.mockClear();
    Object.values(mockVault).forEach((mock: jest.Mock) => mock.mockClear());
    mockStoreState = {
      inited: true,
      status: WalletStatus.Ready,
      accounts: [],
      currentAccount: null,
      networks: [],
      settings: null,
      ownMnemonic: null
    };
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe('init', () => {
    it('calls Vault.isExist and inited', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.isExist.mockResolvedValueOnce(true);

      await init();

      expect(Vault.isExist).toHaveBeenCalled();
      expect(mockInited).toHaveBeenCalledWith(true);
    });

    it('passes false to inited when vault does not exist', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.isExist.mockResolvedValueOnce(false);

      await init();

      expect(mockInited).toHaveBeenCalledWith(false);
    });
  });

  describe('isDAppEnabled', () => {
    it('returns true when vault exists and DApp is enabled', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.isExist.mockResolvedValueOnce(true);

      const result = await isDAppEnabled();

      expect(result).toBe(true);
    });

    it('returns false when vault does not exist', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.isExist.mockResolvedValueOnce(false);

      const result = await isDAppEnabled();

      expect(result).toBe(false);
    });

    it('defaults to true when DAppEnabled key is not in storage', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.isExist.mockResolvedValueOnce(true);

      // Mock storage to return empty object (key not present)
      const browser = jest.requireMock('webextension-polyfill');
      browser.storage.local.get.mockResolvedValueOnce({});

      const result = await isDAppEnabled();
      expect(result).toBe(true);
    });
  });

  describe('getFrontState', () => {
    it('returns state when inited is true', async () => {
      mockStoreState.inited = true;
      mockStoreState.status = WalletStatus.Ready;

      const result = await getFrontState();

      expect(result.status).toBe(WalletStatus.Ready);
    });

    it('returns Idle immediately when inited is false (UI renders while backend inits)', async () => {
      mockStoreState.inited = false;

      const result = await getFrontState();

      expect(result.status).toBe(WalletStatus.Idle);
      expect(result.accounts).toEqual([]);
      expect(result.currentAccount).toBeNull();
    });
  });

  describe('lock', () => {
    it('calls locked', async () => {
      await lock();

      expect(mockLocked).toHaveBeenCalled();
    });
  });

  describe('unlock', () => {
    it('calls Vault.setup and unlocked with password', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const mockVaultInstance = {
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(true)
      };
      Vault.setup.mockResolvedValueOnce(mockVaultInstance);

      await unlock('password123');

      expect(Vault.setup).toHaveBeenCalledWith('password123');
      expect(mockVaultInstance.fetchAccounts).toHaveBeenCalled();
      expect(mockVaultInstance.fetchSettings).toHaveBeenCalled();
      expect(mockUnlocked).toHaveBeenCalled();
    });
  });

  describe('registerNewWallet', () => {
    it('creates new vault and unlocks', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const mockVaultInstance = {
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(false)
      };
      Vault.spawn.mockResolvedValueOnce(mockVaultInstance);

      await registerNewWallet('password123', 'mnemonic words', true);

      expect(Vault.spawn).toHaveBeenCalledWith('password123', 'mnemonic words', true);
      expect(mockVaultInstance.fetchAccounts).toHaveBeenCalled();
      expect(mockUnlocked).toHaveBeenCalled();
    });
  });

  describe('registerNewWallet with undefined password', () => {
    it('passes empty string when password is undefined', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const mockVaultInstance = {
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(false)
      };
      Vault.spawn.mockResolvedValueOnce(mockVaultInstance);

      await registerNewWallet(undefined, 'mnemonic words', true);

      expect(Vault.spawn).toHaveBeenCalledWith('', 'mnemonic words', true);
    });
  });

  describe('registerImportedWallet', () => {
    it('imports wallet from miden client and unlocks', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const mockVaultInstance = {
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(true)
      };
      Vault.spawnFromMidenClient.mockResolvedValueOnce(mockVaultInstance);

      await registerImportedWallet('password123', 'mnemonic words');

      expect(Vault.spawnFromMidenClient).toHaveBeenCalledWith('password123', 'mnemonic words');
      expect(mockVaultInstance.fetchAccounts).toHaveBeenCalled();
      expect(mockUnlocked).toHaveBeenCalled();
    });
  });

  describe('registerImportedWallet with undefined params', () => {
    it('passes empty strings when password and mnemonic are undefined', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const mockVaultInstance = {
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(true)
      };
      Vault.spawnFromMidenClient.mockResolvedValueOnce(mockVaultInstance);

      await registerImportedWallet(undefined, undefined);

      expect(Vault.spawnFromMidenClient).toHaveBeenCalledWith('', '');
    });
  });

  describe('updateCurrentAccount', () => {
    it('updates current account and fires event', async () => {
      const newAccount = { publicKey: 'pk1', name: 'Account 1' };
      mockVault.setCurrentAccount.mockResolvedValueOnce(newAccount);

      await updateCurrentAccount('pk1');

      expect(mockVault.setCurrentAccount).toHaveBeenCalledWith('pk1');
      expect(mockCurrentAccountUpdated).toHaveBeenCalledWith(newAccount);
    });
  });

  describe('editAccount', () => {
    it('trims name and updates accounts', async () => {
      const updatedAccounts = { accounts: [{ publicKey: 'pk1', name: 'Trimmed' }] };
      mockVault.editAccountName.mockResolvedValueOnce(updatedAccounts);

      await editAccount('pk1', '  Trimmed  ');

      expect(mockVault.editAccountName).toHaveBeenCalledWith('pk1', 'Trimmed');
      expect(mockAccountsUpdated).toHaveBeenCalledWith(updatedAccounts);
    });

    it('throws for invalid name', async () => {
      const longName = 'a'.repeat(20); // > 16 chars

      await expect(editAccount('pk1', longName)).rejects.toThrow('Invalid name');
    });
  });

  describe('updateSettings', () => {
    it('updates settings and fires event', async () => {
      const newSettings = { contacts: [] };
      mockVault.updateSettings.mockResolvedValueOnce(newSettings);

      await updateSettings({ contacts: [] });

      expect(mockVault.updateSettings).toHaveBeenCalledWith({ contacts: [] });
      expect(mockSettingsUpdated).toHaveBeenCalledWith(newSettings);
    });
  });

  describe('signTransaction', () => {
    it('calls vault signTransaction', async () => {
      mockVault.signTransaction.mockResolvedValueOnce('signature');

      const result = await signTransaction('pk1', 'inputs');

      expect(mockVault.signTransaction).toHaveBeenCalledWith('pk1', 'inputs');
      expect(result).toBe('signature');
    });
  });

  describe('getAuthSecretKey', () => {
    it('calls vault getAuthSecretKey', async () => {
      mockVault.getAuthSecretKey.mockResolvedValueOnce('secret-key');

      const result = await getAuthSecretKey('key-id');

      expect(mockVault.getAuthSecretKey).toHaveBeenCalledWith('key-id');
      expect(result).toBe('secret-key');
    });
  });

  describe('getAllDAppSessions', () => {
    it('returns all DApp sessions', async () => {
      const { getAllDApps } = jest.requireMock('./dapp');
      getAllDApps.mockResolvedValueOnce({ 'https://example.com': [] });

      const result = await getAllDAppSessions();

      expect(result).toEqual({ 'https://example.com': [] });
    });
  });

  describe('revealMnemonic', () => {
    it('calls Vault.revealMnemonic with password', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.revealMnemonic.mockResolvedValueOnce('word1 word2 word3');

      const result = await revealMnemonic('password123');

      expect(Vault.revealMnemonic).toHaveBeenCalledWith('password123');
      expect(result).toBe('word1 word2 word3');
    });
  });

  describe('removeDAppSession', () => {
    it('removes DApp session for current account', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const { removeDApp } = jest.requireMock('./dapp');
      Vault.getCurrentAccountPublicKey.mockResolvedValueOnce('current-pk');
      removeDApp.mockResolvedValueOnce(true);

      const result = await removeDAppSession('https://example.com');

      expect(Vault.getCurrentAccountPublicKey).toHaveBeenCalled();
      expect(removeDApp).toHaveBeenCalledWith('https://example.com', 'current-pk');
      expect(result).toBe(true);
    });
  });

  describe('getCurrentAccount', () => {
    it('returns current account from vault', async () => {
      const account = { publicKey: 'pk1', name: 'My Account' };
      mockVault.getCurrentAccount.mockResolvedValueOnce(account);

      const result = await getCurrentAccount();

      expect(mockVault.getCurrentAccount).toHaveBeenCalled();
      expect(result).toEqual(account);
    });
  });

  describe('createHDAccount', () => {
    it('creates HD account without name', async () => {
      const accounts = [{ publicKey: 'pk1', name: 'Account 1' }];
      mockVault.createHDAccount.mockResolvedValueOnce(accounts);

      await createHDAccount(WalletType.OnChain);

      expect(mockVault.createHDAccount).toHaveBeenCalledWith(WalletType.OnChain, undefined);
      expect(mockAccountsUpdated).toHaveBeenCalledWith({ accounts });
    });

    it('creates HD account with valid name', async () => {
      const accounts = [{ publicKey: 'pk1', name: 'MyWallet' }];
      mockVault.createHDAccount.mockResolvedValueOnce(accounts);

      await createHDAccount(WalletType.OnChain, '  MyWallet  ');

      expect(mockVault.createHDAccount).toHaveBeenCalledWith(WalletType.OnChain, 'MyWallet');
      expect(mockAccountsUpdated).toHaveBeenCalledWith({ accounts });
    });

    it('throws for name longer than 16 characters', async () => {
      const longName = 'a'.repeat(17);

      await expect(createHDAccount(WalletType.OnChain, longName)).rejects.toThrow('Invalid name');
    });
  });

  describe('processDApp', () => {
    it('handles GetCurrentPermissionRequest', async () => {
      const { getCurrentPermission } = jest.requireMock('./dapp');
      getCurrentPermission.mockResolvedValueOnce({ granted: true });

      const result = await processDApp('https://example.com', {
        type: MidenDAppMessageType.GetCurrentPermissionRequest
      } as any);

      expect(getCurrentPermission).toHaveBeenCalledWith('https://example.com');
      expect(result).toEqual({ granted: true });
    });

    it('handles PermissionRequest', async () => {
      const { requestPermission } = jest.requireMock('./dapp');
      requestPermission.mockResolvedValueOnce({ approved: true });

      const req = { type: MidenDAppMessageType.PermissionRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      // PR-4 chunk 8: processDApp threads sessionId (undefined for legacy
      // single-instance callers) through to handlers.
      expect(requestPermission).toHaveBeenCalledWith('https://example.com', req, undefined);
      expect(result).toEqual({ approved: true });
    });

    it('handles DisconnectRequest', async () => {
      const { requestDisconnect } = jest.requireMock('./dapp');
      requestDisconnect.mockResolvedValueOnce({ disconnected: true });

      const req = { type: MidenDAppMessageType.DisconnectRequest };
      const result = await processDApp('https://example.com', req as any);

      expect(requestDisconnect).toHaveBeenCalledWith('https://example.com', req);
      expect(result).toEqual({ disconnected: true });
    });

    it('handles SignRequest', async () => {
      const { requestSign } = jest.requireMock('./dapp');
      requestSign.mockResolvedValueOnce({ signature: '0x123' });

      const req = { type: MidenDAppMessageType.SignRequest, payload: 'data' };
      const result = await processDApp('https://example.com', req as any);

      expect(requestSign).toHaveBeenCalledWith('https://example.com', req);
      expect(result).toEqual({ signature: '0x123' });
    });

    it('returns undefined for unknown request type', async () => {
      const result = await processDApp('https://example.com', { type: 'UNKNOWN' } as any);

      expect(result).toBeUndefined();
    });

    it('handles TransactionRequest', async () => {
      const { requestTransaction } = jest.requireMock('./dapp');
      requestTransaction.mockResolvedValueOnce({ txId: 'tx-123' });

      const req = { type: MidenDAppMessageType.TransactionRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      expect(requestTransaction).toHaveBeenCalledWith('https://example.com', req, undefined);
      expect(result).toEqual({ txId: 'tx-123' });
    });

    it('handles SendTransactionRequest', async () => {
      const { requestSendTransaction } = jest.requireMock('./dapp');
      requestSendTransaction.mockResolvedValueOnce({ sent: true });

      const req = { type: MidenDAppMessageType.SendTransactionRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      expect(requestSendTransaction).toHaveBeenCalledWith('https://example.com', req, undefined);
      expect(result).toEqual({ sent: true });
    });

    it('handles ConsumeRequest', async () => {
      const { requestConsumeTransaction } = jest.requireMock('./dapp');
      requestConsumeTransaction.mockResolvedValueOnce({ consumed: true });

      const req = { type: MidenDAppMessageType.ConsumeRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      expect(requestConsumeTransaction).toHaveBeenCalledWith('https://example.com', req, undefined);
      expect(result).toEqual({ consumed: true });
    });

    it('handles PrivateNotesRequest', async () => {
      const { requestPrivateNotes } = jest.requireMock('./dapp');
      requestPrivateNotes.mockResolvedValueOnce({ notes: [] });

      const req = { type: MidenDAppMessageType.PrivateNotesRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      expect(requestPrivateNotes).toHaveBeenCalledWith('https://example.com', req);
      expect(result).toEqual({ notes: [] });
    });

    it('handles AssetsRequest', async () => {
      const { requestAssets } = jest.requireMock('./dapp');
      requestAssets.mockResolvedValueOnce({ assets: [] });

      const req = { type: MidenDAppMessageType.AssetsRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      expect(requestAssets).toHaveBeenCalledWith('https://example.com', req);
      expect(result).toEqual({ assets: [] });
    });

    it('handles ImportPrivateNoteRequest', async () => {
      const { requestImportPrivateNote } = jest.requireMock('./dapp');
      requestImportPrivateNote.mockResolvedValueOnce({ imported: true });

      const req = { type: MidenDAppMessageType.ImportPrivateNoteRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      expect(requestImportPrivateNote).toHaveBeenCalledWith('https://example.com', req);
      expect(result).toEqual({ imported: true });
    });

    it('handles ConsumableNotesRequest', async () => {
      const { requestConsumableNotes } = jest.requireMock('./dapp');
      requestConsumableNotes.mockResolvedValueOnce({ notes: [] });

      const req = { type: MidenDAppMessageType.ConsumableNotesRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      expect(requestConsumableNotes).toHaveBeenCalledWith('https://example.com', req);
      expect(result).toEqual({ notes: [] });
    });

    it('handles WaitForTransactionRequest', async () => {
      const { waitForTransaction } = jest.requireMock('./dapp');
      waitForTransaction.mockResolvedValueOnce({ status: 'completed' });

      const req = { type: MidenDAppMessageType.WaitForTransactionRequest, txId: 'tx-123' };
      const result = await processDApp('https://example.com', req as any);

      expect(waitForTransaction).toHaveBeenCalledWith(req);
      expect(result).toEqual({ status: 'completed' });
    });
  });

  describe('stub action functions', () => {
    it('decryptCiphertexts is a no-op stub', () => {
      expect(() => decryptCiphertexts('pk', ['ct1'])).not.toThrow();
    });

    it('revealViewKey is a no-op stub', () => {
      expect(() => revealViewKey('pk', 'pw')).not.toThrow();
    });

    it('revealPrivateKey is a no-op stub', () => {
      expect(() => revealPrivateKey('pk', 'pw')).not.toThrow();
    });

    it('revealPublicKey is a no-op stub', () => {
      expect(() => revealPublicKey('pk')).not.toThrow();
    });

    it('removeAccount is a no-op stub', () => {
      expect(() => removeAccount('pk', 'pw')).not.toThrow();
    });

    it('importAccount is a no-op stub', () => {
      expect(() => importAccount('pk')).not.toThrow();
    });

    it('importMnemonicAccount is a no-op stub', () => {
      expect(() => importMnemonicAccount('mnemonic')).not.toThrow();
    });

    it('importFundraiserAccount is a no-op stub', () => {
      expect(() => importFundraiserAccount('e@x', 'pw', 'mnemonic')).not.toThrow();
    });

    it('importWatchOnlyAccount is a no-op stub', () => {
      expect(() => importWatchOnlyAccount('vk')).not.toThrow();
    });
  });
});
