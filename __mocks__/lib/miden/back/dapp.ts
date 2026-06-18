import { MidenDAppMessageType } from 'lib/adapter/types';
import { MidenDAppSessions } from 'lib/miden/types';
import { Vault } from './vault';

// Mirrors the real dapp.ts export so tests that run through
// processDApp → dappDebug don't blow up with "dappDebug is not a
// function". The mock is a no-op regardless of DEBUG_DAPP_BRIDGE.
export const dappDebug = (..._args: unknown[]) => {};

const sessions: MidenDAppSessions = {};

const defaultSession = (origin: string, accountId: string) => ({
  network: 'testnet',
  appMeta: { name: 'Mock DApp', url: origin },
  accountId,
  privateDataPermission: 'None' as any,
  allowedPrivateData: {} as any,
  publicKey: accountId
});

export async function getAllDApps() {
  return sessions;
}

export async function removeDApp(origin: string, _accountPublicKey: string) {
  delete sessions[origin];
  return sessions;
}

export async function getCurrentPermission(origin: string) {
  const acc = await Vault.getCurrentAccountPublicKey();
  const permission = acc ? { rpc: 'https://rpc.testnet.miden.io', address: acc, privateDataPermission: 'None', allowedPrivateData: {} } : null;
  return {
    type: MidenDAppMessageType.GetCurrentPermissionResponse,
    permission
  };
}

export async function requestPermission(origin: string, _req: any) {
  const acc = (await Vault.getCurrentAccountPublicKey()) ?? 'miden-account-1';
  sessions[origin] = [
    {
      ...defaultSession(origin, acc)
    }
  ];
  return {
    type: MidenDAppMessageType.PermissionResponse,
    accountId: acc,
    network: 'testnet',
    privateDataPermission: 'None' as any,
    allowedPrivateData: {},
    publicKey: acc
  };
}

export async function requestDisconnect(origin: string, _req: any) {
  delete sessions[origin];
  return { type: MidenDAppMessageType.DisconnectResponse };
}

export async function requestTransaction(_origin: string, _req: any) {
  return { type: MidenDAppMessageType.TransactionResponse, transactionId: 'tx-123' };
}

export async function requestSendTransaction(_origin: string, _req: any) {
  return { type: MidenDAppMessageType.SendTransactionResponse, transactionId: 'tx-123' };
}

export async function requestConsumeTransaction(_origin: string, _req: any) {
  return { type: MidenDAppMessageType.ConsumeResponse, transactionId: 'tx-123' };
}

export async function requestPrivateNotes(_origin: string, _req: any) {
  return { type: MidenDAppMessageType.PrivateNotesResponse, privateNotes: [] };
}

export async function requestSign(_origin: string, _req: any) {
  return { type: MidenDAppMessageType.SignResponse, signature: 'deadbeef' };
}

export async function requestAssets(_origin: string, _req: any) {
  return { type: MidenDAppMessageType.AssetsResponse, assets: [] };
}

export async function requestImportPrivateNote(_origin: string, _req: any) {
  return { type: MidenDAppMessageType.ImportPrivateNoteResponse };
}

export async function requestConsumableNotes(_origin: string, _req: any) {
  return { type: MidenDAppMessageType.ConsumableNotesResponse, consumableNotes: [] };
}

export async function initiateSendTransaction() {
  return 'tx-123';
}

export async function requestCustomTransaction() {
  return 'tx-123';
}

export async function initiateConsumeTransactionFromId() {
  return 'tx-123';
}
