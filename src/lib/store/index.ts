import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import { createIntercomClient, IIntercomClient } from 'lib/intercom/client';
import { clearPersistedSeenNoteIds, persistSeenNoteIds } from 'lib/miden/back/note-checker-storage';
import { setTestSyncPaused } from 'lib/miden/front/test-sync-pause';
import { fetchTokenMetadata } from 'lib/miden/metadata';
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

    // Initial note toast state (mobile only)
    seenNoteIds: new Set<string>(),
    isNoteToastVisible: false,
    noteToastShownAt: null,

    // Initial extension sync state
    extensionClaimableNotes: null,
    extensionClaimingNoteIds: new Set<string>(),

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
        isInitialized: true,
        lastSyncedAt: Date.now()
      });

      // Immediately fetch balances when wallet becomes Ready (before any React effects)
      // On extension, skip — balances arrive via SyncCompleted broadcast from service worker
      if (justBecameReady && state.currentAccount && !isExtension()) {
        const address = state.currentAccount.publicKey;
        fetchBalances(address, get().assetsMetadata, { tokenPrices: get().tokenPrices })
          .then(balances => {
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
    registerWallet: async (walletType, password, mnemonic, ownMnemonic) => {
      console.log('[WalletStore] registerWallet called with walletType:', walletType);
      const res = await request({
        type: WalletMessageType.NewWalletRequest,
        walletType,
        password,
        mnemonic,
        ownMnemonic
      });
      assertResponse(res.type === WalletMessageType.NewWalletResponse);
      // State will be synced via StateUpdated notification
    },

    importWalletFromClient: async (password, mnemonic, walletAccounts) => {
      const res = await request({
        type: WalletMessageType.ImportFromClientRequest,
        password,
        mnemonic,
        walletAccounts
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

    revealMnemonic: async password => {
      const res = await request({
        type: WalletMessageType.RevealMnemonicRequest,
        password
      });
      assertResponse(res.type === WalletMessageType.RevealMnemonicResponse);
      return res.mnemonic;
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

    revealHotKey: async (accountPublicKey, password) => {
      const res = await request({
        type: WalletMessageType.RevealHotKeyRequest,
        accountPublicKey,
        password
      });
      assertResponse(res.type === WalletMessageType.RevealHotKeyResponse);
      return res.hotPrivateKey;
    },

    revealGuardianKeys: async (accountPublicKey, password) => {
      const res = await request({
        type: WalletMessageType.RevealGuardianKeysRequest,
        accountPublicKey,
        password
      });
      assertResponse(res.type === WalletMessageType.RevealGuardianKeysResponse);
      return {
        coldPrivateKey: res.coldPrivateKey,
        coldPublicKey: res.coldPublicKey,
        hotPublicKey: res.hotPublicKey
      };
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

    signWord: async (publicKey, wordHex) => {
      const res = await request({
        type: WalletMessageType.SignWordRequest,
        publicKey,
        wordHex
      });
      assertResponse(res.type === WalletMessageType.SignWordResponse);
      return res.signature;
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

    confirmDAppTransaction: async (id, confirmed, delegate) => {
      const res = await request({
        type: MidenMessageType.DAppTransactionConfirmationRequest,
        id,
        confirmed,
        delegate
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
    checkForNewNotes: (currentNoteIds: string[]) => {
      const { seenNoteIds } = get();

      // Find note IDs that weren't previously seen
      const newNoteIds = currentNoteIds.filter(id => !seenNoteIds.has(id));

      if (newNoteIds.length > 0) {
        // Update seen notes and show toast
        const updatedSeenNotes = new Set(seenNoteIds);
        for (const id of newNoteIds) {
          updatedSeenNotes.add(id);
        }
        set({
          seenNoteIds: updatedSeenNotes,
          isNoteToastVisible: true,
          noteToastShownAt: Date.now()
        });

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
        noteToastShownAt: null
      });

      if (isExtension()) {
        clearPersistedSeenNoteIds().catch(() => {});
      }
    },

    // Extension sync actions
    setExtensionClaimableNotes: notes => {
      set({ extensionClaimableNotes: notes });
    },

    addExtensionClaimingNoteId: noteId => {
      set(state => ({
        extensionClaimingNoteIds: new Set([...state.extensionClaimingNoteIds, noteId])
      }));
    },

    removeExtensionClaimingNoteIds: noteIds => {
      if (noteIds.length === 0) return;
      set(state => {
        const next = new Set(state.extensionClaimingNoteIds);
        let changed = false;
        for (const id of noteIds) {
          if (next.delete(id)) changed = true;
        }
        return changed ? { extensionClaimingNoteIds: next } : {};
      });
    },

    clearExtensionClaimingNoteIds: () => {
      set({ extensionClaimingNoteIds: new Set<string>() });
    }
  }))
);

// Export the intercom getter for use in sync hook
export { getIntercom };

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
  // Hex→bech32 faucet-id conversion. iOS E2E needs this to inject
  // synthetic metadata for the CLI-deployed test faucet (whose on-chain
  // procedure layout the SDK can't parse, so the real metadata RPC fails
  // and the wallet's `attachMetadataToNotes` hides the consumable note).
  // The CLI returns hex; the wallet's parsed note `faucetId` is bech32;
  // mismatch → injection misses. Eager-import the SDK at module-init so
  // by the time the test runs, the hook is sync and the WASM is ready.
  // Dynamic-import inside the call (used to live here) contended with the
  // wallet's own WASM lock and serialized behind in-flight SDK calls,
  // blowing past the 30s WebDriver execute_async_script budget.
  void (async () => {
    try {
      const sdk = await import('@miden-sdk/miden-sdk/lazy');
      (globalThis as any).__TEST_HEX_TO_BECH32_FAUCET__ = (
        hex: string,
        network: 'testnet' | 'devnet' = 'testnet'
      ): string => {
        const id = sdk.AccountId.fromHex(hex);
        const netId = network === 'devnet' ? sdk.NetworkId.devnet() : sdk.NetworkId.testnet();
        return sdk.Address.fromAccountId(id, 'BasicWallet').toBech32(netId);
      };
    } catch (e) {
      // E2E-only path; failure here just means the iOS metadata-injection
      // workaround won't work and we'd hit the original symptom (note
      // hidden by attachMetadataToNotes filter).
      console.error('[E2E] Failed to expose __TEST_HEX_TO_BECH32_FAUCET__:', e);
    }
  })();

  // Guardian on-chain auth structure (overall threshold + signer set + procedure
  // thresholds) for E2E assertions — the harness's balance checks can't see the
  // 3-key shape. Dynamic imports avoid a static cycle.
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
          { threshold: number; signerCommitments: string[]; procedureThresholds: Record<string, number> }
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
      const [{ AccountInspector }, { getMidenClient }] = await Promise.all([
        import('@openzeppelin/miden-multisig-client'),
        import('lib/miden/sdk/miden-client')
      ]);
      const account = await (await getMidenClient()).getAccount(accountPublicKey);
      if (!account) {
        return { error: `Guardian account ${accountPublicKey} not found in local client` };
      }
      const config = AccountInspector.fromAccount(account);
      return {
        threshold: config.threshold,
        signerCommitments: config.signerCommitments,
        procedureThresholds: Object.fromEntries(config.procedureThresholds)
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    } finally {
      setTestSyncPaused(false);
    }
  };
}
