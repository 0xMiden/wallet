import type { StrictAuthenticationProtectors } from 'lib/auth/strict-action-authentication';
import type {
  PersistedSpendingLimit,
  SerializedSpendingLimitAssessment,
  SerializedSpendingLimitDraft
} from 'lib/miden/spending-limits/types';
import { MidenMessageType, MidenRequest, MidenResponse } from 'lib/miden/types';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { TelemetryEvent } from 'lib/telemetry/types';
import { WalletType } from 'screens/onboarding/types';

export enum WalletMessageType {
  // Aknowledge
  Acknowledge = 'CONNECT_AKNOWLEDGE',
  // Notifications
  StateUpdated = 'STATE_UPDATED',
  // Generic Responses
  LoadingResponse = 'LOADING_RESPONSE',
  // Request-Response pairs
  GetStateRequest = 'GET_STATE_REQUEST',
  GetStateResponse = 'GET_STATE_RESPONSE',
  NewWalletRequest = 'NEW_WALLET_REQUEST',
  NewWalletResponse = 'NEW_WALLET_RESPONSE',
  NewWalletFromHotKeyRequest = 'NEW_WALLET_FROM_HOT_KEY_REQUEST',
  NewWalletFromHotKeyResponse = 'NEW_WALLET_FROM_HOT_KEY_RESPONSE',
  ImportFromClientRequest = 'IMPORT_FROM_CLIENT_REQUEST',
  ImportFromClientResponse = 'IMPORT_FROM_CLIENT_RESPONSE',
  UnlockRequest = 'UNLOCK_REQUEST',
  UnlockResponse = 'UNLOCK_RESPONSE',
  LockRequest = 'LOCK_REQUEST',
  LockResponse = 'LOCK_RESPONSE',
  CreateAccountRequest = 'CREATE_ACCOUNT_REQUEST',
  CreateAccountResponse = 'CREATE_ACCOUNT_RESPONSE',
  UpdateCurrentAccountRequest = 'UPDATE_CURRENT_ACCOUNT_REQUEST',
  UpdateCurrentAccountResponse = 'UPDATE_CURRENT_ACCOUNT_RESPONSE',
  RevealPublicKeyRequest = 'REVEAL_PUBLIC_KEY_REQUEST',
  RevealPublicKeyResponse = 'REVEAL_PUBLIC_KEY_RESPONSE',
  RevealViewKeyRequest = 'REVEAL_VIEW_KEY_REQUEST',
  RevealViewKeyResponse = 'REVEAL_VIEW_KEY_RESPONSE',
  RevealPrivateKeyRequest = 'REVEAL_PRIVATE_KEY_REQUEST',
  RevealPrivateKeyResponse = 'REVEAL_PRIVATE_KEY_RESPONSE',
  ExportAccountFileRequest = 'EXPORT_ACCOUNT_FILE_REQUEST',
  ExportAccountFileResponse = 'EXPORT_ACCOUNT_FILE_RESPONSE',
  RevealHotKeyRequest = 'REVEAL_HOT_KEY_REQUEST',
  RevealHotKeyResponse = 'REVEAL_HOT_KEY_RESPONSE',
  RevealGuardianKeysRequest = 'REVEAL_GUARDIAN_KEYS_REQUEST',
  RevealGuardianKeysResponse = 'REVEAL_GUARDIAN_KEYS_RESPONSE',
  RevealMnemonicRequest = 'REVEAL_MNEMONIC_REQUEST',
  RevealMnemonicResponse = 'REVEAL_MNEMONIC_RESPONSE',
  ExportWalletBackupMaterialRequest = 'EXPORT_WALLET_BACKUP_MATERIAL_REQUEST',
  ExportWalletBackupMaterialResponse = 'EXPORT_WALLET_BACKUP_MATERIAL_RESPONSE',
  RemoveSeedPhraseRequest = 'REMOVE_SEED_PHRASE_REQUEST',
  RemoveSeedPhraseResponse = 'REMOVE_SEED_PHRASE_RESPONSE',
  ProvideRecoverySeedRequest = 'PROVIDE_RECOVERY_SEED_REQUEST',
  ProvideRecoverySeedResponse = 'PROVIDE_RECOVERY_SEED_RESPONSE',
  PrepareRecoveryRequest = 'PREPARE_RECOVERY_REQUEST',
  PrepareRecoveryResponse = 'PREPARE_RECOVERY_RESPONSE',
  ReleaseRecoveryRequest = 'RELEASE_RECOVERY_REQUEST',
  ReleaseRecoveryResponse = 'RELEASE_RECOVERY_RESPONSE',
  RemoveAccountRequest = 'REMOVE_ACCOUNT_REQUEST',
  RemoveAccountResponse = 'REMOVE_ACCOUNT_RESPONSE',
  EditAccountRequest = 'EDIT_ACCOUNT_REQUEST',
  EditAccountResponse = 'EDIT_ACCOUNT_RESPONSE',
  ImportAccountRequest = 'IMPORT_ACCOUNT_REQUEST',
  ImportAccountResponse = 'IMPORT_ACCOUNT_RESPONSE',
  ImportWatchOnlyAccountRequest = 'IMPORT_WATCH_ONLY_ACCOUNT_REQUEST',
  ImportWatchOnlyAccountResponse = 'IMPORT_WATCH_ONLY_ACCOUNT_RESPONSE',
  ImportMnemonicAccountRequest = 'IMPORT_MNEMONIC_ACCOUNT_REQUEST',
  ImportMnemonicAccountResponse = 'IMPORT_MNEMONIC_ACCOUNT_RESPONSE',
  UpdateSettingsRequest = 'UPDATE_SETTINGS_REQUEST',
  UpdateSettingsResponse = 'UPDATE_SETTINGS_RESPONSE',
  GetSpendingLimitRequest = 'GET_SPENDING_LIMIT_REQUEST',
  GetSpendingLimitResponse = 'GET_SPENDING_LIMIT_RESPONSE',
  SaveSpendingLimitRequest = 'SAVE_SPENDING_LIMIT_REQUEST',
  SaveSpendingLimitResponse = 'SAVE_SPENDING_LIMIT_RESPONSE',
  AssessSpendingLimitRequest = 'ASSESS_SPENDING_LIMIT_REQUEST',
  AssessSpendingLimitResponse = 'ASSESS_SPENDING_LIMIT_RESPONSE',
  GetStrictAuthenticationProtectorsRequest = 'GET_STRICT_AUTHENTICATION_PROTECTORS_REQUEST',
  GetStrictAuthenticationProtectorsResponse = 'GET_STRICT_AUTHENTICATION_PROTECTORS_RESPONSE',
  VerifyStrictActionAuthenticationRequest = 'VERIFY_STRICT_ACTION_AUTHENTICATION_REQUEST',
  VerifyStrictActionAuthenticationResponse = 'VERIFY_STRICT_ACTION_AUTHENTICATION_RESPONSE',
  SignDataRequest = 'SIGN_DATA_REQUEST',
  SignDataResponse = 'SIGN_DATA_RESPONSE',
  SignTransactionRequest = 'SIGN_TRANSACTION_REQUEST',
  SignTransactionResponse = 'SIGN_TRANSACTION_RESPONSE',
  SignWordRequest = 'SIGN_WORD_REQUEST',
  SignWordResponse = 'SIGN_WORD_RESPONSE',
  SignEvmRequest = 'SIGN_EVM_REQUEST',
  SignEvmResponse = 'SIGN_EVM_RESPONSE',
  PersistNewHotKeyRequest = 'PERSIST_NEW_HOT_KEY_REQUEST',
  PersistNewHotKeyResponse = 'PERSIST_NEW_HOT_KEY_RESPONSE',
  SwapHotKeyRequest = 'SWAP_HOT_KEY_REQUEST',
  SwapHotKeyResponse = 'SWAP_HOT_KEY_RESPONSE',
  SetGuardianEndpointRequest = 'SET_GUARDIAN_ENDPOINT_REQUEST',
  SetGuardianEndpointResponse = 'SET_GUARDIAN_ENDPOINT_RESPONSE',
  SetGuardianOperatorCommitmentRequest = 'SET_GUARDIAN_OPERATOR_COMMITMENT_REQUEST',
  SetGuardianOperatorCommitmentResponse = 'SET_GUARDIAN_OPERATOR_COMMITMENT_RESPONSE',
  SetGuardianSyncStatusRequest = 'SET_GUARDIAN_SYNC_STATUS_REQUEST',
  SetGuardianSyncStatusResponse = 'SET_GUARDIAN_SYNC_STATUS_RESPONSE',
  CheckGuardianDriftRequest = 'CHECK_GUARDIAN_DRIFT_REQUEST',
  CheckGuardianDriftResponse = 'CHECK_GUARDIAN_DRIFT_RESPONSE',
  ApplyUserGuardianEndpointRequest = 'APPLY_USER_GUARDIAN_ENDPOINT_REQUEST',
  ApplyUserGuardianEndpointResponse = 'APPLY_USER_GUARDIAN_ENDPOINT_RESPONSE',
  StartGuardianRecoveryRequest = 'START_GUARDIAN_RECOVERY_REQUEST',
  StartGuardianRecoveryResponse = 'START_GUARDIAN_RECOVERY_RESPONSE',
  GetPublicKeyForCommitmentRequest = 'GET_PUBLIC_KEY_FOR_COMMITMENT_REQUEST',
  GetPublicKeyForCommitmentResponse = 'GET_PUBLIC_KEY_FOR_COMMITMENT_RESPONSE',
  GetAuthSecretKeyRequest = 'GET_AUTH_SECRET_KEY_REQUEST',
  GetAuthSecretKeyResponse = 'GET_AUTH_SECRET_KEY_RESPONSE',
  SubmitTransactionRequest = 'SUBMIT_TRANSACTION_REQUEST',
  SubmitTransactionResponse = 'SUBMIT_TRANSACTION_RESPONSE',
  ConfirmationRequest = 'CONFIRMATION_REQUEST',
  ConfirmationResponse = 'CONFIRMATION_RESPONSE',
  PageRequest = 'PAGE_REQUEST',
  PageResponse = 'PAGE_RESPONSE',
  DAppGetPayloadRequest = 'DAPP_GET_PAYLOAD_REQUEST',
  DAppGetPayloadResponse = 'DAPP_GET_PAYLOAD_RESPONSE',
  DAppPermConfirmationRequest = 'DAPP_PERM_CONFIRMATION_REQUEST',
  DAppPermConfirmationResponse = 'DAPP_PERM_CONFIRMATION_RESPONSE',
  DAppSignConfirmationRequest = 'DAPP_SIGN_CONFIRMATION_REQUEST',
  DAppSignConfirmationResponse = 'DAPP_SIGN_CONFIRMATION_RESPONSE',
  DAppDecryptConfirmationRequest = 'DAPP_DECRYPT_CONFIRMATION_REQUEST',
  DAppDecryptConfirmationResponse = 'DAPP_DECRYPT_CONFIRMATION_RESPONSE',
  DAppRecordsConfirmationRequest = 'DAPP_RECORDS_CONFIRMATION_REQUEST',
  DAppRecordsConfirmationResponse = 'DAPP_RECORDS_CONFIRMATION_RESPONSE',
  DAppTransactionConfirmationRequest = 'DAPP_TRANSACTION_CONFIRMATION_REQUEST',
  DAppTransactionConfirmationResponse = 'DAPP_TRANSACTION_CONFIRMATION_RESPONSE',
  DAppBulkTransactionsConfirmationRequest = 'DAPP_BULK_TRANSACTIONS_CONFIRMATION_REQUEST',
  DAppBulkTransactionsConfirmationResponse = 'DAPP_BULK_TRANSACTIONS_CONFIRMATION_RESPONSE',
  DAppDeployConfirmationRequest = 'DAPP_DEPLOY_CONFIRMATION_REQUEST',
  DAppDeployConfirmationResponse = 'DAPP_DEPLOY_CONFIRMATION_RESPONSE',
  DAppGetAllSessionsRequest = 'DAPP_GET_ALL_SESSIONS_REQUEST',
  DAppGetAllSessionsResponse = 'DAPP_GET_ALL_SESSIONS_RESPONSE',
  DAppRemoveSessionRequest = 'DAPP_REMOVE_SESSION_REQUEST',
  DAppRemoveSessionResponse = 'DAPP_REMOVE_SESSION_RESPONSE',
  DecryptCiphertextsRequest = 'DECRYPT_CIPHERTEXTS_REQUEST',
  DecryptCiphertextsResponse = 'DECRYPT_CIPHERTEXTS_RESPONSE',
  GetOwnedRecordsRequest = 'GET_OWNED_RECORDS_REQUEST',
  GetOwnedRecordsResponse = 'GET_OWNED_RECORDS_RESPONSE',
  // Sync messages (service worker <-> frontend)
  SyncCompleted = 'SYNC_COMPLETED',
  SyncRequest = 'SYNC_REQUEST',
  SyncResponse = 'SYNC_RESPONSE',
  // Cross-tab claim coordination
  NoteClaimStarted = 'NOTE_CLAIM_STARTED',
  NoteClaimStartedResponse = 'NOTE_CLAIM_STARTED_RESPONSE',
  // Transaction processing (popup → SW)
  ProcessTransactionsRequest = 'PROCESS_TRANSACTIONS_REQUEST',
  ProcessTransactionsResponse = 'PROCESS_TRANSACTIONS_RESPONSE',
  // Developer endpoint overrides (popup → SW): re-hydrate the SW's override
  // cache + rebuild its Miden client singleton(s) after a save.
  ReloadEndpointOverridesRequest = 'RELOAD_ENDPOINT_OVERRIDES_REQUEST',
  ReloadEndpointOverridesResponse = 'RELOAD_ENDPOINT_OVERRIDES_RESPONSE',
  // Note operations (popup → SW)
  ImportNoteBytesRequest = 'IMPORT_NOTE_BYTES_REQUEST',
  ImportNoteBytesResponse = 'IMPORT_NOTE_BYTES_RESPONSE',
  RetryDeadletteredNotesRequest = 'RETRY_DEADLETTERED_NOTES_REQUEST',
  RetryDeadletteredNotesResponse = 'RETRY_DEADLETTERED_NOTES_RESPONSE',
  ExportNoteRequest = 'EXPORT_NOTE_REQUEST',
  ExportNoteResponse = 'EXPORT_NOTE_RESPONSE',
  GetInputNoteDetailsRequest = 'GET_INPUT_NOTE_DETAILS_REQUEST',
  GetInputNoteDetailsResponse = 'GET_INPUT_NOTE_DETAILS_RESPONSE',
  ReportTelemetryEventRequest = 'REPORT_TELEMETRY_EVENT_REQUEST',
  ReportTelemetryEventResponse = 'REPORT_TELEMETRY_EVENT_RESPONSE'
}

export type WalletNotification = StateUpdated | SyncCompleted | NoteClaimStarted;

export interface WalletMessageBase {
  type: WalletMessageType | MidenMessageType;
}

export interface AcknowledgeRequest extends WalletMessageBase {
  type: WalletMessageType.Acknowledge;
  origin: string;
  payload: any;
  beacon?: boolean;
  encrypted?: boolean;
}

export interface AcknowledgeResponse extends WalletMessageBase {
  type: WalletMessageType.Acknowledge;
  payload: string;
  encrypted?: boolean;
}

export interface StateUpdated extends WalletMessageBase {
  type: WalletMessageType.StateUpdated;
}

export interface SerializedVaultAsset {
  faucetId: string;
  amountBaseUnits: string;
  metadata?: {
    decimals: number;
    symbol: string;
    name: string;
    thumbnailUri?: string;
    /** See `AssetMetadata.scaleIsUnknown` — dropping it here would launder a guess into a fact. */
    scaleIsUnknown?: boolean;
  };
}

export interface SyncData {
  notes: SerializedConsumableNote[];
  vaultAssets: SerializedVaultAsset[];
  accountPublicKey: string;
  // When the service worker's last successful sync finished, so a reader can tell a
  // live result from the snapshot persisted by an earlier session. A pass whose sync
  // failed repeats the previous value. Absent before this service worker's first
  // successful sync, and from snapshots written before the field existed.
  syncedAt?: number;
}

export interface SyncCompleted extends WalletMessageBase {
  type: WalletMessageType.SyncCompleted;
}

export interface SyncRequest extends WalletMessageBase {
  type: WalletMessageType.SyncRequest;
  force?: boolean;
}

export interface SyncResponse extends WalletMessageBase {
  type: WalletMessageType.SyncResponse;
}

export interface SerializedConsumableNote {
  id: string;
  faucetId: string;
  amountBaseUnits: string;
  senderAddress: string;
  noteType?: string; // 'public' | 'private' | 'unknown'
  /** Estimated epoch ms when the sender can reclaim this P2IDE note; absent for non-recallable notes. */
  recallableAtMs?: number;
  /** Note inclusion time, in Unix seconds. */
  receivedAt?: number;
  swapOrder?: {
    orderId: string;
    depth: number;
    role: 'tip' | 'payback';
    lineageState: 'active' | 'filled' | 'reclaimed';
    expiresAt: number;
    expiryTriggeredAt?: number;
    autoConsume?: boolean;
  };
  metadata?: {
    decimals: number;
    symbol: string;
    name: string;
    thumbnailUri?: string;
    /** See `AssetMetadata.scaleIsUnknown` — dropping it here would launder a guess into a fact. */
    scaleIsUnknown?: boolean;
  };
}

export interface NoteClaimStarted extends WalletMessageBase {
  type: WalletMessageType.NoteClaimStarted;
  noteId: string;
}

export interface NoteClaimStartedResponse extends WalletMessageBase {
  type: WalletMessageType.NoteClaimStartedResponse;
}

export interface ProcessTransactionsRequest extends WalletMessageBase {
  type: WalletMessageType.ProcessTransactionsRequest;
}

export interface ProcessTransactionsResponse extends WalletMessageBase {
  type: WalletMessageType.ProcessTransactionsResponse;
}

/**
 * Tell the SW to re-hydrate `lib/miden-chain/effective-endpoints`'s
 * module-level override cache from storage and dispose its Miden client
 * singleton(s), so the next `getMidenClient()` rebuilds against the
 * freshly-saved endpoints. Fire-and-forget from the caller's perspective
 * (the response payload carries no data) — mirrors `ProcessTransactionsRequest`.
 * Still pairs with a Response type: `IntercomServer.processMessage` treats a
 * handler returning `undefined` as "Not Found" and errors the round trip, so
 * every case in `processRequest` must resolve to a typed response, even ones
 * with nothing to report. Extension-only: mobile/desktop share the frontend's
 * JS realm, so `applyEndpointOverride` alone already takes effect there.
 */
export interface ReloadEndpointOverridesRequest extends WalletMessageBase {
  type: WalletMessageType.ReloadEndpointOverridesRequest;
}

export interface ReloadEndpointOverridesResponse extends WalletMessageBase {
  type: WalletMessageType.ReloadEndpointOverridesResponse;
}

export interface ImportNoteBytesRequest extends WalletMessageBase {
  type: WalletMessageType.ImportNoteBytesRequest;
  noteBytes: string; // base64 encoded
}

export interface ImportNoteBytesResponse extends WalletMessageBase {
  type: WalletMessageType.ImportNoteBytesResponse;
  noteId: string;
}

/**
 * Drain the note dead-letter store back onto the import queue (#788 follow-up)
 * — the Activity notice's Retry. Handled in the realm that owns the import
 * pass: the SW on extension, the single realm on mobile/desktop.
 */
export interface RetryDeadletteredNotesRequest extends WalletMessageBase {
  type: WalletMessageType.RetryDeadletteredNotesRequest;
}

export interface RetryDeadletteredNotesResponse extends WalletMessageBase {
  type: WalletMessageType.RetryDeadletteredNotesResponse;
  /** How many notes were moved back onto the import queue. */
  requeued: number;
}

export interface ExportNoteRequest extends WalletMessageBase {
  type: WalletMessageType.ExportNoteRequest;
  noteId: string;
}

export interface ExportNoteResponse extends WalletMessageBase {
  type: WalletMessageType.ExportNoteResponse;
  noteBytes: string; // base64 encoded
}

export interface SerializedInputNoteDetail {
  noteId: string;
  state: string; // serialized InputNoteState — plain string, not SDK enum
  senderAccountId?: string;
  assets: Array<{ amount: string; faucetId: string }>;
  nullifier: string;
}

export interface GetInputNoteDetailsRequest extends WalletMessageBase {
  type: WalletMessageType.GetInputNoteDetailsRequest;
  noteIds: string[];
}

export interface ReportTelemetryEventRequest extends WalletMessageBase {
  type: WalletMessageType.ReportTelemetryEventRequest;
  /** Only the event. Version and platform are derived in the background. */
  event: TelemetryEvent;
}

export interface ReportTelemetryEventResponse extends WalletMessageBase {
  type: WalletMessageType.ReportTelemetryEventResponse;
}

export interface GetInputNoteDetailsResponse extends WalletMessageBase {
  type: WalletMessageType.GetInputNoteDetailsResponse;
  notes: SerializedInputNoteDetail[];
}

export interface GetStateRequest extends WalletMessageBase {
  type: WalletMessageType.GetStateRequest;
  // TODO: Add an enum param here for determining which wallet type
}

export interface GetStateResponse extends WalletMessageBase {
  type: WalletMessageType.GetStateResponse;
  state: WalletState;
}

// TODO: Make generalizable and pull out somewhere
export type GuardianRecoveryAction =
  | { type: 'switch-guardian'; accountId: string; newGuardianEndpoint: string }
  | { type: 'replace-hot-key'; accountId: string }
  | { type: 'update-procedure-threshold'; accountId: string; procedure: string; threshold: number };

export type SeedPhraseStatus = 'stored' | 'removing' | 'removed' | 'unavailable';

export interface WalletState {
  seedPhraseStatus?: SeedPhraseStatus;
  status: WalletStatus;
  accounts: WalletAccount[]; // Miden sdk might soon export a type for this
  networks: WalletNetwork[];
  settings: WalletSettings | null; // TODO: Do we want settings on the state
  currentAccount: WalletAccount | null; // Miden sdk might soon export a type for this
  ownMnemonic: boolean | null; // TODO: Will be boolean in future if used. For seed phrase logic
}

type NonEmptyArray<T> = [T, ...T[]];
export interface ReadyWalletState extends WalletState {
  status: WalletStatus.Ready;
  accounts: NonEmptyArray<WalletAccount>;
  networks: NonEmptyArray<WalletNetwork>;
  settings: WalletSettings;
  currentAccount: WalletAccount;
}

/**
 * Auth scheme an account uses for signing.
 *
 * Mirrors `@miden-sdk/miden-sdk` `AuthSchemeType` ("falcon" | "ecdsa").
 *
 * Optional on stored `WalletAccount` records. Records written before this
 * field existed have it absent on read; consumers MUST treat missing as
 * `"falcon"` (the historical wallet default). This preserves restore +
 * sign behavior 1:1 for pre-migration wallets while letting new accounts
 * be stamped with the new default ("ecdsa").
 *
 * Miden accounts cannot rotate auth, so this field is fixed at account
 * creation time and never mutated.
 */
export type AuthScheme = 'falcon' | 'ecdsa';

/**
 * Key-derivation scheme an account's seed was derived under. Mirrors
 * `KeyDerivation` in `@miden/hd-key`.
 *
 * - `legacy`: label `bls12_377 seed`, path `m/44'/0'/<walletType>'/<hdIndex>'`.
 * - `v1`: label `miden seed`, path `m/44'/5063758'/<walletType>'/<authScheme>'/<hdIndex>'`.
 *
 * Optional on stored `WalletAccount` records. Records written before this
 * field existed have it absent on read; consumers MUST treat missing as
 * `legacy`. Fixed at account creation and never mutated, because the
 * derivation decides which on-chain key the seed phrase recovers.
 */
export type KeyDerivation = 'legacy' | 'v1';

/**
 * Local reconciliation state of a Guardian account's endpoint vs its on-chain
 * guardian key. 'in-sync': stored endpoint matches on-chain. 'resolving':
 * an out-of-band switch was detected and auto-resolution is in progress.
 * 'needs-user-input': the new operator could not be identified (custom URL) and
 * the user must supply it. Absent on non-Guardian accounts and legacy records.
 */
export type GuardianSyncStatus = 'in-sync' | 'resolving' | 'needs-user-input';

/** Built-in guardian provider identity, reverse-mapped from the endpoint. */
export type GuardianProvider = 'open-zeppelin' | 'gateway' | 'lambda-class' | 'custom';

/** dApp-facing guardian info for the connected account. */
export interface GuardianInfo {
  isGuardianAccount: boolean;
  guardianEndpoint: string | null;
  guardianProvider: GuardianProvider | null;
  guardianSyncStatus: 'in-sync' | 'out-of-sync' | null;
}

export interface WalletAccount {
  publicKey: string;
  name: string;
  isPublic: boolean;
  type: WalletType;
  hdIndex: number;
  // Set on Guardian accounts created with the 3-key model (hot + cold + guardian).
  // Absent on non-Guardian accounts and on legacy single-signer Guardian records
  // produced before the migration; consumers should treat absence as "not 3-key".
  hotPublicKey?: string;
  coldPublicKey?: string;
  // True for Guardian accounts adopted via seed-phrase recovery — the on-chain
  // hot signer's secret is unrecoverable, so the wallet defers replacement to
  // a user-triggered rotation (banner on the home view). Cleared by Vault.swapHotKey
  // once the cold+guardian-signed update_signers tx lands on-chain.
  requiresHotKeyRotation?: boolean;
  /**
   * Set on adoption through Guardian seed recovery; the detached pending-note
   * recovery (GuardianRecoveryProvider → maybeStartGuardianRecovery) runs once
   * and clears it. Absent on accounts that were not seed-recovered.
   */
  guardianNoteRecoveryPending?: boolean;
  /**
   * Guardian operator endpoint this account is registered with — the
   * authoritative source of truth for endpoint resolution (#408). Set at create /
   * recovery time, stamped onto legacy accounts by the unlock-time on-chain
   * backfill, and updated when the user switches guardians. Per-account so
   * multiple Guardian accounts can live on different operators. When absent (a
   * legacy record the backfill couldn't resolve on-chain), consumers fall back
   * to the frozen, read-only, never-written legacy global
   * `GUARDIAN_URL_STORAGE_KEY` (see `resolveGuardianEndpoint`). Non-Guardian
   * accounts leave this undefined.
   */
  guardianEndpoint?: string;
  /**
   * The operator-wide guardian key commitment the current `guardianEndpoint`
   * corresponds to (the value baked into the account's on-chain
   * `openzeppelin::guardian::public_key` slot at create/switch time). Local
   * baseline for out-of-band-switch detection. Absent on non-Guardian accounts.
   */
  guardianOperatorCommitment?: string;
  /** Reconciliation state; see GuardianSyncStatus. Defaults to 'in-sync'. */
  guardianSyncStatus?: GuardianSyncStatus;
  /**
   * Auth scheme this account was created with. See {@link AuthScheme} for
   * the missing-on-read → `"falcon"` legacy interpretation.
   */
  authScheme?: AuthScheme;
  /**
   * Key-derivation scheme this account's seed was derived under. See
   * {@link KeyDerivation} for the missing-on-read → `legacy` interpretation.
   * Absent on imported accounts (`hdIndex: -1`), which have no derivation.
   */
  keyDerivation?: KeyDerivation;
  /**
   * Wallet-derived EVM address (BIP-44 m/44'/60'/0'/0/{hdIndex}), used as the
   * Epoch lending position owner. Stamped at account creation and backfilled
   * on unlock. Absent on imported accounts (hdIndex -1) and on records written
   * before this field existed (until the unlock backfill runs). Public data —
   * the matching private key lives AES-GCM-encrypted under the vault key at
   * `accevmsecretkey_<address>` and is only ever decrypted transiently per
   * signing operation.
   */
  evmAddress?: string;
}

export interface ImportedAccountBackup {
  accountId: string;
  publicKeyCommitment: string;
  authScheme: AuthScheme;
  secretKeyHex: string;
}

export interface WalletBackupMaterial {
  seedPhrase: string;
  accounts: WalletAccount[];
  midenClientDbContent: string;
  walletDbContent: string;
  importedAccounts: ImportedAccountBackup[];
}

export interface WalletNetwork {
  rpcBaseURL: string;
  id: string;
  name: string;
  autoSync: boolean;
}

/**
 * A selectable Guardian provider shown in the Choose-Guardian picker.
 */
export interface GuardianOption {
  id: string;
  name: string;
  operatedBy: string;
  location: string;
  endpoint: Map<MIDEN_NETWORK_NAME, string>; // endpoints for guardian
}

export interface LoadingResponse extends WalletMessageBase {
  type: WalletMessageType.LoadingResponse;
}

export interface NewWalletRequest extends WalletMessageBase {
  type: WalletMessageType.NewWalletRequest;
  password?: string; // Optional for hardware-only wallets (mobile/desktop with Secure Enclave)
  mnemonic?: string;
  ownMnemonic?: boolean;
  walletType: WalletType;
  // Guardian operator endpoint the onboarding flow picked (choose-guardian) or
  // probed (import / recovery). Threaded explicitly so a new Guardian account
  // binds to the caller's chosen endpoint without round-tripping through the
  // legacy global GUARDIAN_URL_STORAGE_KEY. Undefined for non-guardian wallets.
  guardianEndpoint?: string;
}

export interface NewWalletResponse extends WalletMessageBase {
  type: WalletMessageType.NewWalletResponse;
}

/**
 * Seed-less Guardian import: spawn a wallet from a pasted HOT secret key.
 * The account is looked up at the guardian by the key's commitment and
 * adopted; no mnemonic is generated, so the wallet's seed status is
 * 'unavailable' from birth.
 */
export interface NewWalletFromHotKeyRequest extends WalletMessageBase {
  type: WalletMessageType.NewWalletFromHotKeyRequest;
  password?: string; // Optional for hardware-only wallets (mobile/desktop with Secure Enclave)
  /** Two raw scalars in hot:evm order; validated again in the vault. */
  keyPairPayload: string;
  /** Operator picked/probed in onboarding; the network default when absent. */
  guardianEndpoint?: string;
}

export interface NewWalletFromHotKeyResponse extends WalletMessageBase {
  type: WalletMessageType.NewWalletFromHotKeyResponse;
}

export interface UnlockRequest extends WalletMessageBase {
  type: WalletMessageType.UnlockRequest;
  password?: string;
}

export interface UnlockResponse extends WalletMessageBase {
  type: WalletMessageType.UnlockResponse;
}

export interface LockRequest extends WalletMessageBase {
  type: WalletMessageType.LockRequest;
}

export interface LockResponse extends WalletMessageBase {
  type: WalletMessageType.LockResponse;
}

export interface CreateAccountRequest extends WalletMessageBase {
  type: WalletMessageType.CreateAccountRequest;
  walletType: WalletType;
  name?: string;
}

export interface CreateAccountResponse extends WalletMessageBase {
  type: WalletMessageType.CreateAccountResponse;
}

export interface UpdateCurrentAccountRequest extends WalletMessageBase {
  type: WalletMessageType.UpdateCurrentAccountRequest;
  accountPublicKey: string;
}

export interface UpdateCurrentAccountResponse extends WalletMessageBase {
  type: WalletMessageType.UpdateCurrentAccountResponse;
}

export interface RevealPublicKeyRequest extends WalletMessageBase {
  type: WalletMessageType.RevealPublicKeyRequest;
  accountPublicKey: string;
}

export interface RevealPublicKeyResponse extends WalletMessageBase {
  type: WalletMessageType.RevealPublicKeyResponse;
  publicKey: string;
}

export interface RevealViewKeyRequest extends WalletMessageBase {
  type: WalletMessageType.RevealViewKeyRequest;
  accountPublicKey: string;
  password: string;
}

export interface RevealViewKeyResponse extends WalletMessageBase {
  type: WalletMessageType.RevealViewKeyResponse;
  viewKey: string;
}

export interface RevealPrivateKeyRequest extends WalletMessageBase {
  type: WalletMessageType.RevealPrivateKeyRequest;
  accountPublicKey: string;
  password?: string;
}

export interface RevealPrivateKeyResponse extends WalletMessageBase {
  type: WalletMessageType.RevealPrivateKeyResponse;
  privateKey: string;
}

export interface ExportAccountFileRequest extends WalletMessageBase {
  type: WalletMessageType.ExportAccountFileRequest;
  accountPublicKey: string;
  password?: string;
}

export interface ExportAccountFileResponse extends WalletMessageBase {
  type: WalletMessageType.ExportAccountFileResponse;
  accountFileBase64: string;
}

export interface RevealHotKeyRequest extends WalletMessageBase {
  type: WalletMessageType.RevealHotKeyRequest;
  accountPublicKey: string;
  password?: string;
}

export interface RevealHotKeyResponse extends WalletMessageBase {
  type: WalletMessageType.RevealHotKeyResponse;
  keyPairPayload: string;
}

export interface RevealGuardianKeysRequest extends WalletMessageBase {
  type: WalletMessageType.RevealGuardianKeysRequest;
  accountPublicKey: string;
  password?: string;
}

export interface RevealGuardianKeysResponse extends WalletMessageBase {
  type: WalletMessageType.RevealGuardianKeysResponse;
  coldPrivateKey: string;
  coldPublicKey: string;
  hotPublicKey?: string;
}

export interface RemoveSeedPhraseRequest extends WalletMessageBase {
  type: WalletMessageType.RemoveSeedPhraseRequest;
  password?: string;
}
export interface RemoveSeedPhraseResponse extends WalletMessageBase {
  type: WalletMessageType.RemoveSeedPhraseResponse;
}
export interface ProvideRecoverySeedRequest extends WalletMessageBase {
  type: WalletMessageType.ProvideRecoverySeedRequest;
  action: GuardianRecoveryAction;
  transactionId: string;
  mnemonic: string;
}
export interface ProvideRecoverySeedResponse extends WalletMessageBase {
  type: WalletMessageType.ProvideRecoverySeedResponse;
}
export interface PrepareRecoveryRequest extends WalletMessageBase {
  type: WalletMessageType.PrepareRecoveryRequest;
  transactionId: string;
}
/**
 * Result of `prepareRecoveryTransaction`. `ready` is false while the pipeline
 * must wait for the seed prompt. `coldPublicKey` is set when the cold key came
 * from that prompt rather than from the account record, so the pipeline can
 * sign with a key that is stored nowhere.
 */
export interface RecoveryPreparation {
  ready: boolean;
  coldPublicKey?: string;
}
export interface PrepareRecoveryResponse extends WalletMessageBase, RecoveryPreparation {
  type: WalletMessageType.PrepareRecoveryResponse;
}
export interface ReleaseRecoveryRequest extends WalletMessageBase {
  type: WalletMessageType.ReleaseRecoveryRequest;
  transactionId: string;
}
export interface ReleaseRecoveryResponse extends WalletMessageBase {
  type: WalletMessageType.ReleaseRecoveryResponse;
}

export interface RevealMnemonicRequest extends WalletMessageBase {
  type: WalletMessageType.RevealMnemonicRequest;
  password?: string;
}

export interface RevealMnemonicResponse extends WalletMessageBase {
  type: WalletMessageType.RevealMnemonicResponse;
  mnemonic: string;
}

export interface ExportWalletBackupMaterialRequest extends WalletMessageBase {
  type: WalletMessageType.ExportWalletBackupMaterialRequest;
  password?: string;
}

export interface ExportWalletBackupMaterialResponse extends WalletMessageBase {
  type: WalletMessageType.ExportWalletBackupMaterialResponse;
  material: WalletBackupMaterial;
}

export interface RemoveAccountRequest extends WalletMessageBase {
  type: WalletMessageType.RemoveAccountRequest;
  accountPublicKey: string;
  password: string;
}

export interface RemoveAccountResponse extends WalletMessageBase {
  type: WalletMessageType.RemoveAccountResponse;
}

export interface EditAccountRequest extends WalletMessageBase {
  type: WalletMessageType.EditAccountRequest;
  accountPublicKey: string;
  name: string;
}

export interface EditAccountResponse extends WalletMessageBase {
  type: WalletMessageType.EditAccountResponse;
}

export interface ImportAccountRequest extends WalletMessageBase {
  type: WalletMessageType.ImportAccountRequest;
  privateKey: string;
  name?: string;
}

export interface ImportAccountResponse extends WalletMessageBase {
  type: WalletMessageType.ImportAccountResponse;
  accountPublicKey: string;
}

export interface ImportWatchOnlyAccountRequest extends WalletMessageBase {
  type: WalletMessageType.ImportWatchOnlyAccountRequest;
  viewKey: string;
}

export interface ImportWatchOnlyAccountResponse extends WalletMessageBase {
  type: WalletMessageType.ImportWatchOnlyAccountResponse;
}

export interface ImportMnemonicAccountRequest extends WalletMessageBase {
  type: WalletMessageType.ImportMnemonicAccountRequest;
  mnemonic: string;
  password?: string;
  derivationPath?: string;
}

export interface ImportMnemonicAccountResponse extends WalletMessageBase {
  type: WalletMessageType.ImportMnemonicAccountResponse;
}

export interface UpdateSettingsRequest extends WalletMessageBase {
  type: WalletMessageType.UpdateSettingsRequest;
  settings: Partial<WalletSettings>;
}

// TODO: Pull this out somewhere and make it more generalizable
export interface WalletSettings {
  contacts?: WalletContact[];
}

export interface WalletContact {
  address: string;
  name: string;
  /**
   * Destination network a `0x` contact is for (a bridge network id, e.g. `sepolia`). The same
   * `0x` address is valid on every EVM chain, so the contact remembers which one; a Miden address
   * carries its own network and leaves this unset.
   */
  network?: string;
  addedAt?: number;
  accountInWallet?: boolean;
  isPublic?: boolean;
  sharedSecret?: string;
}

export interface UpdateSettingsResponse extends WalletMessageBase {
  type: WalletMessageType.UpdateSettingsResponse;
}

export interface GetSpendingLimitRequest extends WalletMessageBase {
  type: WalletMessageType.GetSpendingLimitRequest;
  accountId: string;
}

export interface GetSpendingLimitResponse extends WalletMessageBase {
  type: WalletMessageType.GetSpendingLimitResponse;
  configuration?: PersistedSpendingLimit;
}

export interface SaveSpendingLimitRequest extends WalletMessageBase {
  type: WalletMessageType.SaveSpendingLimitRequest;
  draft: SerializedSpendingLimitDraft;
  observedRevision?: string;
  strictlyAuthenticated: boolean;
}

export interface SaveSpendingLimitResponse extends WalletMessageBase {
  type: WalletMessageType.SaveSpendingLimitResponse;
  configuration?: PersistedSpendingLimit;
}

export interface SerializedSpend {
  faucetId: string;
  amount: string;
}

export interface AssessSpendingLimitRequest extends WalletMessageBase {
  type: WalletMessageType.AssessSpendingLimitRequest;
  accountId: string;
  spends: SerializedSpend[];
}

export interface AssessSpendingLimitResponse extends WalletMessageBase {
  type: WalletMessageType.AssessSpendingLimitResponse;
  assessment?: SerializedSpendingLimitAssessment;
}

export interface GetStrictAuthenticationProtectorsRequest extends WalletMessageBase {
  type: WalletMessageType.GetStrictAuthenticationProtectorsRequest;
}

export interface GetStrictAuthenticationProtectorsResponse extends WalletMessageBase {
  type: WalletMessageType.GetStrictAuthenticationProtectorsResponse;
  protectors: StrictAuthenticationProtectors;
}

export interface VerifyStrictActionAuthenticationRequest extends WalletMessageBase {
  type: WalletMessageType.VerifyStrictActionAuthenticationRequest;
  credential?: string;
}

export interface VerifyStrictActionAuthenticationResponse extends WalletMessageBase {
  type: WalletMessageType.VerifyStrictActionAuthenticationResponse;
}

export interface SignDataRequest extends WalletMessageBase {
  type: WalletMessageType.SignDataRequest;
  publicKey: string;
  signingInputs: string;
}

export interface SignDataResponse extends WalletMessageBase {
  type: WalletMessageType.SignDataResponse;
  signature: string;
}

export interface SignTransactionRequest extends WalletMessageBase {
  type: WalletMessageType.SignTransactionRequest;
  publicKey: string;
  signingInputs: string;
}

export interface SignTransactionResponse extends WalletMessageBase {
  type: WalletMessageType.SignTransactionResponse;
  signature: string;
}

export interface SignWordRequest extends WalletMessageBase {
  transactionId?: string;
  type: WalletMessageType.SignWordRequest;
  publicKey: string;
  wordHex: string;
}

export interface SignWordResponse extends WalletMessageBase {
  type: WalletMessageType.SignWordResponse;
  signature: string;
}

/**
 * Signing operations for the wallet-derived EVM account. All fields are
 * 0x-hex strings — BigInt-bearing structures are pre-serialized (transaction)
 * or pre-hashed (typed data) on the frontend because BigInt does not survive
 * intercom JSON. The three ops map 1:1 to the viem `toAccount` CustomSource
 * callbacks that back the frontend WalletClient.
 */
export type SignEvmOperation =
  | { op: 'transaction'; serializedTransaction: `0x${string}` }
  | { op: 'typed-data'; digest: `0x${string}` }
  | { op: 'message'; messageHex: `0x${string}` };

export interface SignEvmRequest extends WalletMessageBase {
  type: WalletMessageType.SignEvmRequest;
  /** Miden bech32 WalletAccount.publicKey selecting whose EVM key signs. */
  accountPublicKey: string;
  operation: SignEvmOperation;
}

export interface SignEvmResponse extends WalletMessageBase {
  type: WalletMessageType.SignEvmResponse;
  /** Signed serialized tx (op 'transaction') or 65-byte signature hex. */
  result: `0x${string}`;
}

export interface PersistNewHotKeyRequest extends WalletMessageBase {
  type: WalletMessageType.PersistNewHotKeyRequest;
  newHotPubKey: string;
  newHotCiphertext: string;
}

export interface PersistNewHotKeyResponse extends WalletMessageBase {
  type: WalletMessageType.PersistNewHotKeyResponse;
}

export interface SwapHotKeyRequest extends WalletMessageBase {
  type: WalletMessageType.SwapHotKeyRequest;
  accountPublicKey: string;
  newHotPubKey: string;
}

export interface SwapHotKeyResponse extends WalletMessageBase {
  type: WalletMessageType.SwapHotKeyResponse;
}

export interface SetGuardianEndpointRequest extends WalletMessageBase {
  type: WalletMessageType.SetGuardianEndpointRequest;
  accountPublicKey: string;
  guardianEndpoint: string;
}

export interface SetGuardianEndpointResponse extends WalletMessageBase {
  type: WalletMessageType.SetGuardianEndpointResponse;
}

export interface SetGuardianOperatorCommitmentRequest extends WalletMessageBase {
  type: WalletMessageType.SetGuardianOperatorCommitmentRequest;
  accountPublicKey: string;
  guardianOperatorCommitment: string;
}

export interface SetGuardianOperatorCommitmentResponse extends WalletMessageBase {
  type: WalletMessageType.SetGuardianOperatorCommitmentResponse;
}

export interface SetGuardianSyncStatusRequest extends WalletMessageBase {
  type: WalletMessageType.SetGuardianSyncStatusRequest;
  accountPublicKey: string;
  guardianSyncStatus: GuardianSyncStatus;
}

export interface SetGuardianSyncStatusResponse extends WalletMessageBase {
  type: WalletMessageType.SetGuardianSyncStatusResponse;
}

export interface CheckGuardianDriftRequest extends WalletMessageBase {
  type: WalletMessageType.CheckGuardianDriftRequest;
  accountPublicKey: string;
}

export interface CheckGuardianDriftResponse extends WalletMessageBase {
  type: WalletMessageType.CheckGuardianDriftResponse;
  guardianSyncStatus: GuardianSyncStatus;
}

export interface ApplyUserGuardianEndpointRequest extends WalletMessageBase {
  type: WalletMessageType.ApplyUserGuardianEndpointRequest;
  accountPublicKey: string;
  guardianEndpoint: string;
}

/**
 * Why applying a user-typed guardian endpoint did or did not stick.
 *
 * Not a boolean, because the banner that offers this repair accuses the URL
 * the user typed when it fails, and only `'mismatch'` is evidence against it.
 * `'unreachable'` (no answer, or an answer carrying no commitment) is a fact
 * about the network, not about the URL.
 */
export type ApplyUserEndpointOutcome = 'applied' | 'mismatch' | 'unreachable' | 'no-onchain-guardian';

export interface ApplyUserGuardianEndpointResponse extends WalletMessageBase {
  type: WalletMessageType.ApplyUserGuardianEndpointResponse;
  outcome: ApplyUserEndpointOutcome;
}

export interface StartGuardianRecoveryRequest extends WalletMessageBase {
  type: WalletMessageType.StartGuardianRecoveryRequest;
  accountPublicKey: string;
}

export interface StartGuardianRecoveryResponse extends WalletMessageBase {
  type: WalletMessageType.StartGuardianRecoveryResponse;
  started: boolean;
}

export interface GetPublicKeyForCommitmentRequest extends WalletMessageBase {
  type: WalletMessageType.GetPublicKeyForCommitmentRequest;
  commitment: string;
}

export interface GetPublicKeyForCommitmentResponse extends WalletMessageBase {
  type: WalletMessageType.GetPublicKeyForCommitmentResponse;
  publicKey: string;
}

export interface GetAuthSecretKeyRequest extends WalletMessageBase {
  type: WalletMessageType.GetAuthSecretKeyRequest;
  key: string;
}

export interface GetAuthSecretKeyResponse extends WalletMessageBase {
  type: WalletMessageType.GetAuthSecretKeyResponse;
  key: string;
}

export interface ConfirmationRequest extends WalletMessageBase {
  type: WalletMessageType.ConfirmationRequest;
  id: string;
  confirmed: boolean;
  modifiedTotalFee?: number;
  modifiedStorageLimit?: number;
}

export interface ConfirmationResponse extends WalletMessageBase {
  type: WalletMessageType.ConfirmationResponse;
}

export interface PageRequest extends WalletMessageBase {
  type: WalletMessageType.PageRequest;
  origin: string;
  payload: any;
  beacon?: boolean;
  encrypted?: boolean;
}

export interface PageResponse extends WalletMessageBase {
  type: WalletMessageType.PageResponse;
  payload: any;
  encrypted?: boolean;
}

export interface DAppGetPayloadRequest extends WalletMessageBase {
  type: WalletMessageType.DAppGetPayloadRequest;
  id: string;
}

export interface DAppGetPayloadResponse<T> extends WalletMessageBase {
  type: WalletMessageType.DAppGetPayloadResponse;
  payload: T;
}

export interface DAppPermConfirmationRequest extends WalletMessageBase {
  type: WalletMessageType.DAppPermConfirmationRequest;
  id: string;
  confirmed: boolean;
  accountPublicKey: string;
}

export interface DAppPermConfirmationResponse extends WalletMessageBase {
  type: WalletMessageType.DAppPermConfirmationResponse;
  viewKey?: string;
}

export interface DAppSignConfirmationRequest extends WalletMessageBase {
  type: WalletMessageType.DAppSignConfirmationRequest;
  id: string;
  confirmed: boolean;
}

export interface DAppSignConfirmationResponse extends WalletMessageBase {
  type: WalletMessageType.DAppSignConfirmationResponse;
}

export interface DAppDecryptConfirmationRequest extends WalletMessageBase {
  type: WalletMessageType.DAppDecryptConfirmationRequest;
  id: string;
  confirmed: boolean;
}

export interface DAppDecryptConfirmationResponse extends WalletMessageBase {
  type: WalletMessageType.DAppDecryptConfirmationResponse;
}

export interface DAppRecordsConfirmationRequest extends WalletMessageBase {
  type: WalletMessageType.DAppRecordsConfirmationRequest;
  id: string;
  confirmed: boolean;
}

export interface DAppRecordsConfirmationResponse extends WalletMessageBase {
  type: WalletMessageType.DAppRecordsConfirmationResponse;
}

export interface DAppTransactionConfirmationRequest extends WalletMessageBase {
  type: WalletMessageType.DAppTransactionConfirmationRequest;
  id: string;
  confirmed: boolean;
  delegate: boolean;
}

export interface DAppTransactionConfirmationResponse extends WalletMessageBase {
  type: WalletMessageType.DAppTransactionConfirmationResponse;
}

export interface DAppBulkTransactionsConfirmationRequest extends WalletMessageBase {
  type: WalletMessageType.DAppBulkTransactionsConfirmationRequest;
  id: string;
  confirmed: boolean;
  delegate: boolean;
}

export interface DAppBulkTransactionsConfirmationResponse extends WalletMessageBase {
  type: WalletMessageType.DAppBulkTransactionsConfirmationResponse;
}

export interface DAppDeployConfirmationRequest extends WalletMessageBase {
  type: WalletMessageType.DAppDeployConfirmationRequest;
  id: string;
  confirmed: boolean;
  delegate: boolean;
}

export interface DAppDeployConfirmationResponse extends WalletMessageBase {
  type: WalletMessageType.DAppDeployConfirmationResponse;
}

export interface GetAllDAppSessionsRequest extends WalletMessageBase {
  type: WalletMessageType.DAppGetAllSessionsRequest;
}

export interface GetAllDAppSessionsResponse<T> extends WalletMessageBase {
  type: WalletMessageType.DAppGetAllSessionsResponse;
  sessions: T;
}

export interface RemoveDAppSessionRequest extends WalletMessageBase {
  type: WalletMessageType.DAppRemoveSessionRequest;
  origin: string;
}

export interface RemoveDAppSessionResponse<T> extends WalletMessageBase {
  type: WalletMessageType.DAppRemoveSessionResponse;
  sessions: T;
}

export interface DecryptCiphertextsRequest extends WalletMessageBase {
  type: WalletMessageType.DecryptCiphertextsRequest;
  accPublicKey: string;
  ciphertexts: string[];
}

export interface DecryptCiphertextsResponse extends WalletMessageBase {
  type: WalletMessageType.DecryptCiphertextsResponse;
  texts: { ciphertext: string; plaintext: string }[];
}

export interface GetOwnedRecordsRequest extends WalletMessageBase {
  type: WalletMessageType.GetOwnedRecordsRequest;
  accPublicKey: string;
}

export interface GetOwnedRecordsResponse extends WalletMessageBase {
  type: WalletMessageType.GetOwnedRecordsResponse;
}

export interface ImportFromClientRequest extends WalletMessageBase {
  type: WalletMessageType.ImportFromClientRequest;
  password?: string; // Optional for hardware-only wallets (mobile/desktop with Secure Enclave)
  mnemonic: string;
  walletAccounts: WalletAccount[];
  formatVersion?: number;
  importedAccounts?: ImportedAccountBackup[];
}

export interface ImportFromClientResponse extends WalletMessageBase {
  type: WalletMessageType.ImportFromClientResponse;
}

export enum WalletStatus {
  Idle,
  Locked,
  Ready
}

export type WalletRequest =
  | MidenRequest
  | AcknowledgeRequest
  | GetStateRequest
  | NewWalletRequest
  | NewWalletFromHotKeyRequest
  | UnlockRequest
  | LockRequest
  | CreateAccountRequest
  | UpdateCurrentAccountRequest
  | RevealPublicKeyRequest
  | RevealViewKeyRequest
  | RevealPrivateKeyRequest
  | ExportAccountFileRequest
  | RevealHotKeyRequest
  | RevealGuardianKeysRequest
  | RemoveSeedPhraseRequest
  | ProvideRecoverySeedRequest
  | PrepareRecoveryRequest
  | ReleaseRecoveryRequest
  | RevealMnemonicRequest
  | ExportWalletBackupMaterialRequest
  | RemoveAccountRequest
  | EditAccountRequest
  | ImportAccountRequest
  | ImportWatchOnlyAccountRequest
  | ImportMnemonicAccountRequest
  | ConfirmationRequest
  | UpdateSettingsRequest
  | GetSpendingLimitRequest
  | SaveSpendingLimitRequest
  | AssessSpendingLimitRequest
  | GetStrictAuthenticationProtectorsRequest
  | VerifyStrictActionAuthenticationRequest
  | SignDataRequest
  | SignTransactionRequest
  | SignWordRequest
  | SignEvmRequest
  | PersistNewHotKeyRequest
  | SwapHotKeyRequest
  | SetGuardianEndpointRequest
  | SetGuardianOperatorCommitmentRequest
  | SetGuardianSyncStatusRequest
  | CheckGuardianDriftRequest
  | ApplyUserGuardianEndpointRequest
  | StartGuardianRecoveryRequest
  | GetPublicKeyForCommitmentRequest
  | GetAuthSecretKeyRequest
  | PageRequest
  | DAppGetPayloadRequest
  | DAppPermConfirmationRequest
  | DAppSignConfirmationRequest
  | DAppDecryptConfirmationRequest
  | DAppRecordsConfirmationRequest
  | DAppTransactionConfirmationRequest
  | DAppBulkTransactionsConfirmationRequest
  | DAppDeployConfirmationRequest
  | GetAllDAppSessionsRequest
  | RemoveDAppSessionRequest
  | DecryptCiphertextsRequest
  | GetOwnedRecordsRequest
  | ImportFromClientRequest
  | SyncRequest
  | NoteClaimStarted
  | ProcessTransactionsRequest
  | ReloadEndpointOverridesRequest
  | ImportNoteBytesRequest
  | RetryDeadletteredNotesRequest
  | ExportNoteRequest
  | GetInputNoteDetailsRequest
  | ReportTelemetryEventRequest;

export type WalletResponse =
  | MidenResponse
  | AcknowledgeResponse
  | LoadingResponse
  | GetStateResponse
  | NewWalletResponse
  | NewWalletFromHotKeyResponse
  | UnlockResponse
  | LockResponse
  | CreateAccountResponse
  | UpdateCurrentAccountResponse
  | RevealPublicKeyResponse
  | RevealViewKeyResponse
  | RevealPrivateKeyResponse
  | ExportAccountFileResponse
  | RevealHotKeyResponse
  | RevealGuardianKeysResponse
  | RemoveSeedPhraseResponse
  | ProvideRecoverySeedResponse
  | PrepareRecoveryResponse
  | ReleaseRecoveryResponse
  | RevealMnemonicResponse
  | ExportWalletBackupMaterialResponse
  | RemoveAccountResponse
  | EditAccountResponse
  | ImportAccountResponse
  | ImportWatchOnlyAccountResponse
  | ImportMnemonicAccountResponse
  | ConfirmationResponse
  | UpdateSettingsResponse
  | GetSpendingLimitResponse
  | SaveSpendingLimitResponse
  | AssessSpendingLimitResponse
  | GetStrictAuthenticationProtectorsResponse
  | VerifyStrictActionAuthenticationResponse
  | SignDataResponse
  | SignTransactionResponse
  | SignWordResponse
  | SignEvmResponse
  | PersistNewHotKeyResponse
  | SwapHotKeyResponse
  | SetGuardianEndpointResponse
  | SetGuardianOperatorCommitmentResponse
  | SetGuardianSyncStatusResponse
  | CheckGuardianDriftResponse
  | ApplyUserGuardianEndpointResponse
  | StartGuardianRecoveryResponse
  | GetPublicKeyForCommitmentResponse
  | GetAuthSecretKeyResponse
  | PageResponse
  //   | DAppGetPayloadResponse
  | DAppPermConfirmationResponse
  | DAppSignConfirmationResponse
  | DAppDecryptConfirmationResponse
  | DAppRecordsConfirmationResponse
  | DAppTransactionConfirmationResponse
  | DAppBulkTransactionsConfirmationResponse
  | DAppDeployConfirmationResponse
  //   | GetAllDAppSessionsResponse
  // | RemoveDAppSessionResponse
  | DecryptCiphertextsResponse
  | GetOwnedRecordsResponse
  | ImportFromClientResponse
  | SyncResponse
  | NoteClaimStartedResponse
  | ProcessTransactionsResponse
  | ReloadEndpointOverridesResponse
  | ImportNoteBytesResponse
  | RetryDeadletteredNotesResponse
  | ExportNoteResponse
  | GetInputNoteDetailsResponse
  | ReportTelemetryEventResponse;
