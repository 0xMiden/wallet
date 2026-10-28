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
import { WalletMessageType, WalletStatus } from 'lib/shared/types';

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

// The repo-wide stub's constant `id`, unless a test needs confirmation ids of its own.
const mockNanoid = jest.fn(() => 'id');
jest.mock('nanoid', () => ({ nanoid: () => mockNanoid() }));

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
  // This lock never evicts, so its hold is always current.
  assertWasmHoldCurrent: () => {},
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

  it('opens the popup 440 x 760 (the height carries the network banner)', async () => {
    expect(await openConfirm()).toEqual(expect.objectContaining({ type: 'popup', width: 440, height: 760 }));
  });

  it('adds the Windows frame allowance (456 x 777)', async () => {
    _g.__dappConfInternals.os = 'win';

    expect(await openConfirm()).toEqual(expect.objectContaining({ type: 'popup', width: 456, height: 777 }));
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

describe('requestConfirm runs an approval once (#1584)', () => {
  const { requestCustomTransaction } = jest.requireMock('lib/miden/transaction');

  afterEach(() => {
    requestCustomTransaction.mockReset().mockResolvedValue('tx-2');
  });

  const openTransaction = async () => {
    const answer = dapp.requestTransaction('https://test.xyz', {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'a1',
      transaction: {
        payload: { address: 'a1', recipientAddress: 'bob', transactionRequest: 'b64req', importNotes: [] }
      }
    } as never);
    answer.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(0);
    const browser = jest.requireMock('webextension-polyfill').default;
    const id: string = browser.windows.create.mock.calls.at(-1)?.[0]?.url.match(/id=([^&]+)/)?.[1];
    const listener = _g.__dappConfInternals.intercomListeners.at(-1);
    const port = { id: 'confirm-port' };
    await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);
    const confirmation = {
      type: MidenMessageType.DAppTransactionConfirmationRequest,
      id,
      confirmed: true,
      delegate: false
    };
    return { answer, listener, port, confirmation };
  };

  it('runs the action once when the popup confirms twice while it runs', async () => {
    let release: (transactionId: string) => void = () => undefined;
    requestCustomTransaction.mockReturnValueOnce(
      new Promise<string>(resolve => {
        release = resolve;
      })
    );
    const { answer, listener, port, confirmation } = await openTransaction();

    const first = listener(confirmation, port);
    await jest.advanceTimersByTimeAsync(0);
    const second = listener(confirmation, port);
    release('tx-2');

    expect(await first).toEqual({ type: MidenMessageType.DAppTransactionConfirmationResponse });
    expect(await second).toEqual({ type: MidenMessageType.DAppTransactionConfirmationResponse });
    expect(requestCustomTransaction).toHaveBeenCalledTimes(1);
    await expect(answer).resolves.toEqual(expect.objectContaining({ transactionId: 'tx-2' }));
  });

  const holdTransaction = () => {
    let release: (transactionId: string) => void = () => undefined;
    requestCustomTransaction.mockReturnValueOnce(
      new Promise<string>(resolve => {
        release = resolve;
      })
    );
    return (transactionId: string) => release(transactionId);
  };

  it('gives a Deny sent while the action runs that action answer and refuses nothing', async () => {
    const release = holdTransaction();
    const { answer, listener, port, confirmation } = await openTransaction();

    const first = listener(confirmation, port);
    await jest.advanceTimersByTimeAsync(0);
    const deny = listener({ ...confirmation, confirmed: false }, port);
    release('tx-2');

    expect(await deny).toEqual({ type: MidenMessageType.DAppTransactionConfirmationResponse });
    expect(await first).toEqual({ type: MidenMessageType.DAppTransactionConfirmationResponse });
    await expect(answer).resolves.toEqual(expect.objectContaining({ transactionId: 'tx-2' }));
  });

  it('lets another request from the popup reach its own handler while the action runs', async () => {
    const release = holdTransaction();
    const { answer, listener, port, confirmation } = await openTransaction();

    const first = listener(confirmation, port);
    await jest.advanceTimersByTimeAsync(0);
    await expect(listener({ type: WalletMessageType.SyncRequest }, port)).resolves.toBeUndefined();
    release('tx-2');

    expect(await first).toEqual({ type: MidenMessageType.DAppTransactionConfirmationResponse });
    expect(requestCustomTransaction).toHaveBeenCalledTimes(1);
    await expect(answer).resolves.toEqual(expect.objectContaining({ transactionId: 'tx-2' }));
  });

  it('keeps the auto-decline waiting for a running action, which then answers the dApp', async () => {
    const release = holdTransaction();
    const { answer, listener, port, confirmation } = await openTransaction();

    const first = listener(confirmation, port);
    await jest.advanceTimersByTimeAsync(121_000);
    release('tx-2');

    expect(await first).toEqual({ type: MidenMessageType.DAppTransactionConfirmationResponse });
    await expect(answer).resolves.toEqual(expect.objectContaining({ transactionId: 'tx-2' }));
  });

  it('keeps a closed window waiting for a running action, which then answers the dApp', async () => {
    const release = holdTransaction();
    const { answer, listener, port, confirmation } = await openTransaction();

    const first = listener(confirmation, port);
    await jest.advanceTimersByTimeAsync(0);
    for (const removed of _g.__dappConfInternals.onRemovedListeners) removed(888);
    release('tx-2');

    expect(await first).toEqual({ type: MidenMessageType.DAppTransactionConfirmationResponse });
    await expect(answer).resolves.toEqual(expect.objectContaining({ transactionId: 'tx-2' }));
  });

  it('answers that the outcome is unknown at the cap while the action still runs', async () => {
    holdTransaction();
    const { answer, listener, port, confirmation } = await openTransaction();

    void listener(confirmation, port);
    await jest.advanceTimersByTimeAsync(241_000);

    await expect(answer).rejects.toThrow(/^OUTCOME_UNKNOWN: /);
  });

  it('declines once a running answer that a closed window waited for ends without answering', async () => {
    const { answer, listener, port, confirmation } = await openTransaction();

    // A sign confirmation of this approval is an answer the transaction handler gives nothing for.
    const empty = listener(
      { type: MidenMessageType.DAppSignConfirmationRequest, id: confirmation.id, confirmed: true },
      port
    );
    for (const removed of _g.__dappConfInternals.onRemovedListeners) removed(888);

    await expect(empty).resolves.toBeUndefined();
    await expect(answer).rejects.toThrow(MidenDAppErrorType.NotGranted);
    expect(requestCustomTransaction).not.toHaveBeenCalled();
  });

  it('handles a later confirmation after a handler answered nothing', async () => {
    const { answer, listener, port, confirmation } = await openTransaction();

    // A sign confirmation is no answer to a transaction approval: the handler returns nothing for it.
    await expect(
      listener({ type: MidenMessageType.DAppSignConfirmationRequest, id: confirmation.id, confirmed: true }, port)
    ).resolves.toBeUndefined();
    await expect(listener(confirmation, port)).resolves.toEqual({
      type: MidenMessageType.DAppTransactionConfirmationResponse
    });

    expect(requestCustomTransaction).toHaveBeenCalledTimes(1);
    await expect(answer).resolves.toEqual(expect.objectContaining({ transactionId: 'tx-2' }));
  });

  const openPermission = async (origin: string) => {
    const answer = dapp.requestPermission(
      origin,
      {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'App', url: origin },
        force: false,
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0
      } as never,
      'session-1584'
    );
    answer.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(0);
    const browser = jest.requireMock('webextension-polyfill').default;
    const id: string = browser.windows.create.mock.calls.at(-1)?.[0]?.url.match(/id=([^&]+)/)?.[1];
    const listener = _g.__dappConfInternals.intercomListeners.at(-1);
    const port = { id: 'perm-port' };
    await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);
    const confirmation = {
      type: MidenMessageType.DAppPermConfirmationRequest,
      id,
      confirmed: true,
      accountPublicKey: 'a1',
      privateDataPermission: 'UPON_REQUEST'
    };
    return { answer, listener, port, confirmation };
  };

  it('runs the action again for a confirmation after one whose action rejected', async () => {
    const { withUnlocked } = jest.requireMock('lib/miden/back/store');
    const { answer, listener, port, confirmation } = await openPermission('https://retry-1584.xyz');

    withUnlocked
      .mockImplementationOnce(async () => {
        throw new Error('read failed');
      })
      .mockImplementationOnce(async () => 'pk-1584');
    await expect(listener(confirmation, port)).rejects.toThrow('read failed');
    await expect(listener(confirmation, port)).resolves.toEqual({
      type: MidenMessageType.DAppPermConfirmationResponse
    });

    await expect(answer).resolves.toEqual(expect.objectContaining({ accountId: 'a1', publicKey: 'pk-1584' }));
  });

  it('declines a connect at once when its window closes while the read runs (#1471)', async () => {
    const { withUnlocked } = jest.requireMock('lib/miden/back/store');
    let release: (publicKey: string) => void = () => undefined;
    const { answer, listener, port, confirmation } = await openPermission('https://closed-1584.xyz');

    withUnlocked.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          release = resolve;
        })
    );
    const first = listener(confirmation, port);
    await jest.advanceTimersByTimeAsync(0);
    for (const removed of _g.__dappConfInternals.onRemovedListeners) removed(888);

    await expect(answer).rejects.toThrow(MidenDAppErrorType.NotGranted);
    release('pk-1584');
    await expect(first).resolves.toEqual({ type: MidenMessageType.DAppPermConfirmationResponse });
    expect(_g.__dappConfInternals.storage[STORAGE_KEY]?.['https://closed-1584.xyz']).toBeUndefined();
  });

  it('applies a Deny sent while a connect read runs, and the read then saves nothing (#1471)', async () => {
    const { withUnlocked } = jest.requireMock('lib/miden/back/store');
    let release: (publicKey: string) => void = () => undefined;
    const { answer, listener, port, confirmation } = await openPermission('https://deny-1584.xyz');

    withUnlocked.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          release = resolve;
        })
    );
    const first = listener(confirmation, port);
    await jest.advanceTimersByTimeAsync(0);
    const deny = listener({ ...confirmation, confirmed: false, accountPublicKey: '' }, port);

    await expect(deny).resolves.toEqual({ type: MidenMessageType.DAppPermConfirmationResponse });
    await expect(answer).rejects.toThrow(MidenDAppErrorType.NotGranted);
    release('pk-1584');
    await expect(first).resolves.toEqual({ type: MidenMessageType.DAppPermConfirmationResponse });
    expect(_g.__dappConfInternals.storage[STORAGE_KEY]?.['https://deny-1584.xyz']).toBeUndefined();
  });

  it('ignores a confirmation after the approval was answered', async () => {
    const { listener, port, confirmation } = await openTransaction();

    await expect(listener(confirmation, port)).resolves.toEqual({
      type: MidenMessageType.DAppTransactionConfirmationResponse
    });
    await expect(listener(confirmation, port)).resolves.toBeUndefined();

    expect(requestCustomTransaction).toHaveBeenCalledTimes(1);
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
  it('fails the confirmation, persists no session and leaves the dApp to the auto-decline when the pubkey fetch fails', async () => {
    const origin = 'https://new-dapp.xyz';
    const mc = _g.__dappConfInternals.midenClient;
    // Pubkey fetch fails: getAccount → null makes getAccountPublicKeyB64 throw
    // "Account not found". The approval must not persist a session with
    // publicKey: null (which would wedge every later reconnect), and must not
    // be answered as a refusal either (#1471).
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
      let answer: string | undefined;
      p.then(
        () => (answer = 'granted'),
        (error: Error) => (answer = error.message)
      );
      await expect(
        listener(
          {
            type: MidenMessageType.DAppPermConfirmationRequest,
            id,
            confirmed: true,
            accountPublicKey: 'a1',
            privateDataPermission: 'UPON_REQUEST'
          },
          port
        )
      ).rejects.toThrow('Account not found');

      // The broken (publicKey: null) session must NOT be persisted.
      expect(_g.__dappConfInternals.storage[STORAGE_KEY][origin]).toBeUndefined();
      // The window stays open on the error, and the dApp waits until the window's auto-decline.
      await jest.advanceTimersByTimeAsync(119_000);
      expect(answer).toBeUndefined();
      expect(browser.windows.remove).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(answer).toBe(MidenDAppErrorType.NotGranted);
      expect(browser.windows.remove).toHaveBeenCalledWith(888);
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

describe('the state a request no confirmation handler answered is refused with (BREAD-WALLET-2)', () => {
  const ID = 'V1StGXR8_Z5jdHi6B-myT';
  const payloadRequest = { type: MidenMessageType.DAppGetPayloadRequest, id: [ID] };
  // The popup asks for its payload with the SWR key, an array holding the id.
  const refusal = (id: unknown = ID) =>
    dapp.confirmationNotFound({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] });

  beforeEach(() => mockNanoid.mockImplementation(() => ID));
  afterEach(() => mockNanoid.mockImplementation(() => 'id'));

  const openSign = async () => {
    const answer = dapp.requestSign('https://test.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'a1',
      sourceAccountId: 'a1',
      payload: 'aA==',
      kind: 'word'
    } as never);
    answer.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(0);
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    const id: string = browser.windows.create.mock.calls.at(-1)?.[0]?.url.match(/id=([^&]+)/)?.[1];
    return { answer, id, listener: _g.__dappConfInternals.intercomListeners.at(-1) };
  };

  it('names a handler that is still open, keeps the message, and carries no id', async () => {
    const { listener } = await openSign();
    await listener(payloadRequest, { id: 'p' });
    const error = refusal();
    expect(error.message).toBe('Not Found');
    expect(error.code).toMatch(/^confirmation_open:/);
    expect(Object.keys(error)).toEqual(['code']);
    jest.advanceTimersByTime(121_000);
  });

  it('names an answered confirmation, and the first close wins over a later window removal', async () => {
    const { answer, listener } = await openSign();
    const port = { id: 'p' };
    await listener(payloadRequest, port);
    await listener({ type: MidenMessageType.DAppSignConfirmationRequest, id: ID, confirmed: false }, port);
    await expect(answer).rejects.toThrow(MidenDAppErrorType.NotGranted);
    for (const removed of _g.__dappConfInternals.onRemovedListeners) removed(888);

    expect(refusal().code).toMatch(/^confirmation_answered:/);
    // A second answer from the same window sends the id as a string.
    expect(dapp.confirmationNotFound({ type: MidenMessageType.DAppSignConfirmationRequest, id: ID }).code).toMatch(
      /^confirmation_answered:/
    );
  });

  it('names a confirmation its timer expired', async () => {
    const { answer } = await openSign();
    jest.advanceTimersByTime(121_000);
    await expect(answer).rejects.toThrow(MidenDAppErrorType.NotGranted);
    expect(refusal().code).toMatch(/^confirmation_expired:/);
  });

  it('names a confirmation whose window was closed', async () => {
    const { answer } = await openSign();
    _g.__dappConfInternals.onRemovedListeners.at(-1)(888);
    await expect(answer).rejects.toThrow(MidenDAppErrorType.NotGranted);
    expect(refusal().code).toMatch(/^confirmation_window_closed:/);
  });

  it('names a confirmation whose payload failed to build', async () => {
    const { withUnlocked } = jest.requireMock('lib/miden/back/store');
    // Locked when the request arrives, so the popup builds the payload after the unlock, and that build fails.
    withUnlocked.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Wallet is locked'), { reason: 'locked' });
    });
    mockHasSpendingLimits.mockImplementation(() => Promise.resolve(true));
    mockAssessOutgoingSpendingLimitDetails.mockImplementation(() => Promise.reject(new Error('limit read failed')));
    try {
      const answer = dapp.requestTransaction('https://test.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'a1',
        transaction: { payload: { address: 'a1', recipientAddress: 'bob', transactionRequest: 'b64req' } }
      } as never);
      answer.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(0);
      const listener = _g.__dappConfInternals.intercomListeners.at(-1);

      await expect(listener(payloadRequest, { id: 'p' })).rejects.toThrow();
      await expect(answer).rejects.toThrow();
      expect(refusal().code).toMatch(/^confirmation_payload_failed:/);
    } finally {
      mockHasSpendingLimits.mockImplementation(() => Promise.resolve(false));
      mockAssessOutgoingSpendingLimitDetails.mockImplementation(() => Promise.resolve(undefined));
    }
  });

  it('names an id this worker never saw as unknown', () => {
    expect(refusal('never-opened').code).toMatch(/^confirmation_unknown:/);
    expect(dapp.confirmationNotFound({ type: MidenMessageType.DAppSignConfirmationRequest, id: 7 }).code).toMatch(
      /^confirmation_unknown:/
    );
    expect(dapp.confirmationNotFound({}).code).toMatch(/^confirmation_unknown:/);
  });

  it('keeps the states of the newest 64 confirmations only', async () => {
    let opened = 0;
    mockNanoid.mockImplementation(() => `confirmation-${opened++}`);
    const ids: string[] = [];
    for (let i = 0; i < 65; i++) {
      const { answer, id } = await openSign();
      ids.push(id);
      jest.advanceTimersByTime(121_000);
      await expect(answer).rejects.toThrow(MidenDAppErrorType.NotGranted);
    }
    expect(new Set(ids).size).toBe(65);
    expect(refusal(ids[0]).code).toMatch(/^confirmation_unknown:/);
    expect(refusal(ids[1]).code).toMatch(/^confirmation_expired:/);
    expect(refusal(ids[64]).code).toMatch(/^confirmation_expired:/);
    expect(refusal(ids[0]).code).toMatch(/^confirmation_unknown:array_with_string:pruned:/);
  });

  it('names the shape of the id the request carried', () => {
    const shapeOf = (req: unknown) => dapp.confirmationNotFound(req).code.split(':')[1];
    expect(shapeOf({ type: MidenMessageType.DAppSignConfirmationRequest, id: ID })).toBe('string');
    expect(shapeOf(payloadRequest)).toBe('array_with_string');
    expect(shapeOf({ type: MidenMessageType.DAppGetPayloadRequest, id: [7] })).toBe('array_without_string');
    expect(shapeOf({ type: MidenMessageType.DAppGetPayloadRequest, id: [] })).toBe('array_without_string');
    expect(shapeOf({ type: MidenMessageType.DAppGetPayloadRequest })).toBe('missing');
    expect(shapeOf(undefined)).toBe('missing');
    expect(shapeOf({ type: MidenMessageType.DAppSignConfirmationRequest, id: 7 })).toBe('other');
  });

  it('names how long this worker has run', () => {
    const now = jest.spyOn(performance, 'now');
    try {
      now.mockReturnValue(9_999);
      expect(refusal().code).toMatch(/:under_10s$/);
      now.mockReturnValue(12_000);
      expect(refusal().code).toMatch(/:10_to_60s$/);
      now.mockReturnValue(300_000);
      expect(refusal().code).toMatch(/:over_300s$/);
    } finally {
      now.mockRestore();
    }
  });

  it('names an empty registry in a worker that has recorded no approval, then one holding it', async () => {
    let fresh: typeof dapp | undefined;
    jest.isolateModules(() => {
      fresh = require('./dapp');
    });
    if (fresh === undefined) throw new Error('dapp did not load');
    const now = jest.spyOn(performance, 'now').mockReturnValue(1_000);
    try {
      expect(fresh.confirmationNotFound(payloadRequest).code).toBe(
        'confirmation_unknown:array_with_string:empty:under_10s'
      );
      const answer = fresh.requestSign('https://test.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: 'a1',
        sourceAccountId: 'a1',
        payload: 'aA==',
        kind: 'word'
      } as never);
      answer.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(0);
      jest.advanceTimersByTime(121_000);
      await expect(answer).rejects.toThrow(MidenDAppErrorType.NotGranted);
      expect(fresh.confirmationNotFound(payloadRequest).code).toBe(
        'confirmation_expired:array_with_string:holding:under_10s'
      );
    } finally {
      now.mockRestore();
    }
  });
});
