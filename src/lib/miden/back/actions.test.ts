import { MidenDAppMessageType } from 'lib/adapter/types';
import { WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import {
  getFrontState,
  lock,
  unlock,
  provideRecoverySeed,
  registerNewWallet,
  registerWalletFromHotKey,
  removeSeedPhrase,
  registerImportedWallet,
  updateCurrentAccount,
  editAccount,
  updateSettings,
  signTransaction,
  getAuthSecretKey,
  setGuardianOperatorCommitment,
  setGuardianSyncStatus,
  startGuardianRecovery,
  checkGuardianDrift,
  applyUserGuardianEndpoint,
  getAllDAppSessions,
  getCurrentAccount,
  createHDAccount,
  processDApp,
  init,
  isDAppEnabled,
  revealMnemonic,
  exportWalletBackupMaterial,
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
  fetchSeedPhraseStatus: jest.fn().mockResolvedValue('stored'),
  provideRecoverySeed: jest.fn(),
  fetchAccounts: jest.fn(),
  fetchSettings: jest.fn(),
  getCurrentAccount: jest.fn(),
  setCurrentAccount: jest.fn(),
  isOwnMnemonic: jest.fn(),
  createHDAccount: jest.fn(),
  editAccountName: jest.fn(),
  updateSettings: jest.fn(),
  signTransaction: jest.fn(),
  getAuthSecretKey: jest.fn(),
  importAccountFromPrivateKey: jest.fn(),
  setGuardianEndpoint: jest.fn(),
  setGuardianOperatorCommitment: jest.fn(),
  setGuardianSyncStatus: jest.fn(),
  retire: jest.fn(),
  insertKeySink: jest.fn()
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

// The realm keystore (#878): init installs the signer; lock retires the vault, which uninstalls its sink.
// The store's real `locked` drops the vault and the Ready status, so an action that
// needs the vault it locks must read it first; the mock models that transition.
mockLocked.mockImplementation(() => {
  mockStoreState.status = WalletStatus.Locked;
  delete (mockStoreState as { vault?: unknown }).vault;
});

const mockInstallRealmKeystore = jest.fn();
const mockUninstallRealmKeystore = jest.fn();
jest.mock('lib/miden/sdk/miden-client', () => ({
  ...jest.requireActual('lib/miden/sdk/miden-client'),
  installRealmKeystore: (...a: unknown[]) => mockInstallRealmKeystore(...a),
  uninstallRealmKeystore: (...a: unknown[]) => mockUninstallRealmKeystore(...a)
}));

jest.mock('lib/miden/back/guardian-drift', () => ({
  resolveGuardianDrift: jest.fn(),
  applyUserGuardianEndpoint: jest.fn()
}));

jest.mock('lib/miden/back/guardian-recovery', () => ({
  maybeStartGuardianRecovery: jest.fn()
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    isExist: jest.fn(),
    spawn: jest.fn(),
    spawnFromHotKey: jest.fn(),
    setup: jest.fn(),
    revealMnemonic: jest.fn(),
    exportWalletBackupMaterial: jest.fn(),
    revealPrivateKey: jest.fn(),
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
  requestGuardianInfo: jest.fn(),
  waitForTransaction: jest.fn()
}));

// `clear` is what the failed-restore undo calls through clearStorage; without it
// the undo throws inside a finally and masks the failure it was undoing.
const mockStorageClear = jest.fn().mockResolvedValue(undefined);

jest.mock('webextension-polyfill', () => {
  // One object behind both views: consumers read `default ?? module`, and a test
  // that steers `storage.local.get` must steer the same mock either way.
  const storage = {
    local: {
      get: jest.fn().mockResolvedValue({ DAppEnabled: true }),
      // `clear` is what the failed-restore undo reaches through clearStorage.
      clear: (...args: unknown[]) => mockStorageClear(...args)
    }
  };
  const runtime = { onMessage: { addListener: jest.fn() } };
  return { __esModule: true, default: { storage, runtime }, storage, runtime };
});

// `unlock`'s seed-removal resume and the explicit `removeSeedPhrase` both take
// the generate-transactions-loop lock. jsdom's `navigator` is non-configurable,
// so attach `.locks` to whatever object it already is. `lockResult` null models
// the loop already holding it.
const installNavigatorLocksMock = (lockResult: unknown = {}) => {
  const nav = (globalThis as unknown as { navigator?: object }).navigator || {};
  Object.defineProperty(nav, 'locks', {
    value: {
      request: jest.fn(async (_name: string, _opts: unknown, cb: (l: unknown) => unknown) => cb(lockResult))
    },
    writable: true,
    configurable: true
  });
};
installNavigatorLocksMock();

describe('actions', () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    // Reset only the mocks we care about, not the module mocks. The static
    // `Vault.*` mocks belong in here too: they live on the module factory, not on
    // `mockVault`, so without this a call recorded by one test satisfies a later
    // test's assertion and a negative assertion goes red for an unrelated reason.
    const { Vault: staticVault } = jest.requireMock<{ Vault: Record<string, jest.Mock> }>('lib/miden/back/vault');
    Object.values(staticVault).forEach(mock => mock.mockClear());
    // Steered per-test with mockRejectedValueOnce, so it resets where the others
    // do: an unconsumed one-shot would otherwise run a later test's undo down the
    // failure arm while its name claims the successful one.
    mockStorageClear.mockReset().mockResolvedValue(undefined);
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
    it('installs the vault signer as the realm signer, before anything can ask the SDK client to sign (#878)', async () => {
      mockInstallRealmKeystore.mockClear();
      await init();
      expect(mockInstallRealmKeystore).toHaveBeenCalledWith({ sign: expect.any(Function) });
      const { sign } = mockInstallRealmKeystore.mock.calls[0]![0];
      // The SDK's byte shape over the vault's hex signer: hex in, bytes out.
      mockVault.signTransaction.mockResolvedValueOnce('abcd');
      await expect(sign(new Uint8Array([0x01, 0x02]), new Uint8Array([0x10]))).resolves.toEqual(
        new Uint8Array([0xab, 0xcd])
      );
      expect(mockVault.signTransaction).toHaveBeenCalledWith('0102', '10');
      // A locked vault reaches the SDK as a classified error, which the transaction loop defers on.
      mockVault.signTransaction.mockRejectedValueOnce(
        Object.assign(new Error('Wallet is locked'), { reason: 'locked' })
      );
      await expect(sign(new Uint8Array([1]), new Uint8Array([2]))).rejects.toMatchObject({ reason: 'locked' });
    });

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

  describe('startGuardianRecovery', () => {
    it('starts recovery for the matching account', async () => {
      const account = { publicKey: 'account-a' };
      const { maybeStartGuardianRecovery } = jest.requireMock('lib/miden/back/guardian-recovery');
      maybeStartGuardianRecovery.mockClear();
      mockVault.fetchAccounts.mockResolvedValueOnce([account]);
      maybeStartGuardianRecovery.mockResolvedValueOnce(true);

      await expect(startGuardianRecovery(account.publicKey)).resolves.toBe(true);
      // No vault argument: the detached run resolves the live vault per use so
      // a lock mid-run cannot be signed through.
      expect(maybeStartGuardianRecovery).toHaveBeenCalledWith(account);
    });

    it('returns false without starting recovery when the account is missing', async () => {
      const { maybeStartGuardianRecovery } = jest.requireMock('lib/miden/back/guardian-recovery');
      maybeStartGuardianRecovery.mockClear();
      mockVault.fetchAccounts.mockResolvedValueOnce([]);

      await expect(startGuardianRecovery('missing-account')).resolves.toBe(false);
      expect(maybeStartGuardianRecovery).not.toHaveBeenCalled();
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

    it('retires the vault it locks: its insert-key sink leaves the realm with it (#878)', async () => {
      Object.assign(mockStoreState, { vault: mockVault });
      await lock();
      expect(mockLocked).toHaveBeenCalled();
      expect(mockVault.retire).toHaveBeenCalledTimes(1);
    });

    it('retires nothing when no vault is held: an unlock or spawn in flight keeps the sink it installed (#878)', async () => {
      mockUninstallRealmKeystore.mockClear();
      mockInstallRealmKeystore.mockClear();
      await lock();
      expect(mockVault.retire).not.toHaveBeenCalled();
      expect(mockUninstallRealmKeystore).not.toHaveBeenCalled();
      // And never re-derives the sink from a store that holds nothing: that would
      // null a spawn's sink between its key and its adoption (a store resync in lock
      // was proposed and rejected under review; F-025 in the #878 ledger).
      expect(mockInstallRealmKeystore).not.toHaveBeenCalled();
    });
  });

  describe('unlock', () => {
    const unlockableVault = () => ({
      fetchSeedPhraseStatus: jest.fn().mockResolvedValue('stored'),
      migrateLegacyGuardianAccounts: jest.fn().mockResolvedValue(undefined),
      backfillEvmAddresses: jest.fn().mockResolvedValue(undefined),
      backfillGuardianEndpoints: jest.fn().mockResolvedValue(undefined),
      fetchAccounts: jest.fn().mockResolvedValue([]),
      fetchSettings: jest.fn().mockResolvedValue({}),
      getCurrentAccount: jest.fn().mockResolvedValue(null),
      isOwnMnemonic: jest.fn().mockResolvedValue(true),
      insertKeySink: jest.fn()
    });

    it('adopting the vault installs its insert-key sink for the realm (#878)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const adopted = unlockableVault();
      Vault.setup.mockResolvedValueOnce(adopted);
      mockUnlocked.mockImplementationOnce(({ vault }: { vault: unknown }) => {
        mockStoreState.status = WalletStatus.Ready;
        Object.assign(mockStoreState, { vault });
      });
      mockInstallRealmKeystore.mockClear();
      await unlock('pw');
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: adopted.insertKeySink });
    });

    it('a failed unlock leaves the realm sink as the store has it: none while Locked (#878)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const candidate = unlockableVault();
      candidate.fetchAccounts.mockRejectedValueOnce(new Error('storage read failed'));
      Vault.setup.mockResolvedValueOnce(candidate);
      mockStoreState.status = WalletStatus.Locked;
      mockInstallRealmKeystore.mockClear();
      await expect(unlock('pw')).rejects.toThrow('storage read failed');
      expect(mockUnlocked).not.toHaveBeenCalled();
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: null });
    });

    it('a failed unlock while Locked over a vault the store still holds installs no sink (#878)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const candidate = unlockableVault();
      candidate.fetchAccounts.mockRejectedValueOnce(new Error('storage read failed'));
      Vault.setup.mockResolvedValueOnce(candidate);
      // A lock landed before this flow's finally: the vault is still on the state
      // object but the status is not Ready, and the status alone decides.
      mockStoreState.status = WalletStatus.Locked;
      Object.assign(mockStoreState, { vault: mockVault });
      mockInstallRealmKeystore.mockClear();
      await expect(unlock('pw')).rejects.toThrow('storage read failed');
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: null });
    });

    it("a setup that constructs its vault and then throws, over a Ready vault, keeps the Ready vault's sink (#878)", async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const candidateSink = jest.fn();
      // The constructor installed the candidate's sink; setup then failed before returning it.
      Vault.setup.mockImplementationOnce(async () => {
        mockInstallRealmKeystore({ insertKey: candidateSink });
        throw new Error('setup failed after construction');
      });
      Object.assign(mockStoreState, { vault: mockVault });
      mockInstallRealmKeystore.mockClear();
      await expect(unlock('pw')).rejects.toThrow('setup failed after construction');
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: mockVault.insertKeySink });
    });

    it("a failed re-unlock over a Ready vault keeps the Ready vault's sink (#878)", async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const candidate = unlockableVault();
      candidate.fetchSettings.mockRejectedValueOnce(new Error('storage read failed'));
      Vault.setup.mockResolvedValueOnce(candidate);
      Object.assign(mockStoreState, { vault: mockVault });
      mockInstallRealmKeystore.mockClear();
      await expect(unlock('pw')).rejects.toThrow('storage read failed');
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: mockVault.insertKeySink });
    });

    it('uses the unlocked vault for recovery seed input without another password check', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.setup.mockClear();
      const action = { type: 'switch-guardian', accountId: 'account', newGuardianEndpoint: 'https://guardian.example' };
      await provideRecoverySeed('transaction', 'test phrase', {
        type: 'switch-guardian',
        accountId: action.accountId,
        newGuardianEndpoint: action.newGuardianEndpoint
      });

      expect(mockVault.provideRecoverySeed).toHaveBeenCalledWith('transaction', 'test phrase', action);
      expect(Vault.setup).not.toHaveBeenCalled();
    });

    it.each(['stored', 'removing', 'removed', 'unavailable'])('unlocks with seed status %s', async status => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      // The guardian-endpoint backfill makes external HTTP and must NOT gate the
      // unlock UI: model it as a promise that never settles and assert unlock()
      // still resolves (fired detached), while still proving it ran at unlock.
      let backfillStarted = false;
      const mockVaultInstance = {
        fetchSeedPhraseStatus: jest.fn().mockResolvedValue(status),
        removeSeedPhrase: jest.fn().mockResolvedValue(undefined),
        migrateLegacyGuardianAccounts: jest.fn().mockResolvedValue(undefined),
        // Unlock also backfills wallet-derived EVM addresses onto legacy HD
        // accounts (needed by the earn flow) before reading the accounts list.
        backfillEvmAddresses: jest.fn().mockResolvedValue(undefined),
        // ...and stamps a per-account guardianEndpoint onto legacy Guardian
        // accounts that predate the field (#408 stage 2) — detached, so a
        // hanging operator probe can't stall unlock.
        backfillGuardianEndpoints: jest.fn(() => {
          backfillStarted = true;
          return new Promise<void>(() => {}); // never resolves
        }),
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(true)
      };
      Vault.setup.mockResolvedValueOnce(mockVaultInstance);

      // Resolves even though backfillGuardianEndpoints never settles.
      await unlock('password123');

      expect(Vault.setup).toHaveBeenCalledWith('password123');
      expect(mockVaultInstance.removeSeedPhrase).toHaveBeenCalledTimes(Number(status === 'removing'));
      expect(mockVaultInstance.migrateLegacyGuardianAccounts).toHaveBeenCalled();
      expect(mockVaultInstance.backfillEvmAddresses).toHaveBeenCalled();
      expect(mockVaultInstance.fetchAccounts).toHaveBeenCalled();
      expect(mockVaultInstance.fetchSettings).toHaveBeenCalled();
      expect(mockUnlocked).toHaveBeenCalled();
      // Backfill was kicked off at unlock but did not block it.
      expect(mockVaultInstance.backfillGuardianEndpoints).toHaveBeenCalled();
      expect(backfillStarted).toBe(true);
    });

    it('still unlocks when the resumed seed removal fails, leaving the status at removing', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      // removeSeedPhrase throws seedRemovalFailed by design, and reaches the
      // keystore, a client build and the offscreen document. If that rejection
      // escaped unlock() the wallet could never be opened again: the status
      // stays 'removing', so every later unlock re-runs the same failing step.
      const mockVaultInstance = {
        fetchSeedPhraseStatus: jest.fn().mockResolvedValue('removing'),
        removeSeedPhrase: jest.fn().mockRejectedValue(new Error('Removal failed')),
        migrateLegacyGuardianAccounts: jest.fn().mockResolvedValue(undefined),
        backfillEvmAddresses: jest.fn().mockResolvedValue(undefined),
        backfillGuardianEndpoints: jest.fn().mockResolvedValue(undefined),
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(true)
      };
      Vault.setup.mockResolvedValueOnce(mockVaultInstance);

      await expect(unlock('password123')).resolves.toBeUndefined();

      expect(mockVaultInstance.removeSeedPhrase).toHaveBeenCalled();
      // The wallet is open, and the unfinished removal is still reported as
      // 'removing' so the Settings notice can ask the user to retry it.
      expect(mockUnlocked).toHaveBeenCalledWith(expect.objectContaining({ seedPhraseStatus: 'removing' }));
    });

    it('defers the resumed seed removal while the transaction loop holds the lock', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      // removeSeedPhrase zeroes every recovery authorization without checking
      // whether a pipeline is mid-sign with one, so it must not run beside the
      // loop. unlock() can land over an already-Ready vault whose loop is live.
      const mockVaultInstance = {
        fetchSeedPhraseStatus: jest.fn().mockResolvedValue('removing'),
        removeSeedPhrase: jest.fn().mockResolvedValue(undefined),
        migrateLegacyGuardianAccounts: jest.fn().mockResolvedValue(undefined),
        backfillEvmAddresses: jest.fn().mockResolvedValue(undefined),
        backfillGuardianEndpoints: jest.fn().mockResolvedValue(undefined),
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(true)
      };
      Vault.setup.mockResolvedValueOnce(mockVaultInstance);
      installNavigatorLocksMock(null); // the loop holds it
      try {
        await expect(unlock('password123')).resolves.toBeUndefined();
        expect(mockVaultInstance.removeSeedPhrase).not.toHaveBeenCalled();
        // Unlock still completes, and the removal stays pending for a later try.
        expect(mockUnlocked).toHaveBeenCalledWith(expect.objectContaining({ seedPhraseStatus: 'removing' }));
      } finally {
        installNavigatorLocksMock();
      }
    });
  });

  describe('key storage after seed removal and key import', () => {
    it('keeps the active callback when authentication for seed removal fails', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.setup.mockRejectedValueOnce(new Error('authentication failed'));
      Object.assign(mockStoreState, { vault: mockVault });
      await expect(removeSeedPhrase('pw')).rejects.toThrow('authentication failed');
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: mockVault.insertKeySink });
    });

    it('installs the imported wallet callback after key import', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const imported = { ...mockVault, insertKeySink: jest.fn() };
      Vault.spawnFromHotKey.mockResolvedValueOnce(imported);
      mockUnlocked.mockImplementationOnce(() => {
        Object.assign(mockStoreState, { status: WalletStatus.Ready, vault: imported });
      });
      await registerWalletFromHotKey('pw', 'hot:evm', 'https://guardian.example');
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: imported.insertKeySink });
    });

    it('keeps the active callback when key import fails', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.spawnFromHotKey.mockRejectedValueOnce(new Error('import failed'));
      Object.assign(mockStoreState, { vault: mockVault });
      await expect(registerWalletFromHotKey('pw', 'hot:evm')).rejects.toThrow('import failed');
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: mockVault.insertKeySink });
    });
  });

  describe('registerNewWallet', () => {
    it('a spawn that fails leaves the realm sink as the store has it (#878)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.spawn.mockRejectedValueOnce(new Error('hardware setup failed'));
      mockStoreState.status = WalletStatus.Idle;
      mockInstallRealmKeystore.mockClear();
      await expect(registerNewWallet(0 as any, 'pw')).rejects.toThrow('hardware setup failed');
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: null });
    });

    it('adopting the spawned vault installs its insert-key sink for the realm (#878)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const spawned = { ...mockVault, insertKeySink: jest.fn() };
      Vault.spawn.mockResolvedValueOnce(spawned);
      mockUnlocked.mockImplementationOnce(({ vault }: { vault: unknown }) => {
        mockStoreState.status = WalletStatus.Ready;
        Object.assign(mockStoreState, { vault });
      });
      mockInstallRealmKeystore.mockClear();
      await registerNewWallet(0 as any, 'pw');
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: spawned.insertKeySink });
    });

    it('an import whose spawn fails leaves the realm sink as the store has it (#878)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.spawnFromMidenClient.mockRejectedValueOnce(new Error('restore failed'));
      mockStoreState.status = WalletStatus.Idle;
      mockInstallRealmKeystore.mockClear();
      await expect(registerImportedWallet('pw', 'mnemonic', [])).rejects.toThrow('restore failed');
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: null });
    });

    it('adopting the imported vault installs its insert-key sink for the realm (#878)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const imported = { ...mockVault, insertKeySink: jest.fn() };
      Vault.spawnFromMidenClient.mockResolvedValueOnce(imported);
      mockUnlocked.mockImplementationOnce(({ vault }: { vault: unknown }) => {
        mockStoreState.status = WalletStatus.Ready;
        Object.assign(mockStoreState, { vault });
      });
      mockInstallRealmKeystore.mockClear();
      await registerImportedWallet('pw', 'mnemonic', []);
      expect(mockInstallRealmKeystore).toHaveBeenLastCalledWith({ insertKey: imported.insertKeySink });
    });

    it('rides the accounts write queue: an import queued behind a spawn waits for it (#878)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      let spawnInFlight = false;
      let importStartedWhileSpawnInFlight = false;
      Vault.spawn.mockImplementationOnce(async () => {
        spawnInFlight = true;
        await new Promise(r => setTimeout(r, 20));
        spawnInFlight = false;
        throw new Error('spawn failed after its window');
      });
      mockVault.importAccountFromPrivateKey.mockImplementationOnce(async () => {
        if (spawnInFlight) importStartedWhileSpawnInFlight = true;
        return [{ publicKey: 'pk1', name: 'A', isPublic: true, hdIndex: -1 }];
      });
      const spawning = registerNewWallet(0 as any, 'pw').catch(() => {});
      await importAccount('deadbeef', 'A');
      await spawning;
      expect(importStartedWhileSpawnInFlight).toBe(false);
    });

    it('creates new vault and unlocks', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const mockVaultInstance = {
        fetchSeedPhraseStatus: jest.fn().mockResolvedValue('stored'),
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(false)
      };
      Vault.spawn.mockResolvedValueOnce(mockVaultInstance);

      await registerNewWallet(WalletType.Guardian, 'password123', 'mnemonic words', true, 'https://guardian.example');

      expect(Vault.spawn).toHaveBeenCalledWith(
        WalletType.Guardian,
        'password123',
        'mnemonic words',
        true,
        'https://guardian.example'
      );
      expect(mockVaultInstance.fetchAccounts).toHaveBeenCalled();
      expect(mockUnlocked).toHaveBeenCalled();
    });
  });

  describe('registerNewWallet with undefined password', () => {
    it('passes empty string when password is undefined', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const mockVaultInstance = {
        fetchSeedPhraseStatus: jest.fn().mockResolvedValue('stored'),
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(false)
      };
      Vault.spawn.mockResolvedValueOnce(mockVaultInstance);

      await registerNewWallet(WalletType.Guardian, undefined, 'mnemonic words', true);

      expect(Vault.spawn).toHaveBeenCalledWith(WalletType.Guardian, '', 'mnemonic words', true, undefined);
    });
  });

  describe('registerImportedWallet', () => {
    it('imports wallet from miden client and unlocks', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const importedAccounts = [
        { accountId: 'account-id', publicKeyCommitment: 'a1b2', authScheme: 'falcon' as const, secretKeyHex: '0102' }
      ];
      const mockVaultInstance = {
        fetchSeedPhraseStatus: jest.fn().mockResolvedValue('stored'),
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(true)
      };
      Vault.spawnFromMidenClient.mockResolvedValueOnce(mockVaultInstance);

      await registerImportedWallet('password123', 'mnemonic words', [], 2, importedAccounts);

      expect(mockVaultInstance.fetchAccounts).toHaveBeenCalled();
      expect(mockUnlocked).toHaveBeenCalled();
      expect(Vault.spawnFromMidenClient).toHaveBeenCalledWith('password123', 'mnemonic words', [], 2, importedAccounts);
      expect(Vault.setup).not.toHaveBeenCalled();
    });

    it('retires a spawned vault when initialization fails before publication', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const provisionalVault = {
        fetchAccounts: jest.fn().mockRejectedValue(new Error('account read failed')),
        fetchSettings: jest.fn(),
        getCurrentAccount: jest.fn(),
        isOwnMnemonic: jest.fn(),
        retire: jest.fn()
      };
      Vault.spawnFromMidenClient.mockResolvedValueOnce(provisionalVault);

      mockStorageClear.mockClear();

      await expect(registerImportedWallet('password', 'mnemonic', [], 2, [])).rejects.toThrow('account read failed');
      expect(provisionalVault.retire).toHaveBeenCalledTimes(1);
      expect(mockUnlocked).not.toHaveBeenCalled();
      // The spawn RESOLVED, so its own undo cannot fire: without this one the
      // profile keeps a complete, unlockable vault while the UI reports failure.
      expect(mockStorageClear).toHaveBeenCalled();
    });

    it('does not let a failed undo replace the failure it was undoing', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.spawnFromMidenClient.mockResolvedValueOnce({
        fetchAccounts: jest.fn().mockRejectedValue(new Error('account read failed')),
        fetchSettings: jest.fn(),
        getCurrentAccount: jest.fn(),
        isOwnMnemonic: jest.fn(),
        retire: jest.fn()
      });
      mockStorageClear.mockRejectedValueOnce(new Error('storage unavailable'));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // The undo runs in a finally, so an unguarded throw there would surface the
      // storage error and hide the real cause.
      await expect(registerImportedWallet('password', 'mnemonic', [], 2, [])).rejects.toThrow('account read failed');
      // Prove the undo was actually attempted: without this the assertion above is
      // equally satisfied by a run in which it never fired.
      expect(mockStorageClear).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('registerImportedWallet with undefined params', () => {
    it('passes empty strings when password and mnemonic are undefined', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const mockVaultInstance = {
        fetchSeedPhraseStatus: jest.fn().mockResolvedValue('stored'),
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(true)
      };
      Vault.spawnFromMidenClient.mockResolvedValueOnce(mockVaultInstance);

      await registerImportedWallet(undefined, undefined);

      expect(Vault.spawnFromMidenClient).toHaveBeenCalledWith('', '', [], undefined, []);
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

  describe('setGuardianOperatorCommitment', () => {
    it('updates the vault and fires accountsUpdated', async () => {
      const updated = { accounts: [], currentAccount: undefined };
      mockVault.setGuardianOperatorCommitment.mockResolvedValueOnce(updated);

      await setGuardianOperatorCommitment('pk1', 'commitment-hex');

      expect(mockVault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk1', 'commitment-hex');
      expect(mockAccountsUpdated).toHaveBeenCalledWith(updated);
    });
  });

  describe('setGuardianSyncStatus', () => {
    it('updates the vault and fires accountsUpdated', async () => {
      const updated = { accounts: [], currentAccount: undefined };
      mockVault.setGuardianSyncStatus.mockResolvedValueOnce(updated);

      await setGuardianSyncStatus('pk1', 'needs-user-input');

      expect(mockVault.setGuardianSyncStatus).toHaveBeenCalledWith('pk1', 'needs-user-input');
      expect(mockAccountsUpdated).toHaveBeenCalledWith(updated);
    });
  });

  describe('checkGuardianDrift', () => {
    it('delegates to resolveGuardianDrift and broadcasts the refreshed account state when changed', async () => {
      const { resolveGuardianDrift } = jest.requireMock('lib/miden/back/guardian-drift');
      const accounts = [{ publicKey: 'pk1' }];
      const currentAccount = accounts[0];
      mockVault.fetchAccounts.mockResolvedValue(accounts);
      mockVault.getCurrentAccount.mockResolvedValue(currentAccount);
      resolveGuardianDrift.mockResolvedValueOnce({ status: 'needs-user-input', changed: true });

      const result = await checkGuardianDrift('pk1');

      expect(result).toBe('needs-user-input');
      expect(resolveGuardianDrift).toHaveBeenCalledWith(expect.any(Object), 'pk1');
      expect(mockAccountsUpdated).toHaveBeenCalledWith({ accounts, currentAccount });
    });

    it('does not re-fetch accounts or broadcast when resolveGuardianDrift reports no change (no-op drift check)', async () => {
      const { resolveGuardianDrift } = jest.requireMock('lib/miden/back/guardian-drift');
      resolveGuardianDrift.mockResolvedValueOnce({ status: 'in-sync', changed: false });
      mockVault.fetchAccounts.mockClear();
      mockVault.getCurrentAccount.mockClear();

      const result = await checkGuardianDrift('pk1');

      expect(result).toBe('in-sync');
      expect(mockVault.fetchAccounts).not.toHaveBeenCalled();
      expect(mockVault.getCurrentAccount).not.toHaveBeenCalled();
      expect(mockAccountsUpdated).not.toHaveBeenCalled();
    });

    it('wires the vault adapter passed to resolveGuardianDrift to the real vault methods', async () => {
      const { resolveGuardianDrift } = jest.requireMock('lib/miden/back/guardian-drift');
      const accounts = [
        { publicKey: 'pk1', guardianOperatorCommitment: 'abc' },
        { publicKey: 'pk2', guardianOperatorCommitment: 'def' }
      ];
      mockVault.fetchAccounts.mockResolvedValue(accounts);
      mockVault.getCurrentAccount.mockResolvedValue(undefined);
      mockVault.setGuardianEndpoint.mockResolvedValueOnce({ accounts, currentAccount: undefined });
      mockVault.setGuardianOperatorCommitment.mockResolvedValueOnce({ accounts, currentAccount: undefined });
      mockVault.setGuardianSyncStatus.mockResolvedValueOnce({ accounts, currentAccount: undefined });

      resolveGuardianDrift.mockImplementationOnce(async (driftVault: any, pk: string) => {
        const account = await driftVault.getAccount(pk);
        expect(account).toEqual(accounts[0]);
        await driftVault.setGuardianEndpoint(pk, 'https://new-operator');
        await driftVault.setGuardianOperatorCommitment(pk, 'newC');
        await driftVault.setGuardianSyncStatus(pk, 'in-sync');
        return { status: 'in-sync', changed: true };
      });

      await checkGuardianDrift('pk1');

      expect(mockVault.setGuardianEndpoint).toHaveBeenCalledWith('pk1', 'https://new-operator');
      expect(mockVault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk1', 'newC');
      expect(mockVault.setGuardianSyncStatus).toHaveBeenCalledWith('pk1', 'in-sync');
    });

    it("adapter's getAccount returns undefined when no account matches the public key", async () => {
      const { resolveGuardianDrift } = jest.requireMock('lib/miden/back/guardian-drift');
      mockVault.fetchAccounts.mockResolvedValue([{ publicKey: 'other-pk' }]);
      mockVault.getCurrentAccount.mockResolvedValue(undefined);

      resolveGuardianDrift.mockImplementationOnce(async (driftVault: any, pk: string) => {
        const account = await driftVault.getAccount(pk);
        expect(account).toBeUndefined();
        return { status: 'in-sync', changed: false };
      });

      await checkGuardianDrift('missing-pk');
    });
  });

  describe('applyUserGuardianEndpoint', () => {
    it('persists via the guardian-drift verifier and broadcasts the refreshed account state when applied', async () => {
      const { applyUserGuardianEndpoint: applyVerified } = jest.requireMock('lib/miden/back/guardian-drift');
      const accounts = [{ publicKey: 'pk1' }];
      const currentAccount = accounts[0];
      mockVault.fetchAccounts.mockResolvedValue(accounts);
      mockVault.getCurrentAccount.mockResolvedValue(currentAccount);
      applyVerified.mockResolvedValueOnce('applied');

      const result = await applyUserGuardianEndpoint('pk1', 'https://mine');

      expect(result).toBe('applied');
      expect(applyVerified).toHaveBeenCalledWith(expect.any(Object), 'pk1', 'https://mine');
      expect(mockAccountsUpdated).toHaveBeenCalledWith({ accounts, currentAccount });
    });

    it('does not re-read or broadcast account state when the endpoint fails verification', async () => {
      const { applyUserGuardianEndpoint: applyVerified } = jest.requireMock('lib/miden/back/guardian-drift');
      applyVerified.mockResolvedValueOnce('mismatch');
      mockAccountsUpdated.mockClear();
      mockVault.fetchAccounts.mockReset();

      const result = await applyUserGuardianEndpoint('pk1', 'https://wrong');

      expect(result).toBe('mismatch');
      expect(mockAccountsUpdated).not.toHaveBeenCalled();
    });

    it('wires the vault adapter passed to the verifier to the real vault setters', async () => {
      const { applyUserGuardianEndpoint: applyVerified } = jest.requireMock('lib/miden/back/guardian-drift');
      const accounts = [{ publicKey: 'pk1', guardianOperatorCommitment: 'abc' }];
      mockVault.fetchAccounts.mockResolvedValue(accounts);
      mockVault.getCurrentAccount.mockResolvedValue(undefined);
      mockVault.setGuardianEndpoint.mockResolvedValueOnce({ accounts, currentAccount: undefined });
      mockVault.setGuardianOperatorCommitment.mockResolvedValueOnce({ accounts, currentAccount: undefined });
      mockVault.setGuardianSyncStatus.mockResolvedValueOnce({ accounts, currentAccount: undefined });

      applyVerified.mockImplementationOnce(async (driftVault: any, pk: string) => {
        const account = await driftVault.getAccount(pk);
        expect(account).toEqual(accounts[0]);
        await driftVault.setGuardianEndpoint(pk, 'https://new-operator');
        await driftVault.setGuardianOperatorCommitment(pk, 'newC');
        await driftVault.setGuardianSyncStatus(pk, 'in-sync');
        return true;
      });

      await applyUserGuardianEndpoint('pk1', 'https://new-operator');

      expect(mockVault.setGuardianEndpoint).toHaveBeenCalledWith('pk1', 'https://new-operator');
      expect(mockVault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk1', 'newC');
      expect(mockVault.setGuardianSyncStatus).toHaveBeenCalledWith('pk1', 'in-sync');
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
    // Every dispatch now runs through the "DApps Interaction" kill switch, and
    // `isDAppEnabled()` is `vault.isExist() && settings.DAppEnabled`. The suite's
    // shared Vault mock resolves `undefined` by default, so the enabled state has
    // to be arranged explicitly here (and reset so it can't leak into the
    // `mockResolvedValueOnce`-based specs elsewhere in this file).
    beforeEach(() => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.isExist.mockResolvedValue(true);
    });

    afterEach(() => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.isExist.mockReset();
    });

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

      expect(requestSign).toHaveBeenCalledWith('https://example.com', req, undefined);
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

      expect(requestPrivateNotes).toHaveBeenCalledWith('https://example.com', req, undefined);
      expect(result).toEqual({ notes: [] });
    });

    it('handles AssetsRequest', async () => {
      const { requestAssets } = jest.requireMock('./dapp');
      requestAssets.mockResolvedValueOnce({ assets: [] });

      const req = { type: MidenDAppMessageType.AssetsRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      expect(requestAssets).toHaveBeenCalledWith('https://example.com', req, undefined);
      expect(result).toEqual({ assets: [] });
    });

    it('handles GuardianInfoRequest', async () => {
      const { requestGuardianInfo } = jest.requireMock('./dapp');
      requestGuardianInfo.mockResolvedValueOnce({ guardianInfo: {} });

      const req = { type: MidenDAppMessageType.GuardianInfoRequest, sourcePublicKey: 'pk' };
      const result = await processDApp('https://example.com', req as any);

      expect(requestGuardianInfo).toHaveBeenCalledWith('https://example.com', req);
      expect(result).toEqual({ guardianInfo: {} });
    });

    it('handles ImportPrivateNoteRequest', async () => {
      const { requestImportPrivateNote } = jest.requireMock('./dapp');
      requestImportPrivateNote.mockResolvedValueOnce({ imported: true });

      const req = { type: MidenDAppMessageType.ImportPrivateNoteRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      expect(requestImportPrivateNote).toHaveBeenCalledWith('https://example.com', req, undefined);
      expect(result).toEqual({ imported: true });
    });

    it('handles ConsumableNotesRequest', async () => {
      const { requestConsumableNotes } = jest.requireMock('./dapp');
      requestConsumableNotes.mockResolvedValueOnce({ notes: [] });

      const req = { type: MidenDAppMessageType.ConsumableNotesRequest, data: {} };
      const result = await processDApp('https://example.com', req as any);

      expect(requestConsumableNotes).toHaveBeenCalledWith('https://example.com', req, undefined);
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

    // The confirmation store keys prompts by session and the mobile modal renders
    // only the FOREGROUND session's slot, so a handler that drops the id parks its
    // prompt in the unrendered '__default__' slot — the promise never settles and
    // the shared concurrency-1 dApp queue wedges for every origin.
    it.each([
      [MidenDAppMessageType.SignRequest, 'requestSign'],
      [MidenDAppMessageType.PrivateNotesRequest, 'requestPrivateNotes'],
      [MidenDAppMessageType.AssetsRequest, 'requestAssets'],
      [MidenDAppMessageType.ImportPrivateNoteRequest, 'requestImportPrivateNote'],
      [MidenDAppMessageType.ConsumableNotesRequest, 'requestConsumableNotes']
    ])('threads the multi-instance sessionId into %s', async (type, handlerName) => {
      const handler = jest.requireMock('./dapp')[handlerName as string];
      handler.mockResolvedValueOnce({});

      const req = { type, data: {} };
      await processDApp('https://example.com', req as any, 'session-7');

      expect(handler).toHaveBeenCalledWith('https://example.com', req, 'session-7');
    });

    // The Settings toggle used to be enforced only in the extension's PageRequest
    // arm; mobile and desktop call processDApp directly, so it was inert there.
    it('refuses every request when the DApps Interaction switch is off', async () => {
      const browser = jest.requireMock('webextension-polyfill');
      browser.storage.local.get.mockResolvedValueOnce({ DAppEnabled: false });
      const { requestPermission } = jest.requireMock('./dapp');
      // The `./dapp` module mocks are shared across this file and are not reset
      // between specs, so clear this one before asserting it is never reached.
      requestPermission.mockClear();

      await expect(
        processDApp('https://example.com', { type: MidenDAppMessageType.PermissionRequest } as any)
      ).rejects.toThrow('NOT_GRANTED');

      expect(requestPermission).not.toHaveBeenCalled();
    });

    it('refuses when the vault does not exist yet', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.isExist.mockResolvedValue(false);
      const { getCurrentPermission } = jest.requireMock('./dapp');
      getCurrentPermission.mockClear();

      await expect(
        processDApp('https://example.com', { type: MidenDAppMessageType.GetCurrentPermissionRequest } as any)
      ).rejects.toThrow('NOT_GRANTED');

      expect(getCurrentPermission).not.toHaveBeenCalled();
    });
  });

  describe('stub action functions', () => {
    it('decryptCiphertexts is a no-op stub', () => {
      expect(() => decryptCiphertexts('pk', ['ct1'])).not.toThrow();
    });

    it('revealViewKey is a no-op stub', () => {
      expect(() => revealViewKey('pk', 'pw')).not.toThrow();
    });

    it('revealPublicKey is a no-op stub', () => {
      expect(() => revealPublicKey('pk')).not.toThrow();
    });

    it('removeAccount is a no-op stub', () => {
      expect(() => removeAccount('pk', 'pw')).not.toThrow();
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

  describe('revealPrivateKey', () => {
    it('delegates to Vault.revealPrivateKey', async () => {
      const { Vault } = require('lib/miden/back/vault');
      (Vault.revealPrivateKey as jest.Mock).mockResolvedValueOnce('deadbeef');

      const result = await revealPrivateKey('pk-commitment-hex', 'password');

      expect(Vault.revealPrivateKey).toHaveBeenCalledWith('pk-commitment-hex', 'password');
      expect(result).toBe('deadbeef');
    });

    it('forwards undefined password for hardware-unlock path', async () => {
      const { Vault } = require('lib/miden/back/vault');
      (Vault.revealPrivateKey as jest.Mock).mockResolvedValueOnce('abc123');

      await revealPrivateKey('pk-commitment-hex');

      expect(Vault.revealPrivateKey).toHaveBeenCalledWith('pk-commitment-hex', undefined);
    });
  });

  describe('exportWalletBackupMaterial', () => {
    it('forwards the password and returns the vault snapshot unchanged', async () => {
      // The serialization this used to assert now lives with the queue, in
      // Vault.exportWalletBackupMaterial; this layer only authenticates and forwards.
      const { Vault } = require('lib/miden/back/vault');
      const snapshot = {
        seedPhrase: 'words',
        accounts: [],
        midenClientDbContent: 'mc',
        walletDbContent: 'wallet',
        importedAccounts: []
      };
      (Vault.exportWalletBackupMaterial as jest.Mock).mockResolvedValueOnce(snapshot);

      await expect(exportWalletBackupMaterial('password')).resolves.toBe(snapshot);
      expect(Vault.exportWalletBackupMaterial).toHaveBeenCalledWith('password');
    });
  });

  describe('importAccount', () => {
    it('imports via vault, broadcasts accountsUpdated, returns new public key', async () => {
      const newAccounts = [{ publicKey: 'mtst1newly-imported', name: 'Imported', isPublic: true, hdIndex: -1 }];
      mockVault.importAccountFromPrivateKey.mockResolvedValueOnce(newAccounts);

      const result = await importAccount('deadbeef', 'My Import');

      expect(mockVault.importAccountFromPrivateKey).toHaveBeenCalledWith('deadbeef', 'My Import');
      expect(mockAccountsUpdated).toHaveBeenCalledWith({ accounts: newAccounts });
      expect(result).toBe('mtst1newly-imported');
    });

    it('rejects names that exceed 16 characters', async () => {
      await expect(importAccount('deadbeef', 'a'.repeat(17))).rejects.toThrow(/Invalid name/);
      expect(mockVault.importAccountFromPrivateKey).not.toHaveBeenCalled();
    });

    it('serializes concurrent imports through the unlock queue', async () => {
      // Two importAccount calls fired simultaneously must not run their
      // vault-level work in parallel — otherwise both can read the same
      // stale accounts list pre-WASM and the later write clobbers the
      // earlier one. PQueue concurrency: 1 inside `getUnlockQueue`
      // enforces this; prove it by watching whether the second call's
      // vault method observes the first still in-flight.
      let firstCallInFlight = false;
      let secondStartedWhileFirstInFlight = false;

      mockVault.importAccountFromPrivateKey
        .mockImplementationOnce(async () => {
          firstCallInFlight = true;
          await new Promise(r => setTimeout(r, 20));
          firstCallInFlight = false;
          return [{ publicKey: 'pk1', name: 'A', isPublic: true, hdIndex: -1 }];
        })
        .mockImplementationOnce(async () => {
          if (firstCallInFlight) {
            secondStartedWhileFirstInFlight = true;
          }
          return [
            { publicKey: 'pk1', name: 'A', isPublic: true, hdIndex: -1 },
            { publicKey: 'pk2', name: 'B', isPublic: true, hdIndex: -1 }
          ];
        });

      const [pk1, pk2] = await Promise.all([importAccount('deadbeef', 'A'), importAccount('cafebabe', 'B')]);

      expect(secondStartedWhileFirstInFlight).toBe(false);
      expect(pk1).toBe('pk1');
      expect(pk2).toBe('pk2');
    });
  });

  // The lazy `getVault()` accessor in actions.ts has a `typeof init_vault === 'function'`
  // guard that only fires in the SW bundle (Vite injects `init_vault`). In Jest the
  // symbol is undefined, so the true arm of that branch is unreachable without a
  // shim. We isolate the module, install a fake `init_vault` on globalThis, and
  // re-import to drive the factory-await arm.
  describe('lazy getVault() with init_vault present (SW bundle simulation)', () => {
    it('awaits init_vault when defined and proceeds to Vault.isExist', async () => {
      const initVaultStub = jest.fn(async () => {});
      (globalThis as any).init_vault = initVaultStub;
      try {
        await jest.isolateModulesAsync(async () => {
          jest.doMock('lib/miden/back/vault', () => ({
            Vault: {
              isExist: jest.fn().mockResolvedValue(true),
              spawn: jest.fn(),
              setup: jest.fn(),
              spawnFromMidenClient: jest.fn(),
              getCurrentAccountPublicKey: jest.fn()
            }
          }));
          jest.doMock('./store', () => ({
            store: { getState: jest.fn(() => ({ inited: true })) },
            toFront: jest.fn(s => s),
            inited: jest.fn(),
            locked: jest.fn(),
            unlocked: jest.fn(),
            accountsUpdated: jest.fn(),
            settingsUpdated: jest.fn(),
            currentAccountUpdated: jest.fn(),
            withInited: jest.fn(async (fn: any) => fn()),
            withUnlocked: jest.fn(async (fn: any) => fn({ vault: {} }))
          }));
          jest.doMock('./dapp', () => ({
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
          jest.doMock('webextension-polyfill', () => ({
            runtime: { onMessage: { addListener: jest.fn() } },
            storage: { local: { get: jest.fn().mockResolvedValue({ DAppEnabled: true }) } }
          }));

          const isolated = await import('./actions');
          await isolated.init();
          // The factory must have been awaited at least once on first vault access.
          expect(initVaultStub).toHaveBeenCalled();

          // A second call (via isDAppEnabled) does NOT re-enter the factory because
          // the lazy `_vault` is now memoized — exercises the falsy `if (!_vault)` arm.
          initVaultStub.mockClear();
          await isolated.isDAppEnabled();
          expect(initVaultStub).not.toHaveBeenCalled();
        });
      } finally {
        delete (globalThis as any).init_vault;
      }
    });
  });
});
