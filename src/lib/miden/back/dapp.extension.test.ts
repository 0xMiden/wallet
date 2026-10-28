/* eslint-disable import/first */
/**
 * Extension-mode coverage tests for `lib/miden/back/dapp.ts`.
 *
 * Mocks `isExtension()` as true and stubs `browser.windows.*`,
 * `intercom.onRequest`, and `getMidenClient` so the request* functions
 * actually drive the `requestConfirm` flow end-to-end.
 *
 * For each happy-path test we capture the registered intercom listener
 * via the mock, then synthetically post a confirmation message back to
 * trigger the resolve / reject branches inside generatePromisify*.
 */

import { NoteFilterTypes, NoteType, Poseidon2, Word } from '@miden-sdk/miden-sdk/lazy';
import { WalletAdapterNetwork } from '@miden-sdk/miden-wallet-adapter-base';
import extensionBrowser, { type Windows } from 'webextension-polyfill';

import { MidenDAppConsumeRequest, MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';
import { startTransactionProcessing } from 'lib/miden/back/transaction-processor';
import * as noteQuarantine from 'lib/miden/note-quarantine';
import * as Repo from 'lib/miden/repo';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { requestCustomTransaction } from 'lib/miden/transaction';
import { TransactionQueuedError } from 'lib/miden/transaction/initiate';
import { MidenMessageType } from 'lib/miden/types';
import { WalletStatus } from 'lib/shared/types';

// ── Capture intercom listeners via the mock ────────────────────────
const _g = globalThis as any;
_g.__dappExtTest = {
  intercomListeners: [] as Array<(req: any, port?: any) => Promise<any> | any>,
  storage: {} as Record<string, any>,
  midenClient: {
    getAccount: jest.fn(),
    getInputNote: jest.fn(),
    getInputNoteDetails: jest.fn(),
    getConsumableNotes: jest.fn(),
    // Slice-4: dapp reads consumable notes as DTOs via the proxy (flag-off →
    // getMidenClient().getConsumableNoteDtos()).
    getConsumableNoteDtos: jest.fn(async () => []),
    getDetailsCommitmentMatches: jest.fn(),
    syncState: jest.fn(),
    importNoteBytes: jest.fn(),
    on: jest.fn()
  }
};
_g.__dappExtTestStoreListeners = new Set<(state: unknown) => void>();

const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) =>
  fn({
    vault: {
      signData: jest.fn(async () => 'fake-signature-base64')
    }
  })
);
const mockFetchAccounts = jest.fn(async () => [] as unknown[]);
// What an unlocked store hands `withUnlocked`'s callback here.
const unlockedContext = () => ({
  vault: {
    signData: jest.fn(async () => 'fake-signature-base64'),
    fetchAccounts: mockFetchAccounts
  }
});

jest.mock('lib/telemetry/transaction-failure', () => ({
  ...jest.requireActual('lib/telemetry/transaction-failure'),
  reportTransactionFailure: jest.fn(jest.requireActual('lib/telemetry/transaction-failure').reportTransactionFailure)
}));
jest.mock('./background-notification', () => ({
  ...jest.requireActual('./background-notification'),
  notifyBackgroundTransactionFailed: jest.fn(
    jest.requireActual('./background-notification').notifyBackgroundTransactionFailed
  )
}));

jest.mock('../transaction/claim-fee', () => ({
  ...jest.requireActual('../transaction/claim-fee'),
  readClaimFeeContext: jest.fn(jest.requireActual('../transaction/claim-fee').readClaimFeeContext)
}));

jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({
      currentAccount: { publicKey: (globalThis as any).__dappExtTestCurrentAccount ?? 'miden-account-1' },
      status: (globalThis as any).__dappExtTestStatus ?? 'Ready'
    }),
    // Drives `waitForUnlock`: `unlockWallet()` below notifies these the way the real store's updates do.
    updates: {
      watch: (listener: (state: unknown) => void) => {
        (globalThis as any).__dappExtTestStoreListeners.add(listener);
        return () => (globalThis as any).__dappExtTestStoreListeners.delete(listener);
      }
    }
  },
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn)
}));

// Passthrough wrappers, so a test can count the carried-note quarantine release while every other test keeps the real
// module (its exports are not configurable, so they cannot be spied on).
jest.mock('lib/miden/note-quarantine', () => {
  const actual = jest.requireActual('lib/miden/note-quarantine');
  return {
    ...actual,
    importedNoteIds: jest.fn(actual.importedNoteIds),
    releaseNoteIds: jest.fn(actual.releaseNoteIds)
  };
});
jest.mock('lib/miden/transaction', () => ({
  initiateSendTransaction: jest.fn().mockResolvedValue('tx-send-1'),
  requestCustomTransaction: jest.fn().mockResolvedValue('tx-custom-1'),
  initiateConsumeTransactionFromId: jest.fn().mockResolvedValue('tx-consume-1'),
  waitForTransactionCompletion: jest.fn().mockResolvedValue({ status: 'success' })
}));

jest.mock('lib/miden/activity', () => ({
  queueNoteImport: jest.fn()
}));

jest.mock('lib/miden/back/transaction-processor', () => ({
  startTransactionProcessing: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isExtension: () => true,
  isDesktop: () => false,
  isMobile: () => false
}));

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = (globalThis as any).__dappExtTest.storage[k];
      return out;
    },
    set: async (kv: Record<string, unknown>) => {
      Object.assign((globalThis as any).__dappExtTest.storage, kv);
    },
    delete: async (keys: string[]) => {
      for (const k of keys) delete (globalThis as any).__dappExtTest.storage[k];
    }
  })
}));

jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: jest.fn().mockResolvedValue({ decimals: 6, symbol: 'TOK' })
}));

const mockAssessOutgoingSpendingLimitDetails = jest.fn();
const mockHasSpendingLimits = jest.fn((..._args: unknown[]) => Promise.resolve(false));
jest.mock('lib/miden/spending-limits/queue', () => ({
  assessOutgoingSpendingLimitDetails: (...args: unknown[]) => mockAssessOutgoingSpendingLimitDetails(...args),
  hasSpendingLimits: (...args: unknown[]) => mockHasSpendingLimits(...args)
}));

jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: (value: bigint, _decimals: number) => value.toString()
}));

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
      (globalThis as any).__dappExtTest.intercomListeners.push(cb);
      return () => {
        const list = (globalThis as any).__dappExtTest.intercomListeners;
        const idx = list.indexOf(cb);
        if (idx !== -1) list.splice(idx, 1);
      };
    }),
    broadcast: jest.fn()
  }
}));

const mockGetCurrentAccountPublicKey = jest.fn();
jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    getCurrentAccountPublicKey: (...args: unknown[]) => mockGetCurrentAccountPublicKey(...args)
  }
}));

// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
// Models hold OWNERSHIP (#788 follow-up): the lock hands its callback a hold, and
// dapp.ts re-checks it via `assertWasmHoldCurrent` after every parking await. The
// assert re-implements the real comparison (a no-op would make the eviction tests
// below vacuous) and throws the REAL poison class so `isWasmClientPoisonedError`
// routing sees the shape the poison contract promises.
let currentWasmHold: object | null = null;
// Simulates the watchdog handing the mutex to a successor while the current client
// call is still parked — call from inside a client-method mock.
const revokeWasmHold = (): void => {
  currentWasmHold = null;
};
const mockRetireWasmClientForCaughtTrap = jest.fn();
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => (globalThis as any).__dappExtTest.midenClient,
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => {
    const hold = { mock: 'wasm-lock-hold' };
    currentWasmHold = hold;
    try {
      return await fn(hold);
    } catch (error) {
      // The real lock's caught-trap path: a callback that rejects with a trap retires the client through its holder.
      if (error instanceof WebAssembly.RuntimeError) mockRetireWasmClientForCaughtTrap(hold, error);
      throw error;
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
  // Real module underneath: `requestSendTransaction` binds the request's
  // senderAddress to the session account through `sameWalletAccountId`, and a
  // bare stub would drop that authorization check from every test here.
  ...jest.requireActual('lib/miden/sdk/helpers'),
  getBech32AddressFromAccountId: () => 'bech32-addr'
}));

// Stub the wallet adapter package's enums (jest can't destructure the .mjs build).
jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 },
  WalletAdapterNetwork: { Testnet: 'testnet' }
}));

// Provide a richer browser stub than the default __mocks__/webextension-polyfill.
jest.mock('webextension-polyfill', () => {
  // Exposed so a test can close the confirm window the way the user does.
  const removedListeners: any[] = ((globalThis as any).__dappExtRemovedListeners = []);
  const noopEvt = { addListener: jest.fn(), removeListener: jest.fn() };
  const browser = {
    runtime: {
      getPlatformInfo: async () => ({ os: 'mac' }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: noopEvt,
      onInstalled: noopEvt,
      onUpdateAvailable: noopEvt,
      sendMessage: jest.fn(),
      connect: jest.fn(() => ({
        onMessage: noopEvt,
        onDisconnect: noopEvt,
        postMessage: jest.fn()
      })),
      getManifest: () => ({ manifest_version: 3 })
    },
    windows: {
      create: jest.fn(async () => ({ id: 999, left: 0, state: 'normal' })),
      get: jest.fn(async () => ({ id: 999 })),
      remove: jest.fn(async () => {}),
      update: jest.fn(async () => {}),
      getLastFocused: jest.fn(async () => ({ type: 'normal', left: 0, top: 0, width: 1024, height: 768 })),
      getAll: jest.fn(async () => []),
      onRemoved: {
        addListener: (cb: any) => removedListeners.push(cb),
        removeListener: (cb: any) => {
          const idx = removedListeners.indexOf(cb);
          if (idx !== -1) removedListeners.splice(idx, 1);
        }
      }
    },
    storage: {
      local: {
        get: jest.fn(async () => ({})),
        set: jest.fn(async () => {})
      }
    },
    tabs: {
      create: jest.fn(),
      query: jest.fn(async () => []),
      remove: jest.fn()
    }
  };
  return { __esModule: true, default: browser, ...browser };
});

import * as dapp from './dapp';
import { _resetLockedPromptCooldownsForTest } from './dapp-locked';
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
  _resetLockedPromptCooldownsForTest();
  jest.clearAllMocks();
  // The consume approval preview is derived from the note the wallet resolves, not
  // from the dApp's declared faucet/amount/type, so consume tests need the note to
  // exist in the store (note-1 / faucet-1 / 50, matching their request fixtures).
  _g.__dappExtTest.midenClient.getInputNoteDetails = jest.fn().mockResolvedValue([
    {
      noteId: 'note-1',
      noteType: 0,
      senderAccountId: 's1',
      nullifier: 'nf1',
      state: 0,
      assets: [{ faucetId: 'faucet-1', amount: '50' }],
      nonFungibleAssets: []
    }
  ]);
  // No record has a consume request's id as its details commitment unless a test says so (#1389).
  _g.__dappExtTest.midenClient.getDetailsCommitmentMatches = jest
    .fn()
    .mockResolvedValue([{ notes: [], uncommitted: 0 }]);
  _g.__dappExtTest.intercomListeners.length = 0;
  for (const k of Object.keys(_g.__dappExtTest.storage)) delete _g.__dappExtTest.storage[k];
  _g.__dappExtTest.storage[STORAGE_KEY] = { 'https://miden.xyz': [SESSION] };
  mockGetCurrentAccountPublicKey.mockResolvedValue('miden-account-1');
  mockAssessOutgoingSpendingLimitDetails.mockResolvedValue(undefined);
  _g.__dappExtTestCurrentAccount = 'miden-account-1';
  delete _g.__dappExtTestStatus;
  _g.__dappExtTestStoreListeners.clear();
  _g.__dappExtRemovedListeners.length = 0;
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn(unlockedContext()));
});

/** Drive the most recently registered intercom listener with a synthetic confirmation. */
// @ts-ignore — kept for reference

describe('requestConfirm window-position fallback', () => {
  it('keeps a confirmation onscreen when the focused window has no dimensions', async () => {
    const focused = jest.mocked(extensionBrowser.windows.getLastFocused);
    const create = jest.mocked(extensionBrowser.windows.create);
    const update = jest.mocked(extensionBrowser.windows.update);
    const originalUpdate = update.getMockImplementation();
    focused.mockResolvedValueOnce({
      id: 1,
      type: 'normal',
      focused: true,
      incognito: false,
      alwaysOnTop: false,
      left: 0,
      top: 0,
      width: 0,
      height: 0
    });
    create.mockResolvedValueOnce({ id: 999, focused: true, incognito: false, alwaysOnTop: false, left: 20, top: 20 });
    update.mockImplementationOnce(async (_id, bounds) => {
      const left = bounds.left ?? 0;
      const top = bounds.top ?? 0;
      const width = create.mock.calls.at(-1)?.[0]?.width ?? 0;
      const height = create.mock.calls.at(-1)?.[0]?.height ?? 0;
      const visibleWidth = Math.max(0, Math.min(1600, left + width) - Math.max(0, left));
      const visibleHeight = Math.max(0, Math.min(1200, top + height) - Math.max(0, top));
      if (visibleWidth * visibleHeight < (width * height) / 2) {
        throw new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.');
      }
      return { id: 999, focused: true, incognito: false, alwaysOnTop: false, left, top };
    });
    try {
      const result = await driveConfirmation(
        () =>
          dapp
            .requestSign('https://miden.xyz', {
              type: MidenDAppMessageType.SignRequest,
              sourcePublicKey: 'miden-account-1',
              sourceAccountId: 'miden-account-1',
              payload: 'aGVsbG8=',
              kind: 'word'
            })
            .then(
              () => 'approved',
              (error: unknown) => (error instanceof Error ? error.message : String(error))
            ),
        MidenMessageType.DAppSignConfirmationRequest,
        { confirmed: false }
      );
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ left: 20, top: 20 }));
      expect(result).toBe(MidenDAppErrorType.NotGranted);
      expect(update).not.toHaveBeenCalled();
    } finally {
      update.mockReset();
      if (originalUpdate) update.mockImplementation(originalUpdate);
    }
  });

  it('updates the window position when create returns the wrong left coordinate', async () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    browser.windows.create.mockResolvedValueOnce({ id: 999, left: 99999, state: 'normal' });
    const p = dapp.requestSign('https://miden.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'miden-account-1',
      sourceAccountId: 'miden-account-1',
      payload: 'aGVsbG8=',
      kind: 'word'
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(browser.windows.update).toHaveBeenCalled();
    p.catch(() => {});
  });

  it('triggers decline when the user closes the confirm window manually', async () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    browser.windows.create.mockResolvedValueOnce({ id: 1234, left: 0, state: 'normal' });
    // Restored below: later tests close their windows through the suite's own listeners.
    const { addListener, removeListener } = browser.windows.onRemoved;
    let listener: ((winId: number) => void) | null = null;
    browser.windows.onRemoved.addListener = (cb: any) => {
      listener = cb;
    };
    browser.windows.onRemoved.removeListener = jest.fn();
    try {
      const p = dapp.requestSign('https://miden.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: 'miden-account-1',
        sourceAccountId: 'miden-account-1',
        payload: 'aGVsbG8=',
        kind: 'word'
      } as never);
      await new Promise(r => setTimeout(r, 0));
      expect(listener).not.toBeNull();
      // Trigger the window-removed handler
      listener!(1234);
      await expect(p).rejects.toThrow();
    } finally {
      browser.windows.onRemoved.addListener = addListener;
      browser.windows.onRemoved.removeListener = removeListener;
    }
  });
});

describe('requestConfirm placement Chrome refuses', () => {
  const BOUNDS_REFUSAL = 'Invalid value for bounds. Bounds must be at least 50% within visible screen space.';
  const create = jest.mocked(extensionBrowser.windows.create);
  const update = jest.mocked(extensionBrowser.windows.update);
  const get = jest.mocked(extensionBrowser.windows.get);
  const remove = jest.mocked(extensionBrowser.windows.remove);
  const focused = jest.mocked(extensionBrowser.windows.getLastFocused);
  const getAll = jest.mocked(extensionBrowser.windows.getAll);
  const defaults = {
    create: create.getMockImplementation(),
    update: update.getMockImplementation(),
    get: get.getMockImplementation(),
    focused: focused.getMockImplementation(),
    getAll: getAll.getMockImplementation()
  };

  afterEach(() => {
    // clearAllMocks keeps a one-off answer a test left unused, and it would answer a later test's call.
    create.mockReset();
    update.mockReset();
    get.mockReset();
    focused.mockReset();
    getAll.mockReset();
    if (defaults.create) create.mockImplementation(defaults.create);
    if (defaults.update) update.mockImplementation(defaults.update);
    if (defaults.get) get.mockImplementation(defaults.get);
    if (defaults.focused) focused.mockImplementation(defaults.focused);
    if (defaults.getAll) getAll.mockImplementation(defaults.getAll);
  });

  const windowAt = (fields: Partial<Windows.Window>): Windows.Window => ({
    focused: true,
    incognito: false,
    alwaysOnTop: false,
    ...fields
  });
  const settle = (request: Promise<unknown>) =>
    request.then(
      () => 'answered',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
  const sign = () =>
    dapp.requestSign('https://miden.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'miden-account-1',
      sourceAccountId: 'miden-account-1',
      payload: 'aGVsbG8=',
      kind: 'word'
    });
  const connect = (origin: string) =>
    dapp.requestPermission(origin, {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name: 'New Dapp', url: origin },
      force: false,
      network: 'testnet',
      privateDataPermission: 'UPON_REQUEST',
      allowedPrivateData: 0
    } as never);
  const declineSign = () =>
    driveConfirmation(() => settle(sign()), MidenMessageType.DAppSignConfirmationRequest, { confirmed: false });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  // The MV3 service worker has no `window`, so reading its geometry there throws.
  const WINDOW_GEOMETRY = ['screenX', 'screenY', 'outerWidth', 'outerHeight'];
  async function withoutWindowGeometry<T>(run: () => Promise<T>): Promise<T> {
    const saved = WINDOW_GEOMETRY.map((key): [string, PropertyDescriptor | undefined] => [
      key,
      Object.getOwnPropertyDescriptor(window, key)
    ]);
    for (const key of WINDOW_GEOMETRY) {
      Object.defineProperty(window, key, {
        configurable: true,
        get: () => {
          throw new ReferenceError('window is not defined');
        }
      });
    }
    try {
      return await run();
    } finally {
      for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(window, key, descriptor);
    }
  }

  type RefusedMove = {
    request: string;
    start: () => Promise<unknown>;
    confirmation: MidenMessageType;
    decline: Record<string, unknown>;
  };
  it.each<RefusedMove>([
    {
      request: 'sign',
      start: sign,
      confirmation: MidenMessageType.DAppSignConfirmationRequest,
      decline: { confirmed: false }
    },
    {
      request: 'connect',
      start: () => connect('https://moved-dapp.xyz'),
      confirmation: MidenMessageType.DAppPermConfirmationRequest,
      decline: { confirmed: false, accountPublicKey: '' }
    }
  ])('a $request decline closes a popup Chrome refused to move', async ({ start, confirmation, decline }) => {
    // Chrome placed the window elsewhere, then refuses the move because the window is mostly off-screen at its size.
    create.mockResolvedValueOnce(windowAt({ id: 4321, left: 900, top: 186, state: 'normal' }));
    update.mockRejectedValueOnce(new Error(BOUNDS_REFUSAL));
    get.mockImplementationOnce(async id => windowAt({ id }));

    const answer = await driveConfirmation(() => settle(start()), confirmation, decline);
    await flush();

    expect(update).toHaveBeenCalledWith(4321, { left: 292, top: 20 });
    expect(answer).toBe(MidenDAppErrorType.NotGranted);
    expect(remove).toHaveBeenCalledWith(4321);
    expect(_g.__dappExtRemovedListeners).toHaveLength(0);
  });

  it('a decline while Chrome is still moving the popup closes it', async () => {
    let finishMove: () => void = () => undefined;
    create.mockResolvedValueOnce(windowAt({ id: 4321, left: 900, top: 186, state: 'normal' }));
    update.mockImplementationOnce(
      () => new Promise<Windows.Window>(resolve => (finishMove = () => resolve(windowAt({ id: 4321 }))))
    );
    get.mockImplementationOnce(async id => windowAt({ id }));

    const answer = await declineSign();
    await flush();
    finishMove();

    expect(answer).toBe(MidenDAppErrorType.NotGranted);
    expect(remove).toHaveBeenCalledWith(4321);
  });

  it('answers a connect whose popup cannot be opened instead of leaving it pending', async () => {
    create.mockRejectedValueOnce(new Error('Extension context invalidated.'));
    const pending = new Promise<string>(resolve => setTimeout(() => resolve('pending'), 50));

    const answer = await Promise.race([settle(connect('https://unopened-dapp.xyz')), pending]);

    expect(answer).toBe('Extension context invalidated.');
    expect(create).toHaveBeenCalledTimes(1);
  });

  const browserWindow = windowAt({
    id: 1,
    type: 'normal',
    focused: false,
    left: 100,
    top: 50,
    width: 1200,
    height: 900
  });
  const otherBrowserWindow = windowAt({
    id: 4,
    type: 'normal',
    focused: false,
    left: 0,
    top: 0,
    width: 640,
    height: 480
  });
  const approvalPopup = windowAt({ id: 2, type: 'popup', left: 918, top: 186, width: 1288, height: 851 });

  type BrowserWindows = { anchor: string; browserWindows: Windows.Window[] };
  it.each<BrowserWindows>([
    { anchor: 'the focused browser window', browserWindows: [otherBrowserWindow, { ...browserWindow, focused: true }] },
    { anchor: 'the first browser window when none is focused', browserWindows: [browserWindow, otherBrowserWindow] }
  ])('a last-focused approval popup centres the next popup on $anchor', async ({ browserWindows }) => {
    focused.mockResolvedValueOnce(approvalPopup);
    getAll.mockResolvedValueOnce(browserWindows);

    const answer = await declineSign();

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ left: 480, top: 120 }));
    expect(getAll).toHaveBeenCalledWith({ windowTypes: ['normal'] });
    expect(answer).toBe(MidenDAppErrorType.NotGranted);
  });

  it('centres the popup on a last-focused browser window without listing the others', async () => {
    focused.mockResolvedValueOnce(browserWindow);

    const answer = await declineSign();

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ left: 480, top: 120 }));
    expect(focused.mock.calls).toEqual([[]]);
    expect(getAll).not.toHaveBeenCalled();
    expect(answer).toBe(MidenDAppErrorType.NotGranted);
  });

  type NoBrowserWindow = { case: string; arrange: () => void };
  it.each<NoBrowserWindow>([
    {
      case: 'no browser window is open',
      arrange: () => {
        focused.mockResolvedValueOnce(windowAt({ id: 3, type: 'app', left: 300, top: 200, width: 600, height: 800 }));
        getAll.mockResolvedValueOnce([]);
      }
    },
    {
      case: 'no window can be read',
      arrange: () => {
        focused.mockRejectedValueOnce(new Error('No last-focused window'));
        getAll.mockRejectedValueOnce(new Error('No windows'));
      }
    }
  ])('lets the browser place the popup when $case', async ({ arrange }) => {
    arrange();

    const answer = await withoutWindowGeometry(declineSign);

    const options = create.mock.calls[0]?.[0];
    expect(options).toEqual(expect.objectContaining({ type: 'popup', width: 440, height: 760 }));
    expect(options).not.toHaveProperty('left');
    expect(options).not.toHaveProperty('top');
    expect(update).not.toHaveBeenCalled();
    expect(answer).toBe(MidenDAppErrorType.NotGranted);
  });

  it('retries a create Chrome refused for bounds without a position', async () => {
    create.mockRejectedValueOnce(new Error(BOUNDS_REFUSAL));
    create.mockResolvedValueOnce(windowAt({ id: 5678, left: 64, top: 48, state: 'normal' }));
    get.mockImplementationOnce(async id => windowAt({ id }));

    const answer = await declineSign();
    await flush();

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ left: 292, top: 20 }));
    const retry = create.mock.calls[1]?.[0];
    expect(retry).toEqual(expect.objectContaining({ type: 'popup', width: 440, height: 760 }));
    expect(retry).not.toHaveProperty('left');
    expect(retry).not.toHaveProperty('top');
    expect(update).not.toHaveBeenCalled();
    expect(answer).toBe(MidenDAppErrorType.NotGranted);
    expect(remove).toHaveBeenCalledWith(5678);
  });
});

/**
 * `sourcePublicKey` on a sign request is a signer COMMITMENT, not an account id.
 * `connect` hands the page b64 of `Word.serialize()`, and the vault keys its
 * secret blobs by those same 32 bytes in hex — which is the form `signData`
 * looks up by. A fixture that is neither (an account id, say) cannot exercise
 * the key binding, and worse, would pass a check that only compared strings.
 */
const SIGNER_COMMITMENT = new Uint8Array(32).fill(0xab);
const SIGNER_COMMITMENT_HEX = 'ab'.repeat(32);
const FOREIGN_COMMITMENT_HEX = 'cd'.repeat(32);

/**
 * Make the session's account authenticate with SIGNER_COMMITMENT and nothing else.
 *
 * The binding is checked against the key the SESSION stored at connect
 * (`isAuthorizedSigningKey`), so that is what has to carry the commitment here.
 * It is stored in the base64 form the connect response hands back, which is also
 * what makes the hex form the tests send authorize: both encodings name the same
 * commitment, and the check accepts either.
 */
const arrangeSignerAccount = () => {
  _g.__dappExtTest.storage[STORAGE_KEY]['https://miden.xyz'] = [
    { ...SESSION, publicKey: Buffer.from(SIGNER_COMMITMENT).toString('base64') }
  ];
  _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue({
    getPublicKeyCommitments: () => [{ serialize: () => SIGNER_COMMITMENT }]
  });
};

describe('requestSign — extension flow', () => {
  it('opens a confirmation window on call', async () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    // Kick off requestSign — it'll register a listener and call windows.create.
    // We don't need to await: the inner promise hangs until we synth-confirm.
    const sigPromise = dapp.requestSign('https://miden.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'miden-account-1',
      sourceAccountId: 'miden-account-1',
      payload: 'aGVsbG8=',
      kind: 'word'
    } as never);
    // Yield so requestConfirm can run far enough to register listeners
    await new Promise(r => setTimeout(r, 0));
    expect(_g.__dappExtTest.intercomListeners.length).toBeGreaterThan(0);
    expect(browser.windows.create).toHaveBeenCalled();
    // Avoid leaking the unhandled promise — we don't actually resolve it.
    sigPromise.catch(() => {});
  });

  it('resolves with a signature when the user confirms', async () => {
    arrangeSignerAccount();
    const sigPromise = dapp.requestSign('https://miden.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: SIGNER_COMMITMENT_HEX,
      sourceAccountId: 'miden-account-1',
      payload: 'aGVsbG8=',
      kind: 'word'
    } as never);
    await new Promise(r => setTimeout(r, 0));
    // Find the listener and pull the registered id by handshaking through
    // DAppGetPayloadRequest. We don't know the id (it's a nanoid), so the
    // first listener handles the GetPayload request which leaks the id via
    // the payload handshake. Instead, we drive the listener directly with a
    // matching confirmation: nanoid is internal, so we need to fish the id
    // out from the most recent windows.create call's URL.
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const url = browser.windows.create.mock.calls[browser.windows.create.mock.calls.length - 1][0].url;
    const id = url.match(/[?&]id=([^&]+)/)![1];
    const port = { id: 'fake-port' };
    const listener = _g.__dappExtTest.intercomListeners[_g.__dappExtTest.intercomListeners.length - 1];
    // First handshake (captures port)
    await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);
    // Then confirm
    await listener(
      {
        type: MidenMessageType.DAppSignConfirmationRequest,
        id,
        confirmed: true
      },
      port
    );
    const res = await sigPromise;
    expect(res.type).toBe(MidenDAppMessageType.SignResponse);
    expect((res as any).signature).toBe('fake-signature-base64');
  });

  it('rejects with NotGranted when the user declines', async () => {
    const sigPromise = dapp.requestSign('https://miden.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'miden-account-1',
      sourceAccountId: 'miden-account-1',
      payload: 'aGVsbG8=',
      kind: 'word'
    } as never);
    await new Promise(r => setTimeout(r, 0));
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const url = browser.windows.create.mock.calls[browser.windows.create.mock.calls.length - 1][0].url;
    const id = url.match(/[?&]id=([^&]+)/)![1];
    const port = { id: 'fake-port' };
    const listener = _g.__dappExtTest.intercomListeners[_g.__dappExtTest.intercomListeners.length - 1];
    await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);
    await listener(
      {
        type: MidenMessageType.DAppSignConfirmationRequest,
        id,
        confirmed: false
      },
      port
    );
    await expect(sigPromise).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

describe('waitForTransaction', () => {
  it('throws InvalidParams when txId is missing', async () => {
    await expect(dapp.waitForTransaction('https://miden.xyz', {} as never)).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );
  });
});

describe('requestPermission existing-permission early-return', () => {
  it('returns the existing permission directly when wallet is unlocked', async () => {
    // Existing session exists for 'https://miden.xyz' under 'miden-account-1'
    // and `req.appMeta.name === dApp.appMeta.name` matches.
    const res = await dapp.requestPermission('https://miden.xyz', {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
      force: false,
      network: 'testnet',
      privateDataPermission: 'UPON_REQUEST',
      allowedPrivateData: 0
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
    expect((res as any).accountId).toBe('miden-account-1');
  });

  it('throws InvalidParams when appMeta.name is missing', async () => {
    await expect(
      dapp.requestPermission('https://miden.xyz', {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: {},
        force: false,
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });
});

describe('requestImportPrivateNote — extension flow', () => {
  it('opens a confirmation window on call', async () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const p = dapp.requestImportPrivateNote('https://miden.xyz', {
      type: MidenDAppMessageType.ImportPrivateNoteRequest,
      sourcePublicKey: 'miden-account-1',
      note: 'aGVsbG8='
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(browser.windows.create).toHaveBeenCalled();
    p.catch(() => {});
  });
});

describe('requestPrivateNotes — extension flow', () => {
  it('opens a confirmation window on call (non-Auto branch)', async () => {
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest.fn().mockResolvedValue([]);
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const p = dapp.requestPrivateNotes('https://miden.xyz', {
      type: MidenDAppMessageType.PrivateNotesRequest,
      sourcePublicKey: 'miden-account-1',
      notefilterType: NoteFilterTypes.List,
      noteIds: ['n1']
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(browser.windows.create).toHaveBeenCalled();
    p.catch(() => {});
  });

  it('Auto branch returns the private notes directly', async () => {
    _g.__dappExtTest.storage[STORAGE_KEY]['https://miden.xyz'] = [
      { ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 2 }
    ];
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest
      .fn()
      .mockResolvedValue([{ noteType: 'private', noteId: 'n1', state: 'committed', assets: [] }]);
    // Mock NoteType import so the filter works
    const res = await dapp.requestPrivateNotes('https://miden.xyz', {
      type: MidenDAppMessageType.PrivateNotesRequest,
      sourcePublicKey: 'miden-account-1',
      notefilterType: NoteFilterTypes.List,
      noteIds: ['n1']
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.PrivateNotesResponse);
  });
});

describe('requestPrivateNotes by an import id - extension Auto flow (#1536)', () => {
  const importedNote = {
    noteId: 'n9',
    noteType: NoteType.Private,
    senderAccountId: 's1',
    nullifier: 'nf9',
    state: 0,
    assets: []
  };
  const requestList = (notefilterType: NoteFilterTypes) =>
    dapp.requestPrivateNotes('https://miden.xyz', {
      type: MidenDAppMessageType.PrivateNotesRequest,
      sourcePublicKey: 'miden-account-1',
      notefilterType,
      noteIds: ['0xcommit']
    });

  beforeEach(() => {
    _g.__dappExtTest.storage[STORAGE_KEY]['https://miden.xyz'] = [
      { ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 2 }
    ];
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest.fn().mockResolvedValue([]);
    _g.__dappExtTest.midenClient.getDetailsCommitmentMatches = jest
      .fn()
      .mockResolvedValue([{ notes: [importedNote], uncommitted: 0 }]);
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest.fn().mockResolvedValue([{ noteId: 'n9' }]);
  });

  afterEach(() => {
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest.fn(async () => []);
  });

  it('lists by the returned commitment under the real note id without a prompt', async () => {
    await expect(requestList(NoteFilterTypes.List)).resolves.toEqual({
      type: MidenDAppMessageType.PrivateNotesResponse,
      privateNotes: [importedNote]
    });
    expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
  });

  it('propagates an eviction inside the commitment read after reading consumables', async () => {
    _g.__dappExtTest.midenClient.getDetailsCommitmentMatches = jest.fn(
      async (_commitments: string[], _candidateIds: string[], assertLive: () => void) => {
        revokeWasmHold();
        assertLive();
        return [{ notes: [], uncommitted: 0 }];
      }
    );

    const pending = requestList(NoteFilterTypes.List);
    await expect(pending).rejects.toBeInstanceOf(WasmClientPoisonedError);
    await expect(pending).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: 'operation abandoned inside the private-note details-commitment read, before the record reach-through'
      })
    });
    await expect(pending).rejects.not.toThrow(MidenDAppErrorType.InvalidParams);
    expect(_g.__dappExtTest.midenClient.getConsumableNoteDtos).toHaveBeenCalledWith(
      'miden-account-1',
      expect.any(Function)
    );
    expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
  });

  it('keeps an ordinary commitment read failure wrapped as InvalidParams', async () => {
    _g.__dappExtTest.midenClient.getDetailsCommitmentMatches = jest
      .fn()
      .mockRejectedValue(new Error('store unavailable'));

    await expect(requestList(NoteFilterTypes.List)).rejects.toThrow(
      `${MidenDAppErrorType.InvalidParams}: Error: store unavailable`
    );
    expect(_g.__dappExtTest.midenClient.getConsumableNoteDtos).toHaveBeenCalledWith(
      'miden-account-1',
      expect.any(Function)
    );
  });
});

describe('requestConsumableNotes — extension flow', () => {
  it('opens a confirmation window on call (non-Auto branch)', async () => {
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest.fn().mockResolvedValue([]);
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const p = dapp.requestConsumableNotes('https://miden.xyz', {
      type: MidenDAppMessageType.ConsumableNotesRequest,
      sourcePublicKey: 'miden-account-1'
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(browser.windows.create).toHaveBeenCalled();
    p.catch(() => {});
  });
});

describe('requestAssets — extension flow', () => {
  it('opens a confirmation window on call (non-Auto branch)', async () => {
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue({
      vault: () => ({
        fungibleAssets: () => [
          {
            faucetId: () => 'faucet-x',
            amount: () => ({ toString: () => '42' })
          }
        ]
      })
    });
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const p = dapp.requestAssets('https://miden.xyz', {
      type: MidenDAppMessageType.AssetsRequest,
      sourcePublicKey: 'miden-account-1'
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(browser.windows.create).toHaveBeenCalled();
    p.catch(() => {});
  });
});

describe('requestTransaction — extension flow', () => {
  it('opens a confirmation window on call', async () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const p = dapp.requestTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        payload: {
          address: 'miden-account-1',
          recipientAddress: 'bob',
          transactionRequest: 'b64req'
        }
      }
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(browser.windows.create).toHaveBeenCalled();
    p.catch(() => {});
  });
});

describe('requestSendTransaction — extension flow', () => {
  it('opens a confirmation window on call', async () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const p = dapp.requestSendTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.SendTransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        senderAddress: 'miden-account-1',
        recipientAddress: 'bob',
        faucetId: 'faucet-1',
        noteType: 'Private',
        amount: '100'
      }
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(browser.windows.create).toHaveBeenCalled();
    p.catch(() => {});
  });
});

describe('requestConsumeTransaction — extension flow', () => {
  it('opens a confirmation window on call', async () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const p = dapp.requestConsumeTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        accountAddress: 'miden-account-1',
        noteId: 'note-1',
        faucetId: 'faucet-1',
        noteType: 'Private',
        amount: '50'
      }
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(browser.windows.create).toHaveBeenCalled();
    p.catch(() => {});
  });
});

// Helper that drives a full request → confirm → resolve cycle
async function driveConfirmation(
  start: () => Promise<any>,
  confirmRequestType: MidenMessageType,
  extraConfirmFields: Record<string, any> = { confirmed: true },
  beforeConfirm?: () => void
) {
  const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
  const startCallCount = browser.windows.create.mock.calls.length;
  const promise = start();
  await new Promise(r => setTimeout(r, 0));
  // Pull the id from the most recent windows.create call's URL
  const lastCall = browser.windows.create.mock.calls[browser.windows.create.mock.calls.length - 1];
  if (browser.windows.create.mock.calls.length === startCallCount) {
    throw new Error('windows.create was not called by start()');
  }
  const url = lastCall[0].url;
  const id = url.match(/[?&]id=([^&]+)/)![1];
  const port = { id: 'fake-port' };
  const listener = _g.__dappExtTest.intercomListeners[_g.__dappExtTest.intercomListeners.length - 1];
  _g.__dappExtTest.lastPayloadResponse = await listener(
    { type: MidenMessageType.DAppGetPayloadRequest, id: [id] },
    port
  );
  beforeConfirm?.();
  // What the confirm page is answered with; a handler that throws leaves it unset and the dApp unanswered.
  _g.__dappExtTest.lastConfirmResponse = undefined;
  _g.__dappExtTest.lastConfirmResponse = await listener({ type: confirmRequestType, id, ...extraConfirmFields }, port);
  return promise;
}

// A real switch writes both the vault's stored current account and the store's.
function switchCurrentAccount(account: string) {
  _g.__dappExtTestCurrentAccount = account;
  mockGetCurrentAccountPublicKey.mockResolvedValue(account);
}

describe('Full confirmation cycles in extension mode', () => {
  describe.each(['send', 'custom'])('an approved extension %s failure (#1378)', kind => {
    const queuedMessage = 'OUTCOME_UNKNOWN: transaction tx-1 may already be queued; wait for it before sending again';
    const killMessage =
      'OUTCOME_UNKNOWN: the wallet could not confirm whether the transaction was queued; check before sending again';
    const poison = new WasmClientPoisonedError('watchdog', new Error('write parked'));
    const queued = new TransactionQueuedError('tx-1', { cause: poison });

    it.each<[string, Error, string]>([
      ['a queued transaction', queued, queuedMessage],
      ['a cause-wrapped queued transaction', new Error('NOT_GRANTED', { cause: queued }), queuedMessage],
      ['a kill carrying a queued transaction', new WasmClientPoisonedError('watchdog', queued), queuedMessage],
      ['a watchdog eviction', poison, killMessage],
      ['an offscreen abort', new OperationAbortedError('op-1378', 'deadline'), killMessage],
      ['a terminated client', new Error('Client terminated'), killMessage],
      ['a terminated web client', new Error('WebClient terminated'), killMessage],
      ['a cause-wrapped poison', new Error('NOT_GRANTED', { cause: poison }), killMessage],
      ['an authorization refusal', new Error(MidenDAppErrorType.NotGranted), 'NOT_GRANTED']
    ])('reports %s with the exact outcome message', async (_label, error, message) => {
      const sdk = jest.requireMock('lib/miden/transaction');
      const initiate = kind === 'send' ? sdk.initiateSendTransaction : sdk.requestCustomTransaction;
      initiate.mockRejectedValueOnce(error);

      await expect(
        driveConfirmation(
          () =>
            kind === 'send'
              ? dapp.requestSendTransaction('https://miden.xyz', {
                  type: MidenDAppMessageType.SendTransactionRequest,
                  sourcePublicKey: 'miden-account-1',
                  transaction: {
                    senderAddress: 'miden-account-1',
                    recipientAddress: 'bob',
                    faucetId: 'faucet-1',
                    noteType: 'Private',
                    amount: '100'
                  }
                } as never)
              : dapp.requestTransaction('https://miden.xyz', {
                  type: MidenDAppMessageType.TransactionRequest,
                  sourcePublicKey: 'miden-account-1',
                  transaction: {
                    payload: { address: 'miden-account-1', recipientAddress: 'bob', transactionRequest: 'b64req' }
                  }
                } as never),
          MidenMessageType.DAppTransactionConfirmationRequest,
          { confirmed: true, delegate: false }
        )
      ).rejects.toEqual(new Error(message));
      expect(initiate).toHaveBeenCalledTimes(1);
      expect(_g.__dappExtTest.lastConfirmResponse).toEqual({
        type: MidenMessageType.DAppTransactionConfirmationResponse
      });
    });
  });

  describe('approved extension custom carried-note failures (#1378)', () => {
    const queuedMessage = 'OUTCOME_UNKNOWN: transaction tx-1 may already be queued; wait for it before sending again';
    const queued = new TransactionQueuedError('tx-1', { cause: new Error('note queue unavailable') });

    const CARRIED_NOTES = ['bm90ZS0x', 'bm90ZS0y'];
    const CARRIED_NOTE_IDS = ['note-1', 'note-2'];
    // The SDK mock decodes no note, so each carried note decodes to the id its bytes spell.
    const sdkNote: Record<string, unknown> = require('@miden-sdk/miden-sdk/lazy').Note;
    let previousDeserialize: unknown;
    beforeEach(() => {
      previousDeserialize = sdkNote.deserialize;
      sdkNote.deserialize = (bytes: Uint8Array) => ({
        id: () => ({ toString: () => Array.from(bytes, byte => String.fromCharCode(byte)).join('') }),
        metadata: () => undefined,
        assets: () => ({ fungibleAssets: () => [], nonFungibleAssets: () => [] })
      });
    });
    afterEach(() => {
      sdkNote.deserialize = previousDeserialize;
    });
    const runCustomFailure = async (error: Error, message: string, queuedRow: boolean, check: () => void) => {
      jest.mocked(requestCustomTransaction).mockRejectedValueOnce(error);
      if (queuedRow) jest.mocked(startTransactionProcessing).mockResolvedValueOnce(undefined);
      await expect(
        driveConfirmation(
          () =>
            dapp.requestTransaction('https://miden.xyz', {
              type: MidenDAppMessageType.TransactionRequest,
              sourcePublicKey: 'miden-account-1',
              transaction: {
                payload: { address: 'miden-account-1', transactionRequest: 'b64req', importNotes: CARRIED_NOTES }
              }
            } as never),
          MidenMessageType.DAppTransactionConfirmationRequest,
          { confirmed: true, delegate: false }
        )
      ).rejects.toEqual(new Error(message));
      expect(requestCustomTransaction).toHaveBeenCalledTimes(1);
      expect(_g.__dappExtTest.lastConfirmResponse).toEqual({
        type: MidenMessageType.DAppTransactionConfirmationResponse
      });
      check();
    };

    it.each<[string, Error]>([
      ['a queued row', queued],
      ['a cause-wrapped queued row', new Error('custom wrapper', { cause: queued })]
    ])('starts processing and releases the carried notes after %s', async (_label, error) => {
      await runCustomFailure(error, queuedMessage, true, () => {
        expect(startTransactionProcessing).toHaveBeenCalledTimes(1);
        // The dry run derives the same ids with a second argument; the release derives them with the notes alone.
        expect(noteQuarantine.importedNoteIds).toHaveBeenCalledWith(CARRIED_NOTES);
        expect(noteQuarantine.releaseNoteIds).toHaveBeenCalledTimes(1);
        expect(noteQuarantine.releaseNoteIds).toHaveBeenCalledWith(CARRIED_NOTE_IDS);
      });
    });

    it('starts nothing and keeps the carried notes quarantined after a NOT_GRANTED refusal', async () => {
      await runCustomFailure(new Error(MidenDAppErrorType.NotGranted), 'NOT_GRANTED', false, () => {
        expect(startTransactionProcessing).not.toHaveBeenCalled();
        expect(noteQuarantine.releaseNoteIds).not.toHaveBeenCalled();
      });
    });
  });

  it('requestImportPrivateNote resolves with note id when confirmed', async () => {
    _g.__dappExtTest.midenClient.importNoteBytes = jest.fn().mockResolvedValue('imported-note-id');
    _g.__dappExtTest.midenClient.syncState = jest.fn().mockResolvedValue(undefined);
    const res = await driveConfirmation(
      () =>
        dapp.requestImportPrivateNote('https://miden.xyz', {
          type: MidenDAppMessageType.ImportPrivateNoteRequest,
          sourcePublicKey: 'miden-account-1',
          note: 'aGVsbG8='
        } as never),
      MidenMessageType.DAppImportPrivateNoteConfirmationRequest
    );
    expect(res.type).toBe(MidenDAppMessageType.ImportPrivateNoteResponse);
    expect((res as any).noteId).toBe('imported-note-id');
  });

  it('requestImportPrivateNote rejects when declined', async () => {
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
  });

  it('requestPrivateNotes resolves with private notes when confirmed', async () => {
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest
      .fn()
      .mockResolvedValue([{ noteType: 'private', noteId: 'n1', state: 'committed', assets: [] }]);
    const res = await driveConfirmation(
      () =>
        dapp.requestPrivateNotes('https://miden.xyz', {
          type: MidenDAppMessageType.PrivateNotesRequest,
          sourcePublicKey: 'miden-account-1',
          notefilterType: NoteFilterTypes.List,
          noteIds: ['n1']
        } as never),
      MidenMessageType.DAppPrivateNotesConfirmationRequest
    );
    expect(res.type).toBe(MidenDAppMessageType.PrivateNotesResponse);
  });

  it('requestPrivateNotes rejects when declined', async () => {
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest.fn().mockResolvedValue([]);
    await expect(
      driveConfirmation(
        () =>
          dapp.requestPrivateNotes('https://miden.xyz', {
            type: MidenDAppMessageType.PrivateNotesRequest,
            sourcePublicKey: 'miden-account-1',
            notefilterType: NoteFilterTypes.List,
            noteIds: ['n1']
          } as never),
        MidenMessageType.DAppPrivateNotesConfirmationRequest,
        { confirmed: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('requestConsumableNotes resolves when confirmed', async () => {
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest.fn().mockResolvedValue([]);
    _g.__dappExtTest.midenClient.syncState = jest.fn().mockResolvedValue(undefined);
    const res = await driveConfirmation(
      () =>
        dapp.requestConsumableNotes('https://miden.xyz', {
          type: MidenDAppMessageType.ConsumableNotesRequest,
          sourcePublicKey: 'miden-account-1'
        } as never),
      MidenMessageType.DAppConsumableNotesConfirmationRequest
    );
    expect(res.type).toBe(MidenDAppMessageType.ConsumableNotesResponse);
  });

  it('requestConsumableNotes maps full notes and skips partial (id-less) ones', async () => {
    // Slice-4: the proxy returns already-reduced ConsumableNoteDtos. A partial
    // note reduces to noteId/nullifier null (dapp skips it); a full note carries
    // the fields dapp maps 1:1 to InputNoteDetails.
    const partialNote = {
      noteId: null,
      nullifier: null,
      noteType: undefined,
      senderAccountId: undefined,
      state: 0,
      assets: [],
      nonFungibleAssets: [],
      swapAttachment: null
    };
    const fullNote = {
      noteId: 'note-full',
      nullifier: 'nullifier-1',
      noteType: 1,
      senderAccountId: 'sender-bech32',
      state: 2,
      assets: [{ amount: '7', faucetId: 'faucet-bech32' }],
      swapAttachment: null
    };
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest.fn().mockResolvedValue([partialNote, fullNote]);
    _g.__dappExtTest.midenClient.syncState = jest.fn().mockResolvedValue(undefined);
    const res = await driveConfirmation(
      () =>
        dapp.requestConsumableNotes('https://miden.xyz', {
          type: MidenDAppMessageType.ConsumableNotesRequest,
          sourcePublicKey: 'miden-account-1'
        } as never),
      MidenMessageType.DAppConsumableNotesConfirmationRequest
    );
    expect(res.type).toBe(MidenDAppMessageType.ConsumableNotesResponse);
    const notes = (res as any).consumableNotes;
    expect(notes).toHaveLength(1);
    expect(notes[0].noteId).toBe('note-full');
  });

  it('requestAssets resolves when confirmed', async () => {
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue({
      vault: () => ({
        fungibleAssets: () => [
          {
            faucetId: () => 'faucet-x',
            amount: () => ({ toString: () => '42' })
          }
        ]
      })
    });
    const res = await driveConfirmation(
      () =>
        dapp.requestAssets('https://miden.xyz', {
          type: MidenDAppMessageType.AssetsRequest,
          sourcePublicKey: 'miden-account-1'
        } as never),
      MidenMessageType.DAppAssetsConfirmationRequest
    );
    expect(res.type).toBe(MidenDAppMessageType.AssetsResponse);
  });

  it('requestTransaction resolves with transactionId when confirmed', async () => {
    const res = await driveConfirmation(
      () =>
        dapp.requestTransaction('https://miden.xyz', {
          type: MidenDAppMessageType.TransactionRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            payload: {
              address: 'miden-account-1',
              recipientAddress: 'bob',
              transactionRequest: 'b64req'
            }
          }
        } as never),
      MidenMessageType.DAppTransactionConfirmationRequest,
      { confirmed: true, delegate: false }
    );
    expect(res.type).toBe(MidenDAppMessageType.TransactionResponse);
  });

  it('requestSendTransaction resolves with transactionId when confirmed', async () => {
    const res = await driveConfirmation(
      () =>
        dapp.requestSendTransaction('https://miden.xyz', {
          type: MidenDAppMessageType.SendTransactionRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            senderAddress: 'miden-account-1',
            recipientAddress: 'bob',
            faucetId: 'faucet-1',
            noteType: 'Private',
            amount: '100'
          }
        } as never),
      MidenMessageType.DAppTransactionConfirmationRequest,
      { confirmed: true, delegate: true }
    );
    expect(res.type).toBe(MidenDAppMessageType.SendTransactionResponse);
  });

  it('serializes breach display data and passes a backend-created authorization only after strict confirmation', async () => {
    const assessment = {
      accountId: 'miden-account-1',
      usdAmount: 100n,
      revision: 'revision-1',
      assessedAt: 100,
      breach: { spent: 90n, proposedTotal: 190n, limit: 100n, overBy: 90n, resetAt: 200 }
    };
    mockAssessOutgoingSpendingLimitDetails.mockResolvedValue({ assessment });

    await driveConfirmation(
      () =>
        dapp.requestSendTransaction('https://miden.xyz', {
          type: MidenDAppMessageType.SendTransactionRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            senderAddress: 'miden-account-1',
            recipientAddress: 'bob',
            faucetId: 'faucet-1',
            noteType: 'Private',
            amount: '100'
          }
        } as never),
      MidenMessageType.DAppTransactionConfirmationRequest,
      { confirmed: true, delegate: true, spendingLimitAuthenticated: true }
    );

    expect(_g.__dappExtTest.lastPayloadResponse.payload).toMatchObject({
      spendingLimitAssessment: { usdAmount: '100', breach: { spent: '90', overBy: '90' } }
    });
    expect(_g.__dappExtTest.lastPayloadResponse.payload).not.toHaveProperty('spendingLimitAsset');
    expect(_g.__dappExtTest.lastPayloadResponse.payload).not.toHaveProperty('spendingLimitAuthorization');
    const transaction = require('lib/miden/transaction');
    expect(transaction.initiateSendTransaction.mock.calls[0]![7]).toMatchObject({
      kind: 'usd',
      accountId: 'miden-account-1',
      usdAmount: 100n,
      revision: 'revision-1'
    });
    expect(transaction.initiateSendTransaction.mock.calls[0]![8]).toBe('https://miden.xyz');
  });

  it('denies an approved send when the origin disconnected while confirmation was open', async () => {
    const transaction = require('lib/miden/transaction');

    await expect(
      driveConfirmation(
        () =>
          dapp.requestSendTransaction('https://miden.xyz', {
            type: MidenDAppMessageType.SendTransactionRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: {
              senderAddress: 'miden-account-1',
              recipientAddress: 'bob',
              faucetId: 'faucet-1',
              noteType: 'Private',
              amount: '100'
            }
          } as never),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: true, delegate: true },
        () => {
          delete _g.__dappExtTest.storage[STORAGE_KEY]['https://miden.xyz'];
        }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);

    expect(transaction.initiateSendTransaction).not.toHaveBeenCalled();
  });

  it('denies an approved send when the active wallet account changed while confirmation was open', async () => {
    const transaction = require('lib/miden/transaction');

    await expect(
      driveConfirmation(
        () =>
          dapp.requestSendTransaction('https://miden.xyz', {
            type: MidenDAppMessageType.SendTransactionRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: {
              senderAddress: 'miden-account-1',
              recipientAddress: 'bob',
              faucetId: 'faucet-1',
              noteType: 'Private',
              amount: '100'
            }
          } as never),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: true, delegate: true },
        () => {
          _g.__dappExtTestCurrentAccount = 'miden-account-2';
        }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);

    expect(transaction.initiateSendTransaction).not.toHaveBeenCalled();
  });

  it('requestConsumeTransaction resolves when confirmed', async () => {
    // ConsumeTransaction's handler still keys off DAppTransactionConfirmationRequest
    // (the request type is shared; only the response type differs).
    const res = await driveConfirmation(
      () =>
        dapp.requestConsumeTransaction('https://miden.xyz', {
          type: MidenDAppMessageType.ConsumeRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            accountAddress: 'miden-account-1',
            noteId: 'note-1',
            faucetId: 'faucet-1',
            noteType: 'Private',
            amount: '50'
          }
        } as never),
      MidenMessageType.DAppTransactionConfirmationRequest,
      { confirmed: true, delegate: true }
    );
    expect(res.type).toBe(MidenDAppMessageType.ConsumeResponse);

    // 4th positional arg is `manualRetry`. The user just approved THIS consume on
    // the confirm page, so auto-consume's exponential backoff must not swallow it
    // and answer the dApp with a previous attempt's Failed row id.
    const sdk = require('lib/miden/transaction');
    expect(sdk.initiateConsumeTransactionFromId.mock.calls[0][3]).toBe(true);
    expect(sdk.initiateConsumeTransactionFromId.mock.calls[0][4]).toBe('https://miden.xyz');
    expect(sdk.initiateConsumeTransactionFromId.mock.calls[0][5]).toBe('dapp');
  });

  it('requestConsumeTransaction refuses a note another transaction holds rather than answer with it', async () => {
    // As the real call: a dApp's request is refused, the wallet's own claim is answered with the holding row.
    const sdk = require('lib/miden/transaction');
    sdk.initiateConsumeTransactionFromId.mockImplementationOnce(async (...args: unknown[]) => {
      if (typeof args[4] === 'string') throw new Error('This note is being consumed by another transaction');
      return 'other-dapp-transaction';
    });
    const request: MidenDAppConsumeRequest = {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: { noteId: 'note-1', faucetId: 'faucet-1', noteType: 'private', amount: 50 }
    };
    await expect(
      driveConfirmation(
        () => dapp.requestConsumeTransaction('https://miden.xyz', request),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: true, delegate: true }
      )
    ).rejects.toThrow('This note is being consumed by another transaction');
  });

  it('requestPrivateNotes rejects when user declines (covers onDecline at L641)', async () => {
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest.fn().mockResolvedValue([]);
    await expect(
      driveConfirmation(
        () =>
          dapp.requestPrivateNotes('https://miden.xyz', {
            type: MidenDAppMessageType.PrivateNotesRequest,
            sourcePublicKey: 'miden-account-1',
            notefilterType: NoteFilterTypes.List,
            noteIds: ['n1']
          } as never),
        MidenMessageType.DAppPrivateNotesConfirmationRequest,
        { confirmed: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('requestConsumableNotes rejects when user declines (covers onDecline at L765)', async () => {
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest.fn().mockResolvedValue([]);
    _g.__dappExtTest.midenClient.syncState = jest.fn().mockResolvedValue(undefined);
    await expect(
      driveConfirmation(
        () =>
          dapp.requestConsumableNotes('https://miden.xyz', {
            type: MidenDAppMessageType.ConsumableNotesRequest,
            sourcePublicKey: 'miden-account-1'
          } as never),
        MidenMessageType.DAppConsumableNotesConfirmationRequest,
        { confirmed: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('requestAssets rejects when user declines (covers onDecline at L1004)', async () => {
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue({
      vault: () => ({ fungibleAssets: () => [] })
    });
    await expect(
      driveConfirmation(
        () =>
          dapp.requestAssets('https://miden.xyz', {
            type: MidenDAppMessageType.AssetsRequest,
            sourcePublicKey: 'miden-account-1'
          } as never),
        MidenMessageType.DAppAssetsConfirmationRequest,
        { confirmed: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('requestTransaction rejects when user declines (covers onDecline at L1148)', async () => {
    await expect(
      driveConfirmation(
        () =>
          dapp.requestTransaction('https://miden.xyz', {
            type: MidenDAppMessageType.TransactionRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: {
              payload: {
                address: 'miden-account-1',
                recipientAddress: 'bob',
                transactionRequest: 'b64req'
              }
            }
          } as never),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: false, delegate: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('requestSendTransaction rejects when user declines (covers onDecline at L1286)', async () => {
    await expect(
      driveConfirmation(
        () =>
          dapp.requestSendTransaction('https://miden.xyz', {
            type: MidenDAppMessageType.SendTransactionRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: {
              senderAddress: 'miden-account-1',
              recipientAddress: 'bob',
              faucetId: 'faucet-1',
              noteType: 'Private',
              amount: '100'
            }
          } as never),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('requestSendTransaction rejects with InvalidParams when initiateSendTransaction throws inside the confirmed branch', async () => {
    const sdk = require('lib/miden/transaction');
    sdk.initiateSendTransaction.mockRejectedValueOnce(new Error('insufficient funds'));
    await expect(
      driveConfirmation(
        () =>
          dapp.requestSendTransaction('https://miden.xyz', {
            type: MidenDAppMessageType.SendTransactionRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: {
              senderAddress: 'miden-account-1',
              recipientAddress: 'bob',
              faucetId: 'faucet-1',
              noteType: 'Private',
              amount: '100'
            }
          } as never),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: true, delegate: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('requestTransaction hands the requesting origin to requestCustomTransaction', async () => {
    const sdk = require('lib/miden/transaction');
    await driveConfirmation(
      () =>
        dapp.requestTransaction('https://miden.xyz', {
          type: MidenDAppMessageType.TransactionRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            payload: { address: 'miden-account-1', recipientAddress: 'bob', transactionRequest: 'b64req' }
          }
        } as never),
      MidenMessageType.DAppTransactionConfirmationRequest,
      { confirmed: true, delegate: false }
    );
    expect(sdk.requestCustomTransaction.mock.calls[0]![8]).toBe('https://miden.xyz');
  });

  it('requestTransaction rejects with InvalidParams when requestCustomTransaction throws inside the confirmed branch', async () => {
    const sdk = require('lib/miden/transaction');
    sdk.requestCustomTransaction.mockRejectedValueOnce(new Error('bad request'));
    await expect(
      driveConfirmation(
        () =>
          dapp.requestTransaction('https://miden.xyz', {
            type: MidenDAppMessageType.TransactionRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: {
              payload: {
                address: 'miden-account-1',
                recipientAddress: 'bob',
                transactionRequest: 'b64req'
              }
            }
          } as never),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: true, delegate: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('requestImportPrivateNote rejects with InvalidParams when importNoteBytes throws inside the confirmed branch', async () => {
    _g.__dappExtTest.midenClient.importNoteBytes = jest.fn().mockRejectedValue(new Error('parse failed'));
    await expect(
      driveConfirmation(
        () =>
          dapp.requestImportPrivateNote('https://miden.xyz', {
            type: MidenDAppMessageType.ImportPrivateNoteRequest,
            sourcePublicKey: 'miden-account-1',
            note: 'aGVsbG8='
          } as never),
        MidenMessageType.DAppImportPrivateNoteConfirmationRequest,
        { confirmed: true }
      )
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('requestSign rejects with InvalidParams when signData throws inside the confirmed branch', async () => {
    arrangeSignerAccount();
    mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) =>
      fn({
        vault: {
          signData: jest.fn(async () => {
            throw new Error('sign failed');
          })
        }
      })
    );
    await expect(
      driveConfirmation(
        () =>
          dapp.requestSign('https://miden.xyz', {
            type: MidenDAppMessageType.SignRequest,
            sourcePublicKey: SIGNER_COMMITMENT_HEX,
            sourceAccountId: 'miden-account-1',
            payload: 'aGVsbG8=',
            kind: 'word'
          } as never),
        MidenMessageType.DAppSignConfirmationRequest,
        { confirmed: true }
      )
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  /**
   * The signing key is a separate field from the account the session is resolved
   * by, and the vault's lookup is keyed by commitment alone with no
   * back-reference to an account — so every key in the wallet is reachable from
   * that one string. A page connected to its own account puts its own id in
   * `sourceAccountId` (so the permission check passes) and somebody else's
   * commitment in `sourcePublicKey`, and gets a signature from a key it was
   * never granted. Approving the sheet does not help: the sheet shows the
   * payload, not whose key will sign it.
   */
  describe('requestSign — the key must belong to the account the session authorized', () => {
    const request = (sourcePublicKey: string) =>
      ({
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey,
        sourceAccountId: 'miden-account-1',
        payload: 'aGVsbG8=',
        kind: 'word'
      }) as never;

    const signWith = (sourcePublicKey: string) =>
      driveConfirmation(
        () => dapp.requestSign('https://miden.xyz', request(sourcePublicKey)),
        MidenMessageType.DAppSignConfirmationRequest,
        { confirmed: true }
      );

    /**
     * The refusal cases call through directly rather than driving a confirmation:
     * the key binding is checked BEFORE any prompt is raised, so there is no
     * window for `driveConfirmation` to find and it would fail on the harness
     * rather than on the assertion.
     */
    const signRefused = (sourcePublicKey: string) => dapp.requestSign('https://miden.xyz', request(sourcePublicKey));

    it('refuses a commitment the session account does not authenticate with', async () => {
      arrangeSignerAccount();
      const signData = jest.fn(async () => 'stolen-signature');
      mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: { signData } }));

      await expect(signRefused(FOREIGN_COMMITMENT_HEX)).rejects.toThrow(MidenDAppErrorType.NotGranted);
      // Refused, not merely reported: the key is never touched.
      expect(signData).not.toHaveBeenCalled();
    });

    it('accepts the b64 form the wallet itself handed out at connect', async () => {
      arrangeSignerAccount();
      mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) =>
        fn({ vault: { signData: jest.fn(async () => 'fake-signature-base64') } })
      );

      const res = await signWith(Buffer.from(SIGNER_COMMITMENT).toString('base64'));
      expect((res as any).signature).toBe('fake-signature-base64');
    });

    it.each([
      ['an account id, which denotes no key at all', 'miden-account-1'],
      ['a short hex string', '0xdeadbeef'],
      ['a 32-byte value that is neither hex nor b64', 'not a commitment at all']
    ])('refuses %s', async (_label, sourcePublicKey) => {
      arrangeSignerAccount();
      const signData = jest.fn(async () => 'stolen-signature');
      mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: { signData } }));

      await expect(signRefused(sourcePublicKey)).rejects.toThrow();
      expect(signData).not.toHaveBeenCalled();
    });

    it('refuses a sign approved after the current account changed, before any key is used', async () => {
      arrangeSignerAccount();
      const signData = jest.fn(async () => 'stolen-signature');
      mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: { signData } }));

      await expect(
        driveConfirmation(
          () => dapp.requestSign('https://miden.xyz', request(SIGNER_COMMITMENT_HEX)),
          MidenMessageType.DAppSignConfirmationRequest,
          { confirmed: true },
          () => switchCurrentAccount('miden-account-2')
        )
      ).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
      expect(signData).not.toHaveBeenCalled();
    });

    it('refuses when the account cannot be resolved, rather than signing anyway', async () => {
      _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue(null);
      const signData = jest.fn(async () => 'stolen-signature');
      mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: { signData } }));

      await expect(signRefused(SIGNER_COMMITMENT_HEX)).rejects.toThrow(MidenDAppErrorType.NotGranted);
      expect(signData).not.toHaveBeenCalled();
    });
  });

  it('requestPermission rejects when user declines', async () => {
    delete (_g.__dappExtTest.storage[STORAGE_KEY] as any)['https://newdapp2.xyz'];
    await expect(
      driveConfirmation(
        () =>
          dapp.requestPermission('https://newdapp2.xyz', {
            type: MidenDAppMessageType.PermissionRequest,
            appMeta: { name: 'New Dapp', url: 'https://newdapp2.xyz' },
            force: false,
            network: 'testnet',
            privateDataPermission: 'UPON_REQUEST',
            allowedPrivateData: 0
          } as never),
        MidenMessageType.DAppPermConfirmationRequest,
        { confirmed: false, accountPublicKey: '' }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('requestPermission resolves when user grants new connection', async () => {
    delete (_g.__dappExtTest.storage[STORAGE_KEY] as any)['https://newdapp.xyz'];
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }]
    });
    const res = await driveConfirmation(
      () =>
        dapp.requestPermission('https://newdapp.xyz', {
          type: MidenDAppMessageType.PermissionRequest,
          appMeta: { name: 'New Dapp', url: 'https://newdapp.xyz' },
          force: false,
          network: 'testnet',
          privateDataPermission: 'UPON_REQUEST',
          allowedPrivateData: 0
        } as never),
      MidenMessageType.DAppPermConfirmationRequest,
      {
        confirmed: true,
        accountPublicKey: 'miden-account-1',
        privateDataPermission: 'UPON_REQUEST'
      }
    );
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
  });

  it("hands the connect popup the dApp's claimed network, for its mismatch warning", async () => {
    delete (_g.__dappExtTest.storage[STORAGE_KEY] as any)['https://claims-devnet.xyz'];
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }]
    });
    await driveConfirmation(
      () =>
        dapp.requestPermission('https://claims-devnet.xyz', {
          type: MidenDAppMessageType.PermissionRequest,
          appMeta: { name: 'Devnet Dapp', url: 'https://claims-devnet.xyz' },
          force: false,
          network: 'devnet',
          privateDataPermission: 'UPON_REQUEST',
          allowedPrivateData: 0
        } as never),
      MidenMessageType.DAppPermConfirmationRequest,
      { confirmed: true, accountPublicKey: 'miden-account-1', privateDataPermission: 'UPON_REQUEST' }
    );
    expect(_g.__dappExtTest.lastPayloadResponse.payload).toMatchObject({ type: 'connect', network: 'devnet' });
  });

  it('requestConsumeTransaction with noteBytes imports and resolves when confirmed', async () => {
    const { queueNoteImport } = jest.requireMock('lib/miden/activity');
    const sdk = require('lib/miden/transaction');
    // Issue #1459: the import must land before the consume reads the note from the store.
    const sdkLazy: Record<string, unknown> = require('@miden-sdk/miden-sdk/lazy');
    const originalSdk = { Note: sdkLazy.Note, NoteFile: sdkLazy.NoteFile };
    sdkLazy.NoteFile = {
      deserialize: () => {
        throw new Error('not a NoteFile');
      }
    };
    sdkLazy.Note = {
      deserialize: () => ({
        id: () => ({ toString: () => 'note-1' }),
        metadata: () => undefined,
        assets: () => ({ fungibleAssets: () => [], nonFungibleAssets: () => [] })
      })
    };
    const order: string[] = [];
    _g.__dappExtTest.midenClient.importNoteBytes = jest.fn(async (bytes: Uint8Array) => {
      order.push(`import:${Buffer.from(bytes).toString('base64')}`);
      return 'note-1';
    });
    _g.__dappExtTest.midenClient.syncState = jest.fn().mockResolvedValue(undefined);
    sdk.initiateConsumeTransactionFromId.mockImplementationOnce(async (_account: string, noteId: string) => {
      order.push(`consume:${noteId}`);
      return 'tx-c';
    });
    const res = await driveConfirmation(
      () =>
        dapp.requestConsumeTransaction('https://miden.xyz', {
          type: MidenDAppMessageType.ConsumeRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            accountAddress: 'miden-account-1',
            noteId: 'note-1',
            faucetId: 'faucet-1',
            noteType: 'Private',
            amount: '50',
            noteBytes: 'c29tZWJ5dGVz'
          }
        } as never),
      MidenMessageType.DAppTransactionConfirmationRequest,
      { confirmed: true, delegate: true }
    );
    expect(res).toEqual({ type: MidenDAppMessageType.ConsumeResponse, transactionId: 'tx-c' });
    Object.assign(sdkLazy, originalSdk);
    expect(order).toEqual(['import:c29tZWJ5dGVz', 'consume:note-1']);
    expect(queueNoteImport).not.toHaveBeenCalled();
  });

  describe('requestConsumeTransaction with noteBytes checks them by the note they decode to', () => {
    // What `notes.import` answers for raw Note bytes, which the wallet stores as a details-only NoteFile.
    const detailsCommitment = '0x5d1e7a11';
    const sdk: Record<string, unknown> = require('@miden-sdk/miden-sdk/lazy');
    const originalSdk = { Note: sdk.Note, NoteFile: sdk.NoteFile };
    const sdkNote = (id: string) => ({
      id: () => ({ toString: () => id }),
      metadata: () => undefined,
      assets: () => ({ fungibleAssets: () => [], nonFungibleAssets: () => [] })
    });
    const unparsable = (what: string) => () => {
      throw new Error(`not a ${what}`);
    };
    const carryRawNote = (deserialize: () => unknown) => {
      sdk.NoteFile = { deserialize: unparsable('NoteFile') };
      sdk.Note = { deserialize };
    };
    const transaction = () => jest.requireMock('lib/miden/transaction');
    const consumeWithBytes = () =>
      driveConfirmation(
        () =>
          dapp.requestConsumeTransaction('https://miden.xyz', {
            type: MidenDAppMessageType.ConsumeRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: { accountAddress: 'miden-account-1', noteId: 'note-1', noteBytes: 'c29tZWJ5dGVz' }
          } as never),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: true, delegate: true }
      );

    beforeEach(() => {
      _g.__dappExtTest.midenClient.importNoteBytes = jest.fn().mockResolvedValue(detailsCommitment);
      _g.__dappExtTest.midenClient.syncState = jest.fn().mockResolvedValue(undefined);
      transaction().initiateConsumeTransactionFromId.mockReset();
      transaction().initiateConsumeTransactionFromId.mockResolvedValue('tx-c');
    });

    afterEach(() => {
      Object.assign(sdk, originalSdk);
      transaction().initiateConsumeTransactionFromId.mockReset();
      transaction().initiateConsumeTransactionFromId.mockResolvedValue('tx-consume-1');
    });

    it('consumes raw Note bytes that decode to noteId, whatever id the import answers with', async () => {
      carryRawNote(() => sdkNote('note-1'));

      await expect(consumeWithBytes()).resolves.toEqual({
        type: MidenDAppMessageType.ConsumeResponse,
        transactionId: 'tx-c'
      });
      expect(_g.__dappExtTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(1);
    });

    it('refuses bytes that decode to another note before importing them', async () => {
      // As in dapp.branches.test.ts: the sheet decoded note-1, so this pins the approval's own check.
      carryRawNote(jest.fn().mockReturnValueOnce(sdkNote('note-1')).mockReturnValue(sdkNote('note-other')));

      await expect(consumeWithBytes()).rejects.toThrow(
        `${MidenDAppErrorType.InvalidParams}: Error: noteBytes describe a different note than noteId`
      );
      expect(_g.__dappExtTest.midenClient.importNoteBytes).not.toHaveBeenCalled();
      expect(transaction().initiateConsumeTransactionFromId).not.toHaveBeenCalled();
    });

    it('refuses the consume before the import and retires the client when the approval-time decode traps', async () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      carryRawNote(
        jest
          .fn()
          .mockReturnValueOnce(sdkNote('note-1'))
          .mockImplementation(() => {
            throw trap;
          })
      );

      await expect(consumeWithBytes()).rejects.toThrow(`${MidenDAppErrorType.InvalidParams}: RuntimeError`);
      expect(mockRetireWasmClientForCaughtTrap).toHaveBeenCalledWith(expect.anything(), trap);
      expect(_g.__dappExtTest.midenClient.importNoteBytes).not.toHaveBeenCalled();
      expect(transaction().initiateConsumeTransactionFromId).not.toHaveBeenCalled();
    });

    const detailsOnlyFile = (id: string) => ({
      note: () => undefined,
      noteId: () => ({ toString: () => id })
    });

    it('imports a details-only NoteFile whose noteId is the requested note and consumes it', async () => {
      sdk.NoteFile = { deserialize: () => detailsOnlyFile('note-1') };
      sdk.Note = { deserialize: unparsable('Note') };

      await expect(consumeWithBytes()).resolves.toEqual({
        type: MidenDAppMessageType.ConsumeResponse,
        transactionId: 'tx-c'
      });
      expect(_g.__dappExtTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(1);
    });

    it('refuses a details-only NoteFile whose noteId is another note before importing it', async () => {
      sdk.NoteFile = { deserialize: () => detailsOnlyFile('note-other') };
      sdk.Note = { deserialize: unparsable('Note') };

      await expect(consumeWithBytes()).rejects.toThrow(
        `${MidenDAppErrorType.InvalidParams}: Error: noteBytes describe a different note than noteId`
      );
      expect(_g.__dappExtTest.midenClient.importNoteBytes).not.toHaveBeenCalled();
      expect(transaction().initiateConsumeTransactionFromId).not.toHaveBeenCalled();
    });

    describe('bytes that are neither a NoteFile nor a Note', () => {
      beforeEach(() => {
        sdk.NoteFile = { deserialize: unparsable('NoteFile') };
        sdk.Note = { deserialize: unparsable('Note') };
      });

      it('are not imported, and a note the store holds is consumed', async () => {
        const { queueNoteImport } = jest.requireMock('lib/miden/activity');

        await expect(consumeWithBytes()).resolves.toEqual({
          type: MidenDAppMessageType.ConsumeResponse,
          transactionId: 'tx-c'
        });
        expect(_g.__dappExtTest.midenClient.importNoteBytes).not.toHaveBeenCalled();
        expect(queueNoteImport).not.toHaveBeenCalled();
      });

      it('are not imported, and a note the store lacks is refused by the consume itself', async () => {
        const { queueNoteImport } = jest.requireMock('lib/miden/activity');
        transaction().initiateConsumeTransactionFromId.mockRejectedValueOnce(new Error('Input note not found'));

        await expect(consumeWithBytes()).rejects.toThrow(
          `${MidenDAppErrorType.InvalidParams}: Error: Input note not found`
        );
        expect(_g.__dappExtTest.midenClient.importNoteBytes).not.toHaveBeenCalled();
        expect(queueNoteImport).not.toHaveBeenCalled();
      });

      it('leave a kill during the consume to reach the dApp as the kill', async () => {
        const kill = new WasmClientPoisonedError('watchdog', new Error('store read parked'));
        transaction().initiateConsumeTransactionFromId.mockRejectedValueOnce(kill);

        await expect(consumeWithBytes()).rejects.toBe(kill);
        expect(_g.__dappExtTest.midenClient.importNoteBytes).not.toHaveBeenCalled();
      });
    });

    it('refuses a carried note another transaction holds rather than answer with it', async () => {
      carryRawNote(() => sdkNote('note-1'));
      transaction().initiateConsumeTransactionFromId.mockImplementationOnce(async (...args: unknown[]) => {
        if (typeof args[4] === 'string') throw new Error('This note is being consumed by another transaction');
        return 'other-dapp-transaction';
      });

      await expect(consumeWithBytes()).rejects.toThrow('This note is being consumed by another transaction');
    });

    // The import is the one await between the approval's check and the consume, and it can run long.
    it.each([
      ['the current account changes', () => (_g.__dappExtTestCurrentAccount = 'miden-account-2')],
      ['the dApp disconnects', () => delete _g.__dappExtTest.storage[STORAGE_KEY]['https://miden.xyz']]
    ])('refuses the consume when %s while the import is pending', async (_name, change) => {
      carryRawNote(() => sdkNote('note-1'));
      _g.__dappExtTest.midenClient.importNoteBytes = jest.fn(async () => {
        change();
        return detailsCommitment;
      });

      await expect(consumeWithBytes()).rejects.toThrow(MidenDAppErrorType.NotGranted);
      expect(_g.__dappExtTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(1);
      expect(transaction().initiateConsumeTransactionFromId).not.toHaveBeenCalled();
    });
  });

  it('approved consume fee refusal preserves its message without INVALID_PARAMS', async () => {
    const realQueue = jest.requireActual<typeof import('../transaction/initiate')>('../transaction/initiate');
    const { ClaimFeeRefusedError } = realQueue;
    const transaction = jest.requireMock('lib/miden/transaction');
    const originalConsume = transaction.initiateConsumeTransactionFromId.getMockImplementation();
    const feeContext = jest.mocked(
      jest.requireMock<typeof import('../transaction/claim-fee')>('../transaction/claim-fee').readClaimFeeContext
    );
    const proxy = jest.requireActual<typeof import('./miden-client-proxy')>('./miden-client-proxy').midenClientProxy;
    const summary = jest.spyOn(proxy, 'getInputNoteSummary');
    const report = jest.mocked(
      jest.requireMock<typeof import('lib/telemetry/transaction-failure')>('lib/telemetry/transaction-failure')
        .reportTransactionFailure
    );
    const notify = jest.mocked(
      jest.requireMock<typeof import('./background-notification')>('./background-notification')
        .notifyBackgroundTransactionFailed
    );
    await Repo.transactions.clear();
    feeContext.mockResolvedValue({ vaultFeeAsset: 0n, nativeAssetId: 'native-faucet', verificationBaseFee: 10000 });
    summary.mockResolvedValue({ noteType: NoteType.Public, assets: [{ faucetId: 'faucet-1', amount: '50' }] });
    transaction.initiateConsumeTransactionFromId.mockImplementation(realQueue.initiateConsumeTransactionFromId);
    try {
      const error: unknown = await driveConfirmation(
        () =>
          dapp.requestConsumeTransaction('https://miden.xyz', {
            type: MidenDAppMessageType.ConsumeRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: { noteId: 'note-1', faucetId: 'faucet-1', noteType: 'private', amount: 50 }
          }),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: true, delegate: false }
      ).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ClaimFeeRefusedError);
      if (!(error instanceof Error)) throw new Error('Expected an approved consume refusal');
      expect(error.message).toBe(new ClaimFeeRefusedError().message);
      expect(error.message).not.toContain('INVALID_PARAMS');
      expect(error.message).not.toContain(MidenDAppErrorType.InvalidParams);
      expect((await Repo.transactions.toArray()).filter(row => row.type === 'consume')).toEqual([]);
      expect(summary).toHaveBeenCalledWith('note-1');
      expect(feeContext).toHaveBeenCalledWith('miden-account-1');
      expect(startTransactionProcessing).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      transaction.initiateConsumeTransactionFromId.mockReset();
      if (originalConsume) transaction.initiateConsumeTransactionFromId.mockImplementation(originalConsume);
      feeContext.mockReset();
      feeContext.mockImplementation(jest.requireActual('../transaction/claim-fee').readClaimFeeContext);
      summary.mockRestore();
      await Repo.transactions.clear();
    }
  });

  it('requestConsumeTransaction rejects with InvalidParams when consume throws', async () => {
    const sdk = require('lib/miden/transaction');
    sdk.initiateConsumeTransactionFromId.mockRejectedValueOnce(new Error('consume failed'));
    await expect(
      driveConfirmation(
        () =>
          dapp.requestConsumeTransaction('https://miden.xyz', {
            type: MidenDAppMessageType.ConsumeRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: {
              accountAddress: 'miden-account-1',
              noteId: 'note-1',
              faucetId: 'faucet-1',
              noteType: 'Private',
              amount: '50'
            }
          } as never),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: true, delegate: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('requestConsumeTransaction rejects when user declines', async () => {
    await expect(
      driveConfirmation(
        () =>
          dapp.requestConsumeTransaction('https://miden.xyz', {
            type: MidenDAppMessageType.ConsumeRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: {
              accountAddress: 'miden-account-1',
              noteId: 'note-1',
              faucetId: 'faucet-1',
              noteType: 'Private',
              amount: '50'
            }
          } as never),
        MidenMessageType.DAppTransactionConfirmationRequest,
        { confirmed: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('requestPermission handles the extension confirmed path and stores session with publicKey', async () => {
    delete (_g.__dappExtTest.storage[STORAGE_KEY] as any)['https://fresh-dapp.xyz'];
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([10, 20, 30]) }]
    });
    const res = await driveConfirmation(
      () =>
        dapp.requestPermission('https://fresh-dapp.xyz', {
          type: MidenDAppMessageType.PermissionRequest,
          appMeta: { name: 'Fresh Dapp', url: 'https://fresh-dapp.xyz' },
          force: false,
          network: 'testnet',
          privateDataPermission: 'UPON_REQUEST',
          allowedPrivateData: 0
        } as never),
      MidenMessageType.DAppPermConfirmationRequest,
      {
        confirmed: true,
        accountPublicKey: 'miden-account-1',
        privateDataPermission: 'UPON_REQUEST'
      }
    );
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
    expect((res as any).publicKey).toBeDefined();
  });

  it('requestPermission in extension fails the confirmation and saves no session when getAccountPublicKeyB64 throws', async () => {
    delete (_g.__dappExtTest.storage[STORAGE_KEY] as any)['https://err-dapp.xyz'];
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue(null);
    await expect(
      driveConfirmation(
        () =>
          dapp.requestPermission('https://err-dapp.xyz', {
            type: MidenDAppMessageType.PermissionRequest,
            appMeta: { name: 'Err Dapp', url: 'https://err-dapp.xyz' },
            force: false,
            network: 'testnet',
            privateDataPermission: 'UPON_REQUEST',
            allowedPrivateData: 0
          } as never),
        MidenMessageType.DAppPermConfirmationRequest,
        {
          confirmed: true,
          accountPublicKey: 'miden-account-1',
          privateDataPermission: 'UPON_REQUEST'
        }
      )
    ).rejects.toThrow('Account not found');
    // The confirm page got the error instead of a response (#1471).
    expect(_g.__dappExtTest.lastConfirmResponse).toBeUndefined();
    // A failed pubkey fetch must not persist a publicKey: null session.
    expect((_g.__dappExtTest.storage[STORAGE_KEY] as any)['https://err-dapp.xyz']).toBeUndefined();
  });
});

describe('a prompted request approved after the current account changed (#1419, #1415)', () => {
  const ORIGIN = 'https://miden.xyz';
  const consumeTx = { noteId: 'note-1', faucetId: 'faucet-1', noteType: 'Private', amount: '50' };
  const transaction = () => require('lib/miden/transaction');

  beforeEach(() => {
    _g.__dappExtTest.midenClient.getAccount = jest
      .fn()
      .mockResolvedValue({ vault: () => ({ fungibleAssets: () => [] }) });
    _g.__dappExtTest.midenClient.importNoteBytes = jest.fn().mockResolvedValue('imported-note-id');
  });

  // Each handler, its confirm request and response, and what it does once approved, none of which may run here.
  const cases: ReadonlyArray<
    readonly [string, () => Promise<unknown>, MidenMessageType, MidenMessageType, () => readonly jest.Mock[]]
  > = [
    [
      'assets',
      () =>
        dapp.requestAssets(ORIGIN, {
          type: MidenDAppMessageType.AssetsRequest,
          sourcePublicKey: 'miden-account-1'
        } as never),
      MidenMessageType.DAppAssetsConfirmationRequest,
      MidenMessageType.DAppAssetsConfirmationResponse,
      () => []
    ],
    [
      'privateNotes',
      () =>
        dapp.requestPrivateNotes(ORIGIN, {
          type: MidenDAppMessageType.PrivateNotesRequest,
          sourcePublicKey: 'miden-account-1',
          notefilterType: NoteFilterTypes.List,
          noteIds: ['note-1']
        } as never),
      MidenMessageType.DAppPrivateNotesConfirmationRequest,
      MidenMessageType.DAppPrivateNotesConfirmationResponse,
      () => []
    ],
    [
      'consumableNotes',
      () =>
        dapp.requestConsumableNotes(ORIGIN, {
          type: MidenDAppMessageType.ConsumableNotesRequest,
          sourcePublicKey: 'miden-account-1'
        } as never),
      MidenMessageType.DAppConsumableNotesConfirmationRequest,
      MidenMessageType.DAppConsumableNotesConfirmationResponse,
      () => []
    ],
    [
      'importPrivateNote',
      () =>
        dapp.requestImportPrivateNote(ORIGIN, {
          type: MidenDAppMessageType.ImportPrivateNoteRequest,
          sourcePublicKey: 'miden-account-1',
          note: 'aGVsbG8='
        } as never),
      MidenMessageType.DAppImportPrivateNoteConfirmationRequest,
      MidenMessageType.DAppImportPrivateNoteConfirmationResponse,
      () => [_g.__dappExtTest.midenClient.importNoteBytes]
    ],
    [
      'consume',
      () =>
        dapp.requestConsumeTransaction(ORIGIN, {
          type: MidenDAppMessageType.ConsumeRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: { ...consumeTx, noteBytes: 'aGVsbG8=' }
        } as never),
      MidenMessageType.DAppTransactionConfirmationRequest,
      MidenMessageType.DAppTransactionConfirmationResponse,
      () => [require('lib/miden/activity').queueNoteImport, transaction().initiateConsumeTransactionFromId]
    ]
  ];

  it.each(cases)(
    'refuses %s with NOT_GRANTED and still answers the confirm page',
    async (_name, start, confirmRequest, confirmResponse, actions) => {
      await expect(
        driveConfirmation(start, confirmRequest, { confirmed: true, delegate: true }, () =>
          switchCurrentAccount('miden-account-2')
        )
      ).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
      expect(_g.__dappExtTest.lastConfirmResponse).toEqual({ type: confirmResponse });
      for (const action of actions()) expect(action).not.toHaveBeenCalled();
    }
  );
});

// ── Watchdog eviction mid-flow (#788 follow-up) ────────────────────

describe('a watchdog eviction mid-read abandons the extension flow instead of double-borrowing', () => {
  // Both tests revoke hold ownership from INSIDE the parking account read — the
  // moment the real watchdog hands the mutex to a successor — and pin that the
  // commitment reads on the returned Account never run: those are borrows of the
  // client's RefCell, so touching them after the eviction IS the double borrow.

  it('requestPermission fails the confirmation with the poison error when evicted during the account read', async () => {
    delete (_g.__dappExtTest.storage[STORAGE_KEY] as any)['https://evicted-dapp.xyz'];
    const getPublicKeyCommitments = jest.fn(() => [{ serialize: () => new Uint8Array([1, 2, 3]) }]);
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockImplementation(async () => {
      revokeWasmHold();
      return { getPublicKeyCommitments };
    });
    await expect(
      driveConfirmation(
        () =>
          dapp.requestPermission('https://evicted-dapp.xyz', {
            type: MidenDAppMessageType.PermissionRequest,
            appMeta: { name: 'Evicted Dapp', url: 'https://evicted-dapp.xyz' },
            force: false,
            network: 'testnet',
            privateDataPermission: 'UPON_REQUEST',
            allowedPrivateData: 0
          } as never),
        MidenMessageType.DAppPermConfirmationRequest,
        { confirmed: true, accountPublicKey: 'miden-account-1', privateDataPermission: 'UPON_REQUEST' }
      )
      // The confirm page gets the eviction, a retryable internal failure rather
      // than a permissions verdict (#775), and the dApp waits for a Retry (#1471).
    ).rejects.toThrow(WasmClientPoisonedError);
    expect(_g.__dappExtTest.lastConfirmResponse).toBeUndefined();
    // The abandoned flow must not have touched the borrowed account…
    expect(getPublicKeyCommitments).not.toHaveBeenCalled();
    // …nor persisted a session with a publicKey it never safely read.
    expect((_g.__dappExtTest.storage[STORAGE_KEY] as any)['https://evicted-dapp.xyz']).toBeUndefined();
  });

  it('requestPermission fails the confirmation with the terminated-client refusal when the account read meets one', async () => {
    // A terminated client is a kill like the eviction above: retryable, never a permissions verdict.
    const terminated = new Error('WebClient terminated');
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockRejectedValue(terminated);
    await expect(
      driveConfirmation(
        () =>
          dapp.requestPermission('https://terminated-dapp.xyz', {
            type: MidenDAppMessageType.PermissionRequest,
            appMeta: { name: 'Terminated Dapp' },
            network: WalletAdapterNetwork.Testnet
          }),
        MidenMessageType.DAppPermConfirmationRequest,
        { confirmed: true, accountPublicKey: 'miden-account-1', privateDataPermission: 'UPON_REQUEST' }
      )
    ).rejects.toBe(terminated);
    expect(_g.__dappExtTest.lastConfirmResponse).toBeUndefined();
  });

  it('requestSign rejects with the poison error, not a false NotGranted, when evicted during the authorization read', async () => {
    arrangeSignerAccount();
    const getPublicKeyCommitments = jest.fn(() => [{ serialize: () => SIGNER_COMMITMENT }]);
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockImplementation(async () => {
      revokeWasmHold();
      return { getPublicKeyCommitments };
    });
    const signData = jest.fn(async () => 'stolen-signature');
    mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: { signData } }));
    await expect(
      driveConfirmation(
        () =>
          dapp.requestSign('https://miden.xyz', {
            type: MidenDAppMessageType.SignRequest,
            sourcePublicKey: SIGNER_COMMITMENT_HEX,
            sourceAccountId: 'miden-account-1',
            payload: 'aGVsbG8=',
            kind: 'word'
          } as never),
        MidenMessageType.DAppSignConfirmationRequest,
        { confirmed: true }
      )
    ).rejects.toThrow(WasmClientPoisonedError);
    expect(getPublicKeyCommitments).not.toHaveBeenCalled();
    // An abandoned authorization must fail the request, never sign anyway.
    expect(signData).not.toHaveBeenCalled();
  });

  it('requestSign rejects with the terminated-client refusal, not a false NotGranted, when the authorization read meets one', async () => {
    arrangeSignerAccount();
    const terminated = new Error('WebClient terminated');
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockRejectedValue(terminated);
    const signData = jest.fn(async () => 'stolen-signature');
    mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: { signData } }));
    await expect(
      driveConfirmation(
        () =>
          dapp.requestSign('https://miden.xyz', {
            type: MidenDAppMessageType.SignRequest,
            sourcePublicKey: SIGNER_COMMITMENT_HEX,
            sourceAccountId: 'miden-account-1',
            payload: 'aGVsbG8=',
            kind: 'word'
          }),
        MidenMessageType.DAppSignConfirmationRequest,
        { confirmed: true }
      )
    ).rejects.toBe(terminated);
    expect(signData).not.toHaveBeenCalled();
  });

  it('requestSign rejects an approved cause-wrapped poison with its inner kill', async () => {
    arrangeSignerAccount();
    const kill = new WasmClientPoisonedError('watchdog', new Error('authorization read parked'));
    _g.__dappExtTest.midenClient.getAccount = jest
      .fn()
      .mockRejectedValueOnce(new Error('NOT_GRANTED: authorization wrapper', { cause: kill }));
    const signData = jest.fn(async () => 'stolen-signature');
    mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: { signData } }));

    await expect(
      driveConfirmation(
        () =>
          dapp.requestSign('https://miden.xyz', {
            type: MidenDAppMessageType.SignRequest,
            sourcePublicKey: SIGNER_COMMITMENT_HEX,
            sourceAccountId: 'miden-account-1',
            payload: 'aGVsbG8=',
            kind: 'word'
          }),
        MidenMessageType.DAppSignConfirmationRequest,
        { confirmed: true }
      )
    ).rejects.toBe(kill);
    expect(signData).not.toHaveBeenCalled();
    expect(_g.__dappExtTest.lastConfirmResponse).toEqual({ type: MidenMessageType.DAppSignConfirmationResponse });
  });
});

// ── a locked wallet: the popup opens on Unlock and builds its payload after the unlock (#1414) ──

const lockedGateError = () => Object.assign(new Error('Wallet is locked'), { reason: 'locked' as const });

function lockWallet() {
  _g.__dappExtTestStatus = WalletStatus.Locked;
  mockWithUnlocked.mockImplementation(async () => {
    throw lockedGateError();
  });
}

function unlockWallet() {
  _g.__dappExtTestStatus = WalletStatus.Ready;
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn(unlockedContext()));
  for (const listener of [..._g.__dappExtTestStoreListeners]) listener({ status: WalletStatus.Ready });
}

// The window id `windows.create` answers with in this suite.
const closeConfirmWindow = () => {
  for (const listener of [..._g.__dappExtRemovedListeners]) listener(999);
};

type Outcome = { ok: true; value: unknown } | { ok: false; message: string };
const settle = (call: Promise<unknown>): Promise<Outcome> =>
  call.then(
    (value): Outcome => ({ ok: true, value }),
    (error: Error): Outcome => ({ ok: false, message: error.message })
  );

async function openPopup(start: () => Promise<unknown>) {
  const create = jest.mocked(extensionBrowser.windows.create);
  const opened = create.mock.calls.length;
  const outcome = settle(start());
  for (let i = 0; i < 5 && create.mock.calls.length === opened; i++) await new Promise(r => setTimeout(r, 0));
  expect(create).toHaveBeenCalledTimes(opened + 1);
  const id = String(create.mock.calls.at(-1)?.[0]?.url ?? '').match(/[?&]id=([^&]+)/)?.[1];
  const listener = _g.__dappExtTest.intercomListeners.at(-1);
  const port = { id: 'confirm-port' };
  return {
    outcome,
    getPayload: () => listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port),
    decide: (type: MidenMessageType, fields: Record<string, unknown> = { confirmed: true }) =>
      listener({ type, id, ...fields }, port)
  };
}

const LOCKED_ORIGIN = 'https://miden.xyz';
const startAssets = () =>
  dapp.requestAssets(LOCKED_ORIGIN, {
    type: MidenDAppMessageType.AssetsRequest,
    sourcePublicKey: 'miden-account-1'
  } as never);

describe('a request that prompts, made while the wallet is locked (#1414)', () => {
  beforeEach(() => {
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue(undefined);
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest.fn(async () => []);
    _g.__dappExtTest.midenClient.syncState = jest.fn(async () => undefined);
  });

  const kinds = [
    {
      name: 'assets',
      start: startAssets,
      reads: () => _g.__dappExtTest.midenClient.getAccount.mock.calls.length,
      confirm: MidenMessageType.DAppAssetsConfirmationRequest,
      fields: { confirmed: true },
      answer: MidenDAppMessageType.AssetsResponse
    },
    {
      name: 'privateNotes',
      start: () =>
        dapp.requestPrivateNotes(LOCKED_ORIGIN, {
          type: MidenDAppMessageType.PrivateNotesRequest,
          sourcePublicKey: 'miden-account-1',
          notefilterType: NoteFilterTypes.List,
          noteIds: ['note-1']
        } as never),
      reads: () => _g.__dappExtTest.midenClient.getInputNoteDetails.mock.calls.length,
      confirm: MidenMessageType.DAppPrivateNotesConfirmationRequest,
      fields: { confirmed: true },
      answer: MidenDAppMessageType.PrivateNotesResponse
    },
    {
      name: 'consumableNotes',
      start: () =>
        dapp.requestConsumableNotes(LOCKED_ORIGIN, {
          type: MidenDAppMessageType.ConsumableNotesRequest,
          sourcePublicKey: 'miden-account-1'
        } as never),
      reads: () => _g.__dappExtTest.midenClient.getConsumableNoteDtos.mock.calls.length,
      confirm: MidenMessageType.DAppConsumableNotesConfirmationRequest,
      fields: { confirmed: true },
      answer: MidenDAppMessageType.ConsumableNotesResponse
    },
    {
      name: 'send',
      start: () =>
        dapp.requestSendTransaction(LOCKED_ORIGIN, {
          type: MidenDAppMessageType.SendTransactionRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            senderAddress: 'miden-account-1',
            recipientAddress: 'bob',
            faucetId: 'faucet-1',
            noteType: 'Private',
            amount: '100'
          }
        } as never),
      reads: () => mockAssessOutgoingSpendingLimitDetails.mock.calls.length,
      confirm: MidenMessageType.DAppTransactionConfirmationRequest,
      fields: { confirmed: true, delegate: false },
      answer: MidenDAppMessageType.SendTransactionResponse
    },
    {
      name: 'custom',
      start: () =>
        dapp.requestTransaction(LOCKED_ORIGIN, {
          type: MidenDAppMessageType.TransactionRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            payload: { address: 'miden-account-1', recipientAddress: 'bob', transactionRequest: 'b64req' }
          }
        } as never),
      // The custom build ends in the spending-limit state, which reads one of these two.
      reads: () => mockHasSpendingLimits.mock.calls.length + mockAssessOutgoingSpendingLimitDetails.mock.calls.length,
      confirm: MidenMessageType.DAppTransactionConfirmationRequest,
      fields: { confirmed: true, delegate: false },
      answer: MidenDAppMessageType.TransactionResponse
    },
    {
      name: 'consume',
      start: () =>
        dapp.requestConsumeTransaction(LOCKED_ORIGIN, {
          type: MidenDAppMessageType.ConsumeRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            accountAddress: 'miden-account-1',
            noteId: 'note-1',
            faucetId: 'faucet-1',
            noteType: 'Private',
            amount: '50'
          }
        } as never),
      reads: () => _g.__dappExtTest.midenClient.getInputNoteDetails.mock.calls.length,
      confirm: MidenMessageType.DAppTransactionConfirmationRequest,
      fields: { confirmed: true, delegate: false },
      answer: MidenDAppMessageType.ConsumeResponse
    }
  ];

  it('rejects custom request bytes that cannot deserialize without opening a locked-wallet popup', async () => {
    const sdk: Record<string, unknown> = require('@miden-sdk/miden-sdk/lazy');
    const originalRequest = sdk.TransactionRequest;
    sdk.TransactionRequest = {
      deserialize: () => {
        throw new Error('not a transaction request');
      }
    };
    lockWallet();
    try {
      const outcome = settle(
        dapp.requestTransaction(LOCKED_ORIGIN, {
          type: MidenDAppMessageType.TransactionRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            type: 'custom',
            payload: {
              address: 'miden-account-1',
              recipientAddress: 'bob',
              transactionRequest: 'bm90IGEgdHJhbnNhY3Rpb24gcmVxdWVzdA=='
            }
          }
        } as never)
      );
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
      await expect(outcome).resolves.toEqual({ ok: false, message: expect.stringMatching(/^INVALID_PARAMS: /) });
    } finally {
      closeConfirmWindow();
      unlockWallet();
      sdk.TransactionRequest = originalRequest;
    }
  });

  describe('a custom request whose decode or summary traps (F-001)', () => {
    const startCustom = () =>
      dapp.requestTransaction(LOCKED_ORIGIN, {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: {
          type: 'custom',
          payload: { address: 'miden-account-1', recipientAddress: 'bob', transactionRequest: 'cmVxdWVzdA==' }
        }
      } as never);

    const withRequest = async (deserialize: () => unknown, run: () => Promise<void>) => {
      const sdk: Record<string, unknown> = require('@miden-sdk/miden-sdk/lazy');
      const originalRequest = sdk.TransactionRequest;
      sdk.TransactionRequest = { deserialize };
      try {
        await run();
      } finally {
        closeConfirmWindow();
        unlockWallet();
        sdk.TransactionRequest = originalRequest;
      }
    };

    it('retires the client when the request decode traps, and refuses before any popup', async () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      await withRequest(
        () => {
          throw trap;
        },
        async () => {
          lockWallet();
          const outcome = settle(startCustom());
          await new Promise(resolve => setTimeout(resolve, 0));

          expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
          await expect(outcome).resolves.toEqual({ ok: false, message: expect.stringMatching(/^INVALID_PARAMS: /) });
          expect(mockRetireWasmClientForCaughtTrap).toHaveBeenCalledWith(expect.anything(), trap);
        }
      );
    });

    it('retires the client when the declared summary traps, and refuses before any popup', async () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      await withRequest(
        () => ({
          expectedOutputOwnNotes: () => {
            throw trap;
          }
        }),
        async () => {
          lockWallet();
          const outcome = settle(startCustom());
          await new Promise(resolve => setTimeout(resolve, 0));

          expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
          await expect(outcome).resolves.toEqual({ ok: false, message: expect.stringMatching(/^INVALID_PARAMS: /) });
          expect(mockRetireWasmClientForCaughtTrap).toHaveBeenCalledWith(expect.anything(), trap);
        }
      );
    });

    it('keeps the opaque warning, and retires nothing, when the summary fails without a trap', async () => {
      await withRequest(
        () => ({
          expectedOutputOwnNotes: () => {
            throw new Error('cannot summarise');
          }
        }),
        async () => {
          lockWallet();
          const popup = await openPopup(startCustom);
          unlockWallet();
          const payload = await popup.getPayload();

          expect(JSON.stringify(payload)).toContain('Warning, the wallet could not decode this transaction request');
          expect(mockRetireWasmClientForCaughtTrap).not.toHaveBeenCalled();
        }
      );
    });
  });

  it.each(kinds)('$name: opens the popup with no read, reads only for the payload after the unlock', async kind => {
    lockWallet();
    const popup = await openPopup(kind.start);
    expect(kind.reads()).toBe(0);

    unlockWallet();
    await expect(popup.getPayload()).resolves.toEqual(
      expect.objectContaining({ type: MidenMessageType.DAppGetPayloadResponse })
    );
    expect(kind.reads()).toBeGreaterThan(0);

    await popup.decide(kind.confirm, kind.fields);
    await expect(popup.outcome).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({ type: kind.answer })
    });
  });

  it.each(kinds)('$name: answers NOT_GRANTED: Wallet is locked when the popup closes before the unlock', async kind => {
    lockWallet();
    const popup = await openPopup(kind.start);
    closeConfirmWindow();
    await expect(popup.outcome).resolves.toEqual({ ok: false, message: 'NOT_GRANTED: Wallet is locked' });
    expect(kind.reads()).toBe(0);
  });

  it('builds again after a lock that lands as the popup asks for its payload, and serves one build', async () => {
    lockWallet();
    const popup = await openPopup(startAssets);
    // Still locked when the payload is asked for: the build waits for the next unlock.
    const served = popup.getPayload();
    await new Promise(r => setTimeout(r, 0));
    expect(_g.__dappExtTest.midenClient.getAccount).not.toHaveBeenCalled();

    unlockWallet();
    await expect(served).resolves.toEqual(expect.objectContaining({ type: MidenMessageType.DAppGetPayloadResponse }));
    await popup.getPayload();
    expect(_g.__dappExtTest.midenClient.getAccount).toHaveBeenCalledTimes(1);
  });

  it('runs no re-check and no read for a popup closed while its payload waited for the unlock', async () => {
    lockWallet();
    const popup = await openPopup(startAssets);
    const served = popup.getPayload();
    served.catch(() => undefined);
    await new Promise(r => setTimeout(r, 0));
    const gateCalls = mockWithUnlocked.mock.calls.length;

    closeConfirmWindow();
    await expect(popup.outcome).resolves.toEqual({ ok: false, message: 'NOT_GRANTED: Wallet is locked' });
    unlockWallet();
    await new Promise(r => setTimeout(r, 0));

    // The close cancelled the waiting build, so the unlock ran neither the re-check nor the read.
    expect(mockWithUnlocked).toHaveBeenCalledTimes(gateCalls);
    expect(_g.__dappExtTest.midenClient.getAccount).not.toHaveBeenCalled();
  });

  it("answers a build failure with the unlocked path's text and closes the popup", async () => {
    lockWallet();
    const popup = await openPopup(startAssets);
    unlockWallet();
    _g.__dappExtTest.midenClient.getAccount.mockRejectedValueOnce(new Error('node down'));
    await expect(popup.getPayload()).rejects.toThrow('node down');
    await expect(popup.outcome).resolves.toEqual({ ok: false, message: 'INVALID_PARAMS: Error: node down' });
    await new Promise(r => setTimeout(r, 0));
    expect(extensionBrowser.windows.remove).toHaveBeenCalled();
  });

  it("answers a send build's policy failure with the send path's own refusal", async () => {
    lockWallet();
    const popup = await openPopup(kinds[3]!.start);
    unlockWallet();
    mockAssessOutgoingSpendingLimitDetails.mockRejectedValueOnce(
      Object.assign(new Error('policy unreadable'), { code: 'SPENDING_LIMIT_POLICY_UNAVAILABLE' })
    );
    await expect(popup.getPayload()).rejects.toThrow();
    await expect(popup.outcome).resolves.toEqual({
      ok: false,
      message: 'NOT_GRANTED: Spending limit changed. Review and retry the transaction.'
    });
  });

  it('refuses with NOT_GRANTED and reads nothing when the dApp was disconnected before the unlock', async () => {
    lockWallet();
    const popup = await openPopup(startAssets);
    _g.__dappExtTest.storage[STORAGE_KEY] = { [LOCKED_ORIGIN]: [] };
    unlockWallet();
    await expect(popup.getPayload()).rejects.toThrow(MidenDAppErrorType.NotGranted);
    await expect(popup.outcome).resolves.toEqual({ ok: false, message: MidenDAppErrorType.NotGranted });
    expect(_g.__dappExtTest.midenClient.getAccount).not.toHaveBeenCalled();
  });

  it('runs the next request on its unlocked path once the user unlocked in the first popup', async () => {
    lockWallet();
    const first = await openPopup(startAssets);
    unlockWallet();
    await first.getPayload();
    await first.decide(MidenMessageType.DAppAssetsConfirmationRequest);
    await first.outcome;
    _g.__dappExtTest.midenClient.getAccount.mockClear();

    await openPopup(startAssets);
    // Read before its popup opened, with no Unlock step: today's unlocked order.
    expect(_g.__dappExtTest.midenClient.getAccount).toHaveBeenCalledTimes(1);
  });

  it('still reads before the popup opens while unlocked', async () => {
    await openPopup(startAssets);
    const create = jest.mocked(extensionBrowser.windows.create);
    const readAt = _g.__dappExtTest.midenClient.getAccount.mock.invocationCallOrder[0] ?? Infinity;
    expect(readAt).toBeLessThan(create.mock.invocationCallOrder.at(-1) ?? 0);
  });

  it.each([kinds[0]!, kinds[5]!])(
    '$name: serves an unlocked popup the data read before it opened, reading once',
    async kind => {
      const popup = await openPopup(kind.start);
      await expect(popup.getPayload()).resolves.toEqual(
        expect.objectContaining({ type: MidenMessageType.DAppGetPayloadResponse })
      );
      // One read, before the popup: serving the payload builds nothing again.
      expect(kind.reads()).toBe(1);
    }
  );

  it('still refuses an unlocked consume of a note it cannot resolve before any popup', async () => {
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest.fn().mockResolvedValue([]);
    await expect(kinds[5]!.start()).rejects.toThrow('could not be resolved');
    expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
  });
});

// A details-only note file or a bare Note imports as its details commitment, which no record has as its note id.
describe('requestConsumeTransaction by the id importPrivateNote returned, in extension mode (#1389)', () => {
  const COMMITMENT = '0xd37a115c0ffee';
  const request: MidenDAppConsumeRequest = {
    type: MidenDAppMessageType.ConsumeRequest,
    sourcePublicKey: 'miden-account-1',
    transaction: { noteId: COMMITMENT, faucetId: 'faucet-1', noteType: 'private', amount: 1 }
  };
  const importedNote = {
    noteId: '0xreal-note',
    noteType: 0,
    senderAccountId: 's1',
    nullifier: 'nf-real',
    state: 2,
    assets: [{ faucetId: 'faucet-1', amount: '45' }],
    nonFungibleAssets: []
  };

  beforeEach(() => {
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest.fn().mockResolvedValue([]);
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest
      .fn()
      .mockResolvedValue([{ noteId: '0xreal-note', nullifier: 'nf-real' }]);
  });

  afterEach(() => {
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest.fn(async () => []);
  });

  it.each([false, true])(
    'consumes bare Note bytes by commitment when decoding after unlock is %s',
    async decodeAfterUnlock => {
      const sdk: Record<string, unknown> = require('@miden-sdk/miden-sdk/lazy');
      const original = { Note: sdk.Note, NoteFile: sdk.NoteFile };
      const hash = jest.mocked(Poseidon2.hashElements);
      const originalHash = hash.getMockImplementation();
      hash.mockReturnValue(Word.fromHex(COMMITMENT));
      const note = {
        id: () => ({ toString: () => importedNote.noteId }),
        metadata: () => undefined,
        recipient: () => ({ digest: () => Word.fromHex(COMMITMENT) }),
        assets: () => ({ assets: () => [], fungibleAssets: () => [], nonFungibleAssets: () => [] })
      };
      const deserialize = jest.fn(() => note);
      if (decodeAfterUnlock)
        deserialize.mockImplementationOnce(() => {
          throw new Error('SDK not ready');
        });
      sdk.NoteFile = {
        deserialize: () => {
          throw new Error('not a NoteFile');
        }
      };
      sdk.Note = { deserialize };
      _g.__dappExtTest.midenClient.importNoteBytes = jest.fn().mockResolvedValue(COMMITMENT);
      const outcome = dapp.requestConsumeTransaction('https://miden.xyz', {
        ...request,
        transaction: { ...request.transaction, noteBytes: 'c29tZWJ5dGVz' }
      });
      outcome.catch(() => undefined);
      try {
        await expect(
          driveConfirmation(() => outcome, MidenMessageType.DAppTransactionConfirmationRequest, {
            confirmed: true,
            delegate: true
          })
        ).resolves.toEqual({ type: MidenDAppMessageType.ConsumeResponse, transactionId: 'tx-consume-1' });
        expect(_g.__dappExtTest.lastPayloadResponse.payload).toMatchObject({
          type: 'consume',
          noteId: importedNote.noteId
        });
        expect(_g.__dappExtTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(1);
        expect(require('lib/miden/transaction').initiateConsumeTransactionFromId).toHaveBeenCalledWith(
          'miden-account-1',
          importedNote.noteId,
          true,
          true,
          'https://miden.xyz',
          'dapp'
        );
      } finally {
        Object.assign(sdk, original);
        hash.mockReset();
        if (originalHash) hash.mockImplementation(originalHash);
      }
    }
  );

  it('consumes a details-only file by its requested commitment after approval', async () => {
    const sdk: Record<string, unknown> = require('@miden-sdk/miden-sdk/lazy');
    const original = { Note: sdk.Note, NoteFile: sdk.NoteFile };
    sdk.NoteFile = { deserialize: () => ({ note: () => undefined, noteId: () => ({ toString: () => COMMITMENT }) }) };
    sdk.Note = {
      deserialize: () => {
        throw new Error('not a Note');
      }
    };
    _g.__dappExtTest.midenClient.getDetailsCommitmentMatches = jest
      .fn()
      .mockResolvedValue([{ notes: [importedNote], uncommitted: 0 }]);
    _g.__dappExtTest.midenClient.importNoteBytes = jest.fn().mockResolvedValue(COMMITMENT);
    try {
      await expect(
        driveConfirmation(
          () =>
            dapp.requestConsumeTransaction('https://miden.xyz', {
              ...request,
              transaction: { ...request.transaction, noteBytes: 'c29tZWJ5dGVz' }
            }),
          MidenMessageType.DAppTransactionConfirmationRequest,
          { confirmed: true, delegate: true }
        )
      ).resolves.toEqual({ type: MidenDAppMessageType.ConsumeResponse, transactionId: 'tx-consume-1' });
      expect(_g.__dappExtTest.lastPayloadResponse.payload).toMatchObject({
        type: 'consume',
        noteId: importedNote.noteId
      });
      expect(require('lib/miden/transaction').initiateConsumeTransactionFromId).toHaveBeenCalledWith(
        'miden-account-1',
        importedNote.noteId,
        true,
        true,
        'https://miden.xyz',
        'dapp'
      );
    } finally {
      Object.assign(sdk, original);
    }
  });

  it('opens on the note the commitment names and consumes it by its own note id', async () => {
    _g.__dappExtTest.midenClient.getDetailsCommitmentMatches = jest
      .fn()
      .mockResolvedValue([{ notes: [importedNote], uncommitted: 0 }]);

    const res = await driveConfirmation(
      () => dapp.requestConsumeTransaction('https://miden.xyz', request),
      MidenMessageType.DAppTransactionConfirmationRequest,
      { confirmed: true, delegate: true }
    );

    expect(res).toEqual({ type: MidenDAppMessageType.ConsumeResponse, transactionId: 'tx-consume-1' });
    expect(_g.__dappExtTest.lastPayloadResponse.payload).toMatchObject({ type: 'consume', noteId: '0xreal-note' });
    expect(_g.__dappExtTest.lastPayloadResponse.payload.transactionMessages).toContain('Amount, +45');
    expect(require('lib/miden/transaction').initiateConsumeTransactionFromId).toHaveBeenCalledWith(
      'miden-account-1',
      '0xreal-note',
      true,
      true,
      'https://miden.xyz',
      'dapp'
    );
  });

  it('gives unknown, uncommitted and other-account ids exactly the same sync guidance', async () => {
    const refusal = new Error(
      `${MidenDAppErrorType.InvalidParams}: Error: Note ${COMMITMENT} could not be resolved - an imported note resolves once the wallet has synced it`
    );
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest.fn().mockResolvedValue([]);
    for (const match of [
      { notes: [], uncommitted: 0 },
      { notes: [], uncommitted: 1 },
      { notes: [importedNote], uncommitted: 0 }
    ]) {
      _g.__dappExtTest.midenClient.getDetailsCommitmentMatches = jest.fn().mockResolvedValue([match]);
      await expect(dapp.requestConsumeTransaction('https://miden.xyz', request)).rejects.toEqual(refusal);
    }
    expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
    expect(require('lib/miden/transaction').initiateConsumeTransactionFromId).not.toHaveBeenCalled();
  });
});

describe('a request that never prompts while unlocked, made while the wallet is locked (#1414)', () => {
  const autoSession = (allowedPrivateData: number) => {
    _g.__dappExtTest.storage[STORAGE_KEY] = {
      [LOCKED_ORIGIN]: [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData }]
    };
  };

  beforeEach(() => {
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue(undefined);
    _g.__dappExtTest.midenClient.getConsumableNoteDtos = jest.fn(async () => []);
    _g.__dappExtTest.midenClient.syncState = jest.fn(async () => undefined);
  });

  const kinds = [
    {
      name: 'assets',
      allowed: 1,
      start: startAssets,
      reads: () => _g.__dappExtTest.midenClient.getAccount.mock.calls.length,
      answer: MidenDAppMessageType.AssetsResponse
    },
    {
      name: 'privateNotes',
      allowed: 2,
      start: () =>
        dapp.requestPrivateNotes(LOCKED_ORIGIN, {
          type: MidenDAppMessageType.PrivateNotesRequest,
          sourcePublicKey: 'miden-account-1',
          notefilterType: NoteFilterTypes.List,
          noteIds: ['note-1']
        } as never),
      reads: () => _g.__dappExtTest.midenClient.getInputNoteDetails.mock.calls.length,
      answer: MidenDAppMessageType.PrivateNotesResponse
    },
    {
      name: 'consumableNotes',
      allowed: 2,
      start: () =>
        dapp.requestConsumableNotes(LOCKED_ORIGIN, {
          type: MidenDAppMessageType.ConsumableNotesRequest,
          sourcePublicKey: 'miden-account-1'
        } as never),
      reads: () => _g.__dappExtTest.midenClient.getConsumableNoteDtos.mock.calls.length,
      answer: MidenDAppMessageType.ConsumableNotesResponse
    },
    {
      name: 'guardianInfo',
      allowed: 0,
      start: () =>
        dapp.requestGuardianInfo(LOCKED_ORIGIN, {
          type: MidenDAppMessageType.GuardianInfoRequest,
          sourcePublicKey: 'miden-account-1'
        } as never),
      reads: () => mockFetchAccounts.mock.calls.length,
      answer: MidenDAppMessageType.GuardianInfoResponse
    }
  ];

  it.each(kinds)('$name: opens an unlock-only popup, reads nothing until the unlock, then answers', async kind => {
    autoSession(kind.allowed);
    lockWallet();
    const popup = await openPopup(kind.start);
    expect(kind.reads()).toBe(0);

    unlockWallet();
    await expect(popup.getPayload()).resolves.toEqual(
      expect.objectContaining({ payload: expect.objectContaining({ type: 'unlock', origin: LOCKED_ORIGIN }) })
    );
    await expect(popup.decide(MidenMessageType.DAppUnlockConfirmationRequest, {})).resolves.toEqual({
      type: MidenMessageType.DAppUnlockConfirmationResponse
    });
    await expect(popup.outcome).resolves.toEqual({ ok: true, value: expect.objectContaining({ type: kind.answer }) });
    expect(kind.reads()).toBeGreaterThan(0);
  });

  it.each(kinds)(
    '$name: answers NOT_GRANTED: Wallet is locked and reads nothing when the popup closes still locked',
    async kind => {
      autoSession(kind.allowed);
      lockWallet();
      const popup = await openPopup(kind.start);
      closeConfirmWindow();
      await expect(popup.outcome).resolves.toEqual({ ok: false, message: 'NOT_GRANTED: Wallet is locked' });
      expect(kind.reads()).toBe(0);
    }
  );

  it('refuses with NOT_GRANTED and reads nothing when the dApp was disconnected before the unlock', async () => {
    autoSession(1);
    lockWallet();
    const popup = await openPopup(startAssets);
    _g.__dappExtTest.storage[STORAGE_KEY] = { [LOCKED_ORIGIN]: [] };
    unlockWallet();
    await popup.getPayload();
    await popup.decide(MidenMessageType.DAppUnlockConfirmationRequest, {});
    await expect(popup.outcome).resolves.toEqual({ ok: false, message: MidenDAppErrorType.NotGranted });
    expect(_g.__dappExtTest.midenClient.getAccount).not.toHaveBeenCalled();
  });

  it('still answers an unlocked Auto read with no popup', async () => {
    autoSession(1);
    await expect(startAssets()).resolves.toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.AssetsResponse })
    );
    expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
  });
});

describe('the lock prompt cooldown (#1414)', () => {
  let now = 1_000_000;
  let clock: jest.SpyInstance;
  beforeEach(() => {
    now = 1_000_000;
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    _g.__dappExtTest.midenClient.getAccount = jest.fn().mockResolvedValue(undefined);
    _g.__dappExtTest.storage[STORAGE_KEY] = {
      [LOCKED_ORIGIN]: [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 1 }],
      'https://other.xyz': [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 1 }]
    };
  });
  afterEach(() => clock.mockRestore());

  it('refuses a polling Auto read at once for 30 s after its unlock popup closed still locked', async () => {
    lockWallet();
    const first = await openPopup(startAssets);
    closeConfirmWindow();
    await expect(first.outcome).resolves.toEqual({ ok: false, message: 'NOT_GRANTED: Wallet is locked' });

    const create = jest.mocked(extensionBrowser.windows.create);
    const opened = create.mock.calls.length;
    now += 29_999;
    await expect(startAssets()).rejects.toThrow(new Error('NOT_GRANTED: Wallet is locked'));
    expect(create).toHaveBeenCalledTimes(opened);
    expect(_g.__dappExtTest.midenClient.getAccount).not.toHaveBeenCalled();

    now += 1;
    await openPopup(startAssets);
  });

  it('refuses the same origin at once for 30 s, and no other', async () => {
    lockWallet();
    const first = await openPopup(startAssets);
    closeConfirmWindow();
    await first.outcome;
    await expect(startAssets()).rejects.toThrow(new Error('NOT_GRANTED: Wallet is locked'));
    await openPopup(() =>
      dapp.requestAssets('https://other.xyz', {
        type: MidenDAppMessageType.AssetsRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    );
  });

  it('starts no cooldown when the user unlocked and then declined', async () => {
    _g.__dappExtTest.storage[STORAGE_KEY] = { [LOCKED_ORIGIN]: [SESSION] };
    lockWallet();
    const first = await openPopup(startAssets);
    unlockWallet();
    await first.getPayload();
    await first.decide(MidenMessageType.DAppAssetsConfirmationRequest, { confirmed: false });
    await expect(first.outcome).resolves.toEqual({ ok: false, message: MidenDAppErrorType.NotGranted });

    lockWallet();
    await openPopup(startAssets);
  });

  it('still prompts an unlocked request from an origin that is cooling down', async () => {
    _g.__dappExtTest.storage[STORAGE_KEY] = { [LOCKED_ORIGIN]: [SESSION] };
    lockWallet();
    const first = await openPopup(startAssets);
    closeConfirmWindow();
    await expect(first.outcome).resolves.toEqual({ ok: false, message: 'NOT_GRANTED: Wallet is locked' });

    unlockWallet();
    const second = await openPopup(startAssets);
    await second.getPayload();
    await second.decide(MidenMessageType.DAppAssetsConfirmationRequest);
    await expect(second.outcome).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({ type: MidenDAppMessageType.AssetsResponse })
    });
  });
});

describe('an approved connect whose account key read fails (#1471)', () => {
  const ORIGIN = 'https://key-read-dapp.xyz';
  const APPROVE = { confirmed: true, accountPublicKey: 'miden-account-1', privateDataPermission: 'UPON_REQUEST' };
  const CANCEL = { confirmed: false, accountPublicKey: '' };
  const ANSWERED = { type: MidenMessageType.DAppPermConfirmationResponse };
  const remove = jest.mocked(extensionBrowser.windows.remove);
  const connect = () =>
    dapp.requestPermission(ORIGIN, {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name: 'Key Read Dapp', url: ORIGIN },
      force: false,
      network: 'testnet',
      privateDataPermission: 'UPON_REQUEST',
      allowedPrivateData: 0
    } as never);
  const failures: ReadonlyArray<readonly [string, () => Promise<unknown>, string]> = [
    ['"Account not found"', async () => null, 'Account not found'],
    [
      'an offscreen read deadline',
      async () => {
        throw new OperationAbortedError('op-1471', 'deadline-no-kill');
      },
      'Offscreen operation op-1471 aborted (deadline-no-kill)'
    ]
  ];
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  // False while the dApp's request is still pending once every queued callback has run.
  const isAnswered = (outcome: Promise<Outcome>) => Promise.race([outcome.then(() => true), flush().then(() => false)]);
  const savedSession = () => _g.__dappExtTest.storage[STORAGE_KEY][ORIGIN];

  let failingRead: (() => Promise<unknown>) | null;
  let originalGetAccount: unknown;
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    failingRead = null;
    originalGetAccount = _g.__dappExtTest.midenClient.getAccount;
    _g.__dappExtTest.midenClient.getAccount = jest.fn(async () =>
      failingRead ? failingRead() : { getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([7, 8, 9]) }] }
    );
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    _g.__dappExtTest.midenClient.getAccount = originalGetAccount;
    consoleError.mockRestore();
  });

  // Opens the connect, approves it while the key read fails, and lets later reads succeed.
  async function approveWithFailingRead(read: () => Promise<unknown>) {
    failingRead = read;
    const popup = await openPopup(connect);
    await popup.getPayload();
    const failed = await settle(popup.decide(MidenMessageType.DAppPermConfirmationRequest, APPROVE));
    failingRead = null;
    return { popup, failed };
  }

  it.each(failures)(
    'fails the confirmation on %s, keeps the window open and answers the dApp nothing',
    async (_name, read, message) => {
      const { popup, failed } = await approveWithFailingRead(read);

      expect(failed).toEqual({ ok: false, message });
      expect(await isAnswered(popup.outcome)).toBe(false);
      expect(remove).not.toHaveBeenCalled();
      expect(savedSession()).toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('account public key'), expect.any(Error));

      await popup.decide(MidenMessageType.DAppPermConfirmationRequest, CANCEL);
    }
  );

  it.each(failures)(
    'resolves the dApp with its PermissionResponse when a Retry after %s reads the key',
    async (_name, read) => {
      const { popup, failed } = await approveWithFailingRead(read);
      expect(failed.ok).toBe(false);

      await expect(popup.decide(MidenMessageType.DAppPermConfirmationRequest, APPROVE)).resolves.toEqual(ANSWERED);

      await expect(popup.outcome).resolves.toEqual({
        ok: true,
        value: {
          type: MidenDAppMessageType.PermissionResponse,
          accountId: 'miden-account-1',
          network: 'testnet',
          privateDataPermission: 'UPON_REQUEST',
          allowedPrivateData: 0,
          publicKey: 'BwgJ'
        }
      });
      await flush();
      expect(remove).toHaveBeenCalledWith(999);
      expect(savedSession()).toEqual([expect.objectContaining({ accountId: 'miden-account-1', publicKey: 'BwgJ' })]);
    }
  );

  it.each(failures)('still answers NOT_GRANTED when the user cancels after %s', async (_name, read) => {
    const { popup, failed } = await approveWithFailingRead(read);
    expect(failed.ok).toBe(false);

    await expect(popup.decide(MidenMessageType.DAppPermConfirmationRequest, CANCEL)).resolves.toEqual(ANSWERED);

    await expect(popup.outcome).resolves.toEqual({ ok: false, message: MidenDAppErrorType.NotGranted });
    await flush();
    expect(remove).toHaveBeenCalledWith(999);
    expect(savedSession()).toBeUndefined();
  });

  it('saves no session when a Retry read ends after the auto-decline answered the dApp', async () => {
    // Auto-advancing, so the popup helpers' zero-delay waits still run.
    jest.useFakeTimers({ advanceTimers: true });
    try {
      const { popup, failed } = await approveWithFailingRead(failures[0]![1]);
      expect(failed.ok).toBe(false);

      let release: (account: unknown) => void = () => {};
      failingRead = () => new Promise(resolve => (release = resolve));
      const retry = settle(popup.decide(MidenMessageType.DAppPermConfirmationRequest, APPROVE));
      await jest.advanceTimersByTimeAsync(120_000);
      await expect(popup.outcome).resolves.toEqual({ ok: false, message: MidenDAppErrorType.NotGranted });
      await flush();
      expect(remove).toHaveBeenCalledWith(999);

      release({ getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([7, 8, 9]) }] });
      await retry;
      expect(savedSession()).toBeUndefined();
      await expect(popup.outcome).resolves.toEqual({ ok: false, message: MidenDAppErrorType.NotGranted });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('a connect from an origin with a saved session that the session does not cover (#1471)', () => {
  const ORIGIN = 'https://miden.xyz';
  const ANSWERED = { type: MidenMessageType.DAppPermConfirmationResponse };
  const APPROVE_AUTO = { confirmed: true, accountPublicKey: 'miden-account-1', privateDataPermission: 'AUTO' };
  const savedSession = () => _g.__dappExtTest.storage[STORAGE_KEY][ORIGIN];
  const connect = (name: string, force: boolean, privateDataPermission: string, allowedPrivateData: number) => () =>
    dapp.requestPermission(ORIGIN, {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name, url: ORIGIN },
      force,
      network: 'testnet',
      privateDataPermission,
      allowedPrivateData
    } as never);

  let originalGetAccount: unknown;
  beforeEach(() => {
    originalGetAccount = _g.__dappExtTest.midenClient.getAccount;
    _g.__dappExtTest.midenClient.getAccount = jest.fn(async () => ({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([7, 8, 9]) }]
    }));
  });
  afterEach(() => {
    _g.__dappExtTest.midenClient.getAccount = originalGetAccount;
  });

  it.each<[string, string, boolean]>([
    ['a forced connect', SESSION.appMeta.name, true],
    ['a connect under another app name', 'Miden Test v2', false]
  ])(
    'asks %s as a new permission with its requested scope, and saves that scope on approval',
    async (_case, name, force) => {
      const popup = await openPopup(connect(name, force, 'AUTO', 2));

      await expect(popup.getPayload()).resolves.toEqual({
        type: MidenMessageType.DAppGetPayloadResponse,
        payload: expect.objectContaining({
          type: 'connect',
          existingPermission: false,
          privateDataPermission: 'AUTO',
          allowedPrivateData: 2
        })
      });

      await expect(popup.decide(MidenMessageType.DAppPermConfirmationRequest, APPROVE_AUTO)).resolves.toEqual(ANSWERED);
      await expect(popup.outcome).resolves.toEqual({
        ok: true,
        value: expect.objectContaining({
          type: MidenDAppMessageType.PermissionResponse,
          privateDataPermission: 'AUTO',
          allowedPrivateData: 2
        })
      });
      expect(savedSession()).toEqual([
        expect.objectContaining({
          accountId: 'miden-account-1',
          appMeta: { name, url: ORIGIN },
          privateDataPermission: 'AUTO',
          allowedPrivateData: 2,
          publicKey: 'BwgJ'
        })
      ]);
    }
  );

  it('still answers the locked reconnect of the same app on its own, with the saved scope, and saves nothing', async () => {
    const saved = { ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 2 };
    _g.__dappExtTest.storage[STORAGE_KEY] = { [ORIGIN]: [saved] };
    lockWallet();
    const popup = await openPopup(connect(SESSION.appMeta.name, false, 'UPON_REQUEST', 0));

    await expect(popup.getPayload()).resolves.toEqual({
      type: MidenMessageType.DAppGetPayloadResponse,
      payload: expect.objectContaining({
        type: 'connect',
        appMeta: SESSION.appMeta,
        existingPermission: true,
        privateDataPermission: 'AUTO',
        allowedPrivateData: 2
      })
    });

    unlockWallet();
    await expect(popup.decide(MidenMessageType.DAppPermConfirmationRequest, APPROVE_AUTO)).resolves.toEqual(ANSWERED);
    await expect(popup.outcome).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({ privateDataPermission: 'AUTO', allowedPrivateData: 2, publicKey: 'BwgJ' })
    });
    expect(savedSession()).toEqual([saved]);
  });
});
