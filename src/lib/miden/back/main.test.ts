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
  swSignCallback: jest.fn(async () => new Uint8Array([0xab, 0xcd])),
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
  doSync: (force?: boolean) => (globalThis as any).__mainTest.doSync(force)
}));

jest.mock('./transaction-processor', () => ({
  startTransactionProcessing: () => (globalThis as any).__mainTest.startTransactionProcessing(),
  // The reverse-IPC sign handler's fallback signer (issue #260, slice 5).
  swSignCallback: (...a: any[]) => (globalThis as any).__mainTest.swSignCallback(...a)
}));

// Keep the REAL proxy (handleOffscreenSignRequest / midenClientProxy) but replace
// `markOpStarted` with a spy so the reverse-IPC listener's routing of the
// OFFSCREEN_OP_STARTED execution-start signal is observable (issue #260 flip-prep #3).
jest.mock('lib/miden/back/miden-client-proxy', () => {
  const actual = jest.requireActual('lib/miden/back/miden-client-proxy');
  return { ...actual, markOpStarted: jest.fn() };
});
const proxyMock: any = jest.requireMock('lib/miden/back/miden-client-proxy');

// The #260 offscreen client proxy reads (getAccount/syncState/exportNote/
// getInputNoteDetails) through the `lib/...` alias of miden-client, which jest
// mocks separately from the relative specifier below; delegate the alias to the
// same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
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

jest.mock('lib/miden-chain/native-asset', () => ({
  primeNativeAssetId: jest.fn()
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
  revealPrivateKey: jest.fn(),
  removeAccount: jest.fn(),
  editAccount: jest.fn(),
  importAccount: jest.fn(),
  updateSettings: jest.fn(),
  signTransaction: jest.fn(),
  getAuthSecretKey: jest.fn(),
  getAllDAppSessions: jest.fn(),
  removeDAppSession: jest.fn(),
  isDAppEnabled: jest.fn(),
  processDApp: jest.fn(),
  setGuardianOperatorCommitment: jest.fn(),
  setGuardianSyncStatus: jest.fn(),
  checkGuardianDrift: jest.fn(),
  applyUserGuardianEndpoint: jest.fn(),
  handleReportTelemetryEvent: jest.fn()
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
  Actions.revealPrivateKey.mockResolvedValue('deadbeef');
  Actions.importAccount.mockResolvedValue('mtst1imported-pk');
  Actions.signTransaction.mockResolvedValue('hex-signature');
  Actions.getAuthSecretKey.mockResolvedValue('secret-key');
  Actions.getAllDAppSessions.mockResolvedValue({});
  Actions.removeDAppSession.mockResolvedValue({});
  Actions.processDApp.mockResolvedValue({ payload: 'response' });
  mockClient.importNoteBytes.mockResolvedValue('note-id-1');
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
    expect(mockDoSync).toHaveBeenCalledWith(undefined);
  });

  it('forwards a forced SyncRequest', async () => {
    await dispatch({ type: WalletMessageType.SyncRequest, force: true });
    expect(mockDoSync).toHaveBeenCalledWith(true);
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

  it('NewWalletRequest delegates to registerNewWallet (forwarding the picked guardianEndpoint)', async () => {
    const res = await dispatch({
      type: WalletMessageType.NewWalletRequest,
      walletType: 'on-chain',
      password: 'pw',
      mnemonic: 'm',
      ownMnemonic: false,
      guardianEndpoint: 'https://guardian.example'
    });
    expect(Actions.registerNewWallet).toHaveBeenCalledWith('on-chain', 'pw', 'm', false, 'https://guardian.example');
    expect(res.type).toBe(WalletMessageType.NewWalletResponse);
  });

  it('ImportFromClientRequest delegates to registerImportedWallet', async () => {
    const res = await dispatch({
      type: WalletMessageType.ImportFromClientRequest,
      password: 'pw',
      mnemonic: 'm',
      walletAccounts: []
    });
    expect(Actions.registerImportedWallet).toHaveBeenCalledWith('pw', 'm', []);
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

  it('RemoveAccountRequest / EditAccountRequest delegate to Actions', async () => {
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
    expect(Actions.removeAccount).toHaveBeenCalledWith('pk', 'pw');
    expect(Actions.editAccount).toHaveBeenCalledWith('pk', 'new-name');
  });

  it('ImportAccountRequest delegates to Actions and returns new public key', async () => {
    const res = await dispatch({
      type: WalletMessageType.ImportAccountRequest,
      privateKey: 'priv',
      name: 'My Account'
    });
    expect(Actions.importAccount).toHaveBeenCalledWith('priv', 'My Account');
    expect(res.type).toBe(WalletMessageType.ImportAccountResponse);
    expect(res.accountPublicKey).toBe('mtst1imported-pk');
  });

  it('RevealPrivateKeyRequest returns the private key from Actions', async () => {
    const res = await dispatch({
      type: WalletMessageType.RevealPrivateKeyRequest,
      accountPublicKey: 'pk-commitment',
      password: 'pw'
    });
    expect(Actions.revealPrivateKey).toHaveBeenCalledWith('pk-commitment', 'pw');
    expect(res.type).toBe(WalletMessageType.RevealPrivateKeyResponse);
    expect(res.privateKey).toBe('deadbeef');
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

  it('SetGuardianOperatorCommitmentRequest forwards to Actions', async () => {
    const res = await dispatch({
      type: WalletMessageType.SetGuardianOperatorCommitmentRequest,
      accountPublicKey: 'pk',
      guardianOperatorCommitment: 'commitment-hex'
    });
    expect(Actions.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'commitment-hex');
    expect(res.type).toBe(WalletMessageType.SetGuardianOperatorCommitmentResponse);
  });

  it('SetGuardianSyncStatusRequest forwards to Actions', async () => {
    const res = await dispatch({
      type: WalletMessageType.SetGuardianSyncStatusRequest,
      accountPublicKey: 'pk',
      guardianSyncStatus: 'needs-user-input'
    });
    expect(Actions.setGuardianSyncStatus).toHaveBeenCalledWith('pk', 'needs-user-input');
    expect(res.type).toBe(WalletMessageType.SetGuardianSyncStatusResponse);
  });

  it('CheckGuardianDriftRequest forwards to Actions and returns the resolved status', async () => {
    Actions.checkGuardianDrift.mockResolvedValueOnce('needs-user-input');
    const res = await dispatch({
      type: WalletMessageType.CheckGuardianDriftRequest,
      accountPublicKey: 'pk'
    });
    expect(Actions.checkGuardianDrift).toHaveBeenCalledWith('pk');
    expect(res.type).toBe(WalletMessageType.CheckGuardianDriftResponse);
    expect(res.guardianSyncStatus).toBe('needs-user-input');
  });

  it('ApplyUserGuardianEndpointRequest forwards to Actions and returns whether it applied', async () => {
    Actions.applyUserGuardianEndpoint.mockResolvedValueOnce(true);
    const res = await dispatch({
      type: WalletMessageType.ApplyUserGuardianEndpointRequest,
      accountPublicKey: 'pk',
      guardianEndpoint: 'https://mine'
    });
    expect(Actions.applyUserGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://mine');
    expect(res.type).toBe(WalletMessageType.ApplyUserGuardianEndpointResponse);
    expect(res.applied).toBe(true);
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

// Capture the reverse-IPC listener `start()` registers on the global
// webextension `chrome` mock. `registerOffscreenSignHandler` self-guards, so it
// wires the listener exactly ONCE (during the first beforeEach's start()). Wrap
// `addListener` at file scope — before that first start() — and stash listeners
// in a plain array `jest.clearAllMocks()` won't wipe. `start()` only ever calls
// `chrome.runtime.onMessage.addListener` from the sign handler (intercom.onRequest
// is a separate, mocked channel), so index 0 is the sign listener.
const capturedRuntimeListeners: Array<(m: any, s: any, r: (x?: any) => void) => any> = [];

/**
 * The listener refuses any sender that is not this extension, so every fixture
 * has to name one. Shared rather than inlined so the identity check has one
 * place to be wrong in, and so a test about routing is not silently also a test
 * about identity.
 */
const OWN_EXTENSION_ID = 'this-extension';
const ownSender = { id: OWN_EXTENSION_ID };

beforeAll(() => {
  const chromeAny = (globalThis as any).chrome;
  if (chromeAny?.runtime) chromeAny.runtime.id = OWN_EXTENSION_ID;
  if (chromeAny?.runtime?.onMessage) {
    chromeAny.runtime.onMessage.addListener = (l: any) => capturedRuntimeListeners.push(l);
  }
});

describe('registerOffscreenSignHandler (reverse-IPC sign channel, issue #260 slice 5)', () => {
  const flushMicro = () => new Promise(resolve => setTimeout(resolve, 0));
  const signListener = () => capturedRuntimeListeners[0]!;

  it('registers exactly one runtime.onMessage listener that ignores non-sign messages (returns false)', () => {
    expect(capturedRuntimeListeners.length).toBe(1);
    const listener = signListener();
    expect(typeof listener).toBe('function');
    // Wrong target / wrong type → not ours, let other listeners handle it.
    expect(listener({ target: 'offscreen', type: 'OFFSCREEN_CALL' }, ownSender, jest.fn())).toBe(false);
    expect(listener({ type: 'OFFSCREEN_READY' }, ownSender, jest.fn())).toBe(false);
    expect(listener(undefined, ownSender, jest.fn())).toBe(false);
  });

  it('answers an OFFSCREEN_SIGN_REQUEST via handleOffscreenSignRequest → swSignCallback (bytes only)', async () => {
    _g.__mainTest.swSignCallback.mockResolvedValue(new Uint8Array([0xab, 0xcd]));
    const sendResponse = jest.fn();
    const ret = signListener()(
      {
        target: 'sw',
        type: 'OFFSCREEN_SIGN_REQUEST',
        op_id: 'op-x',
        sign_id: 'sign-x',
        publicKeyB64: Buffer.from([0x01, 0x02]).toString('base64'),
        signingInputsB64: Buffer.from([0x03, 0x04]).toString('base64')
      },
      ownSender,
      sendResponse
    );
    // Returning true keeps the message port open for the async sendResponse.
    expect(ret).toBe(true);
    await flushMicro();
    // The fallback signer was called with HEX-converted pubkey / signing inputs.
    expect(_g.__mainTest.swSignCallback).toHaveBeenCalledWith('0102', '0304');
    // And the signature bytes flowed back base64-encoded.
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        sign_id: 'sign-x',
        signatureB64: Buffer.from([0xab, 0xcd]).toString('base64')
      })
    );
  });

  it('routes an OFFSCREEN_OP_STARTED signal to markOpStarted (arms the deadline at execution start) and returns false', () => {
    const sendResponse = jest.fn();
    const ret = signListener()(
      { target: 'sw', type: 'OFFSCREEN_OP_STARTED', op_id: 'op-started-42' },
      ownSender,
      sendResponse
    );
    // Fire-and-forget: no async response, so the port is NOT held open.
    expect(ret).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    // Routed to markOpStarted with the op id — NOT to the sign handler.
    expect(proxyMock.markOpStarted).toHaveBeenCalledWith('op-started-42');
    expect(_g.__mainTest.swSignCallback).not.toHaveBeenCalled();
  });

  it('routes an OFFSCREEN_TELEMETRY_EVENT to the telemetry handler and returns false', async () => {
    // The offscreen document is the one realm that can neither install a page
    // transport nor be detected as the worker — it has a `window` and never
    // loads the React app — so it forwards over this channel instead. Proving
    // runs there on the extension's default build, which makes this listener
    // the whole path by which a prove event reaches the wire.
    Actions.handleReportTelemetryEvent.mockResolvedValue({ type: 'x' });
    const sendResponse = jest.fn();
    const event = { phase: 'settled', operation: 'prove', runId: 'r', result: 'completed', durationMs: 12 };

    const ret = signListener()({ target: 'sw', type: 'OFFSCREEN_TELEMETRY_EVENT', event }, ownSender, sendResponse);

    // Fire-and-forget, like OFFSCREEN_OP_STARTED: nothing answers, so holding
    // the port open would leave the sender's promise pending until Chrome
    // closed it.
    expect(ret).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(Actions.handleReportTelemetryEvent).toHaveBeenCalledWith({ event });
    // And it did NOT reach the sign handler this listener is shared with.
    expect(_g.__mainTest.swSignCallback).not.toHaveBeenCalled();
  });

  describe('the sender check, which nothing else in this listener stands behind', () => {
    // `chrome.runtime.onMessage` is not private to the extension. With no
    // `externally_connectable` declared, Chrome's default is that other
    // EXTENSIONS may send here even though web pages may not — and every branch
    // below the check trusts its message: the op-started signal arms a write
    // deadline, the sign request reaches the vault, the telemetry event reaches
    // the wire. So the check sits above all three rather than on the newest one,
    // and these assertions cover all three.
    const foreign = { id: 'some-other-extension-id' };

    it('refuses a telemetry event from another extension', () => {
      Actions.handleReportTelemetryEvent.mockResolvedValue({ type: 'x' });
      const event = { phase: 'settled', operation: 'prove', runId: 'r', result: 'completed' };

      const ret = signListener()({ target: 'sw', type: 'OFFSCREEN_TELEMETRY_EVENT', event }, foreign, jest.fn());

      expect(ret).toBe(false);
      expect(Actions.handleReportTelemetryEvent).not.toHaveBeenCalled();
    });

    it('refuses an op-started signal from another extension, so a write deadline cannot be armed remotely', () => {
      const ret = signListener()({ target: 'sw', type: 'OFFSCREEN_OP_STARTED', op_id: 'not-ours' }, foreign, jest.fn());

      expect(ret).toBe(false);
      expect(proxyMock.markOpStarted).not.toHaveBeenCalled();
    });

    it('refuses a sign request from another extension, which is the one that reaches the vault', () => {
      const sendResponse = jest.fn();

      const ret = signListener()(
        { target: 'sw', type: 'OFFSCREEN_SIGN_REQUEST', op_id: 'op-x', sign_id: 'sign-x', messageB64: 'AA==' },
        foreign,
        sendResponse
      );

      expect(ret).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
      expect(_g.__mainTest.swSignCallback).not.toHaveBeenCalled();
    });

    it('still accepts our own offscreen document, which is the only legitimate sender', () => {
      // The other half of the check. Without this, a guard that refused
      // everything would pass all three assertions above and silently break the
      // channel that carries every prove event on the default build.
      Actions.handleReportTelemetryEvent.mockResolvedValue({ type: 'x' });
      const event = { phase: 'settled', operation: 'prove', runId: 'r', result: 'completed' };

      signListener()({ target: 'sw', type: 'OFFSCREEN_TELEMETRY_EVENT', event }, ownSender, jest.fn());

      expect(Actions.handleReportTelemetryEvent).toHaveBeenCalledWith({ event });
    });
  });

  it('swallows a rejecting telemetry handler, so a signing listener cannot fail because of telemetry', async () => {
    // This listener is shared with signing. An unhandled rejection here is an
    // unhandled rejection in the worker, which in some runtimes is fatal — and
    // it would be fatal on behalf of the one subsystem that must never be able
    // to break a transaction.
    Actions.handleReportTelemetryEvent.mockRejectedValue(new Error('sink is gone'));

    expect(() =>
      signListener()(
        { target: 'sw', type: 'OFFSCREEN_TELEMETRY_EVENT', event: { phase: 'settled' } },
        ownSender,
        jest.fn()
      )
    ).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('ignores an OFFSCREEN_OP_STARTED with a non-string op_id (no markOpStarted, no crash)', () => {
    const ret = signListener()({ target: 'sw', type: 'OFFSCREEN_OP_STARTED' }, ownSender, jest.fn());
    expect(ret).toBe(false);
    expect(proxyMock.markOpStarted).not.toHaveBeenCalled();
  });

  it('responds ok:false when the sign handler itself throws (never drops the response)', async () => {
    // Force an internal fault inside handleOffscreenSignRequest by feeding a
    // malformed base64 that b64ToBytes/Buffer will still process but the signer
    // rejects — simplest: make the fallback signer throw a non-classified error.
    _g.__mainTest.swSignCallback.mockRejectedValueOnce(new Error('keystore exploded'));
    const sendResponse = jest.fn();
    signListener()(
      {
        target: 'sw',
        type: 'OFFSCREEN_SIGN_REQUEST',
        op_id: 'op-y',
        sign_id: 'sign-y',
        publicKeyB64: Buffer.from([0x01]).toString('base64'),
        signingInputsB64: Buffer.from([0x02]).toString('base64')
      },
      ownSender,
      sendResponse
    );
    await flushMicro();
    // A thrown signer is classified (internal) and returned as ok:false — the
    // offscreen stub then rejects, failing the write rather than hanging.
    const resp = sendResponse.mock.calls[0][0];
    expect(resp.ok).toBe(false);
    expect(resp.sign_id).toBe('sign-y');
  });
});
