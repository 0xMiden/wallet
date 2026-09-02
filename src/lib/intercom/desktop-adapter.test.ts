import * as Actions from 'lib/miden/back/actions';
import { store } from 'lib/miden/back/store';
import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { DesktopIntercomAdapter } from './desktop-adapter';

// Mock the backend action handlers. Only the actions the desktop adapter
// actually calls need to be present; each resolves a representative value.
jest.mock('lib/miden/back/actions', () => ({
  init: jest.fn().mockResolvedValue(undefined),
  getFrontState: jest.fn().mockResolvedValue({ status: 'ready', accounts: [], settings: {} }),
  registerNewWallet: jest.fn().mockResolvedValue(undefined),
  registerImportedWallet: jest.fn().mockResolvedValue(undefined),
  unlock: jest.fn().mockResolvedValue(undefined),
  lock: jest.fn().mockResolvedValue(undefined),
  createHDAccount: jest.fn().mockResolvedValue(undefined),
  updateCurrentAccount: jest.fn().mockResolvedValue(undefined),
  revealMnemonic: jest.fn().mockResolvedValue('test mnemonic'),
  revealPrivateKey: jest.fn().mockResolvedValue('deadbeef'),
  removeAccount: jest.fn().mockResolvedValue(undefined),
  editAccount: jest.fn().mockResolvedValue(undefined),
  importAccount: jest.fn().mockResolvedValue('mtst1imported-pk'),
  updateSettings: jest.fn().mockResolvedValue(undefined),
  signTransaction: jest.fn().mockResolvedValue('signature'),
  signWord: jest.fn().mockResolvedValue('word-signature'),
  revealHotKey: jest.fn().mockResolvedValue('hot-private-key'),
  revealGuardianKeys: jest.fn().mockResolvedValue({
    coldPrivateKey: 'cold-priv',
    coldPublicKey: 'cold-pub',
    hotPublicKey: 'hot-pub'
  }),
  persistNewHotKey: jest.fn().mockResolvedValue(undefined),
  swapHotKey: jest.fn().mockResolvedValue(undefined),
  setGuardianEndpoint: jest.fn().mockResolvedValue(undefined),
  setGuardianOperatorCommitment: jest.fn().mockResolvedValue(undefined),
  setGuardianSyncStatus: jest.fn().mockResolvedValue(undefined),
  checkGuardianDrift: jest.fn().mockResolvedValue('in-sync'),
  applyUserGuardianEndpoint: jest.fn().mockResolvedValue('applied'),
  getPublicKeyForCommitment: jest.fn().mockResolvedValue('pub-key'),
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

describe('DesktopIntercomAdapter', () => {
  let adapter: DesktopIntercomAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    // Fresh adapter per test so `initialized` state never leaks between cases.
    adapter = new DesktopIntercomAdapter();
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

      expect(Actions.getFrontState).toHaveBeenCalled();
      expect(response).toEqual({
        type: WalletMessageType.GetStateResponse,
        state: { status: 'ready', accounts: [], settings: {} }
      });
    });

    it('handles GetStateRequest when state has no accounts field', async () => {
      // Exercises the `state.accounts?.length` nullish branch in the diagnostic log.
      (Actions.getFrontState as jest.Mock).mockResolvedValueOnce({ status: 'idle' });

      const response = await adapter.request({ type: WalletMessageType.GetStateRequest });

      expect(response).toEqual({
        type: WalletMessageType.GetStateResponse,
        state: { status: 'idle' }
      });
    });

    it('handles NewWalletRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.NewWalletRequest,
        walletType: WalletType.OffChain,
        password: 'test123',
        mnemonic: 'word1 word2 word3',
        ownMnemonic: false,
        guardianEndpoint: undefined
      });

      // Every field of the request must reach `registerNewWallet` in the SAME
      // positions the target signature declares
      // (walletType, password, mnemonic, ownMnemonic, guardianEndpoint).
      // Dropping `walletType` here shifts every later argument by one and
      // `Vault.spawn` wipes storage and then throws on `walletTypeIndex(<password>)`.
      expect(Actions.registerNewWallet).toHaveBeenCalledWith(
        WalletType.OffChain,
        'test123',
        'word1 word2 word3',
        false,
        undefined
      );
      expect(response).toEqual({ type: WalletMessageType.NewWalletResponse });
    });

    it('forwards walletType and guardianEndpoint for a Guardian registration', async () => {
      await adapter.request({
        type: WalletMessageType.NewWalletRequest,
        walletType: WalletType.Guardian,
        password: 'pw',
        mnemonic: 'a b c',
        ownMnemonic: true,
        guardianEndpoint: 'https://guardian.example'
      });

      expect(Actions.registerNewWallet).toHaveBeenCalledWith(
        WalletType.Guardian,
        'pw',
        'a b c',
        true,
        'https://guardian.example'
      );
    });

    it('handles ImportFromClientRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.ImportFromClientRequest,
        password: 'test123',
        mnemonic: 'word1 word2 word3',
        walletAccounts: []
      });

      expect(Actions.registerImportedWallet).toHaveBeenCalledWith('test123', 'word1 word2 word3', []);
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

      expect(Actions.createHDAccount).toHaveBeenCalledWith('public', 'Test Account', undefined);
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

    it('handles RevealPrivateKeyRequest', async () => {
      const response = await adapter.request({
        type: WalletMessageType.RevealPrivateKeyRequest,
        accountPublicKey: 'pk-commitment',
        password: 'pw'
      } as any);

      expect(Actions.revealPrivateKey).toHaveBeenCalledWith('pk-commitment', 'pw');
      expect(response).toEqual({
        type: WalletMessageType.RevealPrivateKeyResponse,
        privateKey: 'deadbeef'
      });
    });

    it('falls back to an empty private key when none is returned', async () => {
      // Exercises the `privateKey ?? ''` nullish fallback branch.
      (Actions.revealPrivateKey as jest.Mock).mockResolvedValueOnce(null);

      const response = await adapter.request({
        type: WalletMessageType.RevealPrivateKeyRequest,
        accountPublicKey: 'pk-commitment',
        password: 'pw'
      } as any);

      expect(response).toEqual({
        type: WalletMessageType.RevealPrivateKeyResponse,
        privateKey: ''
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
        name: 'Imported'
      } as any);

      expect(Actions.importAccount).toHaveBeenCalledWith('private-key-123', 'Imported');
      expect(response).toEqual({
        type: WalletMessageType.ImportAccountResponse,
        accountPublicKey: 'mtst1imported-pk'
      });
    });

    it('falls back to an empty account public key when none is returned', async () => {
      // Exercises the `importedAccountPublicKey ?? ''` nullish fallback branch.
      (Actions.importAccount as jest.Mock).mockResolvedValueOnce(null);

      const response = await adapter.request({
        type: WalletMessageType.ImportAccountRequest,
        privateKey: 'private-key-123',
        name: 'Imported'
      } as any);

      expect(response).toEqual({
        type: WalletMessageType.ImportAccountResponse,
        accountPublicKey: ''
      });
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
        payload: { method: 'test' },
        sessionId: 'session-1'
      } as any);

      expect(Actions.processDApp).toHaveBeenCalledWith('https://example.com', { method: 'test' }, 'session-1');
      expect(response).toEqual({
        type: MidenMessageType.PageResponse,
        payload: { result: 'success' }
      });
    });

    it('returns a null payload when the dApp response is nullish', async () => {
      // Exercises the `resPayload ?? null` fallback branch.
      (Actions.processDApp as jest.Mock).mockResolvedValueOnce(null);

      const response = await adapter.request({
        type: MidenMessageType.PageRequest,
        origin: 'https://example.com',
        payload: { method: 'test' }
      } as any);

      expect(response).toEqual({
        type: MidenMessageType.PageResponse,
        payload: null
      });
    });

    it('handles PageRequest when dApp is disabled', async () => {
      (Actions.isDAppEnabled as jest.Mock).mockResolvedValueOnce(false);

      const response = await adapter.request({
        type: MidenMessageType.PageRequest,
        origin: 'https://example.com',
        payload: { method: 'test' }
      } as any);

      expect(Actions.processDApp).not.toHaveBeenCalled();
      expect(response).toBeUndefined();
    });

    // Regression: desktop implemented 16 of the 27 in-process message types and
    // silently dropped the 11 guardian ones to `default:` → `undefined`. Every
    // store wrapper then dereferenced that undefined (`res.type`), so guardian
    // sync, the hot-key rotation gate and "Reveal guardian keys" failed on the
    // Tauri build with a TypeError that read as a wrong password. Both in-process
    // adapters now dispatch through one shared switch.
    it('handles every guardian message type instead of dropping it to the default arm', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation();

      expect(
        await adapter.request({ type: WalletMessageType.SignWordRequest, publicKey: 'pk', wordHex: '0xabc' } as any)
      ).toEqual({ type: WalletMessageType.SignWordResponse, signature: 'word-signature' });

      expect(
        await adapter.request({
          type: WalletMessageType.RevealHotKeyRequest,
          accountPublicKey: 'acc',
          password: 'pw'
        } as any)
      ).toEqual({ type: WalletMessageType.RevealHotKeyResponse, hotPrivateKey: 'hot-private-key' });

      expect(
        await adapter.request({
          type: WalletMessageType.RevealGuardianKeysRequest,
          accountPublicKey: 'acc',
          password: 'pw'
        } as any)
      ).toEqual({
        type: WalletMessageType.RevealGuardianKeysResponse,
        coldPrivateKey: 'cold-priv',
        coldPublicKey: 'cold-pub',
        hotPublicKey: 'hot-pub'
      });

      expect(
        await adapter.request({
          type: WalletMessageType.PersistNewHotKeyRequest,
          newHotPubKey: 'new-pub',
          newHotCiphertext: 'ct'
        } as any)
      ).toEqual({ type: WalletMessageType.PersistNewHotKeyResponse });

      expect(
        await adapter.request({
          type: WalletMessageType.SwapHotKeyRequest,
          accountPublicKey: 'acc',
          newHotPubKey: 'new-pub'
        } as any)
      ).toEqual({ type: WalletMessageType.SwapHotKeyResponse });

      expect(
        await adapter.request({
          type: WalletMessageType.SetGuardianEndpointRequest,
          accountPublicKey: 'acc',
          guardianEndpoint: 'https://guardian.example'
        } as any)
      ).toEqual({ type: WalletMessageType.SetGuardianEndpointResponse });

      expect(
        await adapter.request({
          type: WalletMessageType.SetGuardianOperatorCommitmentRequest,
          accountPublicKey: 'acc',
          guardianOperatorCommitment: '0xcommit'
        } as any)
      ).toEqual({ type: WalletMessageType.SetGuardianOperatorCommitmentResponse });

      expect(
        await adapter.request({
          type: WalletMessageType.SetGuardianSyncStatusRequest,
          accountPublicKey: 'acc',
          guardianSyncStatus: 'in-sync'
        } as any)
      ).toEqual({ type: WalletMessageType.SetGuardianSyncStatusResponse });

      expect(
        await adapter.request({ type: WalletMessageType.CheckGuardianDriftRequest, accountPublicKey: 'acc' } as any)
      ).toEqual({ type: WalletMessageType.CheckGuardianDriftResponse, guardianSyncStatus: 'in-sync' });

      expect(
        await adapter.request({
          type: WalletMessageType.ApplyUserGuardianEndpointRequest,
          accountPublicKey: 'acc',
          guardianEndpoint: 'https://guardian.example'
        } as any)
      ).toEqual({ type: WalletMessageType.ApplyUserGuardianEndpointResponse, outcome: 'applied' });

      expect(
        await adapter.request({
          type: WalletMessageType.GetPublicKeyForCommitmentRequest,
          commitment: '0xcommit'
        } as any)
      ).toEqual({ type: WalletMessageType.GetPublicKeyForCommitmentResponse, publicKey: 'pub-key' });

      // None of them may fall through to the unknown-type warning.
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('handles unknown request type', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const response = await adapter.request({ type: 'UNKNOWN_TYPE' } as any);

      expect(response).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith('DesktopIntercomAdapter: Unknown request type', 'UNKNOWN_TYPE');

      consoleSpy.mockRestore();
    });

    it('handles a nullish request payload', async () => {
      // Exercises the `req?.type` optional-chaining branch in processRequest.
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const response = await adapter.request(undefined as any);

      expect(response).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith('DesktopIntercomAdapter: Unknown request type', undefined);

      consoleSpy.mockRestore();
    });

    it('auto-initializes on first request', async () => {
      await adapter.request({ type: WalletMessageType.GetStateRequest });

      expect(Actions.init).toHaveBeenCalledTimes(1);
    });

    it('does not re-initialize when already initialized', async () => {
      await adapter.init();
      expect(Actions.init).toHaveBeenCalledTimes(1);

      // Second request should skip init since `initialized` is already true.
      await adapter.request({ type: WalletMessageType.GetStateRequest });

      expect(Actions.init).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribe', () => {
    it('adds a subscriber and calls it on state changes', async () => {
      await adapter.init();
      const callback = jest.fn();

      adapter.subscribe(callback);

      // Trigger a store change via the mock's watcher registry.
      (store as any)._triggerWatch();

      expect(callback).toHaveBeenCalledWith({ type: WalletMessageType.StateUpdated });
    });

    it('returns an unsubscribe function that removes the subscriber', async () => {
      await adapter.init();
      const callback = jest.fn();

      const unsubscribe = adapter.subscribe(callback);
      unsubscribe();

      (store as any)._triggerWatch();

      expect(callback).not.toHaveBeenCalled();
    });

    it('isolates errors thrown by subscriber callbacks', async () => {
      await adapter.init();
      const errorCallback = jest.fn(() => {
        throw new Error('Callback error');
      });
      const normalCallback = jest.fn();
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      adapter.subscribe(errorCallback);
      adapter.subscribe(normalCallback);

      (store as any)._triggerWatch();

      expect(consoleSpy).toHaveBeenCalledWith(
        'DesktopIntercomAdapter: Error in subscriber callback',
        expect.any(Error)
      );
      // A throwing subscriber must not prevent later subscribers from running.
      expect(normalCallback).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});

describe('getDesktopIntercomAdapter', () => {
  it('returns a singleton instance', () => {
    // Reset the module registry so the module-level `desktopAdapter` is null again.
    jest.resetModules();

    const { getDesktopIntercomAdapter: getAdapter } = require('./desktop-adapter');

    const adapter1 = getAdapter();
    const adapter2 = getAdapter();

    expect(adapter1).toBe(adapter2);
  });
});
