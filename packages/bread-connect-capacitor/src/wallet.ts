import type { NoteFilterTypes } from '@miden-sdk/miden-sdk';
import {
  AllowedPrivateData,
  Asset,
  EventEmitter,
  GuardianInfo,
  InputNoteDetails,
  MidenConsumeTransaction,
  MidenSendTransaction,
  MidenTransaction,
  PrivateDataPermission,
  SignKind,
  WalletAdapterNetwork,
  WalletError,
  WalletTransactionOutput
} from '@miden-sdk/miden-wallet-adapter-base';
import type { MidenWallet, MidenWalletEvents } from '@miden-sdk/miden-wallet-adapter-miden';

import { DAppMessage, isRecord } from '@miden-sdk/bread-connect';

import { AppSwitchTransport, BreadConnectError } from './transport';

/**
 * The `window.midenWallet` a Capacitor app installs, so the stock Miden wallet adapter talks to Bread through app
 * switches. It builds each request as Bread's in-app browser provider does. An answer is authenticated by its
 * session's keys, so its fields are taken as Bread wrote them once their type and shape check.
 */
export class BreadConnectWallet extends EventEmitter<MidenWalletEvents> implements MidenWallet {
  address?: string;
  publicKey?: Uint8Array;
  privateDataPermission?: string;
  allowedPrivateData?: number;
  network?: WalletAdapterNetwork;

  constructor(
    private readonly transport: AppSwitchTransport,
    private readonly appName: string
  ) {
    super();
  }

  /** Resolves without switching to Bread when the stored session answered the same request. */
  async connect(
    privateDataPermission: PrivateDataPermission,
    network: WalletAdapterNetwork,
    allowedPrivateData?: AllowedPrivateData
  ): Promise<void> {
    const request: DAppMessage = {
      type: 'PERMISSION_REQUEST',
      appMeta: { name: this.appName },
      force: false,
      privateDataPermission,
      network,
      ...(allowedPrivateData === undefined ? {} : { allowedPrivateData })
    };
    const stored = this.transport.session();
    const response =
      stored && sameRequest(stored.request, request) ? stored.permission : await this.transport.connect(request);
    expectType(response, 'PERMISSION_RESPONSE');
    const publicKey = fromBase64(stringField(response, 'publicKey'));
    this.address = stringField(response, 'accountId');
    this.publicKey = publicKey;
    this.privateDataPermission = stringField(response, 'privateDataPermission');
    this.allowedPrivateData = typeof response.allowedPrivateData === 'number' ? response.allowedPrivateData : undefined;
    this.network = network;
  }

  /** Forgets the session in the app; the user removes the app's permission in Bread. */
  async disconnect(): Promise<void> {
    this.transport.cancelPending();
    this.transport.forgetSession();
    this.address = undefined;
    this.publicKey = undefined;
    this.privateDataPermission = undefined;
    this.allowedPrivateData = undefined;
  }

  async requestSend(transaction: MidenSendTransaction): Promise<{ transactionId?: string }> {
    return this.transactionRequest('SEND_TRANSACTION_REQUEST', 'SEND_TRANSACTION_RESPONSE', transaction);
  }

  async requestConsume(transaction: MidenConsumeTransaction): Promise<{ transactionId?: string }> {
    return this.transactionRequest('CONSUME_REQUEST', 'CONSUME_RESPONSE', transaction);
  }

  async requestTransaction(transaction: MidenTransaction): Promise<{ transactionId?: string }> {
    return this.transactionRequest('TRANSACTION_REQUEST', 'TRANSACTION_RESPONSE', transaction);
  }

  async requestPrivateNotes(
    notefilterType: NoteFilterTypes,
    noteIds?: string[]
  ): Promise<{ privateNotes: InputNoteDetails[] }> {
    const response = await this.send({
      type: 'PRIVATE_NOTES_REQUEST',
      sourcePublicKey: this.connectedAddress(),
      notefilterType,
      ...(noteIds === undefined ? {} : { noteIds })
    });
    return { privateNotes: listField<InputNoteDetails>(response, 'PRIVATE_NOTES_RESPONSE', 'privateNotes') };
  }

  async requestAssets(): Promise<{ assets: Asset[] }> {
    const response = await this.send({ type: 'ASSETS_REQUEST', sourcePublicKey: this.connectedAddress() });
    return { assets: listField<Asset>(response, 'ASSETS_RESPONSE', 'assets') };
  }

  async requestGuardianInfo(): Promise<{ guardianInfo: GuardianInfo }> {
    const response = await this.send({ type: 'GUARDIAN_INFO_REQUEST', sourcePublicKey: this.connectedAddress() });
    expectType(response, 'GUARDIAN_INFO_RESPONSE');
    const guardianInfo = response.guardianInfo;
    if (!isObject<GuardianInfo>(guardianInfo)) throw malformed('guardianInfo');
    return { guardianInfo };
  }

  async requestConsumableNotes(): Promise<{ consumableNotes: InputNoteDetails[] }> {
    const response = await this.send({ type: 'CONSUMABLE_NOTES_REQUEST', sourcePublicKey: this.connectedAddress() });
    return { consumableNotes: listField<InputNoteDetails>(response, 'CONSUMABLE_NOTES_RESPONSE', 'consumableNotes') };
  }

  async importPrivateNote(note: Uint8Array): Promise<{ noteId: string }> {
    const response = await this.send({
      type: 'IMPORT_PRIVATE_NOTE_REQUEST',
      sourcePublicKey: this.connectedAddress(),
      note: toBase64(note)
    });
    expectType(response, 'IMPORT_PRIVATE_NOTE_RESPONSE');
    return { noteId: stringField(response, 'noteId') };
  }

  async signBytes(data: Uint8Array, kind: SignKind): Promise<{ signature: Uint8Array }> {
    const publicKey = this.publicKey;
    if (!publicKey) throw new WalletError('The app is not connected to Bread');
    const response = await this.send({
      type: 'SIGN_REQUEST',
      sourceAccountId: this.connectedAddress(),
      sourcePublicKey: toHex(publicKey),
      payload: toBase64(data),
      kind
    });
    expectType(response, 'SIGN_RESPONSE');
    return { signature: fromBase64(stringField(response, 'signature')) };
  }

  /** Bread proves and submits a transaction before it answers, so the outcome came with the answer. */
  async waitForTransaction(txId: string): Promise<WalletTransactionOutput> {
    const outcome = this.transport.transactionOutcome(txId);
    if (!outcome) throw new WalletError('Bread reported no outcome for this transaction to this app');
    if ('error' in outcome) throw new BreadConnectError(outcome.error.code, outcome.error.message);
    if (!isObject<WalletTransactionOutput>(outcome.output)) throw malformed('transaction output');
    return outcome.output;
  }

  async createAccount(): Promise<{ accountId: string }> {
    throw new WalletError('createAccount is not supported by the Miden wallet');
  }

  private async transactionRequest(
    type: string,
    responseType: string,
    transaction: MidenSendTransaction | MidenConsumeTransaction | MidenTransaction
  ): Promise<{ transactionId?: string }> {
    const response = await this.send({ type, sourcePublicKey: this.connectedAddress(), transaction });
    expectType(response, responseType);
    return { transactionId: typeof response.transactionId === 'string' ? response.transactionId : undefined };
  }

  private send(request: DAppMessage): Promise<DAppMessage> {
    return this.transport.request(request);
  }

  private connectedAddress(): string {
    if (!this.address) throw new WalletError('The app is not connected to Bread');
    return this.address;
  }
}

function sameRequest(stored: DAppMessage, request: DAppMessage): boolean {
  return JSON.stringify(stored) === JSON.stringify(request);
}

function expectType(response: DAppMessage, type: string): void {
  if (response.type !== type) throw new WalletError(`Bread answered ${response.type} where ${type} was due`);
}

function stringField(response: DAppMessage, name: string): string {
  const value = response[name];
  if (typeof value !== 'string') throw malformed(name);
  return value;
}

function listField<T extends object>(response: DAppMessage, type: string, name: string): T[] {
  expectType(response, type);
  const value = response[name];
  if (!Array.isArray(value) || !value.every((item): item is T => isObject<T>(item))) throw malformed(name);
  return value;
}

function isObject<T extends object>(value: unknown): value is T {
  return isRecord(value);
}

function malformed(name: string): WalletError {
  return new WalletError(`Bread's answer has no well-formed ${name}`);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw malformed('base64 field');
  }
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
