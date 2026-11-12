import { MidenDAppMessageType, type MidenDAppRequest } from 'lib/adapter/types';
import type { BackupSignalReason } from 'lib/backup/adopt-signal';
import { getMessage } from 'lib/i18n';
import { getAccountsWriteQueue } from 'lib/miden/back/accounts-write-queue';
import { PublicError } from 'lib/miden/back/defaults';
import { SendTransaction } from 'lib/miden/db/types';
import { spendingLimits, transactions } from 'lib/miden/repo';
import { clearStorage, PENDING_ADMISSION_STORAGE_KEY, SETUP_WIPE_KEPT_KEYS } from 'lib/miden/reset';
import { SpendingLimitPriceUnavailableError } from 'lib/miden/spending-limits/types';
import { resolveSpendsUsd } from 'lib/miden/spending-limits/valuation';
import { NoteTypeEnum } from 'lib/miden/types';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import {
  type BackupRefreshOutcome,
  type BackupRefreshReason,
  EstimateUsdcxBurnFeeRequest,
  type UsdcxBurnFeeEstimate,
  WalletMessageType,
  WalletStatus
} from 'lib/shared/types';
import { sendEvent } from 'lib/telemetry/sink';
import { WalletType } from 'screens/onboarding/types';

import {
  DAppQueueDeadlineError,
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
  revertGuardianEndpointAfterDiscard,
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
  exportAccountFile,
  revealViewKey,
  revealPrivateKey,
  revealPublicKey,
  removeAccount,
  importAccount,
  importMnemonicAccount,
  importFundraiserAccount,
  importWatchOnlyAccount,
  handleReportTelemetryEvent,
  estimateUsdcxBurnFee,
  getSpendingLimit,
  saveSpendingLimit,
  assessOutgoingSpendingLimit,
  getStrictAuthenticationProtectors,
  verifyStrictActionAuthentication,
  swapHotKey,
  importHotKeyPair,
  refreshBackup,
  deleteBackup
} from './actions';
import packageJson from '../../../../package.json';

jest.mock('lib/miden/spending-limits/valuation', () => ({ resolveSpendsUsd: jest.fn() }));

const mockEstimateUsdcxBurnFeeReserve = jest.fn<Promise<UsdcxBurnFeeEstimate>, [string, number]>();
jest.mock('lib/usdcx/burn-fee', () => ({
  estimateUsdcxBurnFeeReserve: (accountPublicKey: string, destinationChainId: number) =>
    mockEstimateUsdcxBurnFeeReserve(accountPublicKey, destinationChainId)
}));

const mockedResolve = jest.mocked(resolveSpendsUsd);

// Create mock vault instance
const mockRedeemAccess = jest.fn<Promise<'granted' | 'rejected'>, [string, { accountId: string; rpcUrl: string }]>();
const mockAdmitted = jest.fn<Promise<boolean>, [string]>();
jest.mock('lib/mainnet-access', () => ({
  redeemMainnetAccessCode: (code: string, target: { accountId: string; rpcUrl: string }) =>
    mockRedeemAccess(code, target),
  isMainnetAccountAdmitted: (accountId: string) => mockAdmitted(accountId)
}));

// The endpoint override a case sets; null leaves the build network's defaults.
let mockEndpointOverride: { rpcUrl: string; networkName: MIDEN_NETWORK_NAME } | null = null;
const mockLoadEndpointOverrides = jest.fn();
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const actual = jest.requireActual('lib/miden-chain/effective-endpoints');
  return {
    ...actual,
    loadEndpointOverrides: () => {
      mockLoadEndpointOverrides();
      return actual.loadEndpointOverrides();
    },
    getEffectiveRpcUrl: () => mockEndpointOverride?.rpcUrl ?? actual.getEffectiveRpcUrl(),
    getEffectiveNetworkName: () => mockEndpointOverride?.networkName ?? actual.getEffectiveNetworkName()
  };
});

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
  updateGuardianBinding: jest.fn(),
  swapHotKey: jest.fn(),
  importHotKeyPair: jest.fn(),
  retire: jest.fn(),
  insertKeySink: jest.fn()
};

// A spawned vault whose first read fails, so the action never publishes it.
const unpublishableVault = () => ({
  fetchAccounts: jest.fn().mockRejectedValue(new Error('account read failed')),
  fetchSettings: jest.fn(),
  getCurrentAccount: jest.fn(),
  isOwnMnemonic: jest.fn(),
  retire: jest.fn()
});

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

const mockHold = {};
const mockExportAccountFile = jest.fn();
const mockGetMidenClient = jest.fn();
const mockAssertWasmHoldCurrent = jest.fn();
const mockWithWasmClientLock = jest.fn();
let mockRealmGetKey: ((key: Uint8Array) => Promise<Uint8Array | null | undefined>) | null = null;
const mockInstallRealmKeystore = jest.fn();
const mockUninstallRealmKeystore = jest.fn();
jest.mock('lib/miden/sdk/miden-client', () => ({
  ...jest.requireActual('lib/miden/sdk/miden-client'),
  assertWasmHoldCurrent: (...a: unknown[]) => mockAssertWasmHoldCurrent(...a),
  getMidenClient: (...a: unknown[]) => mockGetMidenClient(...a),
  installRealmKeystore: (...a: unknown[]) => mockInstallRealmKeystore(...a),
  uninstallRealmKeystore: (...a: unknown[]) => mockUninstallRealmKeystore(...a),
  withWasmClientLock: (...a: unknown[]) => mockWithWasmClientLock(...a)
}));

jest.mock('lib/miden/back/guardian-drift', () => ({
  resolveGuardianDrift: jest.fn(),
  applyUserGuardianEndpoint: jest.fn(),
  revertGuardianEndpointAfterDiscard: jest.fn()
}));

jest.mock('lib/miden/back/guardian-recovery', () => ({
  maybeStartGuardianRecovery: jest.fn(),
  releaseGuardianRecoveriesOnLock: jest.fn()
}));

// The encrypted backup is the network boundary of these actions: each action only names the event.
const mockRunBackupRefresh = jest.fn<Promise<BackupRefreshOutcome>, [BackupRefreshReason]>();
const mockDeleteBackupProfile = jest.fn<Promise<BackupRefreshOutcome>, []>();
const mockOnBackupLock = jest.fn<void, []>();
jest.mock('lib/backup/refresh', () => ({
  runBackupRefresh: (reason: BackupRefreshReason) => mockRunBackupRefresh(reason),
  deleteBackupProfile: () => mockDeleteBackupProfile(),
  onBackupLock: () => mockOnBackupLock()
}));

const mockInstallBackupSignalHandler = jest.fn<void, [((reason: BackupSignalReason) => void) | null]>();
jest.mock('lib/backup/adopt-signal', () => ({
  installBackupSignalHandler: (next: ((reason: BackupSignalReason) => void) | null) =>
    mockInstallBackupSignalHandler(next)
}));

const mockVaultGetKey = jest.fn();
const mockWithAccountFileKeyReader = jest.fn();
jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    isExist: jest.fn(),
    spawn: jest.fn(),
    spawnFromHotKey: jest.fn(),
    setup: jest.fn(),
    revealMnemonic: jest.fn(),
    exportWalletBackupMaterial: jest.fn(),
    revealPrivateKey: jest.fn(),
    // A jest.fn wrapping a LAZY forwarder: the factory is hoisted above the const, so referencing
    // it directly is a TDZ error, but a plain arrow is not a mock and the suite-wide
    // Object.values(Vault).forEach(m => m.mockClear()) then throws on it.
    withAccountFileKeyReader: jest.fn((...a: unknown[]) => mockWithAccountFileKeyReader(...a)),
    spawnFromMidenClient: jest.fn(),
    getCurrentAccountPublicKey: jest.fn(),
    hasHardwareProtector: jest.fn(),
    hasPasswordProtector: jest.fn(),
    verifyProtector: jest.fn()
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
  seedPhraseStatusUpdated: jest.fn(),
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
  requestLoginKey: jest.fn(),
  requestLoginSign: jest.fn(),
  waitForTransaction: jest.fn()
}));

// The failed-restore undo reaches `storage.local.remove` through clearStorage; without it
// the undo throws inside a finally and masks the failure it was undoing.
const mockStorageRemove = jest.fn().mockResolvedValue(undefined);
const mockStorageSet = jest.fn().mockResolvedValue(undefined);

jest.mock('webextension-polyfill', () => {
  // One object behind both views: consumers read `default ?? module`, and a test
  // that steers `storage.local.get` must steer the same mock either way.
  const storage = {
    local: {
      get: jest.fn().mockResolvedValue({ DAppEnabled: true }),
      set: (...args: unknown[]) => mockStorageSet(...args),
      // A storage reset lists the keys (`get(null)`) and removes all but the kept ones, so the
      // failed-restore undo reaches `remove` through clearStorage.
      remove: (...args: unknown[]) => mockStorageRemove(...args)
    }
  };
  const runtime = { onMessage: { addListener: jest.fn() } };
  return { __esModule: true, default: { storage, runtime }, storage, runtime };
});

// `unlock`'s seed-removal resume and the explicit `removeSeedPhrase` both take
// the generate-transactions-loop lock. jsdom's `navigator` is non-configurable,
// so attach `.locks` to whatever object it already is. `lockResult` null models
// the loop already holding it. A request without options (the reset's badge
// storage turn) waits for its lock, so it is always granted one.
const installNavigatorLocksMock = (lockResult: unknown = {}) => {
  const nav = (globalThis as unknown as { navigator?: object }).navigator || {};
  Object.defineProperty(nav, 'locks', {
    value: {
      request: jest.fn(async (_name: string, optsOrCb: unknown, cb?: (l: unknown) => unknown) =>
        typeof optsOrCb === 'function' ? optsOrCb({}) : cb?.(lockResult)
      )
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
    mockStorageRemove.mockReset().mockResolvedValue(undefined);
    mockStorageSet.mockReset().mockResolvedValue(undefined);
    mockAdmitted.mockReset();
    mockRunBackupRefresh.mockReset().mockResolvedValue('unchanged');
    mockDeleteBackupProfile.mockReset().mockResolvedValue('updated');
    mockOnBackupLock.mockReset();
    mockInstallBackupSignalHandler.mockReset();
    mockEndpointOverride = null;
    mockInited.mockClear();
    mockLocked.mockClear();
    mockUnlocked.mockClear();
    mockAccountsUpdated.mockClear();
    mockSettingsUpdated.mockClear();
    mockCurrentAccountUpdated.mockClear();
    Object.values(mockVault).forEach((mock: jest.Mock) => mock.mockClear());
    mockRealmGetKey = null;
    mockExportAccountFile.mockReset().mockImplementation(async (_account, assertLive) => {
      assertLive('after account export');
      return new Uint8Array([4, 5, 6]);
    });
    mockGetMidenClient.mockReset().mockResolvedValue({ exportAccountFile: mockExportAccountFile });
    mockAssertWasmHoldCurrent.mockClear();
    mockWithWasmClientLock.mockReset().mockImplementation(async operation => operation(mockHold));
    mockVaultGetKey.mockReset().mockResolvedValue(new Uint8Array([7]));
    mockWithAccountFileKeyReader
      .mockReset()
      .mockImplementation(async (_accountPublicKey, _password, operation) => operation(mockVaultGetKey));
    mockInstallRealmKeystore.mockReset().mockImplementation(callbacks => {
      if ('getKey' in callbacks) mockRealmGetKey = callbacks.getKey;
    });
    mockUninstallRealmKeystore.mockReset().mockImplementation(callbacks => {
      if (callbacks.getKey === mockRealmGetKey) mockRealmGetKey = null;
    });
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

    // The backup keys live in this realm, so a signal raised here runs the refresh directly.
    it('installs the backup signal handler, which runs the refresh of the signalled event', async () => {
      await init();

      expect(mockInstallBackupSignalHandler).toHaveBeenCalledTimes(1);
      const handler = mockInstallBackupSignalHandler.mock.calls[0]![0];
      expect(handler).not.toBeNull();
      handler?.('guardian-adopt');
      handler?.('transaction-completed');
      expect(mockRunBackupRefresh.mock.calls).toEqual([['guardian-adopt'], ['transaction-completed']]);
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
    it.each([WalletStatus.Ready, WalletStatus.Locked])(
      'returns initialized status %s from one snapshot',
      async status => {
        const { store } = jest.requireMock('lib/miden/back/store');
        store.getState.mockClear();
        mockStoreState.inited = true;
        mockStoreState.status = status;

        const result = await getFrontState();

        expect(result.status).toBe(status);
        expect(store.getState).toHaveBeenCalledTimes(1);
        expect(result).toHaveProperty('backendInitialized', true);
      }
    );

    it('returns pending Idle when inited is false', async () => {
      mockStoreState.inited = false;

      const result = await getFrontState();

      expect(result.status).toBe(WalletStatus.Idle);
      expect(result.accounts).toEqual([]);
      expect(result.currentAccount).toBeNull();
      expect(result).toHaveProperty('backendInitialized', false);
    });

    it('marks initialized Idle as a genuine onboarding state', async () => {
      mockStoreState.inited = true;
      mockStoreState.status = WalletStatus.Idle;

      expect(await getFrontState()).toMatchObject({ status: WalletStatus.Idle, backendInitialized: true });
    });

    it('marks a failed store read as pending', async () => {
      const { store } = jest.requireMock('lib/miden/back/store');
      store.getState.mockImplementationOnce(() => {
        throw new Error('Store unavailable');
      });

      expect(await getFrontState()).toMatchObject({ status: WalletStatus.Idle, backendInitialized: false });
    });
  });

  describe('lock', () => {
    it('calls locked', async () => {
      await lock();

      expect(mockLocked).toHaveBeenCalled();
    });

    // The backup's storage key and AES key live for one unlock only.
    it('drops the backup session keys once, before locked', async () => {
      await lock();

      expect(mockOnBackupLock).toHaveBeenCalledTimes(1);
      expect(mockOnBackupLock.mock.invocationCallOrder[0]).toBeLessThan(mockLocked.mock.invocationCallOrder[0]!);
    });

    it('releases the Guardian recoveries a failed source kept, once, under the WASM lock before locked', async () => {
      const { releaseGuardianRecoveriesOnLock } = jest.requireMock('lib/miden/back/guardian-recovery');
      releaseGuardianRecoveriesOnLock.mockClear();
      await lock();
      expect(releaseGuardianRecoveriesOnLock).toHaveBeenCalledTimes(1);
      expect(releaseGuardianRecoveriesOnLock.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockWithWasmClientLock.mock.invocationCallOrder[0]!
      );
      expect(releaseGuardianRecoveriesOnLock.mock.invocationCallOrder[0]).toBeLessThan(
        mockLocked.mock.invocationCallOrder[0]!
      );
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
      const mockVaultInstance = {
        fetchSeedPhraseStatus: jest.fn().mockResolvedValue(status),
        removeSeedPhrase: jest.fn().mockResolvedValue(undefined),
        fetchAccounts: jest.fn().mockResolvedValue([]),
        fetchSettings: jest.fn().mockResolvedValue({}),
        getCurrentAccount: jest.fn().mockResolvedValue(null),
        isOwnMnemonic: jest.fn().mockResolvedValue(true)
      };
      Vault.setup.mockResolvedValueOnce(mockVaultInstance);

      await unlock('password123');

      expect(Vault.setup).toHaveBeenCalledWith('password123');
      expect(mockVaultInstance.removeSeedPhrase).toHaveBeenCalledTimes(Number(status === 'removing'));
      expect(mockVaultInstance.fetchAccounts).toHaveBeenCalled();
      expect(mockVaultInstance.fetchSettings).toHaveBeenCalled();
      expect(mockUnlocked).toHaveBeenCalled();
    });

    it('unlocks without running any account migration', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const migrations = {
        migrateLegacyGuardianAccounts: jest.fn().mockResolvedValue(undefined),
        backfillEvmAddresses: jest.fn().mockResolvedValue(undefined),
        backfillGuardianEndpoints: jest.fn().mockResolvedValue(undefined)
      };
      Vault.setup.mockResolvedValueOnce({ ...unlockableVault(), ...migrations });

      await unlock('pw');

      expect(mockUnlocked).toHaveBeenCalled();
      expect(migrations.migrateLegacyGuardianAccounts).not.toHaveBeenCalled();
      expect(migrations.backfillEvmAddresses).not.toHaveBeenCalled();
      expect(migrations.backfillGuardianEndpoints).not.toHaveBeenCalled();
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

    // The prompt after a recovery passes no credential: the unlocked vault removes the phrase, and a passcode
    // wallet (no hardware protector) is never asked for a credential-free unlock it cannot do.
    it('removes the phrase with the unlocked vault when no password is given', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      // `withUnlocked` is mocked to hand out `mockVault`, so the removal lands on it.
      const removeOnUnlocked = jest.fn().mockResolvedValue(undefined);
      Object.assign(mockVault, { removeSeedPhrase: removeOnUnlocked });
      try {
        await expect(removeSeedPhrase()).resolves.toBeUndefined();
        expect(Vault.setup).not.toHaveBeenCalled();
        expect(removeOnUnlocked).toHaveBeenCalledTimes(1);
      } finally {
        // The shared mock's `beforeEach` clears every value as a mock, so the property must go, not stay undefined.
        Reflect.deleteProperty(mockVault, 'removeSeedPhrase');
      }
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
    it('registers the final account before publishing and keeps it for a failed-request retry', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      mockEndpointOverride = { rpcUrl: 'http://127.0.0.1:57291', networkName: MIDEN_NETWORK_NAME.LOCALNET };
      const candidate = {
        ...mockVault,
        fetchAccounts: jest.fn().mockResolvedValue([{ publicKey: 'final-account' }]),
        getCurrentAccount: jest.fn().mockResolvedValue({ publicKey: 'final-account' })
      };
      Vault.spawn.mockResolvedValueOnce(candidate);
      mockRedeemAccess.mockRejectedValueOnce(new Error('Node unavailable'));
      mockRedeemAccess.mockImplementationOnce(async () => {
        expect(mockUnlocked).not.toHaveBeenCalled();
        return 'granted';
      });
      try {
        await expect(
          registerNewWallet(WalletType.OffChain, 'pw', 'words', false, undefined, '8gKIgL0O6HcU')
        ).rejects.toThrow('Node unavailable');
        expect(mockUnlocked).not.toHaveBeenCalled();
        expect(candidate.retire).not.toHaveBeenCalled();
        await registerNewWallet(WalletType.OffChain, 'pw', 'words', false, undefined, '8gKIgL0O6HcU');
        expect(Vault.spawn).toHaveBeenCalledTimes(1);
        expect(mockRedeemAccess).toHaveBeenLastCalledWith('8gKIgL0O6HcU', {
          accountId: 'final-account',
          rpcUrl: 'http://127.0.0.1:57291'
        });
        expect(mockUnlocked).toHaveBeenCalledTimes(1);
      } finally {
        mockRedeemAccess.mockReset();
      }
    });

    const spawnedFor = (publicKey: string, ...otherAccounts: string[]) => ({
      ...mockVault,
      fetchAccounts: jest.fn().mockResolvedValue([publicKey, ...otherAccounts].map(key => ({ publicKey: key }))),
      getCurrentAccount: jest.fn().mockResolvedValue({ publicKey }),
      retire: jest.fn()
    });
    // The realm's storage in the admission cases: a setup's writes and wipes land in it, and a restart reads it.
    let stored: Record<string, unknown> = {};
    const SAVED_VAULT_KEY = 'spawned-vault';
    const useModelledStorage = () => {
      const { get } = jest.requireMock('webextension-polyfill').default.storage.local;
      beforeEach(() => {
        stored = { DAppEnabled: true };
        get.mockImplementation(async (keys: string[] | null) =>
          keys === null
            ? { ...stored }
            : Object.fromEntries(keys.filter(key => key in stored).map(key => [key, stored[key]]))
        );
        mockStorageSet.mockImplementation(async (items: Record<string, unknown>) => {
          Object.assign(stored, items);
        });
        mockStorageRemove.mockImplementation(async (keys: string[]) => {
          for (const key of keys) delete stored[key];
        });
      });
      afterEach(() => {
        get.mockReset().mockResolvedValue({ DAppEnabled: true });
      });
    };
    // A spawn as the real ones run: it wipes through the real clearStorage with the keep list they pass, saves its
    // vault, and returns it once `returns` settles. One that never settles is a realm that stopped inside the spawn.
    const wipingSpawn =
      (vault: unknown, returns: Promise<unknown> = Promise.resolve()) =>
      async () => {
        await clearStorage(false, SETUP_WIPE_KEPT_KEYS);
        await getStorageProvider().set({ [SAVED_VAULT_KEY]: 'vault' });
        await returns;
        return vault;
      };
    // Stands for a realm that stopped: the test rejects it once it is done, so nothing waiting on it runs before.
    const stoppedRealm = () => {
      let stop: (error: Error) => void = () => {};
      const promise = new Promise<never>((_resolve, reject) => {
        stop = reject;
      });
      return { promise, stop: () => stop(new Error('realm stopped')) };
    };
    const until = async (done: () => boolean) => {
      while (!done()) await new Promise(resolve => setTimeout(resolve, 0));
    };
    // A realm restart: a fresh actions module, which holds no pending vault, over the same storage. Returns the keys
    // the restart removed.
    const restartOver = async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      mockStorageRemove.mockClear();
      mockLoadEndpointOverrides.mockClear();
      Vault.isExist.mockResolvedValueOnce(true);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // The isolated registry shares these mocks, so the storage they model is the same.
        await jest.isolateModulesAsync(async () => {
          const restarted: typeof import('./actions') = jest.requireActual('./actions');
          await restarted.init();
        });
      } finally {
        warn.mockRestore();
      }
      return mockStorageRemove.mock.calls.flatMap(call => call[0] as string[]);
    };

    describe('off an invite-only network', () => {
      useModelledStorage();

      beforeEach(() => {
        mockEndpointOverride = { rpcUrl: 'https://rpc.testnet.miden.io', networkName: MIDEN_NETWORK_NAME.TESTNET };
      });

      it.each([
        ['a create', 'spawn', () => registerNewWallet(WalletType.Guardian, 'pw', 'words', false)],
        ['a seed import', 'spawn', () => registerNewWallet(WalletType.Guardian, 'pw', 'words', true)],
        ['a hot-key setup', 'spawnFromHotKey', () => registerWalletFromHotKey('pw', 'hot:evm')],
        ['a wallet-file restore', 'spawnFromMidenClient', () => registerImportedWallet('pw', 'words', [], [])]
      ] as const)(
        '%s removes a marker an earlier setup left before its spawn, so the next start keeps its wallet',
        async (_name, spawnMethod, invoke) => {
          const { Vault } = jest.requireMock('lib/miden/back/vault');
          // A mainnet setup whose realm stopped inside its spawn, before the profile moved off mainnet.
          stored[PENDING_ADMISSION_STORAGE_KEY] = [];
          let markedAtSpawn: unknown;
          Vault[spawnMethod].mockImplementationOnce(async () => {
            markedAtSpawn = stored[PENDING_ADMISSION_STORAGE_KEY];
            return wipingSpawn(spawnedFor('testnet-account'))();
          });

          await invoke();

          expect(stored).not.toHaveProperty(PENDING_ADMISSION_STORAGE_KEY);
          expect(markedAtSpawn).toBeUndefined();
          expect(mockUnlocked).toHaveBeenCalledTimes(1);
          const removed = await restartOver();
          expect(mockInited).toHaveBeenLastCalledWith(true);
          expect(removed).toEqual([]);
          expect(mockAdmitted).not.toHaveBeenCalled();
        }
      );
    });

    describe('on an invite-only network', () => {
      const MAINNET = { rpcUrl: 'https://rpc.mainnet.miden.io', networkName: MIDEN_NETWORK_NAME.MAINNET };
      useModelledStorage();

      beforeEach(() => {
        mockEndpointOverride = MAINNET;
        // The node admits every account unless a case says otherwise.
        mockAdmitted.mockResolvedValue(true);
      });

      afterEach(() => {
        mockRedeemAccess.mockReset();
      });

      it('undoes a create at once when the node refuses its code, so a new code spawns afresh', async () => {
        const { Vault } = jest.requireMock('lib/miden/back/vault');
        const refused = spawnedFor('refused-account');
        Vault.spawn.mockResolvedValueOnce(refused).mockResolvedValueOnce(spawnedFor('next-account'));
        mockRedeemAccess.mockResolvedValueOnce('rejected').mockResolvedValueOnce('granted');

        const failure = await registerNewWallet(
          WalletType.Guardian,
          'pw',
          'words',
          false,
          undefined,
          'refusedCode1'
        ).catch((error: unknown) => error);
        // clearStorage ran: the refused account's vault is gone, not kept for a retry.
        expect(mockStorageRemove).toHaveBeenCalled();
        expect(refused.retire).toHaveBeenCalledTimes(1);
        expect(mockUnlocked).not.toHaveBeenCalled();
        expect(failure).toMatchObject({ code: 'MAINNET_ACCESS_CODE_REJECTED' });

        await registerNewWallet(WalletType.Guardian, 'pw', 'words', false, undefined, 'acceptedCode');
        expect(Vault.spawn).toHaveBeenCalledTimes(2);
        expect(mockRedeemAccess).toHaveBeenLastCalledWith('acceptedCode', {
          accountId: 'next-account',
          rpcUrl: MAINNET.rpcUrl
        });
        expect(mockUnlocked).toHaveBeenCalledTimes(1);
      });

      it('marks a create the node has not admitted, without its code, and clears the mark once admitted', async () => {
        const { Vault } = jest.requireMock('lib/miden/back/vault');
        Vault.spawn.mockImplementationOnce(wipingSpawn(spawnedFor('final-account')));
        mockRedeemAccess.mockRejectedValueOnce(new Error('Node unavailable')).mockResolvedValueOnce('granted');

        await expect(
          registerNewWallet(WalletType.Guardian, 'pw', 'words', false, undefined, 'secretCode12')
        ).rejects.toThrow('Node unavailable');
        expect(stored[PENDING_ADMISSION_STORAGE_KEY]).toEqual(['final-account']);
        expect(JSON.stringify(mockStorageSet.mock.calls)).not.toContain('secretCode12');
        expect(JSON.stringify(mockStorageSet.mock.calls)).not.toContain('words');

        await registerNewWallet(WalletType.Guardian, 'pw', 'words', false, undefined, 'secretCode12');
        expect(Vault.spawn).toHaveBeenCalledTimes(1);
        expect(stored).not.toHaveProperty(PENDING_ADMISSION_STORAGE_KEY);
        expect(mockUnlocked).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['undoes it when the node does not admit the account', 'pw-refused', false, false],
        ['keeps it and drops the mark when the node admits it', 'pw-admitted', true, true],
        ['keeps it and the mark when the node gives no answer', 'pw-unanswered', undefined, true]
      ] as const)(
        'asks the node, on the next start, about a setup its realm stopped in: %s',
        async (_name, password, admitted, kept) => {
          const { Vault } = jest.requireMock('lib/miden/back/vault');
          Vault.spawn.mockImplementationOnce(wipingSpawn(spawnedFor('final-account')));
          mockRedeemAccess.mockRejectedValueOnce(new Error('Node unavailable'));
          // A password per case, so this create spawns instead of reusing the vault an earlier case left pending.
          await expect(
            registerNewWallet(WalletType.Guardian, password, 'words', false, undefined, 'secretCode12')
          ).rejects.toThrow('Node unavailable');
          expect(stored[PENDING_ADMISSION_STORAGE_KEY]).toEqual(['final-account']);
          const storedKeys = Object.keys(stored);
          if (admitted === undefined) mockAdmitted.mockRejectedValueOnce(new Error('Node unavailable'));
          else mockAdmitted.mockResolvedValueOnce(admitted);

          const removed = await restartOver();

          expect(mockInited).toHaveBeenLastCalledWith(kept);
          expect(mockAdmitted).toHaveBeenCalledWith('final-account');
          // The node asked is the stored network's: a mobile realm runs init before its page loads the choice.
          expect(mockLoadEndpointOverrides.mock.invocationCallOrder[0]).toBeLessThan(
            mockAdmitted.mock.invocationCallOrder[0]!
          );
          const everyStoredKey = expect.arrayContaining(storedKeys);
          expect(removed).toEqual(
            admitted === false ? everyStoredKey : admitted ? [PENDING_ADMISSION_STORAGE_KEY] : []
          );
        }
      );

      it.each([
        [
          'a create',
          'spawn',
          () => registerNewWallet(WalletType.Guardian, 'pw-stopped', 'words', false, undefined, 'secretCode12')
        ],
        ['a seed import', 'spawn', () => registerNewWallet(WalletType.Guardian, 'pw', 'words', true)],
        ['a hot-key setup', 'spawnFromHotKey', () => registerWalletFromHotKey('pw', 'hot:evm')],
        ['a wallet-file restore', 'spawnFromMidenClient', () => registerImportedWallet('pw', 'words', [], [])]
      ] as const)(
        'undoes at the next start %s whose realm stopped inside the spawn',
        async (_name, spawnMethod, invoke) => {
          const { Vault } = jest.requireMock('lib/miden/back/vault');
          const realm = stoppedRealm();
          Vault[spawnMethod].mockImplementationOnce(wipingSpawn(spawnedFor('stopped-account'), realm.promise));
          const setup = invoke().catch(() => undefined);
          try {
            await until(() => SAVED_VAULT_KEY in stored);
            expect(stored[PENDING_ADMISSION_STORAGE_KEY]).toEqual([]);

            const removed = await restartOver();

            expect(mockInited).toHaveBeenLastCalledWith(false);
            expect(removed).toEqual(expect.arrayContaining([SAVED_VAULT_KEY, PENDING_ADMISSION_STORAGE_KEY]));
            expect(mockAdmitted).not.toHaveBeenCalled();
          } finally {
            realm.stop();
            await setup;
          }
        }
      );

      it('undoes at the next start a wallet file stopped after its spawn whose secondary account is not admitted', async () => {
        const { Vault } = jest.requireMock('lib/miden/back/vault');
        Vault.spawnFromMidenClient.mockImplementationOnce(
          wipingSpawn(spawnedFor('current-account', 'secondary-account'))
        );
        const realm = stoppedRealm();
        mockAdmitted.mockReturnValueOnce(realm.promise);
        const setup = registerImportedWallet('pw', 'words', [], []).catch(() => undefined);
        try {
          await until(() => mockAdmitted.mock.calls.length > 0);
          mockAdmitted.mockImplementation(async accountId => accountId === 'current-account');

          const removed = await restartOver();

          expect(removed).toEqual(expect.arrayContaining([SAVED_VAULT_KEY, PENDING_ADMISSION_STORAGE_KEY]));
          expect(mockInited).toHaveBeenLastCalledWith(false);
          expect(mockAdmitted).toHaveBeenCalledWith('secondary-account');
        } finally {
          realm.stop();
          await setup;
        }
      });

      it('refuses a create without a code before the spawn, and lets a seed import without one spawn', async () => {
        const { Vault } = jest.requireMock('lib/miden/back/vault');
        await registerNewWallet(WalletType.Guardian, 'pw', 'words', false).catch(() => undefined);
        expect(Vault.spawn).not.toHaveBeenCalled();
        expect(mockUnlocked).not.toHaveBeenCalled();

        Vault.spawn.mockResolvedValueOnce(spawnedFor('recovered-account'));
        mockAdmitted.mockResolvedValueOnce(true);
        await registerNewWallet(WalletType.Guardian, 'pw', 'words', true);
        expect(Vault.spawn).toHaveBeenCalledTimes(1);
        expect(mockAdmitted).toHaveBeenCalledWith('recovered-account');
        expect(mockUnlocked).toHaveBeenCalledTimes(1);
      });

      it.each([
        [
          'a create',
          'spawn',
          () => registerNewWallet(WalletType.Guardian, 'pw-marked', 'words', false, undefined, 'secretCode12')
        ],
        ['a seed import', 'spawn', () => registerNewWallet(WalletType.Guardian, 'pw', 'words', true)],
        ['a hot-key import', 'spawnFromHotKey', () => registerWalletFromHotKey('pw', 'hot:evm')],
        ['a wallet-file import', 'spawnFromMidenClient', () => registerImportedWallet('pw', 'words', [], [])]
      ] as const)(
        '%s marks its setup before the spawn and every account it holds right after it, and clears the mark once published',
        async (_name, spawnMethod, invoke) => {
          const { Vault } = jest.requireMock('lib/miden/back/vault');
          let markedAtSpawn: unknown;
          let markedAtFirstCheck: unknown;
          let markedAtPublish: unknown;
          Vault[spawnMethod].mockImplementationOnce(async () => {
            markedAtSpawn = stored[PENDING_ADMISSION_STORAGE_KEY];
            return wipingSpawn(spawnedFor('admitted-account', 'second-account'))();
          });
          mockRedeemAccess.mockResolvedValueOnce('granted');
          mockAdmitted.mockImplementation(async () => {
            if (markedAtFirstCheck === undefined) markedAtFirstCheck = stored[PENDING_ADMISSION_STORAGE_KEY];
            return true;
          });
          mockUnlocked.mockImplementationOnce(() => {
            markedAtPublish = stored[PENDING_ADMISSION_STORAGE_KEY];
          });

          await invoke();

          expect(markedAtSpawn).toEqual([]);
          expect(markedAtFirstCheck).toEqual(['admitted-account', 'second-account']);
          expect(mockAdmitted).toHaveBeenCalledWith('second-account');
          expect(JSON.stringify(mockStorageSet.mock.calls)).not.toContain('words');
          expect(mockUnlocked).toHaveBeenCalledTimes(1);
          expect(markedAtPublish).toEqual(['admitted-account', 'second-account']);
          expect(stored).not.toHaveProperty(PENDING_ADMISSION_STORAGE_KEY);
        }
      );

      it.each([
        ['a seed import', 'spawn', () => registerNewWallet(WalletType.Guardian, 'pw', 'words', true)],
        ['a hot-key setup', 'spawnFromHotKey', () => registerWalletFromHotKey('pw', 'hot:evm')],
        ['a wallet-file restore', 'spawnFromMidenClient', () => registerImportedWallet('pw', 'words', [], [])]
      ] as const)(
        '%s that brings a second account the node does not admit is refused before publishing and leaves no vault',
        async (_name, spawnMethod, invoke) => {
          const { Vault } = jest.requireMock('lib/miden/back/vault');
          const restored = spawnedFor('current-account', 'secondary-account');
          Vault[spawnMethod].mockImplementationOnce(wipingSpawn(restored));
          mockAdmitted.mockImplementation(async accountId => accountId === 'current-account');

          const outcome = await invoke().then(
            () => 'published',
            (error: unknown) => error
          );

          expect(mockUnlocked).not.toHaveBeenCalled();
          expect(outcome).toBeInstanceOf(PublicError);
          expect(mockAdmitted).toHaveBeenCalledWith('secondary-account');
          expect(restored.retire).toHaveBeenCalledTimes(1);
          expect(stored).not.toHaveProperty(SAVED_VAULT_KEY);
          expect(stored).not.toHaveProperty(PENDING_ADMISSION_STORAGE_KEY);
        }
      );

      it.each([
        ['a seed import', 'spawn', () => registerNewWallet(WalletType.Guardian, 'pw', 'words', true)],
        ['a hot-key import', 'spawnFromHotKey', () => registerWalletFromHotKey('pw', 'hot:evm')],
        ['a wallet-file import', 'spawnFromMidenClient', () => registerImportedWallet('pw', 'words', [], [])]
      ] as const)('%s whose account the node does not admit leaves no vault', async (_name, spawnMethod, invoke) => {
        const { Vault } = jest.requireMock('lib/miden/back/vault');
        const imported = spawnedFor('unadmitted-account');
        Vault[spawnMethod].mockResolvedValueOnce(imported);
        mockAdmitted.mockResolvedValueOnce(false);

        const outcome = await invoke().then(
          () => 'published',
          (error: unknown) => error
        );
        expect(mockUnlocked).not.toHaveBeenCalled();
        expect(imported.retire).toHaveBeenCalledTimes(1);
        expect(mockStorageRemove).toHaveBeenCalled();
        expect(mockAdmitted).toHaveBeenCalledWith('unadmitted-account');
        expect(outcome).toBeInstanceOf(Error);
      });
    });

    it('reads no admission for an import on a network that is not invite-only', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.spawnFromHotKey.mockResolvedValueOnce(mockVault);
      Vault.spawnFromMidenClient.mockResolvedValueOnce(mockVault);
      Vault.spawn.mockResolvedValueOnce(mockVault);
      await registerWalletFromHotKey('pw', 'hot:evm');
      await registerImportedWallet('pw', 'words', [], []);
      await registerNewWallet(WalletType.Guardian, 'pw', 'words', true);
      expect(mockAdmitted).not.toHaveBeenCalled();
      expect(mockStorageSet).not.toHaveBeenCalled();
      expect(mockUnlocked).toHaveBeenCalledTimes(3);
    });

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
      await expect(registerImportedWallet('pw', 'mnemonic', [], [])).rejects.toThrow('restore failed');
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
      await registerImportedWallet('pw', 'mnemonic', [], []);
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

    it('undoes a created wallet when its setup fails after the spawn resolved (#946)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const provisionalVault = unpublishableVault();
      Vault.spawn.mockResolvedValueOnce(provisionalVault);

      await expect(registerNewWallet(WalletType.OnChain, 'pw')).rejects.toThrow('account read failed');

      expect(provisionalVault.retire).toHaveBeenCalledTimes(1);
      expect(mockUnlocked).not.toHaveBeenCalled();
      // The spawn RESOLVED, so its own undo cannot fire: this one clears the vault it wrote.
      expect(mockStorageRemove).toHaveBeenCalled();
    });

    it('never undoes a published wallet (#946)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.spawn.mockResolvedValueOnce(mockVault);

      await registerNewWallet(WalletType.OnChain, 'pw');

      expect(mockVault.retire).not.toHaveBeenCalled();
      expect(mockStorageRemove).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['registerNewWallet', 'spawn', () => registerNewWallet(WalletType.OnChain, 'pw')],
    ['registerWalletFromHotKey', 'spawnFromHotKey', () => registerWalletFromHotKey('pw', 'hot:evm')],
    ['registerImportedWallet', 'spawnFromMidenClient', () => registerImportedWallet('pw', 'mnemonic', [], [])]
  ] as const)(
    '%s finishes its undo before a queued retry spawns, so the undo cannot wipe the retry (#946)',
    async (_action, spawnMethod, invoke) => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const order: string[] = [];
      Vault[spawnMethod].mockResolvedValueOnce(unpublishableVault()).mockImplementationOnce(async () => {
        order.push('retry spawn');
        return mockVault;
      });
      mockStorageRemove.mockImplementation(async (removed: string[]) => {
        order.push(`remove ${removed.join(',')}`);
      });

      const failed = invoke();
      const retried = invoke();
      await expect(failed).rejects.toThrow('account read failed');
      await retried;

      expect(order).toEqual(['remove DAppEnabled', 'retry spawn']);
    }
  );

  describe('registerWalletFromHotKey', () => {
    it('undoes an imported wallet when its setup fails after the spawn resolved (#946)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      const provisionalVault = unpublishableVault();
      Vault.spawnFromHotKey.mockResolvedValueOnce(provisionalVault);

      await expect(registerWalletFromHotKey('pw', 'hot:evm')).rejects.toThrow('account read failed');

      expect(provisionalVault.retire).toHaveBeenCalledTimes(1);
      expect(mockUnlocked).not.toHaveBeenCalled();
      expect(mockStorageRemove).toHaveBeenCalled();
    });

    it('never undoes a published wallet (#946)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.spawnFromHotKey.mockResolvedValueOnce(mockVault);

      await registerWalletFromHotKey('pw', 'hot:evm');

      expect(mockVault.retire).not.toHaveBeenCalled();
      expect(mockStorageRemove).not.toHaveBeenCalled();
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

      await registerImportedWallet('password123', 'mnemonic words', [], importedAccounts);

      expect(mockVaultInstance.fetchAccounts).toHaveBeenCalled();
      expect(mockUnlocked).toHaveBeenCalled();
      expect(Vault.spawnFromMidenClient).toHaveBeenCalledWith('password123', 'mnemonic words', [], importedAccounts);
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

      mockStorageRemove.mockClear();

      await expect(registerImportedWallet('password', 'mnemonic', [], [])).rejects.toThrow('account read failed');
      expect(provisionalVault.retire).toHaveBeenCalledTimes(1);
      expect(mockUnlocked).not.toHaveBeenCalled();
      // The spawn RESOLVED, so its own undo cannot fire: without this one the
      // profile keeps a complete, unlockable vault while the UI reports failure.
      expect(mockStorageRemove).toHaveBeenCalled();
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
      mockStorageRemove.mockRejectedValueOnce(new Error('storage unavailable'));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // The undo runs in a finally, so an unguarded throw there would surface the
      // storage error and hide the real cause.
      await expect(registerImportedWallet('password', 'mnemonic', [], [])).rejects.toThrow('account read failed');
      // Prove the undo was actually attempted: without this the assertion above is
      // equally satisfied by a run in which it never fired.
      expect(mockStorageRemove).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('keeps the endpoint override through a failed restore undo (#1174)', async () => {
      const { Vault } = jest.requireMock('lib/miden/back/vault');
      Vault.spawnFromMidenClient.mockResolvedValueOnce({
        fetchAccounts: jest.fn().mockRejectedValue(new Error('account read failed')),
        fetchSettings: jest.fn(),
        getCurrentAccount: jest.fn(),
        isOwnMnemonic: jest.fn(),
        retire: jest.fn()
      });
      const { get } = jest.requireMock('webextension-polyfill').default.storage.local;
      get.mockImplementation(async (keys: unknown) =>
        keys === null ? { DAppEnabled: true, endpoint_overrides: '{}' } : { DAppEnabled: true }
      );
      try {
        await expect(registerImportedWallet('password', 'mnemonic', [], [])).rejects.toThrow('account read failed');
        const removed = mockStorageRemove.mock.calls.flatMap(call => call[0] as string[]);
        expect(removed).toContain('DAppEnabled');
        expect(removed).not.toContain('endpoint_overrides');
      } finally {
        get.mockReset().mockResolvedValue({ DAppEnabled: true });
      }
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

      await registerImportedWallet(undefined, undefined, [], []);

      expect(Vault.spawnFromMidenClient).toHaveBeenCalledWith('', '', [], []);
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

    // A changed contacts list goes to the encrypted backup at once, after the vault write.
    it('runs the contacts backup refresh after the write when the settings carry contacts', async () => {
      const contacts = [{ address: 'mtst1friend', name: 'Friend' }];
      mockVault.updateSettings.mockResolvedValueOnce({ contacts });

      await updateSettings({ contacts });

      expect(mockRunBackupRefresh).toHaveBeenCalledTimes(1);
      expect(mockRunBackupRefresh).toHaveBeenCalledWith('contacts-changed');
      expect(mockRunBackupRefresh.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockSettingsUpdated.mock.invocationCallOrder[0]!
      );
    });

    it('runs the contacts backup refresh for an emptied contacts list too', async () => {
      mockVault.updateSettings.mockResolvedValueOnce({ contacts: [] });

      await updateSettings({ contacts: [] });

      expect(mockRunBackupRefresh).toHaveBeenCalledWith('contacts-changed');
    });

    it('does not refresh the backup when the settings carry no contacts', async () => {
      mockVault.updateSettings.mockResolvedValueOnce({});

      await updateSettings({});

      expect(mockRunBackupRefresh).not.toHaveBeenCalled();
    });

    it('does not refresh the backup when the vault write fails', async () => {
      mockVault.updateSettings.mockRejectedValueOnce(new Error('write failed'));

      await expect(updateSettings({ contacts: [] })).rejects.toThrow('write failed');

      expect(mockRunBackupRefresh).not.toHaveBeenCalled();
    });

    it('does not wait for the backup refresh before it resolves', async () => {
      mockVault.updateSettings.mockResolvedValueOnce({ contacts: [] });
      mockRunBackupRefresh.mockReturnValueOnce(new Promise<BackupRefreshOutcome>(() => {}));

      await expect(updateSettings({ contacts: [] })).resolves.toBeUndefined();
      expect(mockRunBackupRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('encrypted backup', () => {
    it('refreshBackup runs the refresh of the named event and returns its outcome', async () => {
      mockRunBackupRefresh.mockResolvedValueOnce('updated');

      await expect(refreshBackup('activity-open')).resolves.toBe('updated');
      expect(mockRunBackupRefresh).toHaveBeenCalledWith('activity-open');
    });

    it('deleteBackup deletes the backup profile and returns its outcome', async () => {
      mockDeleteBackupProfile.mockResolvedValueOnce('disabled');

      await expect(deleteBackup()).resolves.toBe('disabled');
      expect(mockDeleteBackupProfile).toHaveBeenCalledTimes(1);
      expect(mockRunBackupRefresh).not.toHaveBeenCalled();
    });
  });

  describe('spending limits', () => {
    const ACCOUNT = 'account-a';

    beforeEach(async () => {
      // A 1:1 passthrough by default: most cases here exercise the message-layer plumbing, not
      // real dollar valuation, which policy.test.ts and valuation.test.ts already cover.
      mockedResolve.mockImplementation(async spends => spends.reduce((total, spend) => total + spend.amount, 0n));
      await saveSpendingLimit({ accountId: ACCOUNT, limit: '50000000' }, undefined, true);
    });

    it('returns the one configuration for an account', async () => {
      await expect(getSpendingLimit(ACCOUNT)).resolves.toMatchObject({ limit: '50000000' });
    });

    it('reports no configuration for an account with none', async () => {
      await expect(getSpendingLimit('account-unconfigured')).resolves.toBeUndefined();
    });

    it('rejects a non-canonical transport amount without writing it', async () => {
      await expect(saveSpendingLimit({ accountId: 'account-b', limit: '090' }, undefined, true)).rejects.toThrow(
        /policy is unavailable/i
      );
      await expect(spendingLimits.get('account-b')).resolves.toBeUndefined();
    });

    it('assesses a multi-asset proposal as one dollar figure', async () => {
      mockedResolve.mockResolvedValueOnce(4_010_000_000n);

      const assessment = await assessOutgoingSpendingLimit(ACCOUNT, [
        { faucetId: 'eth', amount: '1000000000000000000' },
        { faucetId: 'usdc', amount: '10000000' }
      ]);

      expect(assessment?.usdAmount).toBe('4010000000');
    });

    it('surfaces a price failure as its own code rather than a policy failure', async () => {
      mockedResolve.mockRejectedValue(new SpendingLimitPriceUnavailableError('ETH'));

      await expect(assessOutgoingSpendingLimit(ACCOUNT, [{ faucetId: 'eth', amount: '1' }])).rejects.toMatchObject({
        code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE'
      });
    });

    it('reports no assessment when the account has no policy', async () => {
      // The transport must distinguish "no limit configured" from "assessed and fine": the dApp
      // and UI branches both key off undefined to skip the challenge entirely.
      await expect(
        assessOutgoingSpendingLimit('account-unconfigured', [{ faucetId: 'faucet-a', amount: '20' }])
      ).resolves.toBeUndefined();
    });

    it('serializes a breach built from real transaction history', async () => {
      const now = Math.floor(Date.now() / 1000);
      const previous = new SendTransaction(ACCOUNT, 90n, 'account-b', 'faucet-a', NoteTypeEnum.Public);
      previous.initiatedAt = now - 1;
      await transactions.add({ ...previous, spentUsd: 40_000_000n });

      mockedResolve.mockResolvedValueOnce(20_000_000n);

      await expect(
        assessOutgoingSpendingLimit(ACCOUNT, [{ faucetId: 'faucet-a', amount: '20' }])
      ).resolves.toMatchObject({
        usdAmount: '20000000',
        breach: { spent: '40000000', overBy: '10000000' }
      });
    });

    it('reports no configuration back when a save removes the limit', async () => {
      const stored = await getSpendingLimit(ACCOUNT);

      // Clearing the limit deletes the record, and the caller needs undefined rather than a
      // stale row so the settings screen stops showing a limit that no longer exists.
      await expect(saveSpendingLimit({ accountId: ACCOUNT }, stored?.revision, true)).resolves.toBeUndefined();
      await expect(getSpendingLimit(ACCOUNT)).resolves.toBeUndefined();
    });

    it('rejects a non-canonical preflight proposal amount', async () => {
      await expect(assessOutgoingSpendingLimit(ACCOUNT, [{ faucetId: 'faucet-a', amount: '020' }])).rejects.toThrow(
        /policy is unavailable/i
      );
    });
  });

  describe('strict authentication', () => {
    it('reports the configured protectors', async () => {
      const { Vault: MockVault } = jest.requireMock('lib/miden/back/vault');
      MockVault.hasHardwareProtector.mockResolvedValueOnce(true);
      MockVault.hasPasswordProtector.mockResolvedValueOnce(false);

      await expect(getStrictAuthenticationProtectors()).resolves.toEqual({ hardware: true, password: false });
    });

    it('verifies without adopting another vault', async () => {
      const { Vault: MockVault } = jest.requireMock('lib/miden/back/vault');
      MockVault.verifyProtector.mockResolvedValueOnce(undefined);

      await expect(verifyStrictActionAuthentication('secret')).resolves.toBeUndefined();
      expect(MockVault.verifyProtector).toHaveBeenCalledWith('secret');
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

  describe('importHotKeyPair', () => {
    it('hands the pair to the vault and fires accountsUpdated', async () => {
      const updated = { accounts: [], currentAccount: undefined };
      mockVault.importHotKeyPair.mockResolvedValueOnce(updated);

      await importHotKeyPair('pk1', 'hot:evm');

      expect(mockVault.importHotKeyPair).toHaveBeenCalledWith('pk1', 'hot:evm');
      expect(mockAccountsUpdated).toHaveBeenCalledWith(updated);
    });
  });

  describe('swapHotKey', () => {
    it('passes the expectation to the vault and fires accountsUpdated (#1233)', async () => {
      const updated = { accounts: [], currentAccount: undefined };
      mockVault.swapHotKey.mockResolvedValueOnce(updated);

      await swapHotKey('pk1', 'new-pub', 'old-pub');

      expect(mockVault.swapHotKey).toHaveBeenCalledWith('pk1', 'new-pub', 'old-pub');
      expect(mockAccountsUpdated).toHaveBeenCalledWith(updated);
    });

    it('passes no expectation when the caller passes none (#1233)', async () => {
      mockVault.swapHotKey.mockResolvedValueOnce({ accounts: [], currentAccount: undefined });

      await swapHotKey('pk1', 'new-pub');

      expect(mockVault.swapHotKey).toHaveBeenCalledWith('pk1', 'new-pub', undefined);
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
      mockVault.updateGuardianBinding.mockResolvedValueOnce({
        outcome: 'applied',
        accounts,
        currentAccount: undefined
      });
      mockVault.setGuardianSyncStatus.mockResolvedValueOnce({ accounts, currentAccount: undefined });

      resolveGuardianDrift.mockImplementationOnce(async (driftVault: any, pk: string) => {
        const account = await driftVault.getAccount(pk);
        expect(account).toEqual(accounts[0]);
        await driftVault.updateGuardianBinding(pk, 7, {
          guardianEndpoint: 'https://new-operator',
          guardianOperatorCommitment: 'newC'
        });
        await driftVault.setGuardianSyncStatus(pk, 'in-sync');
        return { status: 'in-sync', changed: true };
      });

      await checkGuardianDrift('pk1');

      expect(mockVault.updateGuardianBinding).toHaveBeenCalledWith('pk1', 7, {
        guardianEndpoint: 'https://new-operator',
        guardianOperatorCommitment: 'newC'
      });
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

    it("adapter's setGuardianSyncStatusIf writes only when the check accepts the stored account", async () => {
      const { resolveGuardianDrift } = jest.requireMock('lib/miden/back/guardian-drift');
      const accounts = [{ publicKey: 'pk1' }];
      mockVault.fetchAccounts.mockResolvedValue(accounts);
      mockVault.getCurrentAccount.mockResolvedValue(undefined);
      mockVault.setGuardianSyncStatus.mockResolvedValue({ accounts, currentAccount: undefined });
      const holds = jest.fn((account?: { publicKey: string }) => account === accounts[0]);

      resolveGuardianDrift.mockImplementationOnce(async (driftVault: any, pk: string) => {
        expect(await driftVault.setGuardianSyncStatusIf(pk, 'in-sync', holds)).toBe(true);
        expect(await driftVault.setGuardianSyncStatusIf('missing-pk', 'in-sync', holds)).toBe(false);
        return { status: 'in-sync', changed: false };
      });

      await checkGuardianDrift('pk1');

      expect(holds.mock.calls).toEqual([[accounts[0]], [undefined]]);
      expect(mockVault.setGuardianSyncStatus).toHaveBeenCalledTimes(1);
      expect(mockVault.setGuardianSyncStatus).toHaveBeenCalledWith('pk1', 'in-sync');
    });

    it("runs the adapter's binding write and conditional status write inside the accounts write queue", async () => {
      const { resolveGuardianDrift } = jest.requireMock('lib/miden/back/guardian-drift');
      mockVault.fetchAccounts.mockResolvedValue([{ publicKey: 'pk1' }]);
      mockVault.getCurrentAccount.mockResolvedValue(undefined);
      mockVault.updateGuardianBinding.mockResolvedValue({
        outcome: 'applied',
        accounts: [],
        currentAccount: undefined
      });
      const holds = jest.fn(() => true);
      let releaseQueue!: () => void;
      const queueHeld = new Promise<void>(resolve => {
        releaseQueue = resolve;
      });
      // Another accounts writer holds the queue while the resolver writes.
      const writer = getAccountsWriteQueue().add(() => queueHeld);
      let writes: Promise<unknown> | undefined;
      resolveGuardianDrift.mockImplementationOnce(async (driftVault: any, pk: string) => {
        writes = Promise.all([
          driftVault.updateGuardianBinding(pk, 7, { guardianOperatorCommitment: 'newC' }),
          driftVault.setGuardianSyncStatusIf(pk, 'in-sync', holds)
        ]);
        return { status: 'in-sync', changed: false };
      });

      try {
        await checkGuardianDrift('pk1');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(mockVault.updateGuardianBinding).not.toHaveBeenCalled();
        expect(holds).not.toHaveBeenCalled();
      } finally {
        releaseQueue();
      }
      await writer;
      await writes;
      expect(mockVault.updateGuardianBinding).toHaveBeenCalledWith('pk1', 7, { guardianOperatorCommitment: 'newC' });
      expect(holds).toHaveBeenCalledTimes(1);
      expect(mockVault.setGuardianSyncStatus).toHaveBeenCalledWith('pk1', 'in-sync');
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
      mockVault.updateGuardianBinding.mockResolvedValueOnce({
        outcome: 'applied',
        accounts,
        currentAccount: undefined
      });
      mockVault.setGuardianSyncStatus.mockResolvedValueOnce({ accounts, currentAccount: undefined });

      applyVerified.mockImplementationOnce(async (driftVault: any, pk: string) => {
        const account = await driftVault.getAccount(pk);
        expect(account).toEqual(accounts[0]);
        await driftVault.updateGuardianBinding(pk, 7, {
          guardianEndpoint: 'https://new-operator',
          guardianOperatorCommitment: 'newC'
        });
        await driftVault.setGuardianSyncStatus(pk, 'in-sync');
        return true;
      });

      await applyUserGuardianEndpoint('pk1', 'https://new-operator');

      expect(mockVault.updateGuardianBinding).toHaveBeenCalledWith('pk1', 7, {
        guardianEndpoint: 'https://new-operator',
        guardianOperatorCommitment: 'newC'
      });
      expect(mockVault.setGuardianSyncStatus).toHaveBeenCalledWith('pk1', 'in-sync');
    });
  });

  // The rollback the pending-rotation recheck runs when the node discards a
  // guardian switch. The decision itself lives in `guardian-drift` next to the
  // on-chain authority check it needs (see `guardian-drift.test.ts`); what this
  // action owes is the queued vault and a broadcast that fires ONLY on a write.
  describe('revertGuardianEndpointAfterDiscard', () => {
    it('broadcasts the new accounts once the rollback actually wrote', async () => {
      const { revertGuardianEndpointAfterDiscard: revert } = jest.requireMock('lib/miden/back/guardian-drift');
      const accounts = [{ publicKey: 'pk1', guardianEndpoint: 'https://old' }];
      revert.mockResolvedValueOnce('reverted');
      mockVault.fetchAccounts.mockResolvedValue(accounts);
      mockVault.getCurrentAccount.mockResolvedValue(accounts[0]);

      const result = await revertGuardianEndpointAfterDiscard('pk1', 'https://new', 'https://old');

      expect(result).toBe('reverted');
      expect(revert).toHaveBeenCalledWith(expect.any(Object), 'pk1', 'https://new', 'https://old');
      expect(mockAccountsUpdated).toHaveBeenCalledWith({ accounts, currentAccount: accounts[0] });
    });

    // `'superseded'` and `'stale'` both mean nothing was written. Broadcasting
    // on them would push a fresh `accounts` array on every recheck tick, and the
    // frontend re-renders on identity, not on value.
    it.each(['superseded', 'stale'])('stays silent when the rollback did not write (%s)', async outcome => {
      const { revertGuardianEndpointAfterDiscard: revert } = jest.requireMock('lib/miden/back/guardian-drift');
      revert.mockResolvedValueOnce(outcome);
      mockAccountsUpdated.mockClear();

      const result = await revertGuardianEndpointAfterDiscard('pk1', 'https://new', 'https://old');

      expect(result).toBe(outcome);
      expect(mockAccountsUpdated).not.toHaveBeenCalled();
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

  describe('exportAccountFile', () => {
    const installedGetKey = () => mockInstallRealmKeystore.mock.calls.at(-1)?.[0].getKey;

    it('exports under one lock and removes the scoped key reader after success', async () => {
      await expect(exportAccountFile('mtst1account_suffix', 'password123')).resolves.toBe('BAUG');

      expect(mockWithAccountFileKeyReader).toHaveBeenCalledWith(
        'mtst1account_suffix',
        'password123',
        expect.any(Function)
      );
      expect(mockWithWasmClientLock).toHaveBeenCalledWith(expect.any(Function), { label: 'export-account-file' });
      expect(mockAssertWasmHoldCurrent).toHaveBeenCalledWith(
        mockHold,
        'export-account-file',
        'after client acquisition'
      );
      expect(mockExportAccountFile).toHaveBeenCalledWith('mtst1account_suffix', expect.any(Function));
      expect(mockUninstallRealmKeystore).toHaveBeenCalledWith({ getKey: installedGetKey() });
      expect(mockRealmGetKey).toBeNull();
    });

    it('zeroes the exported bytes it owns once they have been encoded', async () => {
      const exported = new Uint8Array([4, 5, 6]);
      mockExportAccountFile.mockResolvedValueOnce(exported);

      await expect(exportAccountFile('mtst1account_suffix', 'password123')).resolves.toBe('BAUG');

      expect(Array.from(exported)).toEqual([0, 0, 0]);
    });

    it('removes the scoped key reader when installation fails after assigning it', async () => {
      mockInstallRealmKeystore.mockImplementationOnce(callbacks => {
        mockRealmGetKey = callbacks.getKey;
        throw new Error('install failed');
      });

      await expect(exportAccountFile('mtst1account', 'password123')).rejects.toThrow('install failed');

      expect(mockUninstallRealmKeystore).toHaveBeenCalledWith({ getKey: installedGetKey() });
      expect(mockRealmGetKey).toBeNull();
    });

    it('removes the scoped key reader when client acquisition fails', async () => {
      mockGetMidenClient.mockRejectedValueOnce(new Error('client unavailable'));

      await expect(exportAccountFile('mtst1account', 'password123')).rejects.toThrow('client unavailable');

      expect(mockUninstallRealmKeystore).toHaveBeenCalledWith({ getKey: installedGetKey() });
      expect(mockRealmGetKey).toBeNull();
    });

    it('removes the scoped key reader when the lock hold is no longer current', async () => {
      mockAssertWasmHoldCurrent.mockImplementationOnce(() => {
        throw new Error('operation abandoned');
      });

      await expect(exportAccountFile('mtst1account', 'password123')).rejects.toThrow('operation abandoned');

      expect(mockExportAccountFile).not.toHaveBeenCalled();
      expect(mockUninstallRealmKeystore).toHaveBeenCalledWith({ getKey: installedGetKey() });
      expect(mockRealmGetKey).toBeNull();
    });

    it('removes the scoped key reader when SDK export fails', async () => {
      mockExportAccountFile.mockRejectedValueOnce(new Error('SDK export failed'));

      await expect(exportAccountFile('mtst1account', 'password123')).rejects.toThrow('SDK export failed');

      expect(mockUninstallRealmKeystore).toHaveBeenCalledWith({ getKey: installedGetKey() });
      expect(mockRealmGetKey).toBeNull();
    });

    it('removes the scoped key reader when the lock abandons a parked SDK export', async () => {
      let finishExport!: (bytes: Uint8Array) => void;
      const parkedExport = new Promise<Uint8Array>(resolve => {
        finishExport = resolve;
      });
      const abandonedOperations: Promise<unknown>[] = [];
      mockExportAccountFile.mockReturnValueOnce(parkedExport);
      mockWithWasmClientLock.mockImplementationOnce(async operation => {
        const abandonedOperation = operation(mockHold);
        abandonedOperations.push(abandonedOperation);
        abandonedOperation.catch(() => {});
        await Promise.resolve();
        await Promise.resolve();
        throw new Error('lock watchdog abandoned export');
      });

      try {
        await expect(exportAccountFile('mtst1account', 'password123')).rejects.toThrow(
          'lock watchdog abandoned export'
        );

        expect(mockExportAccountFile).toHaveBeenCalledTimes(1);
        expect(mockUninstallRealmKeystore).toHaveBeenCalledWith({ getKey: installedGetKey() });
        expect(mockRealmGetKey).toBeNull();
      } finally {
        finishExport(new Uint8Array([4, 5, 6]));
        await Promise.all(abandonedOperations);
      }
    });

    it('removes the scoped key reader when the requested vault key is missing', async () => {
      mockVaultGetKey.mockRejectedValueOnce(new Error('Authentication key not found for account export'));
      mockExportAccountFile.mockImplementationOnce(async () => {
        await mockRealmGetKey?.(new Uint8Array([9]));
        return new Uint8Array();
      });

      await expect(exportAccountFile('mtst1account', 'password123')).rejects.toThrow(
        'Authentication key not found for account export'
      );

      expect(mockUninstallRealmKeystore).toHaveBeenCalledWith({ getKey: installedGetKey() });
      expect(mockRealmGetKey).toBeNull();
    });

    it('does not install a key reader when step-up authentication fails', async () => {
      mockWithAccountFileKeyReader.mockRejectedValueOnce(new Error('Invalid password'));

      await expect(exportAccountFile('mtst1account', 'wrong-password')).rejects.toThrow('Invalid password');

      expect(mockInstallRealmKeystore).not.toHaveBeenCalled();
      expect(mockUninstallRealmKeystore).not.toHaveBeenCalled();
      expect(mockRealmGetKey).toBeNull();
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

  describe('adding an account on an invite-only network', () => {
    beforeEach(() => {
      Object.assign(mockStoreState, { vault: mockVault });
      mockEndpointOverride = { rpcUrl: 'https://rpc.mainnet.miden.io', networkName: MIDEN_NETWORK_NAME.MAINNET };
    });

    it.each([
      ['createHDAccount', () => createHDAccount(WalletType.Guardian, 'Second')],
      ['importAccount', () => importAccount('deadbeef', 'Imported')]
    ] as const)('%s refuses before any vault write', async (_name, add) => {
      const refusal = await add().then(
        () => 'added',
        (error: unknown) => error
      );

      expect(refusal).toBeInstanceOf(PublicError);
      expect(refusal).toMatchObject({ message: getMessage('mainnetSecondAccountRefused') });
      expect(mockVault.createHDAccount).not.toHaveBeenCalled();
      expect(mockVault.importAccountFromPrivateKey).not.toHaveBeenCalled();
      expect(mockStorageSet).not.toHaveBeenCalled();
      expect(mockAccountsUpdated).not.toHaveBeenCalled();
    });
  });

  describe('createHDAccount', () => {
    beforeEach(() => {
      Object.assign(mockStoreState, { vault: mockVault });
    });

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

    it('does not publish the new accounts to a store a lock reset while the account was created (#1207)', async () => {
      const accounts = [{ publicKey: 'pk1', name: 'Guardian 1' }];
      mockVault.createHDAccount.mockImplementationOnce(async () => {
        mockLocked();
        return accounts;
      });

      await createHDAccount(WalletType.Guardian);

      expect(mockAccountsUpdated).not.toHaveBeenCalled();
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

    it('refuses a queued request whose start deadline has passed, before it asks the user', async () => {
      const { requestSign } = jest.requireMock('./dapp');
      requestSign.mockClear();
      const req = { type: MidenDAppMessageType.SignRequest, payload: 'data' };

      await expect(processDApp('https://example.com', req as any, undefined, Date.now() - 1)).rejects.toBeInstanceOf(
        DAppQueueDeadlineError
      );
      expect(requestSign).not.toHaveBeenCalled();
    });

    it('checks the start deadline when the request reaches the front of the queue', async () => {
      const { requestPermission, requestSign } = jest.requireMock('./dapp');
      requestSign.mockClear().mockResolvedValueOnce({ signature: '0x123' });
      let release: (value: unknown) => void = () => undefined;
      requestPermission.mockImplementationOnce(() => new Promise(resolve => (release = resolve)));
      const sign = { type: MidenDAppMessageType.SignRequest, payload: 'data' };
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        const ahead = processDApp('https://other.example', { type: MidenDAppMessageType.PermissionRequest } as any);
        const onTime = processDApp('https://example.com', sign as any, undefined, 5_000);
        const late = processDApp('https://example.com', sign as any, undefined, 2_000);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(requestPermission).toHaveBeenCalled();
        expect(requestSign).not.toHaveBeenCalled();

        now.mockReturnValue(3_000);
        release({ approved: true });

        await expect(ahead).resolves.toEqual({ approved: true });
        await expect(onTime).resolves.toEqual({ signature: '0x123' });
        await expect(late).rejects.toBeInstanceOf(DAppQueueDeadlineError);
        expect(requestSign).toHaveBeenCalledTimes(1);
      } finally {
        now.mockRestore();
      }
    });

    it.each([MidenDAppMessageType.LoginKeyRequest, MidenDAppMessageType.LoginSignRequest])(
      'checks the queue-start deadline for %s after waiting behind another request',
      async type => {
        const { requestDisconnect, requestLoginKey, requestLoginSign } = jest.requireMock('./dapp');
        const isKey = type === MidenDAppMessageType.LoginKeyRequest;
        const handler = isKey ? requestLoginKey : requestLoginSign;
        const response = isKey
          ? { type: MidenDAppMessageType.LoginKeyResponse, loginKey: 'AQID' }
          : { type: MidenDAppMessageType.LoginSignResponse, signature: 'BAUG' };
        const request: MidenDAppRequest = isKey
          ? { type: MidenDAppMessageType.LoginKeyRequest, sourceAccountId: 'acc' }
          : {
              type: MidenDAppMessageType.LoginSignRequest,
              sourceAccountId: 'acc',
              payload: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
              kind: 'word'
            };
        handler.mockReset().mockResolvedValue(response);
        let releaseQueue = () => {};
        requestDisconnect.mockReset().mockImplementationOnce(
          () =>
            new Promise<void>(resolve => {
              releaseQueue = resolve;
            })
        );
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const held = processDApp('https://other.example', { type: MidenDAppMessageType.DisconnectRequest });
        let settled: Promise<PromiseSettledResult<Awaited<typeof held>>[]> = Promise.allSettled([held]);
        try {
          await new Promise(resolve => setTimeout(resolve, 0));
          expect(requestDisconnect).toHaveBeenCalledTimes(1);
          const onTime = processDApp('https://example.com', request, 'session-7', 5_000);
          const late = processDApp('https://example.com', request, 'session-7', 2_000);
          settled = Promise.allSettled([held, onTime, late]);
          await new Promise(resolve => setTimeout(resolve, 0));
          expect(handler).not.toHaveBeenCalled();

          now.mockReturnValue(3_000);
          releaseQueue();

          const results = await settled;
          expect(results[0]?.status).toBe('fulfilled');
          expect(results[1]).toEqual({ status: 'fulfilled', value: response });
          expect(results[2]).toEqual({ status: 'rejected', reason: expect.any(DAppQueueDeadlineError) });
          expect(handler).toHaveBeenCalledTimes(1);
          const expectedCall = isKey ? ['https://example.com', request] : ['https://example.com', request, 'session-7'];
          expect(handler).toHaveBeenCalledWith(...expectedCall);
        } finally {
          // A failed assertion must not leave the shared queue held for later tests.
          releaseQueue();
          await settled;
          now.mockRestore();
        }
      }
    );

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

      expect(waitForTransaction).toHaveBeenCalledWith('https://example.com', req);
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

    // Both wait their turn on the one dApp queue, as SIGN_REQUEST does, and the DApps Interaction switch refuses both.
    it('routes both messages through processDApp', async () => {
      const { requestSign, requestLoginKey, requestLoginSign } = jest.requireMock('./dapp');
      let releaseQueue = () => {};
      requestSign.mockReset().mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            releaseQueue = () => resolve();
          })
      );
      requestLoginKey.mockReset().mockResolvedValueOnce({ loginKey: 'login-key' });
      requestLoginSign.mockReset().mockResolvedValueOnce({ signature: 'login-signature' });
      const keyReq = { type: MidenDAppMessageType.LoginKeyRequest, sourceAccountId: 'acc' };
      const signInReq = {
        type: MidenDAppMessageType.LoginSignRequest,
        sourceAccountId: 'acc',
        payload: 'word',
        kind: 'word'
      };

      const held = processDApp('https://example.com', { type: MidenDAppMessageType.SignRequest } as any);
      await new Promise(r => setTimeout(r, 0));
      expect(requestSign).toHaveBeenCalledTimes(1);
      const key = processDApp('https://example.com', keyReq as any);
      const signIn = processDApp('https://example.com', signInReq as any, 'session-7');
      try {
        await new Promise(r => setTimeout(r, 0));
        expect(requestLoginKey).not.toHaveBeenCalled();
        expect(requestLoginSign).not.toHaveBeenCalled();
      } finally {
        // A failure above must not leave the shared queue held for the specs after this one.
        releaseQueue();
      }
      await expect(key).resolves.toEqual({ loginKey: 'login-key' });
      await expect(signIn).resolves.toEqual({ signature: 'login-signature' });
      await held;
      expect(requestLoginKey).toHaveBeenCalledWith('https://example.com', keyReq);
      expect(requestLoginSign).toHaveBeenCalledWith('https://example.com', signInReq, 'session-7');

      const browser = jest.requireMock('webextension-polyfill');
      for (const req of [keyReq, signInReq]) {
        browser.storage.local.get.mockResolvedValueOnce({ DAppEnabled: false });
        await expect(processDApp('https://example.com', req as any)).rejects.toThrow('NOT_GRANTED');
      }
      expect(requestLoginKey).toHaveBeenCalledTimes(1);
      expect(requestLoginSign).toHaveBeenCalledTimes(1);
    });

    it("leaves a login signature's word out of the debug dump", async () => {
      const { dappDebug, requestLoginSign } = jest.requireMock('./dapp');
      dappDebug.mockClear();
      requestLoginSign.mockReset().mockResolvedValueOnce({ signature: 'login-signature' });
      const signInReq = {
        type: MidenDAppMessageType.LoginSignRequest,
        sourceAccountId: 'acc',
        payload: 'word-to-sign',
        kind: 'word'
      };

      await processDApp('https://example.com', signInReq as any);
      expect(dappDebug).toHaveBeenCalledWith(
        '[processDApp] Full request:',
        JSON.stringify({ ...signInReq, payload: '[redacted]' })
      );
      expect(JSON.stringify(dappDebug.mock.calls)).not.toContain('word-to-sign');
      // The handler still gets the word.
      expect(requestLoginSign).toHaveBeenCalledWith('https://example.com', signInReq, undefined);
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

  describe('estimateUsdcxBurnFee', () => {
    const request: EstimateUsdcxBurnFeeRequest = {
      type: WalletMessageType.EstimateUsdcxBurnFeeRequest,
      accountPublicKey: 'mm1account',
      destinationChainId: 5042002
    };

    beforeEach(() => mockEstimateUsdcxBurnFeeReserve.mockReset());

    it('measures for the account and chain and answers the reserve as a decimal string', async () => {
      mockEstimateUsdcxBurnFeeReserve.mockResolvedValueOnce({ outcome: 'measured', reserve: 9007199254740993n });

      await expect(estimateUsdcxBurnFee(request)).resolves.toEqual({
        type: WalletMessageType.EstimateUsdcxBurnFeeResponse,
        outcome: 'measured',
        feeReserve: '9007199254740993'
      });
      expect(mockEstimateUsdcxBurnFeeReserve).toHaveBeenCalledWith('mm1account', 5042002);
    });

    it('answers a measured zero as a measurement', async () => {
      mockEstimateUsdcxBurnFeeReserve.mockResolvedValueOnce({ outcome: 'measured', reserve: 0n });

      await expect(estimateUsdcxBurnFee(request)).resolves.toStrictEqual({
        type: WalletMessageType.EstimateUsdcxBurnFeeResponse,
        outcome: 'measured',
        feeReserve: '0'
      });
    });

    it('preserves only a fixed failed-measurement reason on the response', async () => {
      const failed: UsdcxBurnFeeEstimate = { outcome: 'failed' };
      mockEstimateUsdcxBurnFeeReserve.mockResolvedValueOnce(
        Object.assign(failed, { failure: 'dry_run_failed', message: 'private-account amount=123' })
      );
      await expect(estimateUsdcxBurnFee(request)).resolves.toEqual({
        type: WalletMessageType.EstimateUsdcxBurnFeeResponse,
        outcome: 'failed',
        failure: 'dry_run_failed'
      });
    });

    it.each<'busy' | 'failed'>(['busy', 'failed'])('answers %s as itself, with no reserve', async outcome => {
      mockEstimateUsdcxBurnFeeReserve.mockResolvedValueOnce({ outcome });

      await expect(estimateUsdcxBurnFee(request)).resolves.toStrictEqual({
        type: WalletMessageType.EstimateUsdcxBurnFeeResponse,
        outcome
      });
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

jest.mock('lib/telemetry/sink', () => ({ sendEvent: jest.fn() }));

describe('handleReportTelemetryEvent', () => {
  afterEach(() => jest.resetAllMocks());

  it('forwards the event with a background-derived context', async () => {
    const response = await handleReportTelemetryEvent({
      type: WalletMessageType.ReportTelemetryEventRequest,
      event: { phase: 'started', flow: 'send', flowId: 'f1', runId: 'r1' }
    });
    expect(response.type).toBe(WalletMessageType.ReportTelemetryEventResponse);
    expect(jest.mocked(sendEvent).mock.calls[0]?.[1]).toEqual({
      appVersion: packageJson.version,
      platform: expect.any(String),
      network: expect.any(String)
    });
  });
});
