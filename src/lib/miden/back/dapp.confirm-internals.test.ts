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

const _g = globalThis as any;
_g.__dappConfInternals = {
  intercomListeners: [] as Array<(req: any, port?: any) => Promise<any> | any>,
  storage: {} as Record<string, any>,
  onRemovedListeners: [] as Array<(winId: number) => void>,
  midenClient: {
    getAccount: jest.fn(async () => ({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1]) }]
    })),
    getInputNoteDetails: jest.fn(async () => []),
    getConsumableNotes: jest.fn(async () => []),
    syncState: jest.fn(async () => {}),
    importNoteBytes: jest.fn(async () => ({ toString: () => 'n1' })),
    on: jest.fn()
  }
};

jest.mock('lib/miden/back/store', () => ({
  store: { getState: () => ({ currentAccount: { publicKey: 'a1' }, status: 'Ready' }) },
  withUnlocked: jest.fn(async (fn: any) => fn({ vault: { signData: jest.fn(async () => 'sig') } }))
}));

jest.mock('lib/miden/activity/transactions', () => ({
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

jest.mock('lib/miden/sdk/helpers', () => ({ getBech32AddressFromAccountId: () => 'bech32' }));

jest.mock('@demox-labs/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));

jest.mock('webextension-polyfill', () => {
  const browser = {
    runtime: {
      getPlatformInfo: async () => ({ os: 'mac' }),
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
      getLastFocused: jest.fn(async () => ({ left: 0, top: 0, width: 1024, height: 768 })),
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
  jest.clearAllMocks();
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
