/* eslint-disable import/first */
/**
 * Coverage tests for `lib/miden/back/main.ts` — the message dispatcher
 * that wires intercom requests to backend Actions and the WASM client.
 *
 * `processRequest` is internal, so we exercise it by injecting requests
 * through the mocked `intercom.onRequest` registration.
 */

// Use globalThis for shared mock state because jest.mock factories are
// hoisted and run before const declarations evaluate.
const _g = globalThis as any;
_g.__mainTest = {
  onRequest: jest.fn(),
  broadcast: jest.fn(),
  storeWatch: jest.fn(),
  doSync: jest.fn(),
  startTransactionProcessing: jest.fn(),
  client: {
    importNoteBytes: jest.fn(),
    syncState: jest.fn(),
    exportNote: jest.fn(),
    getInputNote: jest.fn()
  }
};

jest.mock('lib/miden/back/defaults', () => ({
  intercom: {
    onRequest: (cb: any) => (globalThis as any).__mainTest.onRequest(cb),
    broadcast: (msg: any) => (globalThis as any).__mainTest.broadcast(msg)
  }
}));

jest.mock('lib/miden/back/store', () => ({
  store: {
    map: () => ({ watch: (cb: any) => (globalThis as any).__mainTest.storeWatch(cb) })
  },
  toFront: jest.fn()
}));

jest.mock('./sync-manager', () => ({
  doSync: () => (globalThis as any).__mainTest.doSync()
}));

jest.mock('./transaction-processor', () => ({
  startTransactionProcessing: () => (globalThis as any).__mainTest.startTransactionProcessing()
}));

// Bridge wiring is exercised separately in keystore-bridge.test.ts; mock
// here so the test doesn't pull in the Effector store's unlocked/locked
// events that this test fixture mocks away.
jest.mock('./keystore-wiring', () => ({
  wireKeystoreBridge: jest.fn()
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => (globalThis as any).__mainTest.client,
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  runWhenClientIdle: () => {}
}));

const mockOnRequest = _g.__mainTest.onRequest;
const mockBroadcast = _g.__mainTest.broadcast;
const mockStoreWatch = _g.__mainTest.storeWatch;
const mockDoSync = _g.__mainTest.doSync;
const mockStartTransactionProcessing = _g.__mainTest.startTransactionProcessing;
const mockClient = _g.__mainTest.client;

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (x: any) => (typeof x === 'string' ? x : 'bech32-stub')
}));

jest.mock('lib/miden/back/actions', () => ({
  init: jest.fn(),
  getFrontState: jest.fn(),
  registerNewWallet: jest.fn(),
  registerImportedWallet: jest.fn(),
  unlock: jest.fn(),
  lock: jest.fn(),
  createHDAccount: jest.fn(),
  updateCurrentAccount: jest.fn(),
  revealMnemonic: jest.fn(),
  removeAccount: jest.fn(),
  editAccount: jest.fn(),
  importAccount: jest.fn(),
  updateSettings: jest.fn(),
  signTransaction: jest.fn(),
  getAuthSecretKey: jest.fn(),
  getAllDAppSessions: jest.fn(),
  removeDAppSession: jest.fn(),
  isDAppEnabled: jest.fn(),
  processDApp: jest.fn()
}));
const Actions: any = jest.requireMock('lib/miden/back/actions');

import { WalletMessageType } from 'lib/shared/types';

import { MidenMessageType } from '../types';
import { start } from './main';

let dispatch: (req: any, port?: any) => Promise<any>;

beforeEach(async () => {
  jest.clearAllMocks();
  Actions.isDAppEnabled.mockResolvedValue(true);
  Actions.getFrontState.mockResolvedValue({ status: 'Ready', accounts: [] });
  Actions.revealMnemonic.mockResolvedValue('the mnemonic');
  Actions.signTransaction.mockResolvedValue('hex-signature');
  Actions.getAuthSecretKey.mockResolvedValue('secret-key');
  Actions.getAllDAppSessions.mockResolvedValue({});
  Actions.removeDAppSession.mockResolvedValue({});
  Actions.processDApp.mockResolvedValue({ payload: 'response' });
  mockClient.importNoteBytes.mockResolvedValue({ toString: () => 'note-id-1' });
  mockClient.syncState.mockResolvedValue(undefined);
  mockClient.exportNote.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mockClient.getInputNote.mockResolvedValue(null);
  mockDoSync.mockResolvedValue(undefined);
  mockStartTransactionProcessing.mockResolvedValue(undefined);

  // Spin up `start()` so the dispatcher gets registered, then capture
  // the handler intercom.onRequest received.
  await start();
  dispatch = mockOnRequest.mock.calls[0]![0];
});

describe('main.start', () => {
  it('initializes Actions and registers an intercom handler', () => {
    expect(Actions.init).toHaveBeenCalled();
    expect(mockOnRequest).toHaveBeenCalledTimes(1);
    expect(mockStoreWatch).toHaveBeenCalled();
  });

  it('broadcasts StateUpdated when the front store changes', () => {
    const watcher = mockStoreWatch.mock.calls[0]![0];
    watcher();
    expect(mockBroadcast).toHaveBeenCalledWith({ type: WalletMessageType.StateUpdated });
  });
});

describe('processRequest', () => {
  it('SyncRequest → SyncResponse and triggers doSync', async () => {
    const res = await dispatch({ type: WalletMessageType.SyncRequest });
    expect(res.type).toBe(WalletMessageType.SyncResponse);
    expect(mockDoSync).toHaveBeenCalled();
  });

  it('NoteClaimStarted broadcasts the note id and returns ack', async () => {
    const res = await dispatch({ type: WalletMessageType.NoteClaimStarted, noteId: 'n1' });
    expect(res.type).toBe(WalletMessageType.NoteClaimStartedResponse);
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: WalletMessageType.NoteClaimStarted,
      noteId: 'n1'
    });
  });

  it('ProcessTransactionsRequest fires startTransactionProcessing and returns ack', async () => {
    const res = await dispatch({ type: WalletMessageType.ProcessTransactionsRequest });
    expect(res.type).toBe(WalletMessageType.ProcessTransactionsResponse);
    expect(mockStartTransactionProcessing).toHaveBeenCalled();
  });

  it('ImportNoteBytesRequest decodes base64, calls importNoteBytes + syncState, returns id', async () => {
    const res = await dispatch({
      type: WalletMessageType.ImportNoteBytesRequest,
      noteBytes: Buffer.from([1, 2, 3]).toString('base64')
    });
    expect(res.type).toBe(WalletMessageType.ImportNoteBytesResponse);
    expect(res.noteId).toBe('note-id-1');
    expect(mockClient.importNoteBytes).toHaveBeenCalled();
    expect(mockClient.syncState).toHaveBeenCalled();
  });

  it('ExportNoteRequest returns base64-encoded export bytes', async () => {
    const res = await dispatch({
      type: WalletMessageType.ExportNoteRequest,
      noteId: 'note-1'
    });
    expect(res.type).toBe(WalletMessageType.ExportNoteResponse);
    expect(res.noteBytes).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('GetInputNoteDetailsRequest with empty noteIds returns []', async () => {
    const res = await dispatch({
      type: WalletMessageType.GetInputNoteDetailsRequest,
      noteIds: []
    });
    expect(res.type).toBe(WalletMessageType.GetInputNoteDetailsResponse);
    expect(res.notes).toEqual([]);
  });

  it('GetInputNoteDetailsRequest serialises records returned by client.getInputNote', async () => {
    mockClient.getInputNote.mockResolvedValueOnce({
      details: () => ({
        assets: () => ({
          fungibleAssets: () => [
            {
              amount: () => ({ toString: () => '50' }),
              faucetId: () => 'faucet-x'
            }
          ]
        })
      }),
      state: () => ({ toString: () => 'Committed' }),
      nullifier: () => ({ toString: () => 'nullifier-x' })
    });
    const res = await dispatch({
      type: WalletMessageType.GetInputNoteDetailsRequest,
      noteIds: ['n1']
    });
    expect(res.notes).toHaveLength(1);
    expect(res.notes[0]).toEqual({
      noteId: 'n1',
      state: 'Committed',
      assets: [{ amount: '50', faucetId: 'faucet-x' }],
      nullifier: 'nullifier-x'
    });
  });

  it('GetInputNoteDetailsRequest skips notes that throw and notes that are missing', async () => {
    mockClient.getInputNote
      .mockResolvedValueOnce(null) // missing
      .mockRejectedValueOnce(new Error('not found')); // throws
    const res = await dispatch({
      type: WalletMessageType.GetInputNoteDetailsRequest,
      noteIds: ['n1', 'n2']
    });
    expect(res.notes).toEqual([]);
  });

  it('GetStateRequest returns the front state from Actions', async () => {
    const res = await dispatch({ type: WalletMessageType.GetStateRequest });
    expect(res.type).toBe(WalletMessageType.GetStateResponse);
    expect(res.state).toEqual({ status: 'Ready', accounts: [] });
  });

  it('NewWalletRequest delegates to registerNewWallet', async () => {
    const res = await dispatch({
      type: WalletMessageType.NewWalletRequest,
      password: 'pw',
      mnemonic: 'm',
      ownMnemonic: false
    });
    expect(Actions.registerNewWallet).toHaveBeenCalledWith('pw', 'm', false);
    expect(res.type).toBe(WalletMessageType.NewWalletResponse);
  });

  it('ImportFromClientRequest delegates to registerImportedWallet', async () => {
    const res = await dispatch({
      type: WalletMessageType.ImportFromClientRequest,
      password: 'pw',
      mnemonic: 'm'
    });
    expect(Actions.registerImportedWallet).toHaveBeenCalledWith('pw', 'm');
    expect(res.type).toBe(WalletMessageType.ImportFromClientResponse);
  });

  it('UnlockRequest / LockRequest forward to Actions', async () => {
    expect((await dispatch({ type: WalletMessageType.UnlockRequest, password: 'p' })).type).toBe(
      WalletMessageType.UnlockResponse
    );
    expect((await dispatch({ type: WalletMessageType.LockRequest })).type).toBe(WalletMessageType.LockResponse);
    expect(Actions.unlock).toHaveBeenCalledWith('p');
    expect(Actions.lock).toHaveBeenCalled();
  });

  it('CreateAccountRequest forwards walletType + name', async () => {
    const res = await dispatch({
      type: WalletMessageType.CreateAccountRequest,
      walletType: 'OnChain',
      name: 'My Account'
    });
    expect(Actions.createHDAccount).toHaveBeenCalledWith('OnChain', 'My Account');
    expect(res.type).toBe(WalletMessageType.CreateAccountResponse);
  });

  it('UpdateCurrentAccountRequest forwards the public key', async () => {
    const res = await dispatch({
      type: WalletMessageType.UpdateCurrentAccountRequest,
      accountPublicKey: 'pk-1'
    });
    expect(Actions.updateCurrentAccount).toHaveBeenCalledWith('pk-1');
    expect(res.type).toBe(WalletMessageType.UpdateCurrentAccountResponse);
  });

  it('RevealMnemonicRequest returns the mnemonic from Actions', async () => {
    const res = await dispatch({ type: WalletMessageType.RevealMnemonicRequest, password: 'pw' });
    expect(res.type).toBe(WalletMessageType.RevealMnemonicResponse);
    expect(res.mnemonic).toBe('the mnemonic');
  });

  it('RemoveAccountRequest / EditAccountRequest / ImportAccountRequest delegate to Actions', async () => {
    await dispatch({
      type: WalletMessageType.RemoveAccountRequest,
      accountPublicKey: 'pk',
      password: 'pw'
    });
    await dispatch({
      type: WalletMessageType.EditAccountRequest,
      accountPublicKey: 'pk',
      name: 'new-name'
    });
    await dispatch({
      type: WalletMessageType.ImportAccountRequest,
      privateKey: 'priv',
      encPassword: 'epw'
    });
    expect(Actions.removeAccount).toHaveBeenCalledWith('pk', 'pw');
    expect(Actions.editAccount).toHaveBeenCalledWith('pk', 'new-name');
    expect(Actions.importAccount).toHaveBeenCalledWith('priv', 'epw');
  });

  it('UpdateSettingsRequest forwards settings to Actions', async () => {
    await dispatch({
      type: WalletMessageType.UpdateSettingsRequest,
      settings: { fiat: 'USD' }
    });
    expect(Actions.updateSettings).toHaveBeenCalledWith({ fiat: 'USD' });
  });

  it('SignTransactionRequest returns hex signature', async () => {
    const res = await dispatch({
      type: WalletMessageType.SignTransactionRequest,
      publicKey: 'pk',
      signingInputs: 'inputs'
    });
    expect(res.signature).toBe('hex-signature');
  });

  it('GetAuthSecretKeyRequest returns the key from Actions', async () => {
    const res = await dispatch({
      type: WalletMessageType.GetAuthSecretKeyRequest,
      key: 'pk'
    });
    expect(res.key).toBe('secret-key');
  });

  it('DAppGetAllSessionsRequest returns the sessions map', async () => {
    Actions.getAllDAppSessions.mockResolvedValueOnce({ 'origin.xyz': [{ accountId: 'a' }] });
    const res = await dispatch({ type: MidenMessageType.DAppGetAllSessionsRequest });
    expect(res.sessions).toEqual({ 'origin.xyz': [{ accountId: 'a' }] });
  });

  it('DAppRemoveSessionRequest forwards origin and returns the updated map', async () => {
    Actions.removeDAppSession.mockResolvedValueOnce({});
    const res = await dispatch({
      type: MidenMessageType.DAppRemoveSessionRequest,
      origin: 'origin.xyz'
    });
    expect(Actions.removeDAppSession).toHaveBeenCalledWith('origin.xyz');
    expect(res.sessions).toEqual({});
  });

  it('PageRequest with PING payload returns PONG', async () => {
    const res = await dispatch({
      type: MidenMessageType.PageRequest,
      origin: 'o',
      payload: 'PING'
    });
    expect(res).toEqual({
      type: MidenMessageType.PageResponse,
      payload: 'PONG'
    });
  });

  it('PageRequest with non-PING payload delegates to processDApp', async () => {
    Actions.processDApp.mockResolvedValueOnce({ ok: true });
    const res = await dispatch({
      type: MidenMessageType.PageRequest,
      origin: 'o',
      payload: { method: 'foo' }
    });
    expect(Actions.processDApp).toHaveBeenCalledWith('o', { method: 'foo' }, undefined);
    expect(res.type).toBe(MidenMessageType.PageResponse);
    expect(res.payload).toEqual({ ok: true });
  });

  it('PageRequest is a no-op when isDAppEnabled returns false', async () => {
    Actions.isDAppEnabled.mockResolvedValueOnce(false);
    const res = await dispatch({
      type: MidenMessageType.PageRequest,
      origin: 'o',
      payload: 'PING'
    });
    expect(res).toBeUndefined();
  });

  it('returns undefined for an unknown request type', async () => {
    const res = await dispatch({ type: 'UnknownTypeForCoverage' as any });
    expect(res).toBeUndefined();
  });

  it('PageRequest returns null payload when processDApp returns undefined', async () => {
    Actions.processDApp.mockResolvedValueOnce(undefined);
    const res = await dispatch({
      type: MidenMessageType.PageRequest,
      origin: 'o',
      payload: { method: 'bar' }
    });
    expect(res.payload).toBeNull();
  });

  it('PageRequest threads sessionId through to processDApp', async () => {
    Actions.processDApp.mockResolvedValueOnce({ ok: true });
    await dispatch({
      type: MidenMessageType.PageRequest,
      origin: 'o',
      payload: { method: 'baz' },
      sessionId: 'sess-42'
    });
    expect(Actions.processDApp).toHaveBeenCalledWith('o', { method: 'baz' }, 'sess-42');
  });

  it('GetInputNoteDetailsRequest handles null optional chains on record fields', async () => {
    mockClient.getInputNote.mockResolvedValueOnce({
      details: () => ({
        assets: () => ({
          fungibleAssets: () => [
            {
              amount: () => null,
              faucetId: () => null
            }
          ]
        })
      }),
      state: () => null,
      nullifier: () => null
    });
    const res = await dispatch({
      type: WalletMessageType.GetInputNoteDetailsRequest,
      noteIds: ['n1']
    });
    expect(res.notes).toHaveLength(1);
    expect(res.notes[0]).toEqual({
      noteId: 'n1',
      state: 'Unknown',
      assets: [{ amount: '0', faucetId: '' }],
      nullifier: ''
    });
  });
});
