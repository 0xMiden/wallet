import { AllowedPrivateData, PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';

import { ExchangeRateRecord, FiatCurrencyOption } from 'lib/fiat-curency';
import { TokenBalanceData } from 'lib/miden/front/balance';
import { AssetMetadata } from 'lib/miden/metadata';
import { MidenDAppSessions, MidenNetwork, MidenState } from 'lib/miden/types';
import { type TokenPrices } from 'lib/prices/binance';
import {
  AutoBackupEncryption,
  AutoBackupStatus,
  CloudBackupProbeResult,
  CloudBackupRestoreEncryption,
  SerializedConsumableNote,
  WalletAccount,
  WalletSettings,
  WalletStatus
} from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

/**
 * Core wallet state (synced from backend)
 */
export interface WalletSlice {
  status: WalletStatus;
  accounts: WalletAccount[];
  currentAccount: WalletAccount | null;
  networks: MidenNetwork[];
  settings: WalletSettings | null;
  ownMnemonic: boolean | null;
}

/**
 * Balance state (cached from IndexedDB via fetchBalances)
 */
export interface BalancesSlice {
  balances: Record<string, TokenBalanceData[]>;
  balancesLoading: Record<string, boolean>;
  balancesLastFetched: Record<string, number>;
}

/**
 * Assets metadata (previously TokensMetadataProvider)
 */
export interface AssetsSlice {
  assetsMetadata: Record<string, AssetMetadata>;
}

/**
 * UI state (network selection, etc.)
 */
export interface UISlice {
  selectedNetworkId: string | null;
  confirmation: { id: string; error?: any } | null;
}

/**
 * Fiat currency state (previously FiatCurrencyProvider)
 */
export interface FiatCurrencySlice {
  selectedFiatCurrency: FiatCurrencyOption | null;
  fiatRates: ExchangeRateRecord | null;
  fiatRatesLoading: boolean;
  tokenPrices: TokenPrices;
}

/**
 * Sync state
 */
export interface SyncSlice {
  isInitialized: boolean;
  isSyncing: boolean;
  lastSyncedAt: number | null;
  /** True after the first chain sync completes (used for initial loading indicator) */
  hasCompletedInitialSync: boolean;
}

/**
 * Transaction modal state
 */
export interface TransactionModalSlice {
  /** Whether the transaction progress modal is open */
  isTransactionModalOpen: boolean;
  /** Whether the user explicitly dismissed the modal (prevents auto-reopen until transactions complete) */
  isTransactionModalDismissedByUser: boolean;
  /**
   * Whether the dApp browser is open (mobile only).
   *
   * Backwards-compat boolean — kept in lockstep with `activeDappSessionId`.
   * Existing consumers like `native-notifications.ts` continue to read this.
   * New code should prefer `activeDappSessionId` (a string id is friendlier
   * for the multi-instance world that lands in PR-4).
   */
  isDappBrowserOpen: boolean;
  /**
   * The id of the dApp session currently in the foreground, or null when the
   * launcher is showing. Single-session in PR-1; PR-3 adds a parked-session
   * list; PR-4 generalizes to a per-instance map.
   */
  activeDappSessionId: string | null;
  /**
   * On-chain hash of the most recently completed transaction initiated in
   * this session, used to render a "View on Midenscan" action in the
   * transaction-complete modal. Cleared when the modal opens for a new tx
   * or closes, so a stale hash never leaks across sends.
   */
  lastCompletedTxHash: string | null;
}

/**
 * Note toast state (mobile only)
 */
export interface NoteToastSlice {
  /** Set of note IDs that have been seen (to detect new notes) */
  seenNoteIds: Set<string>;
  /** Whether the note received toast is visible */
  isNoteToastVisible: boolean;
  /** Timestamp when the toast was shown (used as key to reset timer) */
  noteToastShownAt: number | null;
}

/**
 * Actions for wallet mutations
 */
export interface WalletActions {
  // Sync action
  syncFromBackend: (state: MidenState) => void;

  // Auth actions
  registerWallet: (password: string | undefined, mnemonic?: string, ownMnemonic?: boolean) => Promise<void>;
  importWalletFromClient: (
    password: string | undefined,
    mnemonic: string,
    walletAccounts: WalletAccount[]
  ) => Promise<void>;
  unlock: (password?: string) => Promise<void>;

  // Account actions
  createAccount: (walletType: WalletType, name?: string) => Promise<void>;
  updateCurrentAccount: (accountPublicKey: string) => Promise<void>;
  editAccountName: (accountPublicKey: string, name: string) => Promise<void>;
  revealMnemonic: (password?: string) => Promise<string>;

  // Settings actions
  updateSettings: (newSettings: Partial<WalletSettings>) => Promise<void>;

  // Signing actions
  signData: (publicKey: string, signingInputs: string) => Promise<string>;
  signTransaction: (publicKey: string, signingInputs: string) => Promise<Uint8Array>;
  getAuthSecretKey: (key: string) => Promise<string>;

  // DApp actions
  getDAppPayload: (id: string) => Promise<any>;
  confirmDAppPermission: (
    id: string,
    confirmed: boolean,
    accountId: string,
    privateDataPermission: PrivateDataPermission,
    allowedPrivateData: AllowedPrivateData
  ) => Promise<void>;
  confirmDAppSign: (id: string, confirmed: boolean) => Promise<void>;
  confirmDAppPrivateNotes: (id: string, confirmed: boolean) => Promise<void>;
  confirmDAppAssets: (id: string, confirmed: boolean) => Promise<void>;
  confirmDAppImportPrivateNote: (id: string, confirmed: boolean) => Promise<void>;
  confirmDAppConsumableNotes: (id: string, confirmed: boolean) => Promise<void>;
  confirmDAppTransaction: (id: string, confirmed: boolean, delegate: boolean) => Promise<void>;
  getAllDAppSessions: () => Promise<MidenDAppSessions>;
  removeDAppSession: (origin: string) => Promise<void>;

  // Cloud backup actions
  restoreCloudBackup: (
    accessToken: string,
    encryption: CloudBackupRestoreEncryption
  ) => Promise<{ walletAccounts: WalletAccount[]; walletSettings: WalletSettings }>;
  probeCloudBackup: (accessToken: string) => Promise<CloudBackupProbeResult>;
  registerFromCloudBackup: (
    password: string | undefined,
    mnemonic: string,
    walletAccounts: WalletAccount[],
    walletSettings: WalletSettings
  ) => Promise<void>;

  // Auto backup actions
  setAutoBackupEnabled: (
    enabled: boolean,
    accessToken?: string,
    expiresAt?: number,
    encryption?: AutoBackupEncryption,
    skipInitialBackup?: boolean
  ) => Promise<void>;
  fetchAutoBackupStatus: () => Promise<AutoBackupStatus>;

  // UI actions
  setSelectedNetworkId: (networkId: string) => void;
  setConfirmation: (confirmation: { id: string; error?: any } | null) => void;
  resetConfirmation: () => void;
}

/**
 * Asset actions
 */
export interface BalanceActions {
  fetchBalances: (accountAddress: string, tokenMetadatas: Record<string, AssetMetadata>) => Promise<void>;
  setBalancesLoading: (accountAddress: string, isLoading: boolean) => void;
}

export interface AssetActions {
  setAssetsMetadata: (metadata: Record<string, AssetMetadata>) => void;
  fetchAssetMetadata: (assetId: string) => Promise<AssetMetadata | null>;
}

/**
 * Fiat currency actions
 */
export interface FiatCurrencyActions {
  setSelectedFiatCurrency: (currency: FiatCurrencyOption) => void;
  setFiatRates: (rates: ExchangeRateRecord | null) => void;
  fetchFiatRates: () => Promise<void>;
  setTokenPrices: (prices: TokenPrices) => void;
}

/**
 * Sync actions
 */
export interface SyncActions {
  setSyncStatus: (isSyncing: boolean) => void;
}

/**
 * Transaction modal actions
 */
export interface TransactionModalActions {
  openTransactionModal: () => void;
  /** Close the modal. If dismissedByUser is true, prevents auto-reopen until transactions complete */
  closeTransactionModal: (dismissedByUser?: boolean) => void;
  /** Reset the dismissed flag (called when all transactions complete) */
  resetTransactionModalDismiss: () => void;
  setDappBrowserOpen: (isOpen: boolean) => void;
  /**
   * Set the active dApp session id (or clear it). Updates `isDappBrowserOpen`
   * in lockstep so legacy consumers stay correct.
   */
  setActiveDappSession: (sessionId: string | null) => void;
  setLastCompletedTxHash: (txHash: string | null) => void;
}

/**
 * Extension sync state (service worker pushes data to frontend via SyncCompleted)
 */
export interface ExtensionSyncSlice {
  /** Claimable notes pushed from service worker (null = not yet received) */
  extensionClaimableNotes: SerializedConsumableNote[] | null;
  /** Note IDs being claimed (optimistic, cleared on each SyncCompleted) */
  extensionClaimingNoteIds: Set<string>;
}

/**
 * Extension sync actions
 */
export interface ExtensionSyncActions {
  setExtensionClaimableNotes: (notes: SerializedConsumableNote[]) => void;
  addExtensionClaimingNoteId: (noteId: string) => void;
  /** Remove specific note IDs from the claiming set (e.g. those no longer consumable). */
  removeExtensionClaimingNoteIds: (noteIds: string[]) => void;
  clearExtensionClaimingNoteIds: () => void;
}

/**
 * Note toast actions (mobile only)
 */
export interface NoteToastActions {
  /** Check if new notes have been received and show toast if so */
  checkForNewNotes: (currentNoteIds: string[]) => void;
  /** Dismiss the note received toast */
  dismissNoteToast: () => void;
  /** Reset all seen notes (used when switching accounts) */
  resetSeenNotes: () => void;
}

/**
 * Combined store type
 */
export interface WalletStore
  extends
    WalletSlice,
    BalancesSlice,
    AssetsSlice,
    UISlice,
    FiatCurrencySlice,
    SyncSlice,
    TransactionModalSlice,
    NoteToastSlice,
    ExtensionSyncSlice,
    WalletActions,
    BalanceActions,
    AssetActions,
    FiatCurrencyActions,
    SyncActions,
    TransactionModalActions,
    NoteToastActions,
    ExtensionSyncActions {}
