/* eslint-disable import/first */
/**
 * Deep branch coverage for `requestConfirm` internals in dapp.ts.
 *
 * Covers: closing guard, knownPort check, autodecline timeout,
 * closeWindow error, getBrowser edge cases, dappLog when DEBUG on.
 *
 * Uses isExtension=true to enter requestConfirm.
 */

import { MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';
import { MidenMessageType } from 'lib/miden/types';
import { WalletStatus } from 'lib/shared/types';

const _g = globalThis as any;
_g.__dappConfInternals = {
  intercomListeners: [] as Array<(req: any, port?: any) => Promise<any> | any>,
  storage: {} as Record<string, any>,
  onRemovedListeners: [] as Array<(winId: number) => void>,
  storeListeners: new Set<(state: unknown) => void>(),
  midenClient: {
    getAccount: jest.fn(async () => ({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1]) }]
    })),
    // The consume approval preview is derived from the note the wallet resolves
    // (not the dApp's declared faucet/amount/type), so the consume tests here need
    // the note to exist in the store.
    getInputNoteDetails: jest.fn(async () => [
      {
        noteId: 'note-1',
        noteType: 0,
        senderAccountId: 's1',
        nullifier: 'nf1',
        state: 0,
        assets: [{ faucetId: 'faucet-1', amount: '50' }]
      }
    ]),
    getConsumableNotes: jest.fn(async () => []),
    getConsumableNoteDtos: jest.fn(async () => []),
    syncState: jest.fn(async () => {}),
    importNoteBytes: jest.fn(async () => ({ toString: () => 'n1' })),
    on: jest.fn()
  }
};

jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({
      currentAccount: { publicKey: 'a1' },
      status: (globalThis as any).__dappConfInternals.status ?? 'Ready'
    }),
    // Drives `waitForUnlock`: the lock tests below notify these the way the real store's updates do.
    updates: {
      watch: (listener: (state: unknown) => void) => {
        (globalThis as any).__dappConfInternals.storeListeners.add(listener);
        return () => (globalThis as any).__dappConfInternals.storeListeners.delete(listener);
      }
    }
  },
  withUnlocked: jest.fn(async (fn: any) => fn({ vault: { signData: jest.fn(async () => 'sig') } }))
}));

jest.mock('lib/miden/transaction', () => ({
  initiateSendTransaction: jest.fn(async () => 'tx-1'),
  requestCustomTransaction: jest.fn(async () => 'tx-2'),
  initiateConsumeTransactionFromId: jest.fn(async () => 'tx-3'),
  waitForTransactionCompletion: jest.fn(async () => ({}))
}));

jest.mock('lib/miden/activity', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/back/transaction-processor', () => ({ startTransactionProcessing: jest.fn(async () => {}) }));

jest.mock('lib/platform', () => ({
  isExtension: () => true,
  isDesktop: () => false,
  isMobile: () => false
}));

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys) out[k] = _g.__dappConfInternals.storage[k];
      return out;
    },
    set: async (kv: Record<string, any>) => Object.assign(_g.__dappConfInternals.storage, kv),
    delete: async (keys: string[]) => {
      for (const k of keys) delete _g.__dappConfInternals.storage[k];
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
    getInstanceId: () => 'test'
  }
}));

jest.mock('lib/miden/back/defaults', () => ({
  intercom: {
    onRequest: jest.fn((cb: any) => {
      _g.__dappConfInternals.intercomListeners.push(cb);
      return () => {
        const idx = _g.__dappConfInternals.intercomListeners.indexOf(cb);
        if (idx !== -1) _g.__dappConfInternals.intercomListeners.splice(idx, 1);
      };
    }),
    broadcast: jest.fn()
  }
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: { getCurrentAccountPublicKey: jest.fn(async () => 'a1') }
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => _g.__dappConfInternals.midenClient,
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  runWhenClientIdle: () => {}
}));

// Spread the real module — see the note in dapp.coverage.test.ts: the send
// flow's authorization gate needs `sameWalletAccountId` to exist.
jest.mock('lib/miden/sdk/helpers', () => ({
  ...jest.requireActual('lib/miden/sdk/helpers'),
  getBech32AddressFromAccountId: () => 'bech32'
}));

// dapp.ts now assesses a custom request's simulated outgoing value against the spending-limit
// policy before raising either sheet, so this suite has to stand that module in. `false` here is
// "no limit configured for this account", which is what every case in this file assumes.
const mockHasSpendingLimits = jest.fn((..._args: unknown[]) => Promise.resolve(false));
const mockAssessOutgoingSpendingLimitDetails = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));
jest.mock('lib/miden/spending-limits/queue', () => ({
  assessOutgoingSpendingLimitDetails: (...args: unknown[]) => mockAssessOutgoingSpendingLimitDetails(...args),
  hasSpendingLimits: (...args: unknown[]) => mockHasSpendingLimits(...args)
}));

jest.mock('./simulate-custom-tx', () => ({
  simulateCustomTransaction: jest.fn(async () => ({ summaryBytes: 'confirm-sim-sum' }))
}));

const mockReleaseNoteIds = jest.fn(async (_ids: string[]) => undefined);
jest.mock('lib/miden/note-quarantine', () => ({
  importedNoteIds: jest.fn((notes: string[] | undefined) => (notes ?? []).map((n: string) => `id:${n}`)),
  releaseNoteIds: (ids: string[]) => mockReleaseNoteIds(ids)
}));

jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));

jest.mock('webextension-polyfill', () => {
  const browser = {
    runtime: {
      getPlatformInfo: async () => ({ os: _g.__dappConfInternals.os ?? 'mac' }),
      getURL: (path: string) => `ext://${path}`,
      onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
      onInstalled: { addListener: jest.fn(), removeListener: jest.fn() },
      onUpdateAvailable: { addListener: jest.fn(), removeListener: jest.fn() },
      sendMessage: jest.fn(),
      connect: jest.fn(() => ({
        onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
        onDisconnect: { addListener: jest.fn(), removeListener: jest.fn() },
        postMessage: jest.fn()
      })),
      getManifest: () => ({ manifest_version: 3 })
    },
    windows: {
      create: jest.fn(async () => ({ id: 888, left: 0, state: 'normal' })),
      get: jest.fn(async () => ({ id: 888 })),
      remove: jest.fn(async () => {}),
      update: jest.fn(async () => {}),
      getLastFocused: jest.fn(async () => ({ type: 'normal', left: 0, top: 0, width: 1024, height: 768 })),
      onRemoved: {
        addListener: (cb: any) => _g.__dappConfInternals.onRemovedListeners.push(cb),
        removeListener: jest.fn()
      }
    },
    storage: { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } },
    tabs: { create: jest.fn(), query: jest.fn(async () => []), remove: jest.fn() }
  };
  return { __esModule: true, default: browser, ...browser };
});

import * as dapp from './dapp';
import { _resetLockedPromptCooldownsForTest } from './dapp-locked';

const STORAGE_KEY = 'dapp_sessions';
const SESSION = {
  network: 'testnet',
  appMeta: { name: 'Test', url: 'https://test.xyz' },
  accountId: 'a1',
  privateDataPermission: 'UPON_REQUEST',
  allowedPrivateData: 0,
  publicKey: 'a1'
};

beforeEach(() => {
  _resetLockedPromptCooldownsForTest();
  delete _g.__dappConfInternals.status;
  _g.__dappConfInternals.storeListeners.clear();
  jest.clearAllMocks();
  delete _g.__dappConfInternals.os;
  _g.__dappConfInternals.intercomListeners.length = 0;
  _g.__dappConfInternals.onRemovedListeners.length = 0;
  for (const k of Object.keys(_g.__dappConfInternals.storage)) delete _g.__dappConfInternals.storage[k];
  _g.__dappConfInternals.storage[STORAGE_KEY] = { 'https://test.xyz': [SESSION] };
  jest.useFakeTimers({ legacyFakeTimers: false });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('requestConfirm autodecline timeout', () => {
  it('auto-declines after the 120s timeout', async () => {
    const p = dapp.requestSign('https://test.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'a1',
      sourceAccountId: 'a1',
      payload: 'aA==',
      kind: 'word'
    } as never);
    await jest.advanceTimersByTimeAsync(0);
    // Advance past the 120s autodecline timer
    jest.advanceTimersByTime(121_000);
    await expect(p).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

describe('requestConfirm popup size', () => {
  const openConfirm = async () => {
    const p = dapp.requestSign('https://test.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'a1',
      sourceAccountId: 'a1',
      payload: 'aA==',
      kind: 'word'
    } as never);
    p.catch(() => {});
    await jest.advanceTimersByTimeAsync(0);
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const options = browser.windows.create.mock.calls.at(-1)?.[0];
    // Settle the pending request so nothing leaks into the next test.
    jest.advanceTimersByTime(121_000);
    await expect(p).rejects.toThrow(MidenDAppErrorType.NotGranted);
    return options;
  };

  it('opens the popup 380 x 676 (the height carries the network banner)', async () => {
    expect(await openConfirm()).toEqual(expect.objectContaining({ type: 'popup', width: 380, height: 676 }));
  });

  it('adds the Windows frame allowance (396 x 693)', async () => {
    _g.__dappConfInternals.os = 'win';

    expect(await openConfirm()).toEqual(expect.objectContaining({ type: 'popup', width: 396, height: 693 }));
  });
});

describe('requestConfirm intercom handler — unknown port', () => {
  it('ignores requests from unknown ports', async () => {
    const p = dapp.requestSign('https://test.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'a1',
      sourceAccountId: 'a1',
      payload: 'aA==',
      kind: 'word'
    } as never);
    await jest.advanceTimersByTimeAsync(0);

    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const url = browser.windows.create.mock.calls[0]?.[0]?.url || '';
    const idMatch = url.match(/id=([^&]+)/);
    if (!idMatch) {
      p.catch(() => {});
      jest.advanceTimersByTime(121_000);
      return;
    }
    const id = idMatch[1];
    const listener = _g.__dappConfInternals.intercomListeners[0];
    if (!listener) {
      p.catch(() => {});
      jest.advanceTimersByTime(121_000);
      return;
    }

    const knownPort = { id: 'known' };
    const unknownPort = { id: 'unknown' };

    // First register the known port via GetPayload
    await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, knownPort);

    // Now send a confirmation from a different port — should be ignored
    const result = await listener(
      { type: MidenMessageType.DAppSignConfirmationRequest, id, confirmed: true },
      unknownPort
    );
    expect(result).toBeUndefined();

    // Clean up by auto-declining
    jest.advanceTimersByTime(121_000);
    p.catch(() => {});
  });
});

describe('requestConfirm — window already fullscreen', () => {
  it('skips window.update when confirmWin.state is fullscreen', async () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    browser.windows.create.mockResolvedValueOnce({ id: 777, left: 99, state: 'fullscreen' });
    const p = dapp.requestSign('https://test.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'a1',
      sourceAccountId: 'a1',
      payload: 'aA==',
      kind: 'word'
    } as never);
    await jest.advanceTimersByTimeAsync(0);
    // Windows.update should NOT have been called when state is fullscreen
    expect(browser.windows.update).not.toHaveBeenCalled();
    jest.advanceTimersByTime(121_000);
    p.catch(() => {});
  });
});

describe('requestConfirm — closeWindow error handling', () => {
  it('does not crash when windows.get throws during close', async () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    browser.windows.get.mockRejectedValueOnce(new Error('window gone'));
    const p = dapp.requestSign('https://test.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'a1',
      sourceAccountId: 'a1',
      payload: 'aA==',
      kind: 'word'
    } as never);
    await jest.advanceTimersByTimeAsync(0);
    // Trigger autodecline which calls close → closeWindow
    jest.advanceTimersByTime(121_000);
    await expect(p).rejects.toThrow();
  });
});

describe('requestPermission (extension) — public-key fetch failure', () => {
  it('rejects with NotGranted and does not persist a session when the pubkey fetch fails', async () => {
    const origin = 'https://new-dapp.xyz';
    const mc = _g.__dappConfInternals.midenClient;
    // Pubkey fetch fails: getAccount → null makes getAccountPublicKeyB64 throw
    // "Account not found". The connect must reject rather than persist a
    // session with publicKey: null (which would wedge every later reconnect).
    mc.getAccount.mockResolvedValue(null);
    try {
      const p = dapp.requestPermission(
        origin,
        {
          type: MidenDAppMessageType.PermissionRequest,
          appMeta: { name: 'New App', url: origin },
          force: false,
          network: 'testnet',
          privateDataPermission: 'UPON_REQUEST',
          allowedPrivateData: 0
        } as never,
        'session-1'
      );
      await jest.advanceTimersByTimeAsync(0);

      const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
      const url = browser.windows.create.mock.calls.at(-1)?.[0]?.url || '';
      const id = url.match(/id=([^&]+)/)?.[1];
      expect(id).toBeTruthy();

      const listener = _g.__dappConfInternals.intercomListeners.at(-1);
      const port = { id: 'p1' };
      // Register the confirm window's port, then approve the connection.
      await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);
      await listener(
        {
          type: MidenMessageType.DAppPermConfirmationRequest,
          id,
          confirmed: true,
          accountPublicKey: 'a1',
          privateDataPermission: 'UPON_REQUEST'
        },
        port
      );

      await expect(p).rejects.toThrow(MidenDAppErrorType.NotGranted);
      // The broken (publicKey: null) session must NOT be persisted.
      expect(_g.__dappConfInternals.storage[STORAGE_KEY][origin]).toBeUndefined();
    } finally {
      mc.getAccount.mockResolvedValue({
        getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1]) }]
      });
    }
  });
});

describe('requestConfirm — DAppSimulateTransactionRequest branch', () => {
  it('answers a matching simulate request without closing the popup', async () => {
    const p = dapp.requestTransaction('https://test.xyz', {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'a1',
      transaction: {
        payload: {
          address: 'a1',
          recipientAddress: 'bob',
          transactionRequest: 'b64req'
        }
      }
    } as never);
    await jest.advanceTimersByTimeAsync(0);

    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const url = browser.windows.create.mock.calls.at(-1)?.[0]?.url || '';
    const id = url.match(/id=([^&]+)/)?.[1];
    expect(id).toBeTruthy();

    const listener = _g.__dappConfInternals.intercomListeners.at(-1);
    const port = { id: 'sim-port' };

    // Register the confirm window's port via the payload fetch, as the real popup does.
    await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);

    const result = await listener({ type: MidenMessageType.DAppSimulateTransactionRequest, id }, port);

    expect(result).toEqual({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      summaryBytes: 'confirm-sim-sum',
      error: undefined
    });
    // Critical: the popup must stay open after a simulate round-trip.
    expect(browser.windows.remove).not.toHaveBeenCalled();

    // Clean up by auto-declining.
    jest.advanceTimersByTime(121_000);
    p.catch(() => {});
  });
});

describe('a custom request made while locked (#1414)', () => {
  it("answers the sheet's simulate request from the dry run built after the unlock", async () => {
    const { withUnlocked } = jest.requireMock('lib/miden/back/store');
    const simulate = jest.requireMock('./simulate-custom-tx').simulateCustomTransaction;
    withUnlocked.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Wallet is locked'), { reason: 'locked' });
    });
    const p = dapp.requestTransaction('https://test.xyz', {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'a1',
      transaction: { payload: { address: 'a1', recipientAddress: 'bob', transactionRequest: 'b64req' } }
    } as never);
    p.catch(() => {});
    await jest.advanceTimersByTimeAsync(0);
    expect(simulate).not.toHaveBeenCalled();

    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const id = (browser.windows.create.mock.calls.at(-1)?.[0]?.url || '').match(/id=([^&]+)/)?.[1];
    const listener = _g.__dappConfInternals.intercomListeners.at(-1);
    const port = { id: 'locked-sim-port' };
    await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);
    expect(simulate).toHaveBeenCalledTimes(1);

    const result = await listener({ type: MidenMessageType.DAppSimulateTransactionRequest, id }, port);
    expect(result).toEqual(expect.objectContaining({ summaryBytes: 'confirm-sim-sum' }));
    expect(simulate).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(121_000);
  });
});

describe('requestConfirm — custom tx quarantine release', () => {
  it('releases the simulation quarantine after a successful confirm', async () => {
    const p = dapp.requestTransaction('https://test.xyz', {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'a1',
      transaction: {
        payload: {
          address: 'a1',
          recipientAddress: 'bob',
          transactionRequest: 'b64req',
          importNotes: ['noteA', 'noteB']
        }
      }
    } as never);
    await jest.advanceTimersByTimeAsync(0);

    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const url = browser.windows.create.mock.calls.at(-1)?.[0]?.url || '';
    const id = url.match(/id=([^&]+)/)?.[1];
    expect(id).toBeTruthy();

    const listener = _g.__dappConfInternals.intercomListeners.at(-1);
    const port = { id: 'confirm-port' };
    await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);

    const result = await listener(
      { type: MidenMessageType.DAppTransactionConfirmationRequest, id, confirmed: true, delegate: false },
      port
    );
    expect(result).toEqual({ type: MidenMessageType.DAppTransactionConfirmationResponse });

    await expect(p).resolves.toEqual(expect.objectContaining({ transactionId: 'tx-2' }));
    // Confirmed: the transaction is queued and will consume these notes, so
    // the quarantine placed on them by the pre-confirm dry-run is released.
    expect(mockReleaseNoteIds).toHaveBeenCalledWith(['id:noteA', 'id:noteB']);
  });

  it('does NOT release the simulation quarantine when the user declines', async () => {
    const p = dapp.requestTransaction('https://test.xyz', {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'a1',
      transaction: {
        payload: {
          address: 'a1',
          recipientAddress: 'bob',
          transactionRequest: 'b64req',
          importNotes: ['noteA']
        }
      }
    } as never);
    await jest.advanceTimersByTimeAsync(0);

    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const url = browser.windows.create.mock.calls.at(-1)?.[0]?.url || '';
    const id = url.match(/id=([^&]+)/)?.[1];
    expect(id).toBeTruthy();

    const listener = _g.__dappConfInternals.intercomListeners.at(-1);
    const port = { id: 'decline-port' };
    await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);

    const result = await listener(
      { type: MidenMessageType.DAppTransactionConfirmationRequest, id, confirmed: false },
      port
    );
    expect(result).toEqual({ type: MidenMessageType.DAppTransactionConfirmationResponse });

    await expect(p).rejects.toThrow(MidenDAppErrorType.NotGranted);
    // Declined: the imported notes must stay hidden from the claimable UI.
    expect(mockReleaseNoteIds).not.toHaveBeenCalled();
  });
});

describe('requestConfirm stops its auto-decline on the first payload request and restarts it on the serve (#1414)', () => {
  const track = (call: Promise<unknown>) => {
    const state = { settled: false, message: '' };
    call.then(
      () => {
        state.settled = true;
      },
      (err: Error) => {
        state.settled = true;
        state.message = err.message;
      }
    );
    return state;
  };
  // The popup's own payload request for the window opened last.
  const payloadRequester = () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const id = (browser.windows.create.mock.calls.at(-1)?.[0]?.url || '').match(/id=([^&]+)/)?.[1];
    const listener = _g.__dappConfInternals.intercomListeners.at(-1);
    return (): Promise<unknown> => listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, { id: 'p' });
  };

  const { withUnlocked } = jest.requireMock('lib/miden/back/store');
  const lock = () => {
    _g.__dappConfInternals.status = WalletStatus.Locked;
    withUnlocked.mockImplementation(async () => {
      throw Object.assign(new Error('Wallet is locked'), { reason: 'locked' });
    });
  };
  const unlock = () => {
    _g.__dappConfInternals.status = WalletStatus.Ready;
    withUnlocked.mockImplementation(async (fn: any) => fn({ vault: { signData: jest.fn(async () => 'sig') } }));
    for (const listener of [..._g.__dappConfInternals.storeListeners]) listener({ status: WalletStatus.Ready });
  };
  // `clearAllMocks` keeps implementations, so a locked gate would leak into the next test.
  afterEach(unlock);

  const openSign = async () => {
    const state = track(
      dapp.requestSign('https://test.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: 'a1',
        sourceAccountId: 'a1',
        payload: 'aA==',
        kind: 'word'
      } as never)
    );
    await jest.advanceTimersByTimeAsync(0);
    return { state, serve: payloadRequester() };
  };

  // A custom request made while locked: its popup opens on Unlock and builds its payload after the unlock.
  const openLockedCustom = async () => {
    lock();
    const state = track(
      dapp.requestTransaction('https://test.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'a1',
        transaction: { payload: { address: 'a1', recipientAddress: 'bob', transactionRequest: 'b64req' } }
      } as never)
    );
    await jest.advanceTimersByTimeAsync(0);
    return { state, requestPayload: payloadRequester() };
  };

  it('gives the review its full 120 s from the first serve', async () => {
    const popup = await openSign();
    await jest.advanceTimersByTimeAsync(100_000);
    await popup.serve();
    await jest.advanceTimersByTimeAsync(119_000);
    expect(popup.state.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(popup.state).toEqual({ settled: true, message: MidenDAppErrorType.NotGranted });
  });

  it('restarts on the first serve only', async () => {
    const popup = await openSign();
    await jest.advanceTimersByTimeAsync(100_000);
    await popup.serve();
    await jest.advanceTimersByTimeAsync(100_000);
    await popup.serve();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(popup.state.settled).toBe(true);
  });

  it('declines at 240 s from opening when the payload was asked for locked at 100 s and the unlock came at 200 s', async () => {
    const popup = await openLockedCustom();
    await jest.advanceTimersByTimeAsync(100_000);
    const served = popup.requestPayload();
    await jest.advanceTimersByTimeAsync(100_000);
    // Past the first 120 s window: asking for the payload stopped it, and only the cap bounds the wait.
    expect(popup.state.settled).toBe(false);

    unlock();
    await expect(served).resolves.toEqual(expect.objectContaining({ type: MidenMessageType.DAppGetPayloadResponse }));
    await jest.advanceTimersByTimeAsync(39_999);
    expect(popup.state.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(popup.state).toEqual({ settled: true, message: MidenDAppErrorType.NotGranted });
  });

  it('never declines while the build that follows the unlock runs', async () => {
    jest
      .requireMock('./simulate-custom-tx')
      .simulateCustomTransaction.mockImplementationOnce(
        () => new Promise(resolve => setTimeout(() => resolve({ summaryBytes: 'confirm-sim-sum' }), 15_000))
      );
    const popup = await openLockedCustom();
    await jest.advanceTimersByTimeAsync(110_000);
    unlock();
    // The popup asks for its payload once unlocked; this 15 s build runs past the first window's 120 s.
    const served = popup.requestPayload();
    await jest.advanceTimersByTimeAsync(14_999);
    expect(popup.state.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(served).resolves.toEqual(expect.objectContaining({ type: MidenMessageType.DAppGetPayloadResponse }));

    // The review's window runs from the serve at 125 s to the cap at 240 s.
    await jest.advanceTimersByTimeAsync(114_999);
    expect(popup.state.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(popup.state).toEqual({ settled: true, message: MidenDAppErrorType.NotGranted });
  });

  it('declines at 240 s from opening when no unlock follows a locked payload request', async () => {
    const popup = await openLockedCustom();
    await jest.advanceTimersByTimeAsync(100_000);
    popup.requestPayload().catch(() => undefined);
    await jest.advanceTimersByTimeAsync(139_999);
    expect(popup.state.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(popup.state).toEqual({ settled: true, message: 'NOT_GRANTED: Wallet is locked' });
  });
});
