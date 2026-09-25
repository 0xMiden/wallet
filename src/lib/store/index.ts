import { Buffer } from 'buffer';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import { installFaucetAddressTestHook } from 'lib/e2e/faucet-address';
import { createIntercomClient, IIntercomClient } from 'lib/intercom/client';
import { clearPersistedSeenNoteIds, persistSeenNoteIds } from 'lib/miden/back/note-checker-storage';
import type { IConsumeBridgeInExtraInputs, IEarnWithdrawExtraInputs, ITransaction } from 'lib/miden/db/types';
import { setTestSyncPaused } from 'lib/miden/front/test-sync-pause';
import { fetchTokenMetadata } from 'lib/miden/metadata';
import {
  parsePersistedSpendingLimit,
  parseSerializedSpendingLimitAssessment,
  toSerializedSpendingLimitDraft
} from 'lib/miden/spending-limits/types';
import { describeHookError, installSwapTestHooks } from 'lib/miden/swap/test-hooks';
import { MidenMessageType, MidenState } from 'lib/miden/types';
import { isExtension } from 'lib/platform';
import { WalletMessageType, WalletRequest, WalletResponse, WalletStatus } from 'lib/shared/types';

import { WalletStore } from './types';
import { fetchBalances } from './utils/fetchBalances';

// Singleton intercom client
let intercom: IIntercomClient | null = null;
function getIntercom(): IIntercomClient {
  if (!intercom) {
    intercom = createIntercomClient();
  }
  return intercom;
}

// Helper to make requests to backend
async function request<T extends WalletRequest>(req: T): Promise<WalletResponse> {
  const res = await getIntercom().request(req);
  // An adapter that has no `case` for this message type falls through to its
  // `default:` arm and resolves `undefined`. Name the unhandled type instead of
  // letting `'type' in undefined` throw a bare TypeError — that TypeError used to
  // surface in the UI as e.g. "Cannot read properties of undefined (reading
  // 'type')" under the password field of Reveal Hot Key, reading to the user as a
  // wrong password rather than as a missing handler.
  if (res == null) {
    throw new Error(`No handler for request type: ${String(req.type)}`);
  }
  if (!('type' in res)) {
    throw new Error('Invalid response received.');
  }
  return res as WalletResponse;
}

// Helper to assert response type
function assertResponse(condition: boolean): asserts condition {
  if (!condition) {
    throw new Error('Invalid response received.');
  }
}

export const useWalletStore = create<WalletStore>()(
  subscribeWithSelector((set, get) => ({
    // Initial wallet state
    status: WalletStatus.Idle,
    accounts: [],
    currentAccount: null,
    networks: [],
    settings: null,
    ownMnemonic: null,

    // Initial balance state
    balances: {},
    balancesLoading: {},
    balancesLastFetched: {},

    // Initial assets state
    assetsMetadata: {},

    // Initial UI state
    selectedNetworkId: null,
    confirmation: null,

    // Initial fiat currency state
    selectedFiatCurrency: null,
    fiatRates: null,
    fiatRatesLoading: false,
    tokenPrices: {},

    // Initial sync state
    isInitialized: false,
    isSyncing: false,
    lastSyncedAt: null,
    hasCompletedInitialSync: false,

    // Initial transaction and dApp browser UI state
    isDappBrowserOpen: false,
    activeDappSessionId: null,
    lastCompletedTxHash: null,
    isTransactionModalOpen: false,
    isTransactionModalDismissedByUser: false,

    // Initial note toast state (mobile only)
    seenNoteIds: new Set<string>(),
    isNoteToastVisible: false,
    noteToastShownAt: null,

    // Initial extension sync state
    extensionClaimableNotes: null,

    // Sync action - updates store from backend state
    syncFromBackend: (state: MidenState) => {
      const prevStatus = get().status;
      const justBecameReady = state.status === WalletStatus.Ready && prevStatus !== WalletStatus.Ready;

      set({
        status: state.status,
        accounts: state.accounts,
        currentAccount: state.currentAccount,
        networks: state.networks,
        settings: state.settings,
        ownMnemonic: state.ownMnemonic,
        seedPhraseStatus: state.seedPhraseStatus,
        isInitialized: true,
        lastSyncedAt: Date.now()
      });

      // Immediately fetch balances when wallet becomes Ready (before any React effects)
      // On extension, skip — balances arrive via SyncCompleted broadcast from service worker
      if (justBecameReady && state.currentAccount && !isExtension()) {
        const address = state.currentAccount.publicKey;
        fetchBalances(address, get().assetsMetadata, { tokenPrices: get().tokenPrices })
          .then(balances => {
            // `null` = WASM client was busy and the read was skipped; leave any
            // prior balances in place and let a later poll refresh.
            if (balances === null) return;
            set(s => ({
              balances: { ...s.balances, [address]: balances },
              balancesLoading: { ...s.balancesLoading, [address]: false },
              balancesLastFetched: { ...s.balancesLastFetched, [address]: Date.now() }
            }));
          })
          .catch(err => {
            console.warn('[syncFromBackend] Initial balance fetch failed:', err);
            set(s => ({
              balancesLoading: { ...s.balancesLoading, [address]: false }
            }));
          });
      }
    },

    // Auth actions
    registerWallet: async (walletType, password, mnemonic, ownMnemonic, guardianEndpoint) => {
      console.log('[WalletStore] registerWallet called with walletType:', walletType);
      const res = await request({
        type: WalletMessageType.NewWalletRequest,
        walletType,
        password,
        mnemonic,
        ownMnemonic,
        guardianEndpoint
      });
      assertResponse(res.type === WalletMessageType.NewWalletResponse);
      // State will be synced via StateUpdated notification
    },

    registerWalletFromHotKey: async (password, keyPairPayload, guardianEndpoint) => {
      const res = await request({
        type: WalletMessageType.NewWalletFromHotKeyRequest,
        password,
        keyPairPayload,
        guardianEndpoint
      });
      assertResponse(res.type === WalletMessageType.NewWalletFromHotKeyResponse);
      // State will be synced via StateUpdated notification
    },

    importWalletFromClient: async (password, mnemonic, walletAccounts, formatVersion, importedAccounts) => {
      const res = await request({
        type: WalletMessageType.ImportFromClientRequest,
        password,
        mnemonic,
        walletAccounts,
        formatVersion,
        importedAccounts
      });
      assertResponse(res.type === WalletMessageType.ImportFromClientResponse);
    },

    unlock: async password => {
      const res = await request({
        type: WalletMessageType.UnlockRequest,
        password
      });
      assertResponse(res.type === WalletMessageType.UnlockResponse);
    },

    // Account actions
    createAccount: async (walletType, name) => {
      const res = await request({
        type: WalletMessageType.CreateAccountRequest,
        walletType,
        name
      });
      assertResponse(res.type === WalletMessageType.CreateAccountResponse);

      // Pull fresh state right away. The StateUpdated broadcast is advisory and can
      // race the CreateAccount response (extension port reconnect, SW waking, etc.),
      // leaving consumers that await createAccount — notably CreateAccount.tsx's
      // length-diff effect — looking at a stale accounts array.
      const stateRes = await request({ type: WalletMessageType.GetStateRequest });
      assertResponse(stateRes.type === WalletMessageType.GetStateResponse);
      get().syncFromBackend(stateRes.state);
    },

    updateCurrentAccount: async accountPublicKey => {
      const { accounts, currentAccount, resetSeenNotes } = get();
      const prevAccount = currentAccount;
      const newAccount = accounts.find(a => a.publicKey === accountPublicKey) || null;

      // Reset seen notes when switching accounts
      resetSeenNotes();

      // Optimistic update
      if (newAccount) {
        set({ currentAccount: newAccount });
      }

      try {
        const res = await request({
          type: WalletMessageType.UpdateCurrentAccountRequest,
          accountPublicKey
        });
        assertResponse(res.type === WalletMessageType.UpdateCurrentAccountResponse);
      } catch (error) {
        // Rollback on error
        set({ currentAccount: prevAccount });
        throw error;
      }
    },

    editAccountName: async (accountPublicKey, name) => {
      const { accounts } = get();
      const prevAccounts = accounts;

      // Optimistic update
      set({
        accounts: accounts.map(a => (a.publicKey === accountPublicKey ? { ...a, name: name.trim() } : a))
      });

      try {
        const res = await request({
          type: WalletMessageType.EditAccountRequest,
          accountPublicKey,
          name
        });
        assertResponse(res.type === WalletMessageType.EditAccountResponse);
      } catch (error) {
        // Rollback on error
        set({ accounts: prevAccounts });
        throw error;
      }
    },

    removeSeedPhrase: async password => {
      const res = await request({ type: WalletMessageType.RemoveSeedPhraseRequest, password });
      assertResponse(res.type === WalletMessageType.RemoveSeedPhraseResponse);
      const state = await request({ type: WalletMessageType.GetStateRequest });
      assertResponse(state.type === WalletMessageType.GetStateResponse);
      get().syncFromBackend(state.state);
    },
    provideRecoverySeed: async (transactionId, mnemonic, action) => {
      const res = await request({
        type: WalletMessageType.ProvideRecoverySeedRequest,
        transactionId,
        mnemonic,
        action
      });
      assertResponse(res.type === WalletMessageType.ProvideRecoverySeedResponse);
    },
    prepareRecoveryTransaction: async transactionId => {
      const res = await request({ type: WalletMessageType.PrepareRecoveryRequest, transactionId });
      assertResponse(res.type === WalletMessageType.PrepareRecoveryResponse);
      return { ready: res.ready, coldPublicKey: res.coldPublicKey };
    },
    releaseRecoveryAuthorization: async transactionId => {
      const res = await request({ type: WalletMessageType.ReleaseRecoveryRequest, transactionId });
      assertResponse(res.type === WalletMessageType.ReleaseRecoveryResponse);
    },
    revealMnemonic: async password => {
      const res = await request({
        type: WalletMessageType.RevealMnemonicRequest,
        password
      });
      assertResponse(res.type === WalletMessageType.RevealMnemonicResponse);
      return res.mnemonic;
    },

    exportWalletBackupMaterial: async password => {
      const res = await request({
        type: WalletMessageType.ExportWalletBackupMaterialRequest,
        password
      });
      assertResponse(res.type === WalletMessageType.ExportWalletBackupMaterialResponse);
      return res.material;
    },

    revealPrivateKey: async (accountPublicKey, password) => {
      const res = await request({
        type: WalletMessageType.RevealPrivateKeyRequest,
        accountPublicKey,
        password
      });
      assertResponse(res.type === WalletMessageType.RevealPrivateKeyResponse);
      return res.privateKey;
    },

    exportAccountFile: async (accountPublicKey, password) => {
      const res = await request({
        type: WalletMessageType.ExportAccountFileRequest,
        accountPublicKey,
        password
      });
      assertResponse(res.type === WalletMessageType.ExportAccountFileResponse);
      // Buffer is IMPORTED, never the bare global: on every extension page `public/globals.js`
      // installs a stub whose `from()` ignores the encoding argument, and the entry points keep it
      // (`globalThis.Buffer = globalThis.Buffer || Buffer`), so a bare global decode returns an
      // EMPTY array and the user is handed a 0-byte account file with a success message.
      // A VIEW over the decoded buffer, not a copy of it, so the array the export screen zeroes is
      // the only mutable plaintext of the account's auth key this realm holds. The three-argument
      // form is bounded to this buffer's own region, so Node's shared pool is never exposed.
      const decoded = Buffer.from(res.accountFileBase64, 'base64');
      return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    },

    revealHotKey: async (accountPublicKey, password) => {
      const res = await request({
        type: WalletMessageType.RevealHotKeyRequest,
        accountPublicKey,
        password
      });
      assertResponse(res.type === WalletMessageType.RevealHotKeyResponse);
      return res.keyPairPayload;
    },

    importAccount: async (privateKey, name) => {
      const res = await request({
        type: WalletMessageType.ImportAccountRequest,
        privateKey,
        name
      });
      assertResponse(res.type === WalletMessageType.ImportAccountResponse);
      return res.accountPublicKey;
    },

    // Settings actions
    updateSettings: async newSettings => {
      const { settings } = get();
      const prevSettings = settings;

      // Optimistic update
      set({
        settings: settings ? { ...settings, ...newSettings } : (newSettings as any)
      });

      try {
        const res = await request({
          type: WalletMessageType.UpdateSettingsRequest,
          settings: newSettings
        });
        assertResponse(res.type === WalletMessageType.UpdateSettingsResponse);
      } catch (error) {
        // Rollback on error
        set({ settings: prevSettings });
        throw error;
      }
    },

    readSpendingLimit: async accountId => {
      const res = await request({
        type: WalletMessageType.GetSpendingLimitRequest,
        accountId
      });
      assertResponse(res.type === WalletMessageType.GetSpendingLimitResponse);
      return res.configuration === undefined ? undefined : parsePersistedSpendingLimit(res.configuration);
    },

    saveSpendingLimit: async (draft, observedRevision, strictlyAuthenticated) => {
      const res = await request({
        type: WalletMessageType.SaveSpendingLimitRequest,
        draft: toSerializedSpendingLimitDraft(draft),
        observedRevision,
        strictlyAuthenticated
      });
      assertResponse(res.type === WalletMessageType.SaveSpendingLimitResponse);
      return res.configuration === undefined ? undefined : parsePersistedSpendingLimit(res.configuration);
    },

    assessSpendingLimit: async (accountId, spends) => {
      const res = await request({
        type: WalletMessageType.AssessSpendingLimitRequest,
        accountId,
        spends: spends.map(spend => ({ faucetId: spend.faucetId, amount: spend.amount.toString() }))
      });
      assertResponse(res.type === WalletMessageType.AssessSpendingLimitResponse);
      return res.assessment === undefined ? undefined : parseSerializedSpendingLimitAssessment(res.assessment);
    },

    getStrictAuthenticationProtectors: async () => {
      const res = await request({ type: WalletMessageType.GetStrictAuthenticationProtectorsRequest });
      assertResponse(res.type === WalletMessageType.GetStrictAuthenticationProtectorsResponse);
      return res.protectors;
    },

    verifyStrictActionAuthentication: async credential => {
      const res = await request({
        type: WalletMessageType.VerifyStrictActionAuthenticationRequest,
        credential
      });
      assertResponse(res.type === WalletMessageType.VerifyStrictActionAuthenticationResponse);
    },

    // Signing actions
    signData: async (publicKey, signingInputs) => {
      const res = await request({
        type: WalletMessageType.SignDataRequest,
        publicKey,
        signingInputs
      });
      assertResponse(res.type === WalletMessageType.SignDataResponse);
      return res.signature;
    },

    signTransaction: async (publicKey, signingInputs) => {
      const res = await request({
        type: WalletMessageType.SignTransactionRequest,
        publicKey,
        signingInputs
      });
      assertResponse(res.type === WalletMessageType.SignTransactionResponse);
      const signatureAsHex = res.signature;
      return new Uint8Array(Buffer.from(signatureAsHex, 'hex'));
    },

    signWord: async (publicKey, wordHex, transactionId) => {
      const res = await request({
        type: WalletMessageType.SignWordRequest,
        transactionId,
        publicKey,
        wordHex
      });
      assertResponse(res.type === WalletMessageType.SignWordResponse);
      return res.signature;
    },

    signEvm: async (accountPublicKey, operation) => {
      const res = await request({
        type: WalletMessageType.SignEvmRequest,
        accountPublicKey,
        operation
      });
      assertResponse(res.type === WalletMessageType.SignEvmResponse);
      return res.result;
    },

    persistNewHotKey: async (newHotPubKey, newHotCiphertext) => {
      const res = await request({
        type: WalletMessageType.PersistNewHotKeyRequest,
        newHotPubKey,
        newHotCiphertext
      });
      assertResponse(res.type === WalletMessageType.PersistNewHotKeyResponse);
    },

    swapHotKey: async (accountPublicKey, newHotPubKey) => {
      const res = await request({
        type: WalletMessageType.SwapHotKeyRequest,
        accountPublicKey,
        newHotPubKey
      });
      assertResponse(res.type === WalletMessageType.SwapHotKeyResponse);
    },

    setGuardianEndpoint: async (accountPublicKey, guardianEndpoint) => {
      const res = await request({
        type: WalletMessageType.SetGuardianEndpointRequest,
        accountPublicKey,
        guardianEndpoint
      });
      assertResponse(res.type === WalletMessageType.SetGuardianEndpointResponse);
    },

    setGuardianOperatorCommitment: async (accountPublicKey, guardianOperatorCommitment) => {
      const res = await request({
        type: WalletMessageType.SetGuardianOperatorCommitmentRequest,
        accountPublicKey,
        guardianOperatorCommitment
      });
      assertResponse(res.type === WalletMessageType.SetGuardianOperatorCommitmentResponse);
    },

    setGuardianSyncStatus: async (accountPublicKey, guardianSyncStatus) => {
      const res = await request({
        type: WalletMessageType.SetGuardianSyncStatusRequest,
        accountPublicKey,
        guardianSyncStatus
      });
      assertResponse(res.type === WalletMessageType.SetGuardianSyncStatusResponse);
    },

    guardianClientRequest: async operation => {
      const res = await request({ type: WalletMessageType.GuardianClientRequest, operation });
      assertResponse(res.type === WalletMessageType.GuardianClientResponse);
      return res.result;
    },

    checkGuardianDrift: async accountPublicKey => {
      const res = await request({
        type: WalletMessageType.CheckGuardianDriftRequest,
        accountPublicKey
      });
      assertResponse(res.type === WalletMessageType.CheckGuardianDriftResponse);
      return res.guardianSyncStatus;
    },

    applyUserGuardianEndpoint: async (accountPublicKey, guardianEndpoint) => {
      const res = await request({
        type: WalletMessageType.ApplyUserGuardianEndpointRequest,
        accountPublicKey,
        guardianEndpoint
      });
      assertResponse(res.type === WalletMessageType.ApplyUserGuardianEndpointResponse);
      return res.outcome;
    },

    startGuardianRecovery: async accountPublicKey => {
      const res = await request({
        type: WalletMessageType.StartGuardianRecoveryRequest,
        accountPublicKey
      });
      assertResponse(res.type === WalletMessageType.StartGuardianRecoveryResponse);
      return res.started;
    },

    getPublicKeyForCommitment: async commitment => {
      const res = await request({
        type: WalletMessageType.GetPublicKeyForCommitmentRequest,
        commitment
      });
      assertResponse(res.type === WalletMessageType.GetPublicKeyForCommitmentResponse);
      return res.publicKey;
    },

    getAuthSecretKey: async key => {
      const res = await request({
        type: WalletMessageType.GetAuthSecretKeyRequest,
        key
      });
      assertResponse(res.type === WalletMessageType.GetAuthSecretKeyResponse);
      return res.key;
    },

    // DApp actions
    getDAppPayload: async id => {
      const res = await request({
        type: MidenMessageType.DAppGetPayloadRequest,
        id
      });
      assertResponse(res.type === MidenMessageType.DAppGetPayloadResponse);
      return res.payload;
    },

    simulateCustomTransaction: async (id: string) => {
      const res = await request({
        type: MidenMessageType.DAppSimulateTransactionRequest,
        id
      });
      assertResponse(res.type === MidenMessageType.DAppSimulateTransactionResponse);
      return { summaryBytes: res.summaryBytes, executedBytes: res.executedBytes, error: res.error };
    },

    confirmDAppPermission: async (id, confirmed, accountId, privateDataPermission, allowedPrivateData) => {
      const res = await request({
        type: MidenMessageType.DAppPermConfirmationRequest,
        id,
        confirmed,
        accountPublicKey: confirmed ? accountId : '',
        privateDataPermission,
        allowedPrivateData
      });
      assertResponse(res.type === MidenMessageType.DAppPermConfirmationResponse);
    },

    confirmDAppSign: async (id, confirmed) => {
      const res = await request({
        type: MidenMessageType.DAppSignConfirmationRequest,
        id,
        confirmed
      });
      assertResponse(res.type === MidenMessageType.DAppSignConfirmationResponse);
    },

    confirmDAppPrivateNotes: async (id, confirmed) => {
      const res = await request({
        type: MidenMessageType.DAppPrivateNotesConfirmationRequest,
        id,
        confirmed
      });
      assertResponse(res.type === MidenMessageType.DAppPrivateNotesConfirmationResponse);
    },

    confirmDAppAssets: async (id, confirmed) => {
      const res = await request({
        type: MidenMessageType.DAppAssetsConfirmationRequest,
        id,
        confirmed
      });
      assertResponse(res.type === MidenMessageType.DAppAssetsConfirmationResponse);
    },

    confirmDAppImportPrivateNote: async (id, confirmed) => {
      const res = await request({
        type: MidenMessageType.DAppImportPrivateNoteConfirmationRequest,
        id,
        confirmed
      });
      assertResponse(res.type === MidenMessageType.DAppImportPrivateNoteConfirmationResponse);
    },

    confirmDAppConsumableNotes: async (id, confirmed) => {
      const res = await request({
        type: MidenMessageType.DAppConsumableNotesConfirmationRequest,
        id,
        confirmed
      });
      assertResponse(res.type === MidenMessageType.DAppConsumableNotesConfirmationResponse);
    },

    confirmDAppTransaction: async (id, confirmed, delegate, spendingLimitAuthenticated) => {
      const res = await request({
        type: MidenMessageType.DAppTransactionConfirmationRequest,
        id,
        confirmed,
        delegate,
        ...(spendingLimitAuthenticated === true && { spendingLimitAuthenticated: true as const })
      });
      assertResponse(res.type === MidenMessageType.DAppTransactionConfirmationResponse);
    },

    getAllDAppSessions: async () => {
      const res = await request({
        type: MidenMessageType.DAppGetAllSessionsRequest
      });
      assertResponse(res.type === MidenMessageType.DAppGetAllSessionsResponse);
      return res.sessions;
    },

    removeDAppSession: async origin => {
      const res = await request({
        type: MidenMessageType.DAppRemoveSessionRequest,
        origin
      });
      assertResponse(res.type === MidenMessageType.DAppRemoveSessionResponse);
    },

    // UI actions
    setSelectedNetworkId: networkId => {
      set({ selectedNetworkId: networkId });
    },

    setConfirmation: confirmation => {
      set({ confirmation });
    },

    resetConfirmation: () => {
      set({ confirmation: null });
    },

    // Balance actions
    fetchBalances: async (accountAddress, tokenMetadatas) => {
      const { balancesLoading, setAssetsMetadata } = get();

      // Skip if already loading
      if (balancesLoading[accountAddress]) {
        return;
      }

      set({
        balancesLoading: { ...balancesLoading, [accountAddress]: true }
      });

      try {
        const balances = await fetchBalances(accountAddress, tokenMetadatas, {
          setAssetsMetadata,
          tokenPrices: get().tokenPrices
        });
        // `null` = WASM client was busy and the read was skipped; clear the
        // loading flag but keep any prior balances and retry later.
        if (balances === null) {
          set(state => ({
            balancesLoading: { ...state.balancesLoading, [accountAddress]: false }
          }));
          return;
        }
        set(state => ({
          balances: { ...state.balances, [accountAddress]: balances },
          balancesLoading: { ...state.balancesLoading, [accountAddress]: false },
          balancesLastFetched: { ...state.balancesLastFetched, [accountAddress]: Date.now() }
        }));
      } catch (error) {
        set(state => ({
          balancesLoading: { ...state.balancesLoading, [accountAddress]: false }
        }));
        throw error;
      }
    },

    setBalancesLoading: (accountAddress, isLoading) => {
      set(state => ({
        balancesLoading: { ...state.balancesLoading, [accountAddress]: isLoading }
      }));
    },

    // Asset actions
    setAssetsMetadata: metadata => {
      set(state => ({
        assetsMetadata: { ...state.assetsMetadata, ...metadata }
      }));
    },

    fetchAssetMetadata: async assetId => {
      try {
        const { base } = await fetchTokenMetadata(assetId);
        set(state => ({
          assetsMetadata: { ...state.assetsMetadata, [assetId]: base }
        }));
        return base;
      } catch {
        return null;
      }
    },

    // Fiat currency actions
    setSelectedFiatCurrency: currency => {
      set({ selectedFiatCurrency: currency });
    },

    setFiatRates: rates => {
      set({ fiatRates: rates });
    },

    fetchFiatRates: async () => {
      const { fiatRatesLoading } = get();
      if (fiatRatesLoading) return;

      set({ fiatRatesLoading: true });
      try {
        // TODO: implement real fiat rate fetching
        const rates = { usd: 1 };
        set({ fiatRates: rates, fiatRatesLoading: false });
      } catch {
        set({ fiatRatesLoading: false });
      }
    },

    setTokenPrices: prices => {
      set({ tokenPrices: prices });
    },

    // Sync actions
    setSyncStatus: isSyncing => {
      // When sync completes (isSyncing becomes false), mark initial sync as done
      if (!isSyncing) {
        set({ isSyncing, hasCompletedInitialSync: true });
      } else {
        set({ isSyncing });
      }
    },

    // Transaction UI actions
    setLastCompletedTxHash: (txHash: string | null) => {
      set({ lastCompletedTxHash: txHash });
    },

    openTransactionModal: () => {
      // Reset dismissed flag when explicitly opening the modal (new transaction initiated).
      // `lastCompletedTxHash` is intentionally NOT cleared here — clearing happens on
      // `closeTransactionModal` and at the start of a fresh send.
      set({ isTransactionModalOpen: true, isTransactionModalDismissedByUser: false });
    },

    closeTransactionModal: (dismissedByUser = false) => {
      set({
        isTransactionModalOpen: false,
        isTransactionModalDismissedByUser: dismissedByUser,
        lastCompletedTxHash: null
      });
    },

    resetTransactionModalDismiss: () => {
      set({ isTransactionModalDismissedByUser: false });
    },

    // DApp browser state (mobile only)
    setDappBrowserOpen: (isOpen: boolean) => {
      // Backwards-compat path: clear `activeDappSessionId` if turning off,
      // leave it alone if turning on (the new code path uses
      // `setActiveDappSession` which sets both atomically).
      set(prev => ({
        isDappBrowserOpen: isOpen,
        activeDappSessionId: isOpen ? prev.activeDappSessionId : null
      }));
    },
    setActiveDappSession: (sessionId: string | null) => {
      set({
        activeDappSessionId: sessionId,
        isDappBrowserOpen: sessionId !== null
      });
    },

    // Note toast actions (mobile only)
    checkForNewNotes: (currentNoteIds: string[], notifiableNoteIds?: readonly string[]) => {
      const { seenNoteIds } = get();

      // Find note IDs that weren't previously seen
      const newNoteIds = currentNoteIds.filter(id => !seenNoteIds.has(id));

      if (newNoteIds.length > 0) {
        const updatedSeenNotes = new Set(seenNoteIds);
        for (const id of newNoteIds) {
          updatedSeenNotes.add(id);
        }
        // Every new note is recorded as seen, but only one the user has to claim by hand shows the
        // toast: a note first listed while the wallet was claiming it must not toast later, when a fee
        // or setting change makes it manual (#811).
        const notifiable = notifiableNoteIds ? new Set(notifiableNoteIds) : null;
        const showToast = !notifiable || newNoteIds.some(id => notifiable.has(id));
        set(
          showToast
            ? { seenNoteIds: updatedSeenNotes, isNoteToastVisible: true, noteToastShownAt: Date.now() }
            : { seenNoteIds: updatedSeenNotes }
        );

        // Persist to chrome.storage.local so service worker can read them
        if (isExtension()) {
          persistSeenNoteIds(updatedSeenNotes).catch(() => {});
        }
      }
    },

    dismissNoteToast: () => {
      set({ isNoteToastVisible: false });
    },

    resetSeenNotes: () => {
      set({
        seenNoteIds: new Set<string>(),
        isNoteToastVisible: false,
        noteToastShownAt: null,
        // Drop the previous account's cached consumable notes so they are never
        // shown or auto-consumed under the newly selected account (#280). The
        // account-scoped poll in useExtensionClaimableNotes repopulates this for
        // the new account on its next tick.
        extensionClaimableNotes: null
      });

      if (isExtension()) {
        clearPersistedSeenNoteIds().catch(() => {});
      }
    },

    // Extension sync actions
    setExtensionClaimableNotes: notes => {
      set({ extensionClaimableNotes: notes });
    }
  }))
);

// Export the intercom getter for use in sync hook
export { getIntercom };

// `reloadEndpointOverridesInSW`'s request must always settle so it can't wedge a caller
// that awaits it before navigating (e.g. Developer Settings' handleSave) — see below.
const RELOAD_ENDPOINT_OVERRIDES_SW_TIMEOUT_MS = 4000;

/**
 * Tell the service worker to reload its endpoint-override cache and dispose
 * its Miden client singleton(s), so the next `getMidenClient()` call there
 * rebuilds against the just-saved override. No-op on mobile/desktop, which
 * share the frontend's JS realm — `applyEndpointOverride` alone already
 * takes effect there. Awaitable so callers (Developer Settings' handleSave)
 * can order navigation after the SW has re-hydrated; best-effort otherwise —
 * a failed nudge just means the override applies after the next SW restart.
 *
 * Bounded to `RELOAD_ENDPOINT_OVERRIDES_SW_TIMEOUT_MS`: `IntercomClient.request`
 * never rejects if the SW port disconnects mid-request, so an un-bounded await
 * here could hang forever and wedge a caller's UI (e.g. leave `saving` stuck).
 * The underlying request keeps running and its own `.catch` still swallows a
 * late failure — this just stops the caller from waiting on it past the timeout.
 */
export function reloadEndpointOverridesInSW(): Promise<void> {
  const request = getIntercom()
    .request({ type: WalletMessageType.ReloadEndpointOverridesRequest })
    .then(() => {})
    .catch(err => {
      console.warn('[reloadEndpointOverridesInSW] failed to nudge SW:', err);
    });

  const timeout = new Promise<void>(resolve => {
    setTimeout(resolve, RELOAD_ENDPOINT_OVERRIDES_SW_TIMEOUT_MS);
  });

  return Promise.race([request, timeout]);
}

// Derived selectors for common patterns
export const selectIsReady = (state: WalletStore) => state.status === WalletStatus.Ready;
export const selectIsLocked = (state: WalletStore) => state.status === WalletStatus.Locked;
export const selectIsIdle = (state: WalletStore) => state.status === WalletStatus.Idle;

// Expose store and intercom for E2E test introspection (only in E2E builds).
// Use globalThis (not window) so this works in both extension pages and the
// service worker context where window is undefined.
if (process.env.MIDEN_E2E_TEST === 'true') {
  (globalThis as any).__TEST_STORE__ = useWalletStore;
  (globalThis as any).__TEST_INTERCOM__ = getIntercom();
  installSwapTestHooks();
  Reflect.set(
    globalThis,
    '__TEST_RUN_SPENDING_LIMIT_RACE__',
    async (input: { recipientAddress: string; faucetId: string; amountBaseUnits: string }) => {
      const [{ SendTransaction, ITransactionStatus }, { NoteTypeEnum }, { queueOutgoingTransaction, spendsOf }, Repo] =
        await Promise.all([
          import('lib/miden/db/types'),
          import('lib/miden/types'),
          import('lib/miden/spending-limits/queue'),
          import('lib/miden/repo')
        ]);
      const accountId = useWalletStore.getState().currentAccount?.publicKey;
      if (accountId === undefined) throw new Error('Spending-limit race hook found no current account');
      const amount = BigInt(input.amountBaseUnits);
      const candidates = [
        new SendTransaction(accountId, amount, input.recipientAddress, input.faucetId, NoteTypeEnum.Public),
        new SendTransaction(accountId, amount, input.recipientAddress, input.faucetId, NoteTypeEnum.Public)
      ];
      const now = Math.floor(Date.now() / 1000);
      for (const candidate of candidates) {
        candidate.status = ITransactionStatus.Completed;
        candidate.completedAt = now;
      }

      try {
        const results = await Promise.allSettled(
          candidates.map(candidate => queueOutgoingTransaction(candidate, spendsOf(candidate)))
        );
        const inserted = await Repo.transactions.bulkGet(candidates.map(candidate => candidate.id));
        return {
          fulfilledCount: results.filter(result => result.status === 'fulfilled').length,
          rejectedCount: results.filter(result => result.status === 'rejected').length,
          insertedCount: inserted.filter(row => row !== undefined).length,
          rejectionCodes: results.flatMap(result => {
            if (result.status !== 'rejected') return [];
            const reason = result.reason as { code?: unknown };
            return typeof reason?.code === 'string' ? [reason.code] : [];
          })
        };
      } finally {
        await Repo.transactions.bulkDelete(candidates.map(candidate => candidate.id));
      }
    }
  );
  // A dApp custom/execute request is opaque base64 `TransactionRequest` bytes, which only the SDK
  // can produce - a fixture dApp page has no SDK and no vault. Built here through the very builder
  // every wallet send uses, so the bytes the suite hands to `requestTransaction` are the shape a
  // real dApp sends: one P2ID output note moving `amountBaseUnits` out of the current account.
  Reflect.set(
    globalThis,
    '__TEST_BUILD_CUSTOM_TRANSACTION_REQUEST__',
    async (input: { recipientAddress: string; faucetId: string; amountBaseUnits: string }) => {
      const [
        { NoteType },
        { accountRefToSdk, buildSendTransactionRequest, randomFeeSalt, walletAccountIdToSdk },
        { assertWasmHoldCurrent, getMidenClient, withWasmClientLock },
        { u8ToB64 }
      ] = await Promise.all([
        import('@miden-sdk/miden-sdk/lazy'),
        import('lib/miden/sdk/helpers'),
        import('lib/miden/sdk/miden-client'),
        import('lib/shared/helpers')
      ]);
      const accountId = useWalletStore.getState().currentAccount?.publicKey;
      if (accountId === undefined) throw new Error('Custom-request hook found no current account');

      const requestBytes = await withWasmClientLock(
        async hold => {
          const client = await getMidenClient();
          assertWasmHoldCurrent(hold, 'e2e-custom-request after the client build');
          const account = await client.getAccount(walletAccountIdToSdk(accountId).toString());
          // The Account is borrowed from the client's RefCell and the build reads its vault.
          assertWasmHoldCurrent(hold, 'e2e-custom-request after the account read');
          return buildSendTransactionRequest(
            account ?? undefined,
            walletAccountIdToSdk(accountId),
            accountRefToSdk(input.recipientAddress),
            input.faucetId,
            BigInt(input.amountBaseUnits),
            NoteType.Public,
            undefined,
            // Declared, like every wallet-built request: since protocol 0.16 `fee::pay_fee` reads
            // the conversion salt from the auth args and aborts without one.
            randomFeeSalt()
          ).serialize();
        },
        { label: 'e2e-custom-request' }
      );
      return u8ToB64(requestBytes);
    }
  );
  Reflect.set(globalThis, '__TEST_SIGN_ACCOUNT_WORD__', async (accountPublicKey: string, wordHex: string) => {
    setTestSyncPaused(true);
    try {
      const [{ assertWasmHoldCurrent, getMidenClient, withWasmClientLock }, { resolvePublicKeyCommitments }] =
        await Promise.all([
          import('lib/miden/sdk/miden-client'),
          import('lib/miden/sdk/resolve-public-key-commitments')
        ]);
      const publicKeyCommitment = await withWasmClientLock(
        async hold => {
          const client = await getMidenClient();
          assertWasmHoldCurrent(hold, 'e2e-account-sign after the client build');
          const account = await client.getAccount(accountPublicKey);
          assertWasmHoldCurrent(hold, 'e2e-account-sign after the account read');
          if (!account) throw new Error('Account not found');

          const commitments = resolvePublicKeyCommitments(account);
          if (commitments.length !== 1) throw new Error('Account does not have exactly one signing key');
          return commitments[0]!.toHex().replace(/^0x/, '');
        },
        { label: 'e2e-account-sign' }
      );
      return await useWalletStore.getState().signWord(publicKeyCommitment, wordHex);
    } finally {
      setTestSyncPaused(false);
    }
  });
  // Point the earn (Epoch lending) collateral faucet at a runtime-created test faucet.
  // `openEarnPosition` runs page-side (EarnDepositReview), so the override must be set in
  // THIS (page) realm. The import is LAZY (like the bridge-in hooks) so the Epoch/EVM SDK
  // that `lib/epoch/earn` pulls in is NOT loaded into the main page bundle at boot — only
  // when the test calls the hook (by which point the earn route has loaded it anyway). The
  // fixed `MIDEN_USDC_FAUCET` testnet id can't exist on the localnet node. Zero prod impact.
  (globalThis as any).__TEST_SET_EARN_FAUCET__ = async (faucetHex: string): Promise<void> => {
    const { setEarnCollateralFaucetForTest } = await import('lib/epoch/earn');
    setEarnCollateralFaucetForTest(faucetHex);
  };
  // Earn WITHDRAW read hooks live in the PAGE realm (here), NOT the SW-side
  // earn-test-hooks: the `earn-withdraw` tracking row is created AND advanced
  // page-side (gaslessEarnWithdrawalToMiden runs in EarnWithdrawReview, and the
  // note-id reconcile flips it), so the SW's Repo view never sees it. The e2e
  // reads these via `walletA.page.evaluate` (the deposit rows, created SW-side,
  // stay on the SW hooks). Lazy Repo import — E2E-gated, zero prod impact.
  const toEarnWithdrawView = async (row: ITransaction | undefined) => {
    if (!row || row.type !== 'earn-withdraw') return null;
    const inputs: IEarnWithdrawExtraInputs | undefined = row.extraInputs;
    const Repo = await import('lib/miden/repo');
    const consumes = await Repo.transactions
      .filter(tx => {
        const extra: IConsumeBridgeInExtraInputs | undefined = tx.extraInputs;
        return tx.type === 'consume' && extra?.bridgeIn?.earnWithdrawTxId === row.id;
      })
      .toArray();
    return {
      id: row.id,
      phase: inputs?.phase,
      displayMessage: row.displayMessage,
      submissionState: inputs?.submissionState,
      withdrawIntentNonce: inputs?.withdrawIntentNonce,
      preparedExecution: inputs?.preparedExecution,
      midenNoteId: inputs?.midenNoteId,
      receipts: consumes.map(tx => {
        const extra: IConsumeBridgeInExtraInputs | undefined = tx.extraInputs;
        return {
          id: tx.id,
          status: tx.status,
          transactionId: tx.transactionId,
          noteIds: tx.inputNoteIds ?? tx.noteIds ?? (tx.noteId ? [tx.noteId] : []),
          intentOwner: extra?.bridgeIn?.intentOwner,
          intentNonce: extra?.bridgeIn?.intentNonce,
          attemptId: extra?.bridgeIn?.earnWithdrawAttemptId,
          midenNoteId: extra?.bridgeIn?.midenNoteId
        };
      })
    };
  };
  Reflect.set(globalThis, '__TEST_LATEST_EARN_WITHDRAW__', async () => {
    const Repo = await import('lib/miden/repo');
    const rows = await Repo.transactions.filter(tx => tx.type === 'earn-withdraw').toArray();
    rows.sort((a, b) => b.initiatedAt - a.initiatedAt);
    return toEarnWithdrawView(rows[0]);
  });
  Reflect.set(globalThis, '__TEST_EARN_WITHDRAW_STATE__', async (txId: string) => {
    const Repo = await import('lib/miden/repo');
    return toEarnWithdrawView(await Repo.transactions.where({ id: txId }).first());
  });
  // Hex-to-bech32 faucet-id conversion. iOS E2E needs this to inject
  // synthetic metadata for the CLI-deployed test faucet (whose on-chain
  // procedure layout the SDK can't parse, so the real metadata RPC fails
  // and the wallet's `attachMetadataToNotes` hides the consumable note).
  // The CLI returns hex; the wallet's parsed note `faucetId` is bech32;
  // mismatch → injection misses. Eager-import the SDK at module-init so
  // by the time the test runs, the hook is sync and the WASM is ready.
  // Dynamic-import inside the call (used to live here) contended with the
  // wallet's own WASM lock and serialized behind in-flight SDK calls,
  // blowing past the 30s WebDriver execute_async_script budget.
  void installFaucetAddressTestHook().catch(e => {
    // E2E-only path; failure here just means the iOS metadata-injection
    // workaround won't work and we'd hit the original symptom (note
    // hidden by attachMetadataToNotes filter).
    console.error('[E2E] Failed to expose __TEST_HEX_TO_BECH32_FAUCET__:', e);
  });

  // Guardian on-chain auth structure (overall threshold + signer set + procedure
  // thresholds + the active guardian-operator commitment) for E2E assertions —
  // the harness's balance checks can't see the 3-key shape. The guardian
  // commitment (`GUARDIAN_SLOT_NAMES.PUBLIC_KEY`) is a SEPARATE storage slot
  // from the multisig `signerCommitments` (`[hot, cold]`) — a guardian switch
  // changes the former while the latter (and its threshold) stay put, so it's
  // the field E2E specs need to verify a switch actually landed. Dynamic
  // imports avoid a static cycle.
  (globalThis as any).__TEST_GUARDIAN_AUTH__ = async (accountPublicKey: string) => {
    // Fast path: the balance poll (`fetchBalances`, which reliably completes in
    // the wallet's own flow) stashes this account's auth structure on
    // `__TEST_GUARDIAN_AUTH_STRUCTURE__`. Serving it here is a plain object read
    // with NO WASM call, so it can't be starved by other main-thread WASM
    // activity on the single-threaded iOS WASM (the live read below otherwise
    // times out: the auth eval was observed taking 60s with the WebView main
    // thread saturated even after all the wallet's own pollers were paused).
    const stashStore = (
      globalThis as {
        __TEST_GUARDIAN_AUTH_STRUCTURE__?: Record<
          string,
          {
            threshold: number;
            signerCommitments: string[];
            procedureThresholds: Record<string, number>;
            guardianCommitment?: string;
          }
        >;
      }
    ).__TEST_GUARDIAN_AUTH_STRUCTURE__;
    // Prefer the exact-key match; fall back to the single stashed entry. The
    // balance poll keys the stash by the address it's called with, which can be
    // a different encoding of the same account than the publicKey the test
    // passes here — and a wallet instance only ever has one Guardian account, so
    // any stashed multisig structure on this page belongs to it.
    const stashed = stashStore?.[accountPublicKey] ?? (stashStore ? Object.values(stashStore)[0] : undefined);
    if (stashed) {
      return stashed;
    }

    // Read the structure with a PURE storage parse (`AccountInspector.fromAccount`),
    // not the transaction-oriented MultisigService. Going through
    // `getOrCreateMultisigService` → `MultisigClient.load` drove a re-sign/realign
    // loop (~48 `signWithHotKey` calls vs. 26 for a full consume) when loading
    // against the post-consume state where the guardian's stored blob lags the
    // on-chain account — on the single-threaded mobile WASM that loop hung the
    // read past the eval budget. The inspector only reads the account's storage
    // maps (signers, threshold_config, procedure_thresholds): no signing, no
    // guardian HTTP, no load. A single `getAccount` (the same read the balance
    // poll already does) plus the parse is cheap and correct — the structure is
    // immutable.
    // The read still needs one `getAccount`, and on the single-threaded mobile
    // WASM even that lone call queues behind an in-flight background sync
    // (`syncState` can hold the SDK's internal call-queue for tens of seconds).
    // So quiesce the always-on frontend WASM pollers (`useSyncTrigger`, the
    // balance poll — which bypasses the wallet mutex — and the claimable-notes
    // SWR) via `__TEST_SYNC_PAUSED__` for the read, restored in `finally`. Gated
    // on MIDEN_E2E_TEST, tree-shaken from production.
    setTestSyncPaused(true);
    try {
      const [
        { AccountInspector },
        { assertWasmHoldCurrent, getMidenClient, withWasmClientLock },
        { getGuardianCommitmentFromAccount }
      ] = await Promise.all([
        import('@openzeppelin/miden-multisig-client'),
        import('lib/miden/sdk/miden-client'),
        import('lib/miden/guardian/account')
      ]);
      // One hold from the read through the inspection of the account it returned
      // (borrowed from the client's RefCell): this realm's reads and writes share one
      // client, and the transaction loop holds this lock on mobile and desktop (#878).
      return await withWasmClientLock(
        async hold => {
          const mc = await getMidenClient();
          assertWasmHoldCurrent(hold, 'e2e-guardian-auth after the client build');
          const account = await mc.getAccount(accountPublicKey);
          assertWasmHoldCurrent(hold, 'e2e-guardian-auth after the account read');
          if (!account) {
            return { error: `Guardian account ${accountPublicKey} not found in local client` };
          }
          const config = AccountInspector.fromAccount(account);
          return {
            threshold: config.threshold,
            signerCommitments: config.signerCommitments,
            procedureThresholds: Object.fromEntries(config.procedureThresholds),
            // Active guardian-operator commitment — a SEPARATE storage slot
            // (`GUARDIAN_SLOT_NAMES.PUBLIC_KEY`) from `signerCommitments` above.
            // A guardian switch changes this while the signer set / threshold
            // stay put, so this is the field that actually verifies a switch.
            guardianCommitment: getGuardianCommitmentFromAccount(account)
          };
        },
        { label: 'e2e-guardian-auth' }
      );
    } catch (e) {
      return { error: describeHookError(e) };
    } finally {
      setTestSyncPaused(false);
    }
  };
}
