import {
  AllowedPrivateData,
  MidenConsumeTransaction,
  MidenSendTransaction,
  MidenTransaction,
  PrivateDataPermission,
  SignKind,
  WalletAdapterNetwork
} from '@demox-labs/miden-wallet-adapter-base';
import { NoteFilterTypes } from '@miden-sdk/miden-sdk/lazy';
import { nanoid } from 'nanoid';

import { b64ToU8 } from 'lib/shared/helpers';

import {
  MidenDAppErrorType,
  MidenDAppMessageType,
  MidenDAppMetadata,
  MidenDAppPermission,
  MidenDAppRequest,
  MidenDAppResponse,
  MidenPageMessage,
  MidenPageMessageType
} from './types';

export function isAvailable() {
  return new Promise<boolean>(resolve => {
    const handleMessage = (evt: MessageEvent) => {
      if (evt.source === window && evt.data?.type === MidenPageMessageType.Response && evt.data?.payload === 'PONG') {
        done(true);
      }
    };

    const done = (result: boolean) => {
      resolve(result);
      window.removeEventListener('message', handleMessage);
      clearTimeout(t);
    };

    send({
      type: MidenPageMessageType.Request,
      payload: 'PING'
    });
    window.addEventListener('message', handleMessage);
    const t = setTimeout(() => done(false), 500);
  });
}

export function onAvailabilityChange(callback: (available: boolean) => void) {
  let t: any;
  let currentStatus = false;
  const check = async (attempt = 0) => {
    const initial = attempt < 5;
    const available = await isAvailable();
    if (currentStatus !== available) {
      callback(available);
      currentStatus = available;
    }
    t = setTimeout(check, available ? 10_000 : !initial ? 5_000 : 0, initial ? attempt + 1 : attempt);
  };
  check();
  return () => clearTimeout(t);
}

export function onPermissionChange(callback: (permission: MidenDAppPermission) => void) {
  let t: any;
  let currentPerm: MidenDAppPermission = null;
  const check = async () => {
    try {
      const perm = await getCurrentPermission();
      if (!permissionsAreEqual(perm, currentPerm)) {
        callback(perm);
        currentPerm = perm;
      }
    } catch {}

    t = setTimeout(check, 10_000);
  };
  check();
  return () => clearTimeout(t);
}

export async function getCurrentPermission() {
  const res = await request({
    type: MidenDAppMessageType.GetCurrentPermissionRequest
  });
  assertResponse(res.type === MidenDAppMessageType.GetCurrentPermissionResponse);
  return res.permission;
}

export async function requestPermission(
  appMeta: MidenDAppMetadata,
  force: boolean,
  privateDataPermission: PrivateDataPermission,
  network: WalletAdapterNetwork,
  allowedPrivateData?: AllowedPrivateData
) {
  const res = await request({
    type: MidenDAppMessageType.PermissionRequest,
    appMeta,
    force,
    privateDataPermission,
    network,
    allowedPrivateData
  });
  assertResponse(res.type === MidenDAppMessageType.PermissionResponse);
  return {
    rpc: res.network,
    address: res.accountId,
    privateDataPermission: res.privateDataPermission,
    allowedPrivateData: res.allowedPrivateData,
    publicKey: b64ToU8(res.publicKey)
  };
}

export async function requestDisconnect() {
  const res = await request({
    type: MidenDAppMessageType.DisconnectRequest
  });
  assertResponse(res.type === MidenDAppMessageType.DisconnectResponse);
  return res;
}

export async function requestSend(sourcePublicKey: string, transaction: MidenSendTransaction) {
  const res = await request({
    type: MidenDAppMessageType.SendTransactionRequest,
    sourcePublicKey,
    transaction
  });
  assertResponse(res.type === MidenDAppMessageType.SendTransactionResponse);
  return res.transactionId;
}

export async function requestTransaction(sourcePublicKey: string, transaction: MidenTransaction) {
  const res = await request({
    type: MidenDAppMessageType.TransactionRequest,
    sourcePublicKey,
    transaction
  });
  assertResponse(res.type === MidenDAppMessageType.TransactionResponse);
  return res.transactionId;
}

export async function requestConsume(sourcePublicKey: string, transaction: MidenConsumeTransaction) {
  const res = await request({
    type: MidenDAppMessageType.ConsumeRequest,
    sourcePublicKey,
    transaction
  });
  assertResponse(res.type === MidenDAppMessageType.ConsumeResponse);
  return res.transactionId;
}

export async function requestPrivateNotes(
  sourcePublicKey: string,
  notefilterType: NoteFilterTypes,
  noteIds?: string[]
) {
  const res = await request({
    type: MidenDAppMessageType.PrivateNotesRequest,
    sourcePublicKey,
    notefilterType,
    noteIds
  });
  assertResponse(res.type === MidenDAppMessageType.PrivateNotesResponse);
  return res.privateNotes;
}

export async function requestAccountFile(sourcePublicKey: string): Promise<string | null> {
  const res = await request({
    type: MidenDAppMessageType.AccountFileRequest,
    sourcePublicKey
  });
  assertResponse(res.type === MidenDAppMessageType.AccountFileResponse);
  return res.bytes;
}

export async function signBytes(sourceAccountId: string, sourcePublicKey: string, message: string, kind: SignKind) {
  const res = await request({
    type: MidenDAppMessageType.SignRequest,
    sourceAccountId,
    sourcePublicKey,
    payload: message,
    kind: kind
  });
  assertResponse(res.type === MidenDAppMessageType.SignResponse);
  return res.signature;
}

export async function requestAssets(sourcePublicKey: string) {
  const res = await request({
    type: MidenDAppMessageType.AssetsRequest,
    sourcePublicKey
  });
  assertResponse(res.type === MidenDAppMessageType.AssetsResponse);
  return res.assets;
}

export async function importPrivateNote(sourcePublicKey: string, note: string) {
  const res = await request({
    type: MidenDAppMessageType.ImportPrivateNoteRequest,
    sourcePublicKey,
    note
  });
  assertResponse(res.type === MidenDAppMessageType.ImportPrivateNoteResponse);
  return res.noteId;
}

export async function requestConsumableNotes(sourcePublicKey: string) {
  const res = await request({
    type: MidenDAppMessageType.ConsumableNotesRequest,
    sourcePublicKey
  });
  assertResponse(res.type === MidenDAppMessageType.ConsumableNotesResponse);
  return res.consumableNotes;
}

export async function waitForTransaction(txId: string) {
  const res = await request({
    type: MidenDAppMessageType.WaitForTransactionRequest,
    txId
  });
  assertResponse(res.type === MidenDAppMessageType.WaitForTransactionResponse);
  return res.transactionOutput;
}

function request(payload: MidenDAppRequest) {
  return new Promise<MidenDAppResponse>((resolve, reject) => {
    const reqId = nanoid();
    const handleMessage = (evt: MessageEvent) => {
      const res = evt.data as MidenPageMessage;
      switch (true) {
        case evt.source !== window || res?.reqId !== reqId:
          return;

        case res?.type === MidenPageMessageType.Response:
          resolve(res.payload);
          window.removeEventListener('message', handleMessage);
          break;

        case res?.type === MidenPageMessageType.ErrorResponse:
          reject(createError(res.payload));
          window.removeEventListener('message', handleMessage);
          break;
      }
    };

    send({
      type: MidenPageMessageType.Request,
      payload,
      reqId
    });

    window.addEventListener('message', handleMessage);
  });
}

function permissionsAreEqual(aPerm: MidenDAppPermission, bPerm: MidenDAppPermission) {
  if (aPerm === null) return bPerm === null;
  return aPerm.address === bPerm?.address && aPerm.rpc === bPerm?.rpc;
}

function createError(payload: any) {
  const getMessage = (value: any): string | undefined => {
    if (Array.isArray(value)) {
      return typeof value[0] === 'string' ? value[0] : String(value[0]);
    }
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object' && typeof (value as any).message === 'string') {
      return (value as any).message;
    }
    return undefined;
  };

  const message = getMessage(payload);
  const includesCode = (code: MidenDAppErrorType) =>
    payload === code || (typeof message === 'string' && message.includes(code));

  let error: MidenWalletError;

  if (includesCode(MidenDAppErrorType.NotGranted)) {
    error = new NotGrantedMidenWalletError();
  } else if (includesCode(MidenDAppErrorType.NotFound)) {
    error = new NotFoundMidenWalletError();
  } else if (includesCode(MidenDAppErrorType.InvalidParams)) {
    error = new InvalidParamsMidenWalletError();
  } else {
    error = new MidenWalletError();
  }

  if (message) {
    error.message = message;
  }

  return error;
}

export function assertResponse(condition: any): asserts condition {
  if (!condition) {
    throw new Error('Invalid response recieved');
  }
}

function send(msg: MidenPageMessage) {
  // Post to same window - use current origin for security (same-window communication)
  window.postMessage(msg, window.location.origin);
}

export class MidenWalletError implements Error {
  name = 'MidenWalletError';
  message = 'An unknown error occured. Please try again or report it';
}

export class NotGrantedMidenWalletError extends MidenWalletError {
  name = 'NotGrantedMidenWalletError';
  message = 'Permission Not Granted';
}

export class NotFoundMidenWalletError extends MidenWalletError {
  name = 'NotFoundMidenWalletError';
  message = 'Account Not Found. Try connect again';
}

export class InvalidParamsMidenWalletError extends MidenWalletError {
  name = 'InvalidParamsMidenWalletError';
  message = 'Some of the parameters you provided are invalid';
}
