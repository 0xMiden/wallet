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

import { MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';
import { MidenMessageType } from 'lib/miden/types';

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
    syncState: jest.fn(),
    importNoteBytes: jest.fn(),
    on: jest.fn()
  }
};

const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) =>
  fn({
    vault: {
      signData: jest.fn(async () => 'fake-signature-base64')
    }
  })
);

jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({ currentAccount: { publicKey: 'miden-account-1' }, status: 'Ready' })
  },
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn)
}));

jest.mock('lib/miden/activity/transactions', () => ({
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

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => (globalThis as any).__dappExtTest.midenClient,
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  runWhenClientIdle: () => {}
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: () => 'bech32-addr'
}));

// Stub the wallet adapter package's enums (jest can't destructure the .mjs build).
jest.mock('@demox-labs/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));

// Provide a richer browser stub than the default __mocks__/webextension-polyfill.
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
      getLastFocused: jest.fn(async () => ({ left: 0, top: 0, width: 1024, height: 768 })),
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
  _g.__dappExtTest.intercomListeners.length = 0;
  for (const k of Object.keys(_g.__dappExtTest.storage)) delete _g.__dappExtTest.storage[k];
  _g.__dappExtTest.storage[STORAGE_KEY] = { 'https://miden.xyz': [SESSION] };
  mockGetCurrentAccountPublicKey.mockResolvedValue('miden-account-1');
});

/** Drive the most recently registered intercom listener with a synthetic confirmation. */
async function fireConfirmation(req: any, port: any = { id: 'fake-port' }) {
  const listeners = _g.__dappExtTest.intercomListeners;
  // Run them all - the matching one will return a response
  for (const cb of [...listeners]) {
    // First send the GetPayload request so the listener captures the port
    await cb(
      { type: MidenMessageType.DAppGetPayloadRequest, id: [req.id] },
      port
    );
    // Then send the actual confirmation
    await cb(req, port);
  }
}

describe('requestConfirm window-position fallback', () => {
  it('uses screen coordinates when getLastFocused throws', async () => {
    const browser = (require('webextension-polyfill').default || require('webextension-polyfill')) as any;
    browser.windows.getLastFocused.mockRejectedValueOnce(new Error('no focused window'));
    const p = dapp.requestSign('https://miden.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'miden-account-1',
      sourceAccountId: 'miden-account-1',
      payload: 'aGVsbG8=',
      kind: 'word'
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(browser.windows.create).toHaveBeenCalled();
    p.catch(() => {});
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
    let listener: ((winId: number) => void) | null = null;
    browser.windows.onRemoved.addListener = (cb: any) => {
      listener = cb;
    };
    browser.windows.onRemoved.removeListener = jest.fn();
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
  });
});

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
    const sigPromise = dapp.requestSign('https://miden.xyz', {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'miden-account-1',
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
    await expect(dapp.waitForTransaction({} as never)).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });
});

describe('requestPermission existing-permission early-return', () => {
  it('returns the existing permission directly when wallet is unlocked', async () => {
    // Existing session exists for 'https://miden.xyz' under 'miden-account-1'
    // and `req.appMeta.name === dApp.appMeta.name` matches.
    const res = await dapp.requestPermission(
      'https://miden.xyz',
      {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
        force: false,
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0
      } as never
    );
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
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest.fn().mockResolvedValue([
      { noteType: 'private', noteId: 'n1', state: 'committed', assets: [] }
    ]);
    // Mock NoteType import so the filter works
    const res = await dapp.requestPrivateNotes('https://miden.xyz', {
      type: MidenDAppMessageType.PrivateNotesRequest,
      sourcePublicKey: 'miden-account-1',
      noteIds: ['n1']
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.PrivateNotesResponse);
  });
});

describe('requestConsumableNotes — extension flow', () => {
  it('opens a confirmation window on call (non-Auto branch)', async () => {
    _g.__dappExtTest.midenClient.getConsumableNotes = jest.fn().mockResolvedValue([]);
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
  extraConfirmFields: Record<string, any> = { confirmed: true }
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
  await listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port);
  await listener({ type: confirmRequestType, id, ...extraConfirmFields }, port);
  return promise;
}

describe('Full confirmation cycles in extension mode', () => {
  it('requestImportPrivateNote resolves with note id when confirmed', async () => {
    _g.__dappExtTest.midenClient.importNoteBytes = jest.fn().mockResolvedValue({
      toString: () => 'imported-note-id'
    });
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
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest.fn().mockResolvedValue([
      { noteType: 'private', noteId: 'n1', state: 'committed', assets: [] }
    ]);
    const res = await driveConfirmation(
      () =>
        dapp.requestPrivateNotes('https://miden.xyz', {
          type: MidenDAppMessageType.PrivateNotesRequest,
          sourcePublicKey: 'miden-account-1',
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
            noteIds: ['n1']
          } as never),
        MidenMessageType.DAppPrivateNotesConfirmationRequest,
        { confirmed: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('requestConsumableNotes resolves when confirmed', async () => {
    _g.__dappExtTest.midenClient.getConsumableNotes = jest.fn().mockResolvedValue([]);
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
  });

  it('requestPrivateNotes rejects when user declines (covers onDecline at L641)', async () => {
    _g.__dappExtTest.midenClient.getInputNoteDetails = jest.fn().mockResolvedValue([]);
    await expect(
      driveConfirmation(
        () =>
          dapp.requestPrivateNotes('https://miden.xyz', {
            type: MidenDAppMessageType.PrivateNotesRequest,
            sourcePublicKey: 'miden-account-1',
            noteIds: ['n1']
          } as never),
        MidenMessageType.DAppPrivateNotesConfirmationRequest,
        { confirmed: false }
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('requestConsumableNotes rejects when user declines (covers onDecline at L765)', async () => {
    _g.__dappExtTest.midenClient.getConsumableNotes = jest.fn().mockResolvedValue([]);
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
    const sdk = require('lib/miden/activity/transactions');
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

  it('requestTransaction rejects with InvalidParams when requestCustomTransaction throws inside the confirmed branch', async () => {
    const sdk = require('lib/miden/activity/transactions');
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
            sourcePublicKey: 'miden-account-1',
            sourceAccountId: 'miden-account-1',
            payload: 'aGVsbG8=',
            kind: 'word'
          } as never),
        MidenMessageType.DAppSignConfirmationRequest,
        { confirmed: true }
      )
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
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
});
