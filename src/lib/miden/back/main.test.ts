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
  resetSyncBackoffForEndpointChange: jest.fn(),
  startTransactionProcessing: jest.fn(),
  resetMidenClient: jest.fn(),
  loadEndpointOverrides: jest.fn(),
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
  doSync: (force?: boolean) => (globalThis as any).__mainTest.doSync(force),
  resetSyncBackoffForEndpointChange: () => (globalThis as any).__mainTest.resetSyncBackoffForEndpointChange()
}));

jest.mock('./transaction-processor', () => ({
  startTransactionProcessing: () => (globalThis as any).__mainTest.startTransactionProcessing(),
  // The reverse-IPC sign handler's fallback signer (issue #260, slice 5).
  swSignCallback: (...a: any[]) => (globalThis as any).__mainTest.swSignCallback(...a)
}));

// Keep the REAL proxy (handleOffscreenSignRequest / midenClientProxy) but replace
// the two FIRE-AND-FORGET handlers with spies so the reverse-IPC listener's routing
// of them is observable: `markOpStarted` for the OFFSCREEN_OP_STARTED execution-start
// signal (issue #260 flip-prep #3), `handleOffscreenStageEvent` for the
// OFFSCREEN_STAGE_EVENT per-step stage stamp (PR #524). `reloadOffscreenEndpointOverrides`
// is spied for the same reason — its real body is a no-op with the flag off, which
// would make "did the handler invalidate the offscreen realm?" unobservable here (the
// message itself is covered in miden-client-proxy.test.ts).
jest.mock('lib/miden/back/miden-client-proxy', () => {
  const actual = jest.requireActual('lib/miden/back/miden-client-proxy');
  return {
    ...actual,
    markOpStarted: jest.fn(),
    handleOffscreenStageEvent: jest.fn(),
    reloadOffscreenEndpointOverrides: jest.fn(async () => true)
  };
});

// The speculation singleton, made settable per test. `initSpeculationManager` returns
// null — leaving `getSpeculationManager()` null — whenever the send that would claim a
// speculation runs in the offscreen realm (issue #260), which is the extension's
// DEFAULT configuration. The real module cannot reach that state here: jsdom has no
// `chrome.offscreen`, so its gate always wires a manager and the two SPECULATE
// handlers' null branches — now the default production path — would never be executed.
_g.__mainTest.speculationManager = null;
jest.mock('lib/miden/back/speculation-manager', () => ({
  initSpeculationManager: jest.fn(() => (globalThis as any).__mainTest.speculationManager),
  getSpeculationManager: () => (globalThis as any).__mainTest.speculationManager
}));
const proxyMock: any = jest.requireMock('lib/miden/back/miden-client-proxy');

// In-memory storage so connectivity-state's mirror (the copy the popup renders, and
// the thing an SW restart leaves behind) is both harmless and READABLE here.
_g.__mainConnStore = {} as Record<string, any>;
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys)
        if (k in (globalThis as any).__mainConnStore) out[k] = (globalThis as any).__mainConnStore[k];
      return out;
    },
    set: async (items: Record<string, any>) => {
      Object.assign((globalThis as any).__mainConnStore, items);
    },
    remove: async (keys: string[]) => {
      for (const k of keys) delete (globalThis as any).__mainConnStore[k];
    }
  })
}));

// Keep the REAL connectivity-state — the listener validates against its canonical
// CONNECTIVITY_CATEGORIES list, and the tests below assert on the snapshot (and its
// storage mirror) the real mutators produce, which is the only way "the SW's node
// issue survived an offscreen prover clear" can be pinned. `applyConnectivityReport`
// is wrapped in a spy that still RUNS the real implementation, so the routing/
// validation tests can assert on the call while the behavioural ones read state.
jest.mock('lib/miden/activity/connectivity-state', () => {
  const actual = jest.requireActual('lib/miden/activity/connectivity-state');
  return {
    ...actual,
    applyConnectivityReport: jest.fn(actual.applyConnectivityReport)
  };
});
const connectivityMock: any = jest.requireMock('lib/miden/activity/connectivity-state');

// The #260 offscreen client proxy reads (getAccount/syncState/exportNote/
// getInputNoteDetails) through the `lib/...` alias of miden-client, which jest
// mocks separately from the relative specifier below; delegate the alias to the
// same mock so the proxy's flag-off passthrough hits it.
// `queueNoteImport` is the manual import's only safety net when the pipeline is
// abandoned, so it has to be observable rather than reaching the real storage queue.
const mockQueueNoteImport = jest.fn(async (_bytes: string) => {});
jest.mock('lib/miden/activity', () => ({
  queueNoteImport: (bytes: string) => mockQueueNoteImport(bytes)
}));

jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => (globalThis as any).__mainTest.client,
  getCurrentWasmLockHold: () => (globalThis as any).__mainTest.currentHold ?? null,
  // Models hold OWNERSHIP: the manual note import re-checks its hold between the import
  // and the trailing sync, so a mock that hands out no hold makes that guard throw on
  // every import and one that never revokes it makes the guard untestable.
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => {
    const hold = {};
    (globalThis as any).__mainTest.currentHold = hold;
    try {
      return await fn(hold);
    } finally {
      if ((globalThis as any).__mainTest.currentHold === hold) {
        (globalThis as any).__mainTest.currentHold = null;
      }
    }
  },
  runWhenClientIdle: () => {},
  resetMidenClient: async () => (globalThis as any).__mainTest.resetMidenClient()
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  loadEndpointOverrides: async () => (globalThis as any).__mainTest.loadEndpointOverrides()
}));

const mockOnRequest = _g.__mainTest.onRequest;
const mockBroadcast = _g.__mainTest.broadcast;
const mockStoreWatch = _g.__mainTest.storeWatch;
const mockDoSync = _g.__mainTest.doSync;
const mockStartTransactionProcessing = _g.__mainTest.startTransactionProcessing;
const mockResetMidenClient = _g.__mainTest.resetMidenClient;
const mockLoadEndpointOverrides = _g.__mainTest.loadEndpointOverrides;
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
  retryDeadletteredNotes: jest.fn(async () => ({ requeued: 2 }))
}));
const Actions: any = jest.requireMock('lib/miden/back/actions');

import { WalletMessageType } from 'lib/shared/types';

import { CONNECTIVITY_CATEGORIES } from '../activity/connectivity-state';
import { TRANSACTION_STAGES } from '../db/types';
import { MidenMessageType } from '../types';
import { start } from './main';

let dispatch: (req: any, port?: any) => Promise<any>;

/** connectivity-state mirrors to storage fire-and-forget; yield so the write lands. */
const flushStorage = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(async () => {
  jest.clearAllMocks();
  for (const k of Object.keys(_g.__mainConnStore)) delete _g.__mainConnStore[k];
  // `current` in connectivity-state is module state that nothing else here resets, and
  // the real mutators run in this suite. Reset it from the HARNESS, not as a side
  // effect of the code under test — otherwise a test's stated setup can be deleted and
  // it still passes on state leaked from the previous one.
  connectivityMock.resetConnectivityState();
  _g.__mainTest.speculationManager = null;
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

  // The connectivity snapshot is per-realm memory and therefore empty on every MV3
  // wake, but its storage mirror — the copy the popup renders — survives. Left
  // unreconciled the two disagree, and the mutators' "already clear" short-circuit
  // then swallows the clear that would repair the mirror: the banner latches an issue
  // that has already recovered. Seeding FROM the mirror fixes that without blanking
  // it, so an outage that is still happening keeps its banner across the wake.
  it('hydrates the connectivity snapshot from the durable mirror at start', async () => {
    _g.__mainConnStore[connectivityMock.CONNECTIVITY_STATE_KEY] = {
      network: { active: false, since: null },
      node: { active: true, since: 7 },
      prover: { active: false, since: null },
      resolving: { active: false, since: null }
    };

    await start();
    await flushStorage();

    // The mirrored issue survives — blanking it here is what would make a real
    // outage's banner vanish on every wake.
    expect(_g.__mainConnStore[connectivityMock.CONNECTIVITY_STATE_KEY].node.active).toBe(true);
    // ...and `current` now agrees with it, which is the point: the next successful
    // sync's clearReachabilityIssues() has something to transition.
    const snap = connectivityMock.getConnectivityState();
    expect(snap.node).toEqual({ active: true, since: 7 });
    connectivityMock.clearReachabilityIssues();
    await flushStorage();
    expect(_g.__mainConnStore[connectivityMock.CONNECTIVITY_STATE_KEY].node.active).toBe(false);
  });

  // A category this realm has already observed for itself is a FRESHER fact than the
  // pre-restart mirror, and the storage read is asynchronous — an offscreen report or
  // a sync result can land while it is in flight.
  it('does not let the mirror overwrite a category observed while it was loading', async () => {
    _g.__mainConnStore[connectivityMock.CONNECTIVITY_STATE_KEY] = {
      network: { active: false, since: null },
      node: { active: true, since: 7 },
      prover: { active: false, since: null },
      resolving: { active: false, since: null }
    };

    const started = start();
    // Same turn the hydrate read is pending in: the node came back.
    connectivityMock.clearReachabilityIssues();
    await started;
    await flushStorage();

    expect(connectivityMock.getConnectivityState().node.active).toBe(false);
    expect(_g.__mainConnStore[connectivityMock.CONNECTIVITY_STATE_KEY].node.active).toBe(false);
  });

  // Anything else under the key (an older build's shape, a hand-edited profile) must
  // not become `current` — the banner renders whatever lands there.
  it('ignores a malformed stored snapshot instead of hydrating it', async () => {
    _g.__mainConnStore[connectivityMock.CONNECTIVITY_STATE_KEY] = {
      network: { active: false, since: null },
      node: { active: 'yes', since: 7 },
      prover: { active: false, since: null },
      resolving: { active: false, since: null }
    };

    await start();

    expect(connectivityMock.getConnectivityState().node).toEqual({ active: false, since: null });
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

  it('ReloadEndpointOverridesRequest re-hydrates the override cache, resets the Miden client, and acks', async () => {
    // `start()` in beforeEach already calls loadEndpointOverrides once (see main.ts);
    // clear that call so this assertion is scoped to the dispatched request.
    mockLoadEndpointOverrides.mockClear();
    const res = await dispatch({ type: WalletMessageType.ReloadEndpointOverridesRequest });
    expect(res.type).toBe(WalletMessageType.ReloadEndpointOverridesResponse);
    expect(mockLoadEndpointOverrides).toHaveBeenCalledTimes(1);
    expect(mockResetMidenClient).toHaveBeenCalledTimes(1);
    // And the breaker/fuse state, which is a set of findings about the node the wallet
    // just stopped pointing at. A fused SW that keeps them syncs once per 30 min against
    // the new endpoint and withholds the success that is the fuse's only exit (#777).
    expect(_g.__mainTest.resetSyncBackoffForEndpointChange).toHaveBeenCalledTimes(1);
    // Before the client is replaced, so the next probe cannot be turned away by a
    // window the old node earned.
    expect(_g.__mainTest.resetSyncBackoffForEndpointChange.mock.invocationCallOrder[0]).toBeLessThan(
      mockResetMidenClient.mock.invocationCallOrder[0]
    );
  });

  // `resetMidenClient()` disposes only THIS realm's singleton. Flag-on
  // (MIDEN_USE_OFFSCREEN_CLIENT, the service worker's default) the client that
  // executes writes/syncs and talks to the node lives in the offscreen document —
  // a separate JS realm with its own override cache and its own client — so a saved
  // override that isn't pushed there never reaches the node the wallet actually uses.
  it('ReloadEndpointOverridesRequest also invalidates the OFFSCREEN realm, after re-reading the override', async () => {
    mockLoadEndpointOverrides.mockClear();
    await dispatch({ type: WalletMessageType.ReloadEndpointOverridesRequest });

    expect(proxyMock.reloadOffscreenEndpointOverrides).toHaveBeenCalledTimes(1);
    // Ordering: the SW's own cache is refreshed first, so both realms end up reading
    // the same freshly-saved override.
    expect(mockLoadEndpointOverrides.mock.invocationCallOrder[0]).toBeLessThan(
      proxyMock.reloadOffscreenEndpointOverrides.mock.invocationCallOrder[0]
    );
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

  it('ImportNoteBytesRequest stops before the sync when the hold was evicted mid-import, and queues the bytes (#777)', async () => {
    // The import is a network round trip; an eviction during it hands the mutex on
    // without stopping this callback, so the trailing `syncState` would be a WASM call
    // with no lock held. Throwing instead takes the catch that queues the bytes, so the
    // note — whose only copy can be those bytes — is preserved either way, and the
    // background pass re-imports it under a hold that is actually its own.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockClient.importNoteBytes.mockImplementationOnce(async () => {
      (globalThis as any).__mainTest.currentHold = null;
      return 'note-id-1';
    });
    mockClient.syncState.mockClear();
    mockQueueNoteImport.mockClear();

    await expect(
      dispatch({
        type: WalletMessageType.ImportNoteBytesRequest,
        noteBytes: Buffer.from([1, 2, 3]).toString('base64')
      })
    ).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    expect(mockClient.syncState).not.toHaveBeenCalled();
    // Not lost: an abandoned import is exactly the "we do not know whether this landed"
    // case the retry queue exists for.
    expect(mockQueueNoteImport).toHaveBeenCalledWith(Buffer.from([1, 2, 3]).toString('base64'));
    errorSpy.mockRestore();
  });

  // #788 follow-up: the Activity notice's Retry drains the dead-letter store in
  // the realm that owns the import pass — here, the SW.
  it('RetryDeadletteredNotesRequest runs the drain action and reports the requeued count', async () => {
    Actions.retryDeadletteredNotes.mockClear();

    const res = await dispatch({ type: WalletMessageType.RetryDeadletteredNotesRequest });

    expect(res.type).toBe(WalletMessageType.RetryDeadletteredNotesResponse);
    expect(res.requeued).toBe(2);
    expect(Actions.retryDeadletteredNotes).toHaveBeenCalledTimes(1);
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
beforeAll(() => {
  const chromeAny = (globalThis as any).chrome;
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
    expect(listener({ target: 'offscreen', type: 'OFFSCREEN_CALL' }, {}, jest.fn())).toBe(false);
    expect(listener({ type: 'OFFSCREEN_READY' }, {}, jest.fn())).toBe(false);
    expect(listener(undefined, {}, jest.fn())).toBe(false);
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
      {},
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
      {},
      sendResponse
    );
    // Fire-and-forget: no async response, so the port is NOT held open.
    expect(ret).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    // Routed to markOpStarted with the op id — NOT to the sign handler.
    expect(proxyMock.markOpStarted).toHaveBeenCalledWith('op-started-42');
    expect(_g.__mainTest.swSignCallback).not.toHaveBeenCalled();
  });

  it('ignores an OFFSCREEN_OP_STARTED with a non-string op_id (no markOpStarted, no crash)', () => {
    const ret = signListener()({ target: 'sw', type: 'OFFSCREEN_OP_STARTED' }, {}, jest.fn());
    expect(ret).toBe(false);
    expect(proxyMock.markOpStarted).not.toHaveBeenCalled();
  });

  it('routes an OFFSCREEN_STAGE_EVENT to handleOffscreenStageEvent (op_id + stage) and returns false (PR #524)', () => {
    const sendResponse = jest.fn();
    const ret = signListener()(
      { target: 'sw', type: 'OFFSCREEN_STAGE_EVENT', op_id: 'op-524', stage: 'proving' },
      {},
      sendResponse
    );
    // Fire-and-forget like the start signal: no async response, port not held open.
    expect(ret).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    // Routed to the stage handler — NOT to the sign handler or markOpStarted.
    expect(proxyMock.handleOffscreenStageEvent).toHaveBeenCalledWith('op-524', 'proving');
    expect(proxyMock.markOpStarted).not.toHaveBeenCalled();
    expect(_g.__mainTest.swSignCallback).not.toHaveBeenCalled();
  });

  it('ignores an OFFSCREEN_STAGE_EVENT missing op_id or stage (no handler call, no crash)', () => {
    expect(signListener()({ target: 'sw', type: 'OFFSCREEN_STAGE_EVENT', stage: 'proving' }, {}, jest.fn())).toBe(
      false
    );
    expect(signListener()({ target: 'sw', type: 'OFFSCREEN_STAGE_EVENT', op_id: 'op-524' }, {}, jest.fn())).toBe(false);
    expect(proxyMock.handleOffscreenStageEvent).not.toHaveBeenCalled();
  });

  // The message type declares `stage?: ITransactionStage`, but the value arrives off
  // the extension message bus — the compiler never saw it. A `typeof === 'string'`
  // narrowing therefore validates NOTHING, and whatever string arrived would be
  // written to the row as its stage, where the generating-transaction screen reads it
  // to pick the active step (and, on a Failed row, to pin the step that failed).
  it('drops an OFFSCREEN_STAGE_EVENT whose stage is not a real ITransactionStage (a string is not a stage)', () => {
    for (const stage of ['not-a-stage', '', 'Proving', 'proving ', '__proto__', 'toString']) {
      expect(
        signListener()({ target: 'sw', type: 'OFFSCREEN_STAGE_EVENT', op_id: 'op-524', stage }, {}, jest.fn())
      ).toBe(false);
    }
    expect(proxyMock.handleOffscreenStageEvent).not.toHaveBeenCalled();
  });

  it('forwards every real ITransactionStage (the check is derived from the canonical list, not a hand-copied subset)', () => {
    // Guards the other failure mode of a value check: rejecting stages that ARE real.
    // Sourced from the same tuple the union is derived from, so a stage added there
    // is exercised here automatically.
    for (const stage of TRANSACTION_STAGES) {
      signListener()({ target: 'sw', type: 'OFFSCREEN_STAGE_EVENT', op_id: 'op-524', stage }, {}, jest.fn());
    }
    expect(proxyMock.handleOffscreenStageEvent).toHaveBeenCalledTimes(TRANSACTION_STAGES.length);
    expect(proxyMock.handleOffscreenStageEvent.mock.calls.map((c: unknown[]) => c[1])).toEqual([...TRANSACTION_STAGES]);
  });

  // Connectivity reports (issue #260 single writer). The offscreen realm executes
  // the writes, so it observes prover health, but the snapshot is module-scoped and
  // mirrors to ONE shared key — so it reports here and the SW stays the only writer.
  it('applies an OFFSCREEN_CONNECTIVITY_EVENT to the SW snapshot (active → mark) and returns false', () => {
    const sendResponse = jest.fn();
    const ret = signListener()(
      { target: 'sw', type: 'OFFSCREEN_CONNECTIVITY_EVENT', category: 'prover', active: true },
      {},
      sendResponse
    );
    // Fire-and-forget like the other two signals: no response, port not held open.
    expect(ret).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(connectivityMock.applyConnectivityReport).toHaveBeenCalledWith('prover', true);
    // Routed as its own family — not to the sign handler or the stage/start signals.
    expect(proxyMock.handleOffscreenStageEvent).not.toHaveBeenCalled();
    expect(proxyMock.markOpStarted).not.toHaveBeenCalled();
    expect(_g.__mainTest.swSignCallback).not.toHaveBeenCalled();
  });

  it('applies `active: false` as a CLEAR of that one category', () => {
    expect(
      signListener()(
        { target: 'sw', type: 'OFFSCREEN_CONNECTIVITY_EVENT', category: 'node', active: false },
        {},
        jest.fn()
      )
    ).toBe(false);
    expect(connectivityMock.applyConnectivityReport).toHaveBeenCalledWith('node', false);
  });

  // Same reasoning as the stage stamp's value check: the declared type is a claim
  // about bytes off the message bus. An unvalidated category would be written into
  // the snapshot the banner renders.
  it('drops a report whose category is not a real ConnectivityCategory', () => {
    for (const category of ['not-a-category', '', 'Prover', 'prover ', '__proto__', 'toString']) {
      expect(
        signListener()({ target: 'sw', type: 'OFFSCREEN_CONNECTIVITY_EVENT', category, active: true }, {}, jest.fn())
      ).toBe(false);
    }
    expect(connectivityMock.applyConnectivityReport).not.toHaveBeenCalled();
  });

  // A missing `active` must not read as "clear" — that would let a malformed
  // message silently dismiss a live banner.
  it('drops a report whose `active` is not a boolean', () => {
    for (const active of [undefined, null, 'true', 1, 0]) {
      signListener()({ target: 'sw', type: 'OFFSCREEN_CONNECTIVITY_EVENT', category: 'prover', active }, {}, jest.fn());
    }
    expect(connectivityMock.applyConnectivityReport).not.toHaveBeenCalled();
  });

  it('accepts every real ConnectivityCategory (the check is derived from the canonical list)', () => {
    for (const category of CONNECTIVITY_CATEGORIES) {
      signListener()({ target: 'sw', type: 'OFFSCREEN_CONNECTIVITY_EVENT', category, active: true }, {}, jest.fn());
    }
    expect(connectivityMock.applyConnectivityReport.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      ...CONNECTIVITY_CATEGORIES
    ]);
  });

  // The headline user-visible property of the single-writer fix, asserted on real
  // state rather than on the spy: pre-fix BOTH realms blind-wrote the whole snapshot
  // to one storage key, so an offscreen prover SUCCESS erased a live "node
  // unreachable" banner. The report has to land per category.
  it('an offscreen prover clear leaves the node issue the SW marked standing (snapshot + mirror)', async () => {
    connectivityMock.markConnectivityIssue('node');

    signListener()(
      { target: 'sw', type: 'OFFSCREEN_CONNECTIVITY_EVENT', category: 'prover', active: false },
      {},
      jest.fn()
    );
    await flushStorage();

    const snap = connectivityMock.getConnectivityState();
    expect(snap.node.active).toBe(true);
    expect(snap.prover.active).toBe(false);
    // The mirror is what the popup renders (`use-connectivity-state` prefers it over
    // its in-memory copy on the extension), so it has to keep node too.
    expect(_g.__mainConnStore[connectivityMock.CONNECTIVITY_STATE_KEY].node.active).toBe(true);
  });

  // Drop-safety, receiving half. The offscreen realm re-sends its observation on
  // EVERY prove; `current` here is per-realm memory an MV3 eviction resets while the
  // mirror is durable, so the two routinely disagree. Applying through the ordinary
  // de-duplicating clear would see "already clear", skip the notify, and latch the
  // stale mirrored banner with no in-app recovery.
  it('a reported clear repairs a stale mirror this realm already believes clear', async () => {
    _g.__mainConnStore[connectivityMock.CONNECTIVITY_STATE_KEY] = {
      network: { active: false, since: null },
      node: { active: false, since: null },
      prover: { active: true, since: 4242 },
      resolving: { active: false, since: null }
    };
    expect(connectivityMock.getConnectivityState().prover.active).toBe(false);

    signListener()(
      { target: 'sw', type: 'OFFSCREEN_CONNECTIVITY_EVENT', category: 'prover', active: false },
      {},
      jest.fn()
    );
    await flushStorage();

    expect(_g.__mainConnStore[connectivityMock.CONNECTIVITY_STATE_KEY].prover.active).toBe(false);
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
      {},
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

/**
 * The two SPECULATE handlers, in the configuration the realm gate created (issue
 * #260): flag-on Chrome, `getSpeculationManager()` is null and both handlers must be
 * inert but still ANSWER — the popup's `requestSpeculateSend` /
 * `requestSpeculateInvalidate` are intercom requests, so a throw or a missing
 * response surfaces as a rejected request on the review screen rather than as the
 * silent no-op it is meant to be.
 */
describe('SPECULATE handlers (issue #260 realm gate)', () => {
  const params = {
    accountId: 'mtst1acct',
    recipientAccountId: 'mtst1recip',
    faucetId: 'mtst1faucet',
    noteType: 'private' as const,
    amount: '1234'
  };

  it('answers SpeculateSendRequest without throwing when there is no manager', async () => {
    expect(_g.__mainTest.speculationManager).toBeNull();
    await expect(dispatch({ type: WalletMessageType.SpeculateSendRequest, ...params })).resolves.toEqual({
      type: WalletMessageType.SpeculateSendResponse
    });
  });

  it('answers SpeculateInvalidate without throwing when there is no manager', async () => {
    expect(_g.__mainTest.speculationManager).toBeNull();
    await expect(dispatch({ type: WalletMessageType.SpeculateInvalidate })).resolves.toEqual({
      type: WalletMessageType.SpeculateInvalidateResponse
    });
  });

  // The other half: where a manager IS wired (flag-off, or a browser with no
  // chrome.offscreen) the request still has to reach it, with `amount` decoded back
  // from the string the intercom message carries into the bigint SpeculationParams
  // hashes on — a mismatch there is a guaranteed cache miss.
  it('forwards the decoded params to a wired manager, amount as a BigInt', async () => {
    const speculate = jest.fn();
    _g.__mainTest.speculationManager = { speculate, invalidate: jest.fn() };

    await dispatch({ type: WalletMessageType.SpeculateSendRequest, ...params });

    expect(speculate).toHaveBeenCalledWith({
      accountId: 'mtst1acct',
      recipientAccountId: 'mtst1recip',
      faucetId: 'mtst1faucet',
      noteType: 'private',
      amount: 1234n
    });
  });

  it('forwards SpeculateInvalidate to a wired manager', async () => {
    const invalidate = jest.fn();
    _g.__mainTest.speculationManager = { speculate: jest.fn(), invalidate };

    await dispatch({ type: WalletMessageType.SpeculateInvalidate });

    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
