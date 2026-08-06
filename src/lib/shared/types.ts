import { MidenMessageType, MidenRequest, MidenResponse } from 'lib/miden/types';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { WalletType } from 'screens/onboarding/types';

import {
  SendPageEventRequest,
  SendPageEventResponse,
  SendPerformanceEventRequest,
  SendPerformanceEventResponse,
  SendTrackEventRequest,
  SendTrackEventResponse
} from './analytics-types';

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
  ImportFromClientRequest = 'IMPORT_FROM_CLIENT_REQUEST',
  ImportFromClientResponse = 'IMPORT_FROM_CLIENT_RESPONSE',
  UnlockRequest = 'UNLOCK_REQUEST',
  UnlockResponse = 'UNLOCK_RESPONSE',
  ReauthenticateRequest = 'REAUTHENTICATE_REQUEST',
  ReauthenticateResponse = 'REAUTHENTICATE_RESPONSE',
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
  RevealHotKeyRequest = 'REVEAL_HOT_KEY_REQUEST',
  RevealHotKeyResponse = 'REVEAL_HOT_KEY_RESPONSE',
  RevealGuardianKeysRequest = 'REVEAL_GUARDIAN_KEYS_REQUEST',
  RevealGuardianKeysResponse = 'REVEAL_GUARDIAN_KEYS_RESPONSE',
  RevealMnemonicRequest = 'REVEAL_MNEMONIC_REQUEST',
  RevealMnemonicResponse = 'REVEAL_MNEMONIC_RESPONSE',
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
  SendTrackEventRequest = 'SEND_TRACK_EVENT_REQUEST',
  SendTrackEventResponse = 'SEND_TRACK_EVENT_RESPONSE',
  SendPageEventRequest = 'SEND_PAGE_EVENT_REQUEST',
  SendPageEventResponse = 'SEND_PAGE_EVENT_RESPONSE',
  SendPerformanceEventRequest = 'SEND_PROOF_GENERATION_EVENT_REQUEST',
  SendPerformanceEventResponse = 'SEND_PROOF_GENERATION_EVENT_RESPONSE',
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
  // Note operations (popup → SW)
  ImportNoteBytesRequest = 'IMPORT_NOTE_BYTES_REQUEST',
  ImportNoteBytesResponse = 'IMPORT_NOTE_BYTES_RESPONSE',
  ExportNoteRequest = 'EXPORT_NOTE_REQUEST',
  ExportNoteResponse = 'EXPORT_NOTE_RESPONSE',
  GetInputNoteDetailsRequest = 'GET_INPUT_NOTE_DETAILS_REQUEST',
  GetInputNoteDetailsResponse = 'GET_INPUT_NOTE_DETAILS_RESPONSE',
  // Speculative pre-prove (popup → SW): kicked off when the review screen
  // mounts so prove runs in parallel with the user reading the review;
  // invalidated on review-screen unmount or if form params change.
  // See lib/miden/back/speculation-manager.ts.
  SpeculateSendRequest = 'SPECULATE_SEND_REQUEST',
  SpeculateSendResponse = 'SPECULATE_SEND_RESPONSE',
  SpeculateInvalidate = 'SPECULATE_INVALIDATE',
  SpeculateInvalidateResponse = 'SPECULATE_INVALIDATE_RESPONSE'
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
  };
}

export interface SyncData {
  notes: SerializedConsumableNote[];
  vaultAssets: SerializedVaultAsset[];
  accountPublicKey: string;
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

export interface ImportNoteBytesRequest extends WalletMessageBase {
  type: WalletMessageType.ImportNoteBytesRequest;
  noteBytes: string; // base64 encoded
}

export interface ImportNoteBytesResponse extends WalletMessageBase {
  type: WalletMessageType.ImportNoteBytesResponse;
  noteId: string;
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

/**
 * Pre-prove the user's in-flight send transaction with the params currently
 * showing on the review screen. Fire-and-forget from the popup; the SW kicks
 * off execute + offscreen prove and caches the {txResult, proven} bytes
 * keyed by params hash. When the user clicks Confirm, the existing send
 * pipeline (initiateSendTransaction → SW processor) hits the cache via
 * MidenClientInterface.proveLocallyViaOffscreen and skips the prove step.
 *
 * Params shape mirrors what the wallet's SendTransaction DB record holds.
 * Skipping speculation when `recallBlocks` is set — block-height drift
 * between speculate-time and commit-time would invalidate the cached
 * reclaim height, easier to skip than handle.
 */
export interface SpeculateSendRequest extends WalletMessageBase {
  type: WalletMessageType.SpeculateSendRequest;
  accountId: string;
  recipientAccountId: string;
  faucetId: string;
  noteType: 'public' | 'private';
  amount: string; // bigint as string (postMessage-safe)
}

export interface SpeculateSendResponse extends WalletMessageBase {
  type: WalletMessageType.SpeculateSendResponse;
}

export interface SpeculateInvalidate extends WalletMessageBase {
  type: WalletMessageType.SpeculateInvalidate;
}

export interface SpeculateInvalidateResponse extends WalletMessageBase {
  type: WalletMessageType.SpeculateInvalidateResponse;
}

export interface GetInputNoteDetailsResponse extends WalletMessageBase {
  type: WalletMessageType.GetInputNoteDetailsResponse;
  notes: SerializedInputNoteDetail[];
}

export interface GetStateRequest extends WalletMessageBase {
  type: WalletMessageType.GetStateRequest;
  // TODO: Add an enum param here for determining "which wallet" i.e. Aleo vs Miden
}

export interface GetStateResponse extends WalletMessageBase {
  type: WalletMessageType.GetStateResponse;
  state: WalletState;
}

// TODO: Make generalizable and pull out somewhere
export interface WalletState {
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
   * Guardian operator endpoint this account is registered with. Set at create /
   * recovery time and updated when the user switches guardians. Per-account so
   * multiple Guardian accounts can live on different operators — absence means a
   * record created before this field existed, in which case consumers fall back
   * to the legacy global `GUARDIAN_URL_STORAGE_KEY` (see `resolveGuardianEndpoint`).
   * Non-Guardian accounts leave this undefined.
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
}

export interface NewWalletResponse extends WalletMessageBase {
  type: WalletMessageType.NewWalletResponse;
}

export interface UnlockRequest extends WalletMessageBase {
  type: WalletMessageType.UnlockRequest;
  password?: string;
}

export interface UnlockResponse extends WalletMessageBase {
  type: WalletMessageType.UnlockResponse;
}

export interface ReauthenticateRequest extends WalletMessageBase {
  type: WalletMessageType.ReauthenticateRequest;
  /** Omit only for a hardware-protected vault; a supplied string verifies the password/passcode protector. */
  password?: string;
}

export interface ReauthenticateResponse extends WalletMessageBase {
  type: WalletMessageType.ReauthenticateResponse;
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

export interface RevealHotKeyRequest extends WalletMessageBase {
  type: WalletMessageType.RevealHotKeyRequest;
  accountPublicKey: string;
  password?: string;
}

export interface RevealHotKeyResponse extends WalletMessageBase {
  type: WalletMessageType.RevealHotKeyResponse;
  hotPrivateKey: string;
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

export interface RevealMnemonicRequest extends WalletMessageBase {
  type: WalletMessageType.RevealMnemonicRequest;
  password?: string;
}

export interface RevealMnemonicResponse extends WalletMessageBase {
  type: WalletMessageType.RevealMnemonicResponse;
  mnemonic: string;
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
  addedAt?: number;
  accountInWallet?: boolean;
  isPublic?: boolean;
  sharedSecret?: string;
}

export interface UpdateSettingsResponse extends WalletMessageBase {
  type: WalletMessageType.UpdateSettingsResponse;
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

export interface ApplyUserGuardianEndpointResponse extends WalletMessageBase {
  type: WalletMessageType.ApplyUserGuardianEndpointResponse;
  applied: boolean;
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
  | UnlockRequest
  | ReauthenticateRequest
  | LockRequest
  | CreateAccountRequest
  | UpdateCurrentAccountRequest
  | RevealPublicKeyRequest
  | RevealViewKeyRequest
  | RevealPrivateKeyRequest
  | RevealHotKeyRequest
  | RevealGuardianKeysRequest
  | RevealMnemonicRequest
  | RemoveAccountRequest
  | EditAccountRequest
  | ImportAccountRequest
  | ImportWatchOnlyAccountRequest
  | ImportMnemonicAccountRequest
  | ConfirmationRequest
  | UpdateSettingsRequest
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
  | SendTrackEventRequest
  | SendPageEventRequest
  | SendPerformanceEventRequest
  | DecryptCiphertextsRequest
  | GetOwnedRecordsRequest
  | ImportFromClientRequest
  | SyncRequest
  | NoteClaimStarted
  | ProcessTransactionsRequest
  | ImportNoteBytesRequest
  | ExportNoteRequest
  | GetInputNoteDetailsRequest
  | SpeculateSendRequest
  | SpeculateInvalidate;

export type WalletResponse =
  | MidenResponse
  | AcknowledgeResponse
  | LoadingResponse
  | GetStateResponse
  | NewWalletResponse
  | UnlockResponse
  | ReauthenticateResponse
  | LockResponse
  | CreateAccountResponse
  | UpdateCurrentAccountResponse
  | RevealPublicKeyResponse
  | RevealViewKeyResponse
  | RevealPrivateKeyResponse
  | RevealHotKeyResponse
  | RevealGuardianKeysResponse
  | RevealMnemonicResponse
  | RemoveAccountResponse
  | EditAccountResponse
  | ImportAccountResponse
  | ImportWatchOnlyAccountResponse
  | ImportMnemonicAccountResponse
  | ConfirmationResponse
  | UpdateSettingsResponse
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
  | SendTrackEventResponse
  | SendPageEventResponse
  | SendPerformanceEventResponse
  | DecryptCiphertextsResponse
  | GetOwnedRecordsResponse
  | ImportFromClientResponse
  | SyncResponse
  | NoteClaimStartedResponse
  | ProcessTransactionsResponse
  | ImportNoteBytesResponse
  | ExportNoteResponse
  | GetInputNoteDetailsResponse
  | SpeculateSendResponse
  | SpeculateInvalidateResponse;
