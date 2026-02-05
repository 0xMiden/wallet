import { AllowedPrivateData, PrivateDataPermission, SignKind } from '@demox-labs/miden-wallet-adapter-base';

import { MidenDAppMetadata } from 'lib/adapter/types';
import { ReadyWalletState, WalletMessageBase, WalletNetwork, WalletState } from 'lib/shared/types';

export interface MidenState extends WalletState {
  networks: MidenNetwork[];
}

export interface ReadyMidenState extends ReadyWalletState {}

export interface MidenNetwork extends WalletNetwork {}

export enum NoteTypeEnum {
  Public = 'public',
  Private = 'private'
}

export type NoteType = NoteTypeEnum.Public | NoteTypeEnum.Private;

export interface ExportedNote {
  noteId: string;
  noteBytes: Uint8Array;
}

export interface ConsumableNote {
  id: string;
  faucetId: string;
  amount: string;
  senderAddress: string;
  isBeingClaimed: boolean;
  type: NoteType | 'unknown';
}

export enum MidenSharedStorageKey {
  DAppEnabled = 'DAppEnabled',
  PasswordAttempts = 'PasswordAttempts',
  TimeLock = 'TimeLock'
}

export interface MidenDAppSession {
  network: string; // TODO: replace with MidenChainId
  appMeta: MidenDAppMetadata;
  accountId: string;
  privateDataPermission: PrivateDataPermission;
  allowedPrivateData: AllowedPrivateData;
  publicKey: string;
}

export type MidenDAppSessions = Record<string, MidenDAppSession[]>;

/**
 * DApp confirmation payloads
 */

export type DappMetadata = MidenDAppMetadata & {
  icon?: string;
};

export interface MidenDAppPayloadBase {
  type: string;
  origin: string;
  networkRpc: string;
  appMeta: DappMetadata;
  error?: any;
}

export interface MidenDAppConnectPayload extends MidenDAppPayloadBase {
  type: 'connect';
  privateDataPermission: PrivateDataPermission;
  existingPermission: boolean;
  allowedPrivateData: AllowedPrivateData;
}

export interface MidenDAppTransactionPayload extends MidenDAppPayloadBase {
  type: 'transaction';
  sourcePublicKey: string;
  preview: any;
  transactionMessages: string[];
}

export interface MidenDAppConsumePayload extends MidenDAppPayloadBase {
  type: 'consume';
  sourcePublicKey: string;
  transactionMessages: string[];
  noteId: string;
}

export interface MidenDAppPrivateNotesPayload extends MidenDAppPayloadBase {
  type: 'privateNotes';
  sourcePublicKey: string;
  privateNotes: any[];
  preview: any;
}

export interface MidenDAppSignPayload extends MidenDAppPayloadBase {
  type: 'sign';
  sourcePublicKey: string;
  payload: string;
  preview: any;
  kind: SignKind;
}

export interface MidenDAppAssetsPayload extends MidenDAppPayloadBase {
  type: 'assets';
  sourcePublicKey: string;
  assets: any[];
  preview: any;
}

export interface MidenDAppImportPrivateNotePayload extends MidenDAppPayloadBase {
  type: 'importPrivateNote';
  sourcePublicKey: string;
  note: string;
  preview: any;
}

export interface MidenDAppConsumableNotesPayload extends MidenDAppPayloadBase {
  type: 'consumableNotes';
  sourcePublicKey: string;
  consumableNotes: any[];
  preview: any;
}

export type MidenDAppPayload =
  | MidenDAppConnectPayload
  | MidenDAppTransactionPayload
  | MidenDAppConsumePayload
  | MidenDAppPrivateNotesPayload
  | MidenDAppSignPayload
  | MidenDAppAssetsPayload
  | MidenDAppImportPrivateNotePayload
  | MidenDAppConsumableNotesPayload;

/**
 * Messages
 */
export enum MidenMessageType {
  PageRequest = 'MIDEN_PAGE_REQUEST',
  PageResponse = 'MIDEN_PAGE_RESPONSE',
  DAppGetPayloadRequest = 'MIDEN_DAPP_GET_PAYLOAD_REQUEST',
  DAppGetPayloadResponse = 'MIDEN_DAPP_GET_PAYLOAD_RESPONSE',
  DAppPermConfirmationRequest = 'MIDEN_DAPP_PERM_CONFIRMATION_REQUEST',
  DAppPermConfirmationResponse = 'MIDEN_DAPP_PERM_CONFIRMATION_RESPONSE',
  DAppTransactionConfirmationRequest = 'MIDEN_DAPP_TRANSACTION_CONFIRMATION_REQUEST',
  DAppTransactionConfirmationResponse = 'MIDEN_DAPP_TRANSACTION_CONFIRMATION_RESPONSE',
  DAppConsumeConfirmationRequest = 'MIDEN_DAPP_CONSUME_CONFIRMATION_REQUEST',
  DAppConsumeConfirmationResponse = 'MIDEN_DAPP_CONSUME_CONFIRMATION_RESPONSE',
  DAppGetAllSessionsRequest = 'MIDEN_DAPP_GET_ALL_SESSIONS_REQUEST',
  DAppGetAllSessionsResponse = 'MIDEN_DAPP_GET_ALL_SESSIONS_RESPONSE',
  DAppRemoveSessionRequest = 'MIDEN_DAPP_REMOVE_SESSION_REQUEST',
  DAppRemoveSessionResponse = 'MIDEN_DAPP_REMOVE_SESSION_RESPONSE',
  DAppPrivateNotesConfirmationRequest = 'MIDEN_DAPP_PRIVATE_NOTES_CONFIRMATION_REQUEST',
  DAppPrivateNotesConfirmationResponse = 'MIDEN_DAPP_PRIVATE_NOTES_CONFIRMATION_RESPONSE',
  DAppSignConfirmationRequest = 'MIDEN_DAPP_SIGN_CONFIRMATION_REQUEST',
  DAppSignConfirmationResponse = 'MIDEN_DAPP_SIGN_CONFIRMATION_RESPONSE',
  DAppAssetsConfirmationRequest = 'MIDEN_DAPP_ASSETS_CONFIRMATION_REQUEST',
  DAppAssetsConfirmationResponse = 'MIDEN_DAPP_ASSETS_CONFIRMATION_RESPONSE',
  DAppImportPrivateNoteConfirmationRequest = 'MIDEN_DAPP_IMPORT_PRIVATE_NOTE_CONFIRMATION_REQUEST',
  DAppImportPrivateNoteConfirmationResponse = 'MIDEN_DAPP_IMPORT_PRIVATE_NOTE_CONFIRMATION_RESPONSE',
  DAppConsumableNotesConfirmationRequest = 'MIDEN_DAPP_CONSUMABLE_NOTES_CONFIRMATION_REQUEST',
  DAppConsumableNotesConfirmationResponse = 'MIDEN_DAPP_CONSUMABLE_NOTES_CONFIRMATION_RESPONSE'
}

export type MidenRequest =
  | MidenPageRequest
  | MidenDAppGetPayloadRequest
  | MidenDAppPermConfirmationRequest
  | MidenDAppTransactionConfirmationRequest
  | MidenDAppConsumeConfirmationRequest
  | MidenGetAllDAppSessionsRequest
  | MidenRemoveDAppSessionRequest
  | MidenDAppPrivateNotesConfirmationRequest
  | MidenDAppSignConfirmationRequest
  | MidenDAppAssetsConfirmationRequest
  | MidenDAppImportPrivateNoteConfirmationRequest
  | MidenDAppConsumableNotesConfirmationRequest;

export type MidenResponse =
  | MidenPageResponse
  | MidenDAppGetPayloadResponse
  | MidenDAppPermConfirmationResponse
  | MidenDAppTransactionConfirmationResponse
  | MidenDAppconsumeConfirmationResponse
  | MidenGetAllDAppSessionsResponse
  | MidenRemoveDAppSessionResponse
  | MidenDAppPrivateNotesConfirmationResponse
  | MidenDAppSignConfirmationResponse
  | MidenDAppAssetsConfirmationResponse
  | MidenDAppImportPrivateNoteConfirmationResponse
  | MidenDAppConsumableNotesConfirmationResponse;

export interface MidenPageRequest extends WalletMessageBase {
  type: MidenMessageType.PageRequest;
  origin: string;
  payload: any;
  beacon?: boolean;
  encrypted?: boolean;
}

export interface MidenPageResponse extends WalletMessageBase {
  type: MidenMessageType.PageResponse;
  payload: any;
  encrypted?: boolean;
}

export interface MidenDAppGetPayloadRequest extends WalletMessageBase {
  type: MidenMessageType.DAppGetPayloadRequest;
  id: string;
}

export interface MidenDAppGetPayloadResponse extends WalletMessageBase {
  type: MidenMessageType.DAppGetPayloadResponse;
  payload: MidenDAppPayload;
  privateDataPermission: PrivateDataPermission;
}

export interface MidenDAppPermConfirmationRequest extends WalletMessageBase {
  type: MidenMessageType.DAppPermConfirmationRequest;
  id: string;
  confirmed: boolean;
  accountPublicKey: string;
  privateDataPermission: PrivateDataPermission;
  allowedPrivateData: AllowedPrivateData;
}

export interface MidenDAppPermConfirmationResponse extends WalletMessageBase {
  type: MidenMessageType.DAppPermConfirmationResponse;
  viewKey?: string;
}

export interface MidenDAppTransactionConfirmationRequest extends WalletMessageBase {
  type: MidenMessageType.DAppTransactionConfirmationRequest;
  id: string;
  confirmed: boolean;
  delegate: boolean;
}

export interface MidenDAppTransactionConfirmationResponse extends WalletMessageBase {
  type: MidenMessageType.DAppTransactionConfirmationResponse;
}

export interface MidenDAppConsumeConfirmationRequest extends WalletMessageBase {
  type: MidenMessageType.DAppConsumeConfirmationRequest;
}

export interface MidenDAppconsumeConfirmationResponse extends WalletMessageBase {
  type: MidenMessageType.DAppConsumeConfirmationResponse;
}

export interface MidenGetAllDAppSessionsRequest extends WalletMessageBase {
  type: MidenMessageType.DAppGetAllSessionsRequest;
}

export interface MidenGetAllDAppSessionsResponse extends WalletMessageBase {
  type: MidenMessageType.DAppGetAllSessionsResponse;
  sessions: MidenDAppSessions;
}

export interface MidenRemoveDAppSessionRequest extends WalletMessageBase {
  type: MidenMessageType.DAppRemoveSessionRequest;
  origin: string;
}

export interface MidenRemoveDAppSessionResponse extends WalletMessageBase {
  type: MidenMessageType.DAppRemoveSessionResponse;
  sessions: MidenDAppSessions;
}

export interface MidenDAppPrivateNotesConfirmationRequest extends WalletMessageBase {
  type: MidenMessageType.DAppPrivateNotesConfirmationRequest;
  id: string;
  confirmed: boolean;
}

export interface MidenDAppPrivateNotesConfirmationResponse extends WalletMessageBase {
  type: MidenMessageType.DAppPrivateNotesConfirmationResponse;
}

export interface MidenDAppSignConfirmationRequest extends WalletMessageBase {
  type: MidenMessageType.DAppSignConfirmationRequest;
  id: string;
  confirmed: boolean;
}

export interface MidenDAppSignConfirmationResponse extends WalletMessageBase {
  type: MidenMessageType.DAppSignConfirmationResponse;
  signature: string;
}

export interface MidenDAppAssetsConfirmationRequest extends WalletMessageBase {
  type: MidenMessageType.DAppAssetsConfirmationRequest;
  id: string;
  confirmed: boolean;
}

export interface MidenDAppAssetsConfirmationResponse extends WalletMessageBase {
  type: MidenMessageType.DAppAssetsConfirmationResponse;
}

export interface MidenDAppImportPrivateNoteConfirmationRequest extends WalletMessageBase {
  type: MidenMessageType.DAppImportPrivateNoteConfirmationRequest;
  id: string;
  confirmed: boolean;
}

export interface MidenDAppImportPrivateNoteConfirmationResponse extends WalletMessageBase {
  type: MidenMessageType.DAppImportPrivateNoteConfirmationResponse;
}

export interface MidenDAppConsumableNotesConfirmationRequest extends WalletMessageBase {
  type: MidenMessageType.DAppConsumableNotesConfirmationRequest;
  id: string;
  confirmed: boolean;
}

export interface MidenDAppConsumableNotesConfirmationResponse extends WalletMessageBase {
  type: MidenMessageType.DAppConsumableNotesConfirmationResponse;
}
