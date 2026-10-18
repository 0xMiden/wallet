import { NoteFilterTypes } from '@miden-sdk/miden-sdk';
import {
  AllowedPrivateData,
  MidenConsumeTransaction,
  MidenSendTransaction,
  PrivateDataPermission,
  TransactionType,
  WalletAdapterNetwork,
  WalletError
} from '@miden-sdk/miden-wallet-adapter-base';

import { DAppMessage } from '@miden-sdk/bread-connect';

import { KeyValueStorage } from './storage';
import { AppSwitchTransport, BreadConnectError, StoredSession } from './transport';
import { BreadConnectWallet } from './wallet';

const PERMISSION: DAppMessage = {
  type: 'PERMISSION_RESPONSE',
  accountId: 'mtst1account',
  publicKey: 'AQID',
  privateDataPermission: 'UPON_REQUEST',
  allowedPrivateData: 1,
  network: 'testnet'
};

const PERMISSION_REQUEST: DAppMessage = {
  type: 'PERMISSION_REQUEST',
  appMeta: { name: 'Game' },
  force: false,
  privateDataPermission: 'UPON_REQUEST',
  network: 'testnet'
};

const SEND: MidenSendTransaction = {
  senderAddress: 'mtst1account',
  recipientAddress: 'mtst1other',
  faucetId: 'mtst1faucet',
  noteType: 'public',
  amount: 5
};

const CONSUME: MidenConsumeTransaction = { faucetId: 'mtst1faucet', noteId: '0xnote', noteType: 'private', amount: 5 };

class MemoryStorage implements KeyValueStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function setup() {
  const transport = new AppSwitchTransport({
    callback: 'https://game.example/bread',
    storage: new MemoryStorage(),
    links: { launchUrl: async () => undefined, onUrl: () => () => undefined },
    openWallet: async () => true
  });
  const connect = jest.spyOn(transport, 'connect').mockResolvedValue(PERMISSION);
  const request = jest.spyOn(transport, 'request');
  const wallet = new BreadConnectWallet(transport, 'Game');
  return { transport, connect, request, wallet };
}

async function connected() {
  const setupResult = setup();
  await setupResult.wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
  return setupResult;
}

function storedSession(request: DAppMessage): StoredSession {
  return {
    session: 's',
    callback: 'https://game.example/bread',
    appSecretKey: 'k',
    appPublicKey: 'a',
    walletPublicKey: 'w',
    request,
    permission: PERMISSION
  };
}

describe('BreadConnectWallet', () => {
  it("connects with the request Bread's own provider sends, and takes the account from the answer", async () => {
    const { wallet, connect } = await connected();
    expect(connect).toHaveBeenCalledWith(PERMISSION_REQUEST);
    expect(connect.mock.calls[0]![0]).not.toHaveProperty('allowedPrivateData');
    expect(wallet.address).toBe('mtst1account');
    expect(wallet.publicKey).toEqual(new Uint8Array([1, 2, 3]));
    expect(wallet.privateDataPermission).toBe('UPON_REQUEST');
    expect(wallet.allowedPrivateData).toBe(1);
    expect(wallet.network).toBe(WalletAdapterNetwork.Testnet);

    connect.mockResolvedValueOnce({ ...PERMISSION, allowedPrivateData: undefined });
    await wallet.connect(PrivateDataPermission.Auto, WalletAdapterNetwork.Devnet, AllowedPrivateData.Assets);
    expect(connect).toHaveBeenLastCalledWith({
      ...PERMISSION_REQUEST,
      privateDataPermission: 'AUTO',
      network: 'devnet',
      allowedPrivateData: AllowedPrivateData.Assets
    });
    expect(wallet.allowedPrivateData).toBeUndefined();
  });

  it('reconnects without switching to Bread when the stored session answered the same request', async () => {
    const { transport, connect, wallet } = setup();
    const session = jest.spyOn(transport, 'session').mockReturnValue(storedSession(PERMISSION_REQUEST));
    await wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
    expect(connect).not.toHaveBeenCalled();
    expect(wallet.address).toBe('mtst1account');

    session.mockReturnValue(storedSession({ ...PERMISSION_REQUEST, network: 'devnet' }));
    await wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('refuses a permission answer of the wrong type or shape', async () => {
    const { connect, wallet } = setup();
    const connectWallet = () => wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
    connect.mockResolvedValueOnce({ type: 'SIGN_RESPONSE' });
    await expect(connectWallet()).rejects.toBeInstanceOf(WalletError);
    connect.mockResolvedValueOnce({ ...PERMISSION, publicKey: 7 });
    await expect(connectWallet()).rejects.toThrow('publicKey');
    connect.mockResolvedValueOnce({ ...PERMISSION, publicKey: '***' });
    await expect(connectWallet()).rejects.toThrow('base64');
    connect.mockResolvedValueOnce({ ...PERMISSION, accountId: undefined });
    await expect(connectWallet()).rejects.toThrow('accountId');
    expect(wallet.address).toBeUndefined();
  });

  it('forgets the session in the app on disconnect', async () => {
    const { transport, wallet } = await connected();
    const cancel = jest.spyOn(transport, 'cancelPending');
    const forget = jest.spyOn(transport, 'forgetSession');
    await wallet.disconnect();
    expect(cancel).toHaveBeenCalled();
    expect(forget).toHaveBeenCalled();
    expect(wallet.address).toBeUndefined();
    expect(wallet.publicKey).toBeUndefined();
    expect(wallet.privateDataPermission).toBeUndefined();
    expect(wallet.allowedPrivateData).toBeUndefined();
  });

  it("sends transactions as Bread's own provider does", async () => {
    const { request, wallet } = await connected();
    request.mockResolvedValueOnce({ type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-send' });
    await expect(wallet.requestSend(SEND)).resolves.toEqual({ transactionId: 'tx-send' });
    expect(request).toHaveBeenLastCalledWith({
      type: 'SEND_TRANSACTION_REQUEST',
      sourcePublicKey: 'mtst1account',
      transaction: SEND
    });

    request.mockResolvedValueOnce({ type: 'CONSUME_RESPONSE', transactionId: 'tx-consume' });
    await expect(wallet.requestConsume(CONSUME)).resolves.toEqual({ transactionId: 'tx-consume' });
    expect(request).toHaveBeenLastCalledWith({
      type: 'CONSUME_REQUEST',
      sourcePublicKey: 'mtst1account',
      transaction: CONSUME
    });

    const transaction = { type: TransactionType.Send, payload: SEND };
    request.mockResolvedValueOnce({ type: 'TRANSACTION_RESPONSE', transactionId: 9 });
    await expect(wallet.requestTransaction(transaction)).resolves.toEqual({ transactionId: undefined });
    expect(request).toHaveBeenLastCalledWith({
      type: 'TRANSACTION_REQUEST',
      sourcePublicKey: 'mtst1account',
      transaction
    });

    request.mockResolvedValueOnce({ type: 'CONSUME_RESPONSE', transactionId: 'tx' });
    await expect(wallet.requestSend(SEND)).rejects.toThrow('SEND_TRANSACTION_RESPONSE');
  });

  it('asks for notes, assets, guardian details and a note import', async () => {
    const { request, wallet } = await connected();
    const note = { noteId: '0xnote' };
    request.mockResolvedValueOnce({ type: 'PRIVATE_NOTES_RESPONSE', privateNotes: [note] });
    await expect(wallet.requestPrivateNotes(NoteFilterTypes.All, ['0xnote'])).resolves.toEqual({
      privateNotes: [note]
    });
    expect(request).toHaveBeenLastCalledWith({
      type: 'PRIVATE_NOTES_REQUEST',
      sourcePublicKey: 'mtst1account',
      notefilterType: NoteFilterTypes.All,
      noteIds: ['0xnote']
    });
    request.mockResolvedValueOnce({ type: 'PRIVATE_NOTES_RESPONSE', privateNotes: [] });
    await wallet.requestPrivateNotes(NoteFilterTypes.All);
    expect(request.mock.lastCall![0]).not.toHaveProperty('noteIds');

    const asset = { faucetId: 'mtst1faucet', amount: '5' };
    request.mockResolvedValueOnce({ type: 'ASSETS_RESPONSE', assets: [asset] });
    await expect(wallet.requestAssets()).resolves.toEqual({ assets: [asset] });
    expect(request).toHaveBeenLastCalledWith({ type: 'ASSETS_REQUEST', sourcePublicKey: 'mtst1account' });

    const guardianInfo = { isGuardianAccount: false };
    request.mockResolvedValueOnce({ type: 'GUARDIAN_INFO_RESPONSE', guardianInfo });
    await expect(wallet.requestGuardianInfo()).resolves.toEqual({ guardianInfo });
    expect(request).toHaveBeenLastCalledWith({ type: 'GUARDIAN_INFO_REQUEST', sourcePublicKey: 'mtst1account' });

    request.mockResolvedValueOnce({ type: 'CONSUMABLE_NOTES_RESPONSE', consumableNotes: [note] });
    await expect(wallet.requestConsumableNotes()).resolves.toEqual({ consumableNotes: [note] });
    expect(request).toHaveBeenLastCalledWith({ type: 'CONSUMABLE_NOTES_REQUEST', sourcePublicKey: 'mtst1account' });

    request.mockResolvedValueOnce({ type: 'IMPORT_PRIVATE_NOTE_RESPONSE', noteId: '0xnew' });
    await expect(wallet.importPrivateNote(new Uint8Array([1, 2, 3]))).resolves.toEqual({ noteId: '0xnew' });
    expect(request).toHaveBeenLastCalledWith({
      type: 'IMPORT_PRIVATE_NOTE_REQUEST',
      sourcePublicKey: 'mtst1account',
      note: 'AQID'
    });
  });

  it("signs bytes as Bread's own provider does", async () => {
    const { request, wallet } = await connected();
    request.mockResolvedValueOnce({ type: 'SIGN_RESPONSE', signature: 'BAUG' });
    await expect(wallet.signBytes(new Uint8Array([1, 2, 3]), 'word')).resolves.toEqual({
      signature: new Uint8Array([4, 5, 6])
    });
    expect(request).toHaveBeenLastCalledWith({
      type: 'SIGN_REQUEST',
      sourceAccountId: 'mtst1account',
      sourcePublicKey: '010203',
      payload: 'AQID',
      kind: 'word'
    });
  });

  it('refuses answers of the wrong shape', async () => {
    const { request, wallet } = await connected();
    request.mockResolvedValueOnce({ type: 'ASSETS_RESPONSE', assets: 'none' });
    await expect(wallet.requestAssets()).rejects.toThrow('assets');
    request.mockResolvedValueOnce({ type: 'ASSETS_RESPONSE', assets: [{ faucetId: 'f', amount: '1' }, 7] });
    await expect(wallet.requestAssets()).rejects.toThrow('assets');
    request.mockResolvedValueOnce({ type: 'GUARDIAN_INFO_RESPONSE', guardianInfo: 'yes' });
    await expect(wallet.requestGuardianInfo()).rejects.toThrow('guardianInfo');
    request.mockResolvedValueOnce({ type: 'IMPORT_PRIVATE_NOTE_RESPONSE' });
    await expect(wallet.importPrivateNote(new Uint8Array([1]))).rejects.toThrow('noteId');
    request.mockResolvedValueOnce({ type: 'SIGN_RESPONSE', signature: '%%' });
    await expect(wallet.signBytes(new Uint8Array([1]), 'word')).rejects.toThrow('base64');
  });

  it('refuses every request before it is connected', async () => {
    const { request, wallet } = setup();
    await expect(wallet.requestSend(SEND)).rejects.toBeInstanceOf(WalletError);
    await expect(wallet.requestAssets()).rejects.toBeInstanceOf(WalletError);
    await expect(wallet.signBytes(new Uint8Array([1]), 'word')).rejects.toBeInstanceOf(WalletError);
    expect(request).not.toHaveBeenCalled();
  });

  it('waits for a transaction with the outcome Bread reported with its answer', async () => {
    const { transport, wallet } = await connected();
    const outcome = jest.spyOn(transport, 'transactionOutcome');
    outcome.mockReturnValueOnce({ output: { txHash: '0xabc', outputNotes: [] } });
    await expect(wallet.waitForTransaction('tx')).resolves.toEqual({ txHash: '0xabc', outputNotes: [] });
    outcome.mockReturnValueOnce({ error: { code: 'TRANSACTION_FAILED', message: 'rejected by the node' } });
    await expect(wallet.waitForTransaction('tx')).rejects.toBeInstanceOf(BreadConnectError);
    outcome.mockReturnValueOnce({ error: { code: 'TRANSACTION_TIMEOUT', message: 'slow' } });
    await expect(wallet.waitForTransaction('tx')).rejects.toMatchObject({ code: 'TRANSACTION_TIMEOUT' });
    outcome.mockReturnValueOnce({ output: 'done' });
    await expect(wallet.waitForTransaction('tx')).rejects.toThrow('transaction output');
    outcome.mockReturnValueOnce(undefined);
    await expect(wallet.waitForTransaction('tx')).rejects.toBeInstanceOf(WalletError);
  });

  it('does not create accounts', async () => {
    await expect(setup().wallet.createAccount()).rejects.toBeInstanceOf(WalletError);
  });
});
