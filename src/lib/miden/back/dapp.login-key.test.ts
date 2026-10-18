/* eslint-disable import/first */
/**
 * Tests for `requestLoginKey` and `requestLoginSign`: a connected page gets its own site's login key without a prompt,
 * and a login signature over a 32-byte word once the user approves. The vault is a stub and the domain comes from the
 * real `loginKeyDomain`. Requests run on mobile, and as the extension where the two platforms differ.
 */

import extensionBrowser from 'webextension-polyfill';

import {
  MidenDAppErrorType,
  type MidenDAppLoginKeyRequest,
  type MidenDAppLoginSignRequest,
  MidenDAppMessageType
} from 'lib/adapter/types';
import { MidenMessageType } from 'lib/miden/types';
import { u8ToB64 } from 'lib/shared/helpers';
import { WalletStatus } from 'lib/shared/types';

// Mocks

// Read through `isExtension()` while a request runs, so each test picks its platform.
// eslint-disable-next-line no-var
var mockIsExtension = false;

const mockLoginKeyCommitment = jest.fn();
const mockSignWithLoginKey = jest.fn();
const UNLOCKED_CONTEXT = {
  vault: { loginKeyCommitment: mockLoginKeyCommitment, signWithLoginKey: mockSignWithLoginKey }
};
const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) => fn(UNLOCKED_CONTEXT));

let mockWalletStatus = WalletStatus.Ready;
const mockStoreListeners = new Set<(state: unknown) => void>();
jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({ currentAccount: { publicKey: 'miden-account-1' }, status: mockWalletStatus }),
    // Drives `waitForUnlock`: `unlockWallet()` notifies these the way the real store's updates do.
    updates: {
      watch: (listener: (state: unknown) => void) => {
        mockStoreListeners.add(listener);
        return () => mockStoreListeners.delete(listener);
      }
    }
  },
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn)
}));

jest.mock('lib/miden/transaction', () => ({
  initiateSendTransaction: jest.fn(),
  requestCustomTransaction: jest.fn(),
  initiateConsumeTransactionFromId: jest.fn(),
  waitForTransactionCompletion: jest.fn()
}));

jest.mock('lib/miden/activity', () => ({
  queueNoteImport: jest.fn()
}));

jest.mock('lib/miden/back/transaction-processor', () => ({
  startTransactionProcessing: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension,
  isDesktop: () => false,
  isMobile: () => !mockIsExtension
}));

const mockStorageState: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = mockStorageState[k];
      return out;
    },
    set: async (kv: Record<string, unknown>) => {
      Object.assign(mockStorageState, kv);
    },
    delete: async (keys: string[]) => {
      for (const k of keys) delete mockStorageState[k];
    }
  })
}));

jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: jest.fn()
}));

jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: (value: bigint) => value.toString()
}));

const mockRequestConfirmation = jest.fn();
jest.mock('lib/dapp-browser/confirmation-store', () => ({
  dappConfirmationStore: {
    requestConfirmation: (...args: unknown[]) => mockRequestConfirmation(...args),
    resolveConfirmation: jest.fn(),
    hasPendingRequest: jest.fn(() => false),
    getPendingRequest: jest.fn(() => null),
    getAllPendingRequests: jest.fn(() => []),
    subscribe: jest.fn(() => () => undefined),
    getInstanceId: () => 'test-store'
  }
}));

// The extension popup's port: `requestConfirm` listens here for the popup's messages.
const mockIntercomListeners: Array<(req: unknown, port?: unknown) => Promise<unknown>> = [];
jest.mock('lib/miden/back/defaults', () => ({
  intercom: {
    onRequest: (listener: (req: unknown, port?: unknown) => Promise<unknown>) => {
      mockIntercomListeners.push(listener);
      return () => {
        const at = mockIntercomListeners.indexOf(listener);
        if (at !== -1) mockIntercomListeners.splice(at, 1);
      };
    },
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
  getMidenClient: async () => ({
    getAccount: jest.fn(),
    getInputNoteDetails: jest.fn(async () => []),
    getConsumableNotes: jest.fn(async () => []),
    getConsumableNoteDtos: jest.fn(async () => []),
    syncState: jest.fn(async () => {}),
    on: jest.fn()
  }),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn()
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: () => 'bech32-addr',
  sameWalletAccountId: (a: string, b: string) => a === b
}));

jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));

jest.mock('webextension-polyfill', () => {
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
      getLastFocused: jest.fn(async () => ({ type: 'normal', left: 0, top: 0, width: 1024, height: 768 })),
      getAll: jest.fn(async () => []),
      onRemoved: noopEvt
    },
    storage: { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } },
    tabs: { create: jest.fn(), query: jest.fn(async () => []), remove: jest.fn() }
  };
  return { __esModule: true, default: browser, ...browser };
});

// Import under test

import * as dapp from './dapp';
import { _resetLockedPromptCooldownsForTest, noteLockedPromptEnded, WALLET_LOCKED_REFUSAL } from './dapp-locked';

const STORAGE_KEY = 'dapp_sessions';
const ORIGIN = 'https://www.example.org';
const DOMAIN = 'example.org';
const ACCOUNT = 'miden-account-1';
// Not the account id, so a test catches one passed in place of the other.
const SESSION_KEY = 'session-public-key';
const WORD = u8ToB64(new Uint8Array(32).fill(7));
const LOGIN_KEY = 'login-key-commitment';
const SIGNATURE = 'login-signature';
const UNAVAILABLE = `${MidenDAppErrorType.LoginKeyUnavailable}: this account's root key is not on this device`;
const NOT_A_WORD = `${MidenDAppErrorType.InvalidParams}: a login signature signs only a 32-byte word`;
const NOT_HTTPS = `${MidenDAppErrorType.InvalidParams}: login keys need an https page`;

function connect(origin: string, session: Record<string, unknown> = {}) {
  mockStorageState[STORAGE_KEY] = {
    [origin]: [
      {
        network: 'testnet',
        appMeta: { name: 'Example', url: origin },
        accountId: ACCOUNT,
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0,
        publicKey: SESSION_KEY,
        ...session
      }
    ]
  };
}

const keyRequest = (fields: object = {}): MidenDAppLoginKeyRequest => ({
  type: MidenDAppMessageType.LoginKeyRequest,
  sourceAccountId: ACCOUNT,
  ...fields
});

const signRequest = (fields: object = {}): MidenDAppLoginSignRequest => ({
  type: MidenDAppMessageType.LoginSignRequest,
  sourceAccountId: ACCOUNT,
  payload: WORD,
  kind: 'word',
  ...fields
});

const lockWallet = () => {
  mockWalletStatus = WalletStatus.Locked;
  mockWithUnlocked.mockImplementation(async () => {
    throw Object.assign(new Error('Wallet is locked'), { reason: 'locked' });
  });
};

const unlockWallet = () => {
  mockWalletStatus = WalletStatus.Ready;
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn(UNLOCKED_CONTEXT));
  for (const listener of [...mockStoreListeners]) listener({ status: WalletStatus.Ready });
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// When a mock was first called, among every mock call so far: never is infinitely late.
const firstCall = (order: number[]) => order[0] ?? Number.POSITIVE_INFINITY;

type Outcome = { ok: true; value: unknown } | { ok: false; message: string };
const settle = (call: Promise<unknown>): Promise<Outcome> =>
  call.then(
    (value): Outcome => ({ ok: true, value }),
    (error: Error): Outcome => ({ ok: false, message: error.message })
  );

// Starts a request that opens the extension's confirm popup, then speaks for the popup on its port.
async function openPopup(start: () => Promise<unknown>) {
  const create = jest.mocked(extensionBrowser.windows.create);
  const opened = create.mock.calls.length;
  const outcome = settle(start());
  for (let i = 0; i < 5 && create.mock.calls.length === opened; i++) await flush();
  expect(create).toHaveBeenCalledTimes(opened + 1);
  const id = String(create.mock.calls.at(-1)?.[0]?.url ?? '').match(/[?&]id=([^&]+)/)?.[1];
  const listener = mockIntercomListeners.at(-1);
  if (!listener) throw new Error('the popup has no listener');
  const port = { id: 'confirm-port' };
  return {
    outcome,
    getPayload: () => listener({ type: MidenMessageType.DAppGetPayloadRequest, id: [id] }, port),
    decide: (type: MidenMessageType, fields: Record<string, unknown>) => listener({ type, id, ...fields }, port)
  };
}

beforeEach(() => {
  _resetLockedPromptCooldownsForTest();
  jest.clearAllMocks();
  mockIsExtension = false;
  mockWalletStatus = WalletStatus.Ready;
  mockStoreListeners.clear();
  mockIntercomListeners.length = 0;
  for (const key of Object.keys(mockStorageState)) delete mockStorageState[key];
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn(UNLOCKED_CONTEXT));
  mockGetCurrentAccountPublicKey.mockResolvedValue(ACCOUNT);
  mockLoginKeyCommitment.mockReset().mockResolvedValue(LOGIN_KEY);
  mockSignWithLoginKey.mockReset().mockResolvedValue(SIGNATURE);
  mockRequestConfirmation.mockReset().mockResolvedValue({ confirmed: true });
  connect(ORIGIN);
});

describe('requestLoginKey', () => {
  it("answers the login key for the session's account and the page's domain", async () => {
    await expect(dapp.requestLoginKey(ORIGIN, keyRequest())).resolves.toEqual({
      type: MidenDAppMessageType.LoginKeyResponse,
      loginKey: LOGIN_KEY
    });
    expect(mockLoginKeyCommitment).toHaveBeenCalledWith(ACCOUNT, SESSION_KEY, DOMAIN);
    expect(mockRequestConfirmation).not.toHaveBeenCalled();

    mockIsExtension = true;
    await expect(dapp.requestLoginKey(ORIGIN, keyRequest())).resolves.toEqual({
      type: MidenDAppMessageType.LoginKeyResponse,
      loginKey: LOGIN_KEY
    });
    expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
  });

  it('unlocks before answering a locked wallet', async () => {
    // Mobile and desktop wait for the app's own unlock.
    lockWallet();
    const onMobile = dapp.requestLoginKey(ORIGIN, keyRequest());
    await flush();
    expect(mockLoginKeyCommitment).not.toHaveBeenCalled();
    unlockWallet();
    await expect(onMobile).resolves.toEqual({ type: MidenDAppMessageType.LoginKeyResponse, loginKey: LOGIN_KEY });

    // The extension opens a popup that only unlocks.
    mockIsExtension = true;
    lockWallet();
    const popup = await openPopup(() => dapp.requestLoginKey(ORIGIN, keyRequest()));
    unlockWallet();
    await expect(popup.getPayload()).resolves.toEqual(
      expect.objectContaining({ payload: expect.objectContaining({ type: 'unlock', origin: ORIGIN }) })
    );
    await expect(popup.decide(MidenMessageType.DAppUnlockConfirmationRequest, {})).resolves.toEqual({
      type: MidenMessageType.DAppUnlockConfirmationResponse
    });
    await expect(popup.outcome).resolves.toEqual({
      ok: true,
      value: { type: MidenDAppMessageType.LoginKeyResponse, loginKey: LOGIN_KEY }
    });
    expect(mockLoginKeyCommitment.mock.calls).toEqual([
      [ACCOUNT, SESSION_KEY, DOMAIN],
      [ACCOUNT, SESSION_KEY, DOMAIN]
    ]);
  });

  it("passes a session's missing public key through, and keeps the vault's refusal", async () => {
    // A session stored by an older version may lack it; the vault then refuses rather than guess a key.
    connect(ORIGIN, { publicKey: undefined });
    mockLoginKeyCommitment.mockRejectedValue(new Error(UNAVAILABLE));
    await expect(dapp.requestLoginKey(ORIGIN, keyRequest())).rejects.toThrow(new Error(UNAVAILABLE));
    expect(mockLoginKeyCommitment).toHaveBeenCalledWith(ACCOUNT, undefined, DOMAIN);
  });
});

describe('both login key messages', () => {
  it('ignores a domain or origin in the request', async () => {
    const lure = { domain: 'evil.example', origin: 'https://evil.example' };
    await expect(dapp.requestLoginKey(ORIGIN, keyRequest(lure))).resolves.toEqual(
      expect.objectContaining({ loginKey: LOGIN_KEY })
    );
    await expect(dapp.requestLoginSign(ORIGIN, signRequest(lure))).resolves.toEqual(
      expect.objectContaining({ signature: SIGNATURE })
    );
    expect(mockLoginKeyCommitment.mock.calls).toEqual([
      [ACCOUNT, SESSION_KEY, DOMAIN],
      [ACCOUNT, SESSION_KEY, DOMAIN]
    ]);
    expect(mockRequestConfirmation).toHaveBeenCalledWith(expect.objectContaining({ origin: ORIGIN, domain: DOMAIN }));
    expect(mockSignWithLoginKey).toHaveBeenCalledWith(ACCOUNT, SESSION_KEY, DOMAIN, WORD);
  });

  it('refuses a page without a session', async () => {
    connect('https://example.com');
    await expect(dapp.requestLoginKey(ORIGIN, keyRequest())).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    await expect(dapp.requestLoginSign(ORIGIN, signRequest())).rejects.toThrow(
      new Error(MidenDAppErrorType.NotGranted)
    );

    // This page's session for another account is no session for this one.
    connect(ORIGIN, { accountId: 'miden-account-2' });
    await expect(dapp.requestLoginKey(ORIGIN, keyRequest())).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    await expect(dapp.requestLoginSign(ORIGIN, signRequest())).rejects.toThrow(
      new Error(MidenDAppErrorType.NotGranted)
    );
    expect(mockWithUnlocked).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('refuses a page that is not https', async () => {
    connect('http://example.org');
    await expect(dapp.requestLoginKey('http://example.org', keyRequest())).rejects.toThrow(new Error(NOT_HTTPS));
    await expect(dapp.requestLoginSign('http://example.org', signRequest())).rejects.toThrow(new Error(NOT_HTTPS));
    expect(mockWithUnlocked).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('refuses a request that names no account', async () => {
    for (const sourceAccountId of [undefined, '']) {
      await expect(dapp.requestLoginKey(ORIGIN, keyRequest({ sourceAccountId }))).rejects.toThrow(
        new Error(MidenDAppErrorType.InvalidParams)
      );
      await expect(dapp.requestLoginSign(ORIGIN, signRequest({ sourceAccountId }))).rejects.toThrow(
        new Error(MidenDAppErrorType.InvalidParams)
      );
    }
    await expect(dapp.requestLoginKey(ORIGIN, undefined as never)).rejects.toThrow(
      new Error(MidenDAppErrorType.InvalidParams)
    );
    await expect(dapp.requestLoginSign(ORIGIN, undefined as never)).rejects.toThrow(
      new Error(MidenDAppErrorType.InvalidParams)
    );
    expect(mockWithUnlocked).not.toHaveBeenCalled();
  });

  it('refuses a session whose account is not the current one', async () => {
    mockGetCurrentAccountPublicKey.mockResolvedValue('miden-account-2');
    await expect(dapp.requestLoginKey(ORIGIN, keyRequest())).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    await expect(dapp.requestLoginSign(ORIGIN, signRequest())).rejects.toThrow(
      new Error(MidenDAppErrorType.NotGranted)
    );
    expect(mockWithUnlocked).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });
});

describe('requestLoginSign', () => {
  it('refuses a login signature over anything but a 32-byte word', async () => {
    const notWords = [
      { kind: 'signingInputs' },
      { kind: undefined },
      { payload: u8ToB64(new Uint8Array(31).fill(7)) },
      { payload: u8ToB64(new Uint8Array(33).fill(7)) },
      { payload: 'not base64!' },
      // atob would read this array as the word it holds.
      { payload: [WORD] }
    ];
    for (const fields of notWords) {
      await expect(dapp.requestLoginSign(ORIGIN, signRequest(fields))).rejects.toThrow(new Error(NOT_A_WORD));
    }
    mockIsExtension = true;
    await expect(dapp.requestLoginSign(ORIGIN, signRequest({ kind: 'signingInputs' }))).rejects.toThrow(
      new Error(NOT_A_WORD)
    );
    expect(mockWithUnlocked).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
  });

  it('refuses without a prompt when the account has no root key', async () => {
    mockLoginKeyCommitment.mockRejectedValue(new Error(UNAVAILABLE));
    await expect(dapp.requestLoginSign(ORIGIN, signRequest())).rejects.toThrow(new Error(UNAVAILABLE));
    expect(mockRequestConfirmation).not.toHaveBeenCalled();

    mockIsExtension = true;
    await expect(dapp.requestLoginSign(ORIGIN, signRequest())).rejects.toThrow(new Error(UNAVAILABLE));
    expect(extensionBrowser.windows.create).not.toHaveBeenCalled();
    expect(mockIntercomListeners).toHaveLength(0);
    expect(mockSignWithLoginKey).not.toHaveBeenCalled();
  });

  it("asks with the site's domain and signs on approval", async () => {
    // Mobile and desktop: the shared confirmation sheet, raised for the requesting session.
    await expect(dapp.requestLoginSign(ORIGIN, signRequest(), 'session-7')).resolves.toEqual({
      type: MidenDAppMessageType.LoginSignResponse,
      signature: SIGNATURE
    });
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    expect(mockRequestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'loginSign',
        sessionId: 'session-7',
        origin: ORIGIN,
        domain: DOMAIN,
        accountId: ACCOUNT,
        transactionMessages: []
      })
    );
    expect(firstCall(mockLoginKeyCommitment.mock.invocationCallOrder)).toBeLessThan(
      firstCall(mockRequestConfirmation.mock.invocationCallOrder)
    );
    expect(mockSignWithLoginKey).toHaveBeenCalledWith(ACCOUNT, SESSION_KEY, DOMAIN, WORD);

    // The extension: its confirm popup.
    mockLoginKeyCommitment.mockClear();
    mockSignWithLoginKey.mockClear();
    mockIsExtension = true;
    const popup = await openPopup(() => dapp.requestLoginSign(ORIGIN, signRequest()));
    expect(firstCall(mockLoginKeyCommitment.mock.invocationCallOrder)).toBeLessThan(
      firstCall(jest.mocked(extensionBrowser.windows.create).mock.invocationCallOrder)
    );
    await expect(popup.getPayload()).resolves.toEqual({
      type: MidenMessageType.DAppGetPayloadResponse,
      payload: {
        type: 'loginSign',
        origin: ORIGIN,
        networkRpc: expect.any(String),
        appMeta: { name: 'Example', url: ORIGIN },
        domain: DOMAIN,
        accountId: ACCOUNT
      }
    });
    expect(mockSignWithLoginKey).not.toHaveBeenCalled();
    await expect(popup.decide(MidenMessageType.DAppSignConfirmationRequest, { confirmed: true })).resolves.toEqual({
      type: MidenMessageType.DAppSignConfirmationResponse
    });
    await expect(popup.outcome).resolves.toEqual({
      ok: true,
      value: { type: MidenDAppMessageType.LoginSignResponse, signature: SIGNATURE }
    });
    expect(mockSignWithLoginKey).toHaveBeenCalledWith(ACCOUNT, SESSION_KEY, DOMAIN, WORD);
  });

  it('refuses on decline', async () => {
    mockRequestConfirmation.mockResolvedValue({ confirmed: false });
    await expect(dapp.requestLoginSign(ORIGIN, signRequest())).rejects.toThrow(
      new Error(MidenDAppErrorType.NotGranted)
    );

    mockIsExtension = true;
    const popup = await openPopup(() => dapp.requestLoginSign(ORIGIN, signRequest()));
    await popup.getPayload();
    await expect(popup.decide(MidenMessageType.DAppSignConfirmationRequest, { confirmed: false })).resolves.toEqual({
      type: MidenMessageType.DAppSignConfirmationResponse
    });
    await expect(popup.outcome).resolves.toEqual({ ok: false, message: MidenDAppErrorType.NotGranted });
    expect(mockSignWithLoginKey).not.toHaveBeenCalled();
  });

  it('waits for a mobile unlock, then checks the root key before asking', async () => {
    lockWallet();
    const call = dapp.requestLoginSign(ORIGIN, signRequest());
    await flush();
    expect(mockWithUnlocked).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    unlockWallet();
    await expect(call).resolves.toEqual({ type: MidenDAppMessageType.LoginSignResponse, signature: SIGNATURE });
    expect(firstCall(mockLoginKeyCommitment.mock.invocationCallOrder)).toBeLessThan(
      firstCall(mockRequestConfirmation.mock.invocationCallOrder)
    );
  });

  it('refuses NOT_GRANTED: Wallet is locked when a mobile unlock is not offered', async () => {
    // A lock prompt from this page just ended still locked, so this request gets none (#1414).
    noteLockedPromptEnded(ORIGIN);
    lockWallet();
    await expect(dapp.requestLoginSign(ORIGIN, signRequest())).rejects.toThrow(new Error(WALLET_LOCKED_REFUSAL));
    expect(mockWithUnlocked).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('asks a locked extension in its popup and signs after the unlock', async () => {
    mockIsExtension = true;
    lockWallet();
    const popup = await openPopup(() => dapp.requestLoginSign(ORIGIN, signRequest()));
    expect(mockLoginKeyCommitment).not.toHaveBeenCalled();
    unlockWallet();
    await expect(popup.getPayload()).resolves.toEqual(
      expect.objectContaining({ payload: expect.objectContaining({ type: 'loginSign', domain: DOMAIN }) })
    );
    await popup.decide(MidenMessageType.DAppSignConfirmationRequest, { confirmed: true });
    await expect(popup.outcome).resolves.toEqual({
      ok: true,
      value: { type: MidenDAppMessageType.LoginSignResponse, signature: SIGNATURE }
    });
    expect(mockSignWithLoginKey).toHaveBeenCalledWith(ACCOUNT, SESSION_KEY, DOMAIN, WORD);
  });

  it('keeps the LOGIN_KEY_UNAVAILABLE code when a locked extension finds no root key on approval', async () => {
    mockIsExtension = true;
    lockWallet();
    mockSignWithLoginKey.mockRejectedValue(new Error(UNAVAILABLE));
    const popup = await openPopup(() => dapp.requestLoginSign(ORIGIN, signRequest()));
    unlockWallet();
    await popup.getPayload();
    await popup.decide(MidenMessageType.DAppSignConfirmationRequest, { confirmed: true });
    await expect(popup.outcome).resolves.toEqual({ ok: false, message: UNAVAILABLE });
  });

  it('refuses an approval once the page has been disconnected', async () => {
    // Mobile: the page disconnects while the sheet is open.
    mockRequestConfirmation.mockImplementation(async () => {
      mockStorageState[STORAGE_KEY] = { [ORIGIN]: [] };
      return { confirmed: true };
    });
    await expect(dapp.requestLoginSign(ORIGIN, signRequest())).rejects.toThrow(
      new Error(MidenDAppErrorType.NotGranted)
    );

    // The extension: the page disconnects while the popup is open.
    connect(ORIGIN);
    mockIsExtension = true;
    const popup = await openPopup(() => dapp.requestLoginSign(ORIGIN, signRequest()));
    await popup.getPayload();
    mockStorageState[STORAGE_KEY] = { [ORIGIN]: [] };
    await popup.decide(MidenMessageType.DAppSignConfirmationRequest, { confirmed: true });
    await expect(popup.outcome).resolves.toEqual({ ok: false, message: MidenDAppErrorType.NotGranted });
    expect(mockSignWithLoginKey).not.toHaveBeenCalled();
  });

  it('answers only its own approval in the extension popup', async () => {
    mockIsExtension = true;
    const popup = await openPopup(() => dapp.requestLoginSign(ORIGIN, signRequest()));
    await popup.getPayload();
    await expect(
      popup.decide(MidenMessageType.DAppSignConfirmationRequest, { id: 'another-id', confirmed: true })
    ).resolves.toBeUndefined();
    await expect(
      popup.decide(MidenMessageType.DAppTransactionConfirmationRequest, { confirmed: true })
    ).resolves.toBeUndefined();
    expect(mockSignWithLoginKey).not.toHaveBeenCalled();

    await popup.decide(MidenMessageType.DAppSignConfirmationRequest, { confirmed: false });
    await expect(popup.outcome).resolves.toEqual({ ok: false, message: MidenDAppErrorType.NotGranted });
  });
});
