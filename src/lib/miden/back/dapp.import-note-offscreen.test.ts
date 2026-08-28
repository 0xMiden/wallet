/* eslint-disable import/first */
/**
 * dApp import-private-note → offscreen proxy routing (issue #260, slice 7c, TARGET 1).
 *
 * `generatePromisifyImportPrivateNote` imports a claimable private note the dApp
 * handed over (its bytes are the note's only copy). Before 7c the confirm handler
 * ran a RAW `getMidenClient().importNoteBytes(...)` + `.syncState()`. Flag-ON that
 * lands the note in the DORMANT SW client's store — the realm that syncs and
 * consumes is the OFFSCREEN one, so it never sees the note and the note is
 * unclaimable. 7c routes the import through `midenClientProxy.importNoteBytes` +
 * `midenClientProxy.syncState` (both already exist — slice 7a), so flag-ON the note
 * lands in the offscreen store.
 *
 * This suite mocks the proxy with spies and asserts the WIRING: the confirm handler
 * calls the proxy (importNoteBytes then syncState) and NEVER the raw SW client
 * directly. The proxy's own flag-OFF byte-identity + flag-ON offscreen dispatch is
 * proven in miden-client-proxy.test.ts; the flag-OFF byte-identity of THIS call site
 * (real proxy passthrough → raw getMidenClient) is proven by the confirmed-import
 * test in dapp.extension.test.ts, which stays green under this change.
 */

import { MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { MidenMessageType } from 'lib/miden/types';

const _g = globalThis as any;
_g.__dappImportNoteTest = {
  intercomListeners: [] as Array<(req: any, port?: any) => Promise<any> | any>,
  storage: {} as Record<string, any>,
  // The RAW SW client. Its importNoteBytes / syncState are spies that MUST NOT be
  // invoked flag-ON — the whole point of 7c is that the note does not land here.
  midenClient: {
    getAccount: jest.fn(),
    getConsumableNoteDtos: jest.fn(async () => []),
    syncState: jest.fn(async () => {}),
    importNoteBytes: jest.fn(async () => 'RAW-SW-CLIENT-NOTE-ID'),
    on: jest.fn()
  }
};

// The offscreen proxy — spies. importNoteBytes returns a DISTINCT id so the
// response can be traced back to the proxy (not the raw client).
const mockProxyImportNoteBytes = jest.fn(async (_bytes: Uint8Array) => 'OFFSCREEN-NOTE-ID');
const mockProxySyncState = jest.fn(async (..._a: unknown[]) => {});
jest.mock('./miden-client-proxy', () => ({
  midenClientProxy: {
    importNoteBytes: (...a: unknown[]) => mockProxyImportNoteBytes(...(a as [Uint8Array])),
    syncState: (...a: unknown[]) => mockProxySyncState(...a),
    getAccount: jest.fn(async () => null),
    getInputNoteDetails: jest.fn(async () => []),
    getConsumableNotes: jest.fn(async () => [])
  }
}));

const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) =>
  fn({ vault: { signData: jest.fn(async () => 'fake-signature-base64') } })
);
jest.mock('lib/miden/back/store', () => ({
  store: { getState: () => ({ currentAccount: { publicKey: 'miden-account-1' }, status: 'Ready' }) },
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn)
}));

jest.mock('lib/miden/transaction', () => ({
  initiateSendTransaction: jest.fn().mockResolvedValue('tx-send-1'),
  requestCustomTransaction: jest.fn().mockResolvedValue('tx-custom-1'),
  initiateConsumeTransactionFromId: jest.fn().mockResolvedValue('tx-consume-1'),
  waitForTransactionCompletion: jest.fn().mockResolvedValue({ status: 'success' })
}));

jest.mock('lib/miden/activity', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/back/transaction-processor', () => ({ startTransactionProcessing: jest.fn() }));

jest.mock('lib/platform', () => ({
  isExtension: () => true,
  isDesktop: () => false,
  isMobile: () => false
}));

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys) out[k] = _g.__dappImportNoteTest.storage[k];
      return out;
    },
    set: async (kv: Record<string, any>) => Object.assign(_g.__dappImportNoteTest.storage, kv),
    delete: async (keys: string[]) => {
      for (const k of keys) delete _g.__dappImportNoteTest.storage[k];
    }
  })
}));

jest.mock('lib/miden/metadata/utils', () => ({ getTokenMetadata: jest.fn(async () => ({ decimals: 6 })) }));
jest.mock('lib/i18n/numbers', () => ({ formatBigInt: (v: bigint) => v.toString() }));

jest.mock('lib/dapp-browser/confirmation-store', () => ({
  dappConfirmationStore: {
    requestConfirmation: jest.fn(),
    resolveConfirmation: jest.fn(),
    hasPendingRequest: jest.fn(() => false),
    getPendingRequest: jest.fn(() => null),
    getAllPendingRequests: jest.fn(() => []),
    subscribe: jest.fn(() => () => undefined),
    getInstanceId: () => 'test-store'
  }
}));

jest.mock('lib/miden/back/defaults', () => ({
  intercom: {
    onRequest: jest.fn((cb: (req: any, port?: any) => any) => {
      _g.__dappImportNoteTest.intercomListeners.push(cb);
      return () => {
        const list = _g.__dappImportNoteTest.intercomListeners;
        const idx = list.indexOf(cb);
        if (idx !== -1) list.splice(idx, 1);
      };
    }),
    broadcast: jest.fn()
  }
}));

const mockGetCurrentAccountPublicKey = jest.fn();
jest.mock('lib/miden/back/vault', () => ({
  Vault: { getCurrentAccountPublicKey: (...args: unknown[]) => mockGetCurrentAccountPublicKey(...args) }
}));

// Bridge the alias → relative specifier so any residual passthrough hits the same
// raw-client mock (there should be none on the import path after 7c).
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
// Models hold OWNERSHIP (#788 follow-up): the lock hands its callback a hold, and
// `importDAppPrivateNote` re-checks it via `assertWasmHoldCurrent` between the
// import and its sync. The assert re-implements the real comparison (a no-op
// would make the eviction test below vacuous) and throws the REAL poison class
// so the queue-on-abandonment gate classifies it as it would in production.
let currentWasmHold: object | null = null;
// Simulates the watchdog handing the mutex to a successor while the current client
// call is still parked — call from inside a client-method mock.
const revokeWasmHold = (): void => {
  currentWasmHold = null;
};
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => (globalThis as any).__dappImportNoteTest.midenClient,
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => {
    const hold = { mock: 'wasm-lock-hold' };
    currentWasmHold = hold;
    try {
      return await fn(hold);
    } finally {
      if (currentWasmHold === hold) currentWasmHold = null;
    }
  },
  getCurrentWasmLockHold: () => currentWasmHold,
  assertWasmHoldCurrent: (hold: object | null, where: string): void => {
    if (hold !== null && hold === currentWasmHold) return;
    throw new WasmClientPoisonedError('watchdog', new Error(`operation abandoned ${where}`));
  },
  runWhenClientIdle: () => {}
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: () => 'bech32-addr',
  sameWalletAccountId: (a: string, b: string) => (a.split('_')[0] ?? a) === (b.split('_')[0] ?? b)
}));

jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));

jest.mock('webextension-polyfill', () => {
  const removedListeners: any[] = [];
  const noopEvt = { addListener: jest.fn(), removeListener: jest.fn() };
  const browser = {
    runtime: {
      getPlatformInfo: async () => ({ os: 'mac' }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: noopEvt,
      onInstalled: noopEvt,
      onUpdateAvailable: noopEvt,
      sendMessage: jest.fn(),
      connect: jest.fn(() => ({ onMessage: noopEvt, onDisconnect: noopEvt, postMessage: jest.fn() })),
      getManifest: () => ({ manifest_version: 3 })
    },
    windows: {
      create: jest.fn(async () => ({ id: 999, left: 0, state: 'normal' })),
      get: jest.fn(async () => ({ id: 999 })),
      remove: jest.fn(async () => {}),
      update: jest.fn(async () => {}),
      getLastFocused: jest.fn(async () => ({ left: 0, top: 0, width: 1024, height: 768 })),
      onRemoved: {
        addListener: (cb: any) => removedListeners.push(cb),
        removeListener: (cb: any) => {
          const idx = removedListeners.indexOf(cb);
          if (idx !== -1) removedListeners.splice(idx, 1);
        }
      }
    },
    storage: { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } },
    tabs: { create: jest.fn(), query: jest.fn(async () => []), remove: jest.fn() }
  };
  return { __esModule: true, default: browser, ...browser };
});

import * as dapp from './dapp';
import { OperationAbortedError } from './offscreen-codec';

const STORAGE_KEY = 'dapp_sessions';
const SESSION = {
  network: 'testnet',
  appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
  accountId: 'miden-account-1',
  privateDataPermission: 'UPON_REQUEST',
  allowedPrivateData: 0,
  publicKey: 'miden-account-1'
};

beforeEach(() => {
  jest.clearAllMocks();
  _g.__dappImportNoteTest.intercomListeners.length = 0;
  for (const k of Object.keys(_g.__dappImportNoteTest.storage)) delete _g.__dappImportNoteTest.storage[k];
  _g.__dappImportNoteTest.storage[STORAGE_KEY] = { 'https://miden.xyz': [SESSION] };
  mockGetCurrentAccountPublicKey.mockResolvedValue('miden-account-1');
  process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
});

afterEach(() => {
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
});

/** Drive the full request → confirm → resolve cycle (extension mode). */
async function driveConfirmation(
  start: () => Promise<any>,
  confirmRequestType: MidenMessageType,
  extraConfirmFields: Record<string, any> = { confirmed: true }
) {
  const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
  const startCallCount = browser.windows.create.mock.calls.length;
  const promise = start();
  await new Promise(r => setTimeout(r, 0));
  if (browser.windows.create.mock.calls.length === startCallCount) {
    throw new Error('windows.create was not called by start()');
  }
  const lastCall = browser.windows.create.mock.calls[browser.windows.create.mock.calls.length - 1];
  const url = lastCall[0].url;
  const id = url.match(/[?&]id=([^&]+)/)![1];
  const port = { id: 'fake-port' };
  const listener = _g.__dappImportNoteTest.intercomListeners[_g.__dappImportNoteTest.intercomListeners.length - 1];
  await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);
  await listener({ type: confirmRequestType, id, ...extraConfirmFields }, port);
  return promise;
}

describe('dApp import-private-note leaf → offscreen proxy (flag ON)', () => {
  it('routes the confirmed import through midenClientProxy.importNoteBytes + syncState, never the raw SW client', async () => {
    // 'aGVsbG8=' decodes to the bytes of "hello" — the exact bytes the proxy must receive.
    const noteB64 = 'aGVsbG8=';
    const expectedBytes = Array.from(Buffer.from('hello'));

    const res = await driveConfirmation(
      () =>
        dapp.requestImportPrivateNote('https://miden.xyz', {
          type: MidenDAppMessageType.ImportPrivateNoteRequest,
          sourcePublicKey: 'miden-account-1',
          note: noteB64
        } as never),
      MidenMessageType.DAppImportPrivateNoteConfirmationRequest
    );

    // The import + sync crossed the offscreen proxy…
    expect(mockProxyImportNoteBytes).toHaveBeenCalledTimes(1);
    expect(Array.from(mockProxyImportNoteBytes.mock.calls[0]![0])).toEqual(expectedBytes);
    expect(mockProxySyncState).toHaveBeenCalledTimes(1);
    // …in the right order (import THEN sync).
    expect(mockProxyImportNoteBytes.mock.invocationCallOrder[0]!).toBeLessThan(
      mockProxySyncState.mock.invocationCallOrder[0]!
    );

    // …and NEVER the raw SW client (which flag-ON is the dormant store).
    expect(_g.__dappImportNoteTest.midenClient.importNoteBytes).not.toHaveBeenCalled();
    expect(_g.__dappImportNoteTest.midenClient.syncState).not.toHaveBeenCalled();

    // The response carries the id the OFFSCREEN import returned, not the raw client's.
    expect(res.type).toBe(MidenDAppMessageType.ImportPrivateNoteResponse);
    expect((res as any).noteId).toBe('OFFSCREEN-NOTE-ID');
  });

  it.each([
    ['a watchdog eviction', () => new WasmClientPoisonedError('watchdog')],
    ['an offscreen deadline kill', () => new OperationAbortedError('op-7', 'deadline')]
  ])('queues the note for background retry after %s (#777)', async (_label, makeError) => {
    // The queue exists for exactly this: "we do not know whether this landed". Both kill
    // shapes say that, and before #777 an eviction took the not-transient path and dropped
    // the bytes from the one mechanism built to preserve them — which for a private note
    // the dApp handed over can be the only surviving copy of the funds it carries.
    //
    // Honest about what each leg proves: the POISON leg falsifies the gate (its message is
    // closed wallet-authored text that `isLikelyNetworkError` does not match, so the clause
    // is the only thing queueing it). The ABORT leg does not, because 'aborted' is in its
    // message and the classifier tokenises on that — it is a redundancy check, kept so the
    // shape stays covered if that token list is ever re-tuned.
    const { queueNoteImport } = require('lib/miden/activity');
    queueNoteImport.mockClear();
    queueNoteImport.mockResolvedValue(undefined);
    mockProxyImportNoteBytes.mockRejectedValueOnce(makeError());

    await expect(
      driveConfirmation(
        () =>
          dapp.requestImportPrivateNote('https://miden.xyz', {
            type: MidenDAppMessageType.ImportPrivateNoteRequest,
            sourcePublicKey: 'miden-account-1',
            note: 'aGVsbG8='
          } as never),
        MidenMessageType.DAppImportPrivateNoteConfirmationRequest
      )
    ).rejects.toBeDefined();

    expect(queueNoteImport).toHaveBeenCalledTimes(1);
    expect(queueNoteImport).toHaveBeenCalledWith('aGVsbG8=');
  });

  it('an eviction between the import and its sync queues the note and never runs the dead sync (#788)', async () => {
    // The import itself lands, but while it was parked the watchdog handed the
    // mutex to a successor: ownership is gone by the time the callback resumes,
    // so the follow-up sync would borrow a client somebody else is inside.
    const { queueNoteImport } = require('lib/miden/activity');
    queueNoteImport.mockClear();
    queueNoteImport.mockResolvedValue(undefined);
    mockProxyImportNoteBytes.mockImplementationOnce(async () => {
      revokeWasmHold();
      return 'OFFSCREEN-NOTE-ID';
    });

    await expect(
      driveConfirmation(
        () =>
          dapp.requestImportPrivateNote('https://miden.xyz', {
            type: MidenDAppMessageType.ImportPrivateNoteRequest,
            sourcePublicKey: 'miden-account-1',
            note: 'aGVsbG8='
          } as never),
        MidenMessageType.DAppImportPrivateNoteConfirmationRequest
      )
      // The poison reaches the dApp AS poison. Rewritten to `INVALID_PARAMS` it
      // told the site its note was malformed — a verdict nobody reached — when
      // the truth is that the outcome is unknown and a retry is warranted.
    ).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    // The dead sync must not run…
    expect(mockProxySyncState).not.toHaveBeenCalled();
    // …and the note still reaches the background-retry queue: whether the import
    // landed is unknown, and these bytes can be the only copy of the funds.
    expect(queueNoteImport).toHaveBeenCalledTimes(1);
    expect(queueNoteImport).toHaveBeenCalledWith('aGVsbG8=');
  });

  it('does NOT queue the note when the import failed for a non-abandonment reason', async () => {
    // The falsifier for the pair above: a deterministic rejection is not "unknown
    // whether it landed", and queueing it would retry a note the SDK refused on its
    // merits every lap.
    const { queueNoteImport } = require('lib/miden/activity');
    queueNoteImport.mockClear();
    mockProxyImportNoteBytes.mockRejectedValueOnce(new Error('malformed note'));

    await expect(
      driveConfirmation(
        () =>
          dapp.requestImportPrivateNote('https://miden.xyz', {
            type: MidenDAppMessageType.ImportPrivateNoteRequest,
            sourcePublicKey: 'miden-account-1',
            note: 'aGVsbG8='
          } as never),
        MidenMessageType.DAppImportPrivateNoteConfirmationRequest
      )
    ).rejects.toBeDefined();

    expect(queueNoteImport).not.toHaveBeenCalled();
  });

  it('a decline never touches the proxy import path', async () => {
    await expect(
      driveConfirmation(
        () =>
          dapp.requestImportPrivateNote('https://miden.xyz', {
            type: MidenDAppMessageType.ImportPrivateNoteRequest,
            sourcePublicKey: 'miden-account-1',
            note: 'aGVsbG8='
          } as never),
        MidenMessageType.DAppImportPrivateNoteConfirmationRequest,
        { confirmed: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);

    expect(mockProxyImportNoteBytes).not.toHaveBeenCalled();
    expect(mockProxySyncState).not.toHaveBeenCalled();
  });
});
