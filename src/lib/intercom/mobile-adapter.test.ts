import * as Actions from 'lib/miden/back/actions';
import { store } from 'lib/miden/back/store';
import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType } from 'lib/shared/types';

import { MobileIntercomAdapter } from './mobile-adapter';

// Mock the dependencies
jest.mock('lib/miden/back/actions', () => ({
  init: jest.fn().mockResolvedValue(undefined),
  getFrontState: jest.fn().mockResolvedValue({ accounts: [], settings: {} }),
  registerNewWallet: jest.fn().mockResolvedValue(undefined),
  registerImportedWallet: jest.fn().mockResolvedValue(undefined),
  unlock: jest.fn().mockResolvedValue(undefined),
  lock: jest.fn().mockResolvedValue(undefined),
  createHDAccount: jest.fn().mockResolvedValue(undefined),
  updateCurrentAccount: jest.fn().mockResolvedValue(undefined),
  revealMnemonic: jest.fn().mockResolvedValue('test mnemonic'),
  removeAccount: jest.fn().mockResolvedValue(undefined),
  editAccount: jest.fn().mockResolvedValue(undefined),
  importAccount: jest.fn().mockResolvedValue(undefined),
  updateSettings: jest.fn().mockResolvedValue(undefined),
  signTransaction: jest.fn().mockResolvedValue('signature'),
  getAuthSecretKey: jest.fn().mockResolvedValue('secret-key'),
  getAllDAppSessions: jest.fn().mockResolvedValue([]),
  removeDAppSession: jest.fn().mockResolvedValue([]),
  isDAppEnabled: jest.fn().mockResolvedValue(true),
  processDApp: jest.fn().mockResolvedValue({ result: 'success' })
}));

jest.mock('lib/miden/back/store', () => {
  const mockWatchers: Array<() => void> = [];
  return {
    store: {
      map: jest.fn(() => ({
        watch: jest.fn((callback: () => void) => {
          mockWatchers.push(callback);
          return { unsubscribe: jest.fn() };
        })
      })),
      _triggerWatch: () => mockWatchers.forEach(cb => cb())
    },
    toFront: jest.fn(state => state)
  };
});

// Bridge wiring is exercised separately in keystore-bridge.test.ts; mock
// here so the test doesn't pull in the Effector store's unlocked/locked
// events that this test fixture mocks away.
jest.mock('lib/miden/back/keystore-wiring', () => ({
  wireKeystoreBridge: jest.fn()
}));

describe('MobileIntercomAdapter', () => {
  let adapter: MobileIntercomAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    // Create a fresh adapter for each test
    adapter = new MobileIntercomAdapter();
  });

  describe('init', () => {
    it('initializes the backend', async () => {
      await adapter.init();

      expect(Actions.init).toHaveBeenCalled();
    });

    it('only initializes once', async () => {
      await adapter.init();
      await adapter.init();

      expect(Actions.init).toHaveBeenCalledTimes(1);
    });
  });

  describe('request', () => {
    it('handles GetStateRequest', async () => {
      const response = await adapter.request({ type: WalletMessageType.GetStateRequest });

      expect(response).toEqual({
        type: WalletMessageType.GetStateResponse,
        state: { accounts: [], settings: {} }
      });
    });

    it('handles NewWalletRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.NewWalletRequest,
        password: 'test123',
        mnemonic: 'word1 word2 word3',
        ownMnemonic: false
      } as any);

      expect(Actions.registerNewWallet).toHaveBeenCalledWith('test123', 'word1 word2 word3', false);
      expect(response).toEqual({ type: WalletMessageType.NewWalletResponse });
    });

    it('handles ImportFromClientRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.ImportFromClientRequest,
        password: 'test123',
        mnemonic: 'word1 word2 word3'
      } as any);

      expect(Actions.registerImportedWallet).toHaveBeenCalledWith('test123', 'word1 word2 word3');
      expect(response).toEqual({ type: WalletMessageType.ImportFromClientResponse });
    });

    it('handles UnlockRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.UnlockRequest,
        password: 'test123'
      } as any);

      expect(Actions.unlock).toHaveBeenCalledWith('test123');
      expect(response).toEqual({ type: WalletMessageType.UnlockResponse });
    });

    it('handles LockRequest', async () => {
      const response = await adapter.request({ type: WalletMessageType.LockRequest });

      expect(Actions.lock).toHaveBeenCalled();
      expect(response).toEqual({ type: WalletMessageType.LockResponse });
    });

    it('handles CreateAccountRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.CreateAccountRequest,
        walletType: 'public',
        name: 'Test Account'
      } as any);

      expect(Actions.createHDAccount).toHaveBeenCalledWith('public', 'Test Account');
      expect(response).toEqual({ type: WalletMessageType.CreateAccountResponse });
    });

    it('handles UpdateCurrentAccountRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.UpdateCurrentAccountRequest,
        accountPublicKey: 'pub-key-123'
      } as any);

      expect(Actions.updateCurrentAccount).toHaveBeenCalledWith('pub-key-123');
      expect(response).toEqual({ type: WalletMessageType.UpdateCurrentAccountResponse });
    });

    it('handles RevealMnemonicRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.RevealMnemonicRequest,
        password: 'test123'
      } as any);

      expect(Actions.revealMnemonic).toHaveBeenCalledWith('test123');
      expect(response).toEqual({
        type: WalletMessageType.RevealMnemonicResponse,
        mnemonic: 'test mnemonic'
      });
    });

    it('handles RemoveAccountRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.RemoveAccountRequest,
        accountPublicKey: 'pub-key-123',
        password: 'test123'
      } as any);

      expect(Actions.removeAccount).toHaveBeenCalledWith('pub-key-123', 'test123');
      expect(response).toEqual({ type: WalletMessageType.RemoveAccountResponse });
    });

    it('handles EditAccountRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.EditAccountRequest,
        accountPublicKey: 'pub-key-123',
        name: 'New Name'
      } as any);

      expect(Actions.editAccount).toHaveBeenCalledWith('pub-key-123', 'New Name');
      expect(response).toEqual({ type: WalletMessageType.EditAccountResponse });
    });

    it('handles ImportAccountRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.ImportAccountRequest,
        privateKey: 'private-key-123',
        encPassword: 'enc-pass'
      } as any);

      expect(Actions.importAccount).toHaveBeenCalledWith('private-key-123', 'enc-pass');
      expect(response).toEqual({ type: WalletMessageType.ImportAccountResponse });
    });

    it('handles UpdateSettingsRequest', async () => {
      const settings = { theme: 'dark' };
      const response = await adapter.request({
        type: WalletMessageType.UpdateSettingsRequest,
        settings
      } as any);

      expect(Actions.updateSettings).toHaveBeenCalledWith(settings);
      expect(response).toEqual({ type: WalletMessageType.UpdateSettingsResponse });
    });

    it('handles SignTransactionRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.SignTransactionRequest,
        publicKey: 'pub-key-123',
        signingInputs: { data: 'test' }
      } as any);

      expect(Actions.signTransaction).toHaveBeenCalledWith('pub-key-123', { data: 'test' });
      expect(response).toEqual({
        type: WalletMessageType.SignTransactionResponse,
        signature: 'signature'
      });
    });

    it('handles GetAuthSecretKeyRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.GetAuthSecretKeyRequest,
        key: 'test-key'
      } as any);

      expect(Actions.getAuthSecretKey).toHaveBeenCalledWith('test-key');
      expect(response).toEqual({
        type: WalletMessageType.GetAuthSecretKeyResponse,
        key: 'secret-key'
      });
    });

    it('handles DAppGetAllSessionsRequest', async () => {
      const response = await adapter.request({
        type: MidenMessageType.DAppGetAllSessionsRequest
      } as any);

      expect(Actions.getAllDAppSessions).toHaveBeenCalled();
      expect(response).toEqual({
        type: MidenMessageType.DAppGetAllSessionsResponse,
        sessions: []
      });
    });

    it('handles DAppRemoveSessionRequest', async () => {
      const response = await adapter.request({
        type: MidenMessageType.DAppRemoveSessionRequest,
        origin: 'https://example.com'
      } as any);

      expect(Actions.removeDAppSession).toHaveBeenCalledWith('https://example.com');
      expect(response).toEqual({
        type: MidenMessageType.DAppRemoveSessionResponse,
        sessions: []
      });
    });

    it('handles PageRequest PING', async () => {
      const response = await adapter.request({
        type: MidenMessageType.PageRequest,
        origin: 'https://example.com',
        payload: 'PING'
      } as any);

      expect(response).toEqual({
        type: MidenMessageType.PageResponse,
        payload: 'PONG'
      });
    });

    it('handles PageRequest with dApp payload', async () => {
      const response = await adapter.request({
        type: MidenMessageType.PageRequest,
        origin: 'https://example.com',
        payload: { method: 'test' }
      } as any);

      expect(Actions.processDApp).toHaveBeenCalledWith('https://example.com', { method: 'test' }, undefined);
      expect(response).toEqual({
        type: MidenMessageType.PageResponse,
        payload: { result: 'success' }
      });
    });

    it('handles PageRequest when dApp is disabled', async () => {
      (Actions.isDAppEnabled as jest.Mock).mockResolvedValueOnce(false);

      const response = await adapter.request({
        type: MidenMessageType.PageRequest,
        origin: 'https://example.com',
        payload: { method: 'test' }
      } as any);

      expect(response).toBeUndefined();
    });

    it('handles unknown request type', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const response = await adapter.request({ type: 'UNKNOWN_TYPE' } as any);

      expect(response).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith('MobileIntercomAdapter: Unknown request type', 'UNKNOWN_TYPE');

      consoleSpy.mockRestore();
    });

    it('auto-initializes on first request', async () => {
      await adapter.request({ type: WalletMessageType.GetStateRequest });

      expect(Actions.init).toHaveBeenCalled();
    });
  });

  describe('subscribe', () => {
    it('adds a subscriber and calls it on state changes', async () => {
      await adapter.init();
      const callback = jest.fn();

      adapter.subscribe(callback);

      // Trigger a state change via the mock
      (store as any)._triggerWatch();

      expect(callback).toHaveBeenCalledWith({ type: WalletMessageType.StateUpdated });
    });

    it('returns unsubscribe function that removes subscriber', async () => {
      await adapter.init();
      const callback = jest.fn();

      const unsubscribe = adapter.subscribe(callback);
      unsubscribe();

      // Trigger a state change
      (store as any)._triggerWatch();

      // Callback should not be called after unsubscribe
      expect(callback).not.toHaveBeenCalled();
    });

    it('handles errors in subscriber callbacks', async () => {
      await adapter.init();
      const errorCallback = jest.fn(() => {
        throw new Error('Callback error');
      });
      const normalCallback = jest.fn();
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      adapter.subscribe(errorCallback);
      adapter.subscribe(normalCallback);

      // Trigger a state change
      (store as any)._triggerWatch();

      expect(consoleSpy).toHaveBeenCalledWith('MobileIntercomAdapter: Error in subscriber callback', expect.any(Error));
      // Normal callback should still be called
      expect(normalCallback).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});

describe('getMobileIntercomAdapter', () => {
  it('returns a singleton instance', () => {
    // Reset the module to clear the singleton
    jest.resetModules();

    // Re-import to get fresh module
    const { getMobileIntercomAdapter: getAdapter } = require('./mobile-adapter');

    const adapter1 = getAdapter();
    const adapter2 = getAdapter();

    expect(adapter1).toBe(adapter2);
  });
});
