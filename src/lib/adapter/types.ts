import {
  AllowedPrivateData,
  Asset,
  InputNoteDetails,
  MidenConsumeTransaction,
  MidenSendTransaction,
  MidenTransaction,
  PrivateDataPermission,
  SignKind,
  WalletAdapterNetwork
} from '@demox-labs/miden-wallet-adapter-base';
import type { NoteFilterTypes } from '@miden-sdk/miden-sdk';

import { TransactionOutput } from 'lib/miden/db/types';

export type MidenDAppMessage = MidenDAppRequest | MidenDAppResponse;

export type MidenDAppRequest =
  | MidenDAppGetCurrentPermissionRequest
  | MidenDAppPermissionRequest
  | MidenDAppDisconnectRequest
  | MidenDAppTransactionRequest
  | MidenDAppSendTransactionRequest
  | MidenDAppConsumeRequest
  | MidenDAppPrivateNotesRequest
  | MidenDAppSignRequest
  | MidenDAppAssetsRequest
  | MidenDAppImportPrivateNoteRequest
  | MidenDAppConsumableNotesRequest
  | MidenDAppWaitForTxRequest;

export type MidenDAppResponse =
  | MidenDAppGetCurrentPermissionResponse
  | MidenDAppPermissionResponse
  | MidenDAppDisconnectResponse
  | MidenDAppTransactionResponse
  | MidenDAppSendTransactionResponse
  | MidenDAppConsumeResponse
  | MidenDAppPrivateNotesResponse
  | MidenDAppSignResponse
  | MidenDAppAssetsResponse
  | MidenDAppImportPrivateNoteResponse
  | MidenDAppConsumableNotesResponse
  | MidenDAppWaitForTxResponse;

export interface MidenDAppMessageBase {
  type: MidenDAppMessageType;
}

export enum MidenDAppMessageType {
  GetCurrentPermissionRequest = 'GET_CURRENT_PERMISSION_REQUEST',
  GetCurrentPermissionResponse = 'GET_CURRENT_PERMISSION_RESPONSE',
  PermissionRequest = 'PERMISSION_REQUEST',
  PermissionResponse = 'PERMISSION_RESPONSE',
  DisconnectRequest = 'DISCONNECT_REQUEST',
  DisconnectResponse = 'DISCONNECT_RESPONSE',
  TransactionRequest = 'TRANSACTION_REQUEST',
  TransactionResponse = 'TRANSACTION_RESPONSE',
  SendTransactionRequest = 'SEND_TRANSACTION_REQUEST',
  SendTransactionResponse = 'SEND_TRANSACTION_RESPONSE',
  ConsumeRequest = 'CONSUME_REQUEST',
  ConsumeResponse = 'CONSUME_RESPONSE',
  PrivateNotesRequest = 'PRIVATE_NOTES_REQUEST',
  PrivateNotesResponse = 'PRIVATE_NOTES_RESPONSE',
  SignRequest = 'SIGN_REQUEST',
  SignResponse = 'SIGN_RESPONSE',
  AssetsRequest = 'ASSETS_REQUEST',
  AssetsResponse = 'ASSETS_RESPONSE',
  ImportPrivateNoteRequest = 'IMPORT_PRIVATE_NOTE_REQUEST',
  ImportPrivateNoteResponse = 'IMPORT_PRIVATE_NOTE_RESPONSE',
  ConsumableNotesRequest = 'CONSUMABLE_NOTES_REQUEST',
  ConsumableNotesResponse = 'CONSUMABLE_NOTES_RESPONSE',
  WaitForTransactionRequest = 'WAIT_FOR_TRANSACTION_REQUEST',
  WaitForTransactionResponse = 'WAIT_FOR_TRANSACTION_RESPONSE'
}

/**
 * Messages
 */

export interface MidenDAppGetCurrentPermissionRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.GetCurrentPermissionRequest;
}

export interface MidenDAppGetCurrentPermissionResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.GetCurrentPermissionResponse;
  permission: MidenDAppPermission;
}

export interface MidenDAppPermissionRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.PermissionRequest;
  appMeta: MidenDAppMetadata;
  network: WalletAdapterNetwork;
  force?: boolean;
  privateDataPermission?: PrivateDataPermission;
  allowedPrivateData?: AllowedPrivateData;
}

export interface MidenDAppPermissionResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.PermissionResponse;
  accountId: string;
  network: string;
  privateDataPermission: PrivateDataPermission;
  allowedPrivateData: AllowedPrivateData;
  publicKey: string;
}

export interface MidenDAppDisconnectRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.DisconnectRequest;
}

export interface MidenDAppDisconnectResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.DisconnectResponse;
}

export interface MidenDAppTransactionRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.TransactionRequest;
  sourcePublicKey: string;
  transaction: MidenTransaction;
}

export interface MidenDAppTransactionResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.TransactionResponse;
  transactionId?: string;
}

export interface MidenDAppSendTransactionRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.SendTransactionRequest;
  sourcePublicKey: string;
  transaction: MidenSendTransaction;
}

export interface MidenDAppSendTransactionResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.SendTransactionResponse;
  transactionId?: string;
}

export interface MidenDAppConsumeRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.ConsumeRequest;
  sourcePublicKey: string;
  transaction: MidenConsumeTransaction;
}

export interface MidenDAppConsumeResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.ConsumeResponse;
  transactionId?: string;
}

export interface MidenDAppPrivateNotesRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.PrivateNotesRequest;
  sourcePublicKey: string;
  notefilterType: NoteFilterTypes;
  noteIds?: string[];
}

export interface MidenDAppPrivateNotesResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.PrivateNotesResponse;
  privateNotes: InputNoteDetails[];
}

export interface MidenDAppSignRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.SignRequest;
  sourceAccountId: string;
  sourcePublicKey: string;
  payload: string;
  kind: SignKind;
}

export interface MidenDAppSignResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.SignResponse;
  signature: string;
}

export interface MidenDAppAssetsRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.AssetsRequest;
  sourcePublicKey: string;
}

export interface MidenDAppAssetsResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.AssetsResponse;
  assets: Asset[];
}

export interface MidenDAppImportPrivateNoteRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.ImportPrivateNoteRequest;
  sourcePublicKey: string;
  note: string;
}

export interface MidenDAppImportPrivateNoteResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.ImportPrivateNoteResponse;
  noteId: string;
}

export interface MidenDAppConsumableNotesRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.ConsumableNotesRequest;
  sourcePublicKey: string;
}

export interface MidenDAppConsumableNotesResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.ConsumableNotesResponse;
  consumableNotes: any[];
}

export interface MidenDAppWaitForTxRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.WaitForTransactionRequest;
  txId: string;
}

export interface MidenDAppWaitForTxResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.WaitForTransactionResponse;
  transactionOutput: TransactionOutput;
}

/**
 * Errors
 */
export enum MidenDAppErrorType {
  NotGranted = 'NOT_GRANTED',
  NotFound = 'NOT_FOUND',
  InvalidParams = 'INVALID_PARAMS',
  NetworkNotGranted = 'NETWORK_NOT_GRANTED'
}

/**
 * Misc
 */

export type MidenDAppPermission = {
  rpc?: string;
  address: string;
  privateDataPermission: PrivateDataPermission;
  allowedPrivateData: AllowedPrivateData;
} | null;

export interface MidenDAppMetadata {
  name: string;
}

export interface MidenPageMessage {
  type: MidenPageMessageType;
  payload: any;
  reqId?: string | number;
}

export enum MidenPageMessageType {
  Request = 'MIDEN_PAGE_REQUEST',
  Response = 'MIDEN_PAGE_RESPONSE',
  ErrorResponse = 'MIDEN_PAGE_ERROR_RESPONSE'
}
