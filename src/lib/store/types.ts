import { AllowedPrivateData, PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';

import { ExchangeRateRecord, FiatCurrencyOption } from 'lib/fiat-curency';
import { AssetMetadata } from 'lib/miden/metadata';
import { MidenDAppSessions, MidenNetwork, MidenState } from 'lib/miden/types';
import { type TokenPrices } from 'lib/prices/binance';
import { WalletAccount, WalletSettings, WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { TokenBalanceData } from '../miden/front/balance';

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
 * Balance state (previously separate SWR cache)
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
  /** Whether the dApp browser is open (mobile only) */
  isDappBrowserOpen: boolean;
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
  importWalletFromClient: (password: string | undefined, mnemonic: string) => Promise<void>;
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
  signWord: (publicKey: string, wordHex: string) => Promise<string>;
  getAuthSecretKey: (key: string) => Promise<string>;
  getPublicKeyForCommitment: (publicKeyCommitment: string) => Promise<string>;

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

  // UI actions
  setSelectedNetworkId: (networkId: string) => void;
  setConfirmation: (confirmation: { id: string; error?: any } | null) => void;
  resetConfirmation: () => void;
}

/**
 * Balance actions
 */
export interface BalanceActions {
  fetchBalances: (accountAddress: string, tokenMetadatas: Record<string, AssetMetadata>) => Promise<void>;
  setBalancesLoading: (accountAddress: string, isLoading: boolean) => void;
}

/**
 * Asset actions
 */
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
    WalletActions,
    BalanceActions,
    AssetActions,
    FiatCurrencyActions,
    SyncActions,
    TransactionModalActions,
    NoteToastActions {}
