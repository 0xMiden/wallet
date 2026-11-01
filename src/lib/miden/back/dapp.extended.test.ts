/* eslint-disable import/first */
/**
 * Extended coverage tests for `lib/miden/back/dapp.ts`.
 *
 * Scope: every exported request* handler's error branches (missing
 * params, no session, wrong account) AND the mobile/desktop happy path
 * that flows through `dappConfirmationStore.requestConfirmation`.
 *
 * This file complements `dapp.coverage.test.ts` (the narrower smoke
 * suite) by pushing coverage deep into the bodies of generatePromisify*
 * helpers, the format* preview builders, and the mobile branches.
 */

import { NoteFilterTypes } from '@miden-sdk/miden-sdk/lazy';
import { WalletAdapterNetwork } from '@miden-sdk/miden-wallet-adapter-base';
import PQueue from 'p-queue';

import { MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';
import * as noteQuarantine from 'lib/miden/note-quarantine';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { TransactionQueuedError } from 'lib/miden/transaction/initiate';
import { DEFAULT_DELEGATE_PROOF } from 'lib/settings/constants';
import { WalletStatus } from 'lib/shared/types';

// ── Shared mocks ───────────────────────────────────────────────────

const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) => fn({ vault: {} }));

let mockWalletStatus: unknown = 'Ready';
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

const mockInitiateSendTransaction = jest.fn();
const mockRequestCustomTransaction = jest.fn();
const mockInitiateConsumeTransactionFromId = jest.fn();
const mockWaitForTransactionCompletion = jest.fn();

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
  initiateSendTransaction: (...args: unknown[]) => mockInitiateSendTransaction(...args),
  requestCustomTransaction: (...args: unknown[]) => mockRequestCustomTransaction(...args),
  initiateConsumeTransactionFromId: (...args: unknown[]) => mockInitiateConsumeTransactionFromId(...args),
  waitForTransactionCompletion: (...args: unknown[]) => mockWaitForTransactionCompletion(...args)
}));

const mockQueueNoteImport = jest.fn();
jest.mock('lib/miden/activity', () => ({
  queueNoteImport: (...args: unknown[]) => mockQueueNoteImport(...args)
}));

const mockStartTransactionProcessing = jest.fn();
jest.mock('lib/miden/back/transaction-processor', () => ({
  startTransactionProcessing: () => mockStartTransactionProcessing()
}));

// A hoisted `var`: `transaction/cancel.ts` calls `isMobile()` while `./dapp` loads, before a `let` here exists.
// eslint-disable-next-line no-var
var mockIsDesktop = false;
jest.mock('lib/platform', () => ({
  isExtension: () => false,
  isDesktop: () => mockIsDesktop,
  isMobile: () => !mockIsDesktop
}));

const mockFocusMainWindow = jest.fn(async () => undefined);
jest.mock('lib/desktop/dapp-browser', () => ({
  focusMainWindow: () => mockFocusMainWindow()
}));

const storageState: Record<string, unknown> = {};

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = storageState[k];
      return out;
    },
    set: async (kv: Record<string, unknown>) => {
      Object.assign(storageState, kv);
    },
    delete: async (keys: string[]) => {
      for (const k of keys) delete storageState[k];
    }
  })
}));

// Consume previews quote a MAX fee bound, so the base fee has to be steerable.
// Default null = undiscovered, which is what every pre-existing test in this file
// implicitly assumed when the row did not exist.
let mockBaseFee: number | null = null;
jest.mock('lib/miden-chain/native-asset', () => ({
  getVerificationBaseFee: async () => mockBaseFee,
  getNativeAssetId: async () => 'native-faucet'
}));

const mockGetTokenMetadata = jest.fn();
jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: (...args: unknown[]) => mockGetTokenMetadata(...args),
  getAssetSymbol: (metadata?: { symbol?: string }) => metadata?.symbol ?? 'Unknown'
}));

// Mock lib/i18n/numbers so requestConsumeTransaction can run formatBigInt
jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: (value: bigint, _decimals: number) => value.toString()
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

jest.mock('lib/miden/back/defaults', () => ({
  intercom: { broadcast: jest.fn() }
}));

// The real module, except the hot-key commitment, which needs the SDK's key decoder. A case steers it to name
// THIS DEVICE's signer (multi-device: the signer set can hold one hot key per device).
const mockCommitmentFromPublicKeyHex = jest.fn<Promise<string>, [string]>();
jest.mock('lib/secure-hot-key/commitment', () => ({
  ...jest.requireActual('lib/secure-hot-key/commitment'),
  commitmentFromPublicKeyHex: (publicKeyHex: string) => mockCommitmentFromPublicKeyHex(publicKeyHex)
}));

const mockGetCurrentAccountPublicKey = jest.fn();
jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    getCurrentAccountPublicKey: (...args: unknown[]) => mockGetCurrentAccountPublicKey(...args)
  }
}));

// WASM client mock — use the RELATIVE path so dapp.ts's relative import
// resolves to this factory. Define the jest.fn stubs on globalThis so the
// factory closure reaches them even though it runs BEFORE the const
// declarations at module-eval time (jest.mock is hoisted, import statements
// that trigger the factory are also hoisted, and consts are NOT hoisted).
const _g = globalThis as any;
_g.__dappTestMockGetAccount = jest.fn();
_g.__dappTestMockGetOutputNotes = jest.fn();
// Extra client methods the non-extension private-data / import prompts reach
// through `midenClientProxy`'s flag-off passthrough.
_g.__dappTestMockGetInputNoteDetails = jest.fn(async () => []);
_g.__dappTestMockGetConsumableNotes = jest.fn(async () => []);
_g.__dappTestMockImportNoteBytes = jest.fn(async () => 'imported-note-id');
_g.__dappTestMockSyncState = jest.fn(async () => {});
const mockGetAccount = _g.__dappTestMockGetAccount;
const mockGetInputNoteDetails = _g.__dappTestMockGetInputNoteDetails;
const mockGetConsumableNotes = _g.__dappTestMockGetConsumableNotes;
const mockImportNoteBytes = _g.__dappTestMockImportNoteBytes;
// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
// Models hold OWNERSHIP, not just mutual exclusion (#788 follow-up): the lock hands
// its callback a hold, and dapp.ts re-checks it via `assertWasmHoldCurrent` after
// every parking await. A hold-less pass-through would make those guards a TypeError
// on the happy path and unreachable for the eviction tests below; a no-op assert
// would make them vacuous. The closures run at test time, after this `let`
// initializes, so the factory-hoisting caveat above doesn't bite them.
let currentWasmHold: object | null = null;
// Simulates the watchdog handing the mutex to a successor while the current client
// call is still parked — call from inside a client-method mock.
const revokeWasmHold = (): void => {
  currentWasmHold = null;
};
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({
    getAccount: (id: string) => (globalThis as any).__dappTestMockGetAccount(id),
    getOutputNotes: (id: string) => (globalThis as any).__dappTestMockGetOutputNotes(id),
    getInputNoteDetails: (q: unknown) => (globalThis as any).__dappTestMockGetInputNoteDetails(q),
    // No record has a consume request's id as its details commitment here (#1389).
    getDetailsCommitmentMatches: async () => [{ notes: [], uncommitted: 0 }],
    getConsumableNoteDtos: (...a: unknown[]) => (globalThis as any).__dappTestMockGetConsumableNotes(...a),
    importNoteBytes: (b: Uint8Array) => (globalThis as any).__dappTestMockImportNoteBytes(b),
    syncState: () => (globalThis as any).__dappTestMockSyncState(),
    on: jest.fn()
  }),
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
  // Re-implements the real comparison against this mock's hold, and throws the
  // REAL poison class so dapp.ts's `isWasmClientPoisonedError` routing sees the
  // shape the poison contract promises.
  assertWasmHoldCurrent: (hold: object | null, where: string, step?: string): void => {
    if (hold !== null && hold === currentWasmHold) return;
    throw new WasmClientPoisonedError('watchdog', new Error(`operation abandoned ${where}${step ? `, ${step}` : ''}`));
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

// Mock the wallet adapter package so the enums are defined at import time.
// At runtime the package is an ESM .mjs build and may not destructure cleanly
// in jest's CJS-emulation mode.
jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: {
    UponRequest: 'UPON_REQUEST',
    Auto: 'AUTO'
  },
  AllowedPrivateData: {
    None: 0,
    Assets: 1,
    Notes: 2,
    Storage: 4,
    All: 65535
  },
  WalletAdapterNetwork: { Testnet: 'testnet' }
}));

// ── Imports under test ─────────────────────────────────────────────

import * as dapp from './dapp';
import { _resetLockedPromptCooldownsForTest, WALLET_LOCKED_REFUSAL } from './dapp-locked';
import { OperationAbortedError } from './offscreen-codec';

const UNLOCKED_CONTEXT = { vault: { signData: jest.fn(async () => 'fake-sig-base64') } };

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

const STORAGE_KEY = 'dapp_sessions';

const SESSION = {
  network: 'testnet',
  appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
  accountId: 'miden-account-1',
  privateDataPermission: 'UponRequest',
  allowedPrivateData: {},
  publicKey: 'miden-account-1'
};

beforeEach(() => {
  _resetLockedPromptCooldownsForTest();
  jest.clearAllMocks();
  mockWalletStatus = 'Ready';
  mockStoreListeners.clear();
  mockIsDesktop = false;
  // The consume approval preview is derived from the note the wallet resolves, not
  // from the dApp's declared faucet/amount/type, so every consume test needs the
  // note to exist in the store. Matches `validTx` below (note-1 / faucet-1 / 50).
  mockGetInputNoteDetails.mockImplementation(async () => [
    {
      noteId: 'note-1',
      noteType: 0,
      senderAccountId: 'sender-1',
      nullifier: 'nf-1',
      state: 0,
      assets: [{ faucetId: 'faucet-1', amount: '50' }],
      nonFungibleAssets: []
    }
  ]);
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) =>
    fn({
      vault: {
        signData: jest.fn(async () => 'fake-sig-base64')
      }
    })
  );
  mockGetCurrentAccountPublicKey.mockResolvedValue('miden-account-1');
  // Wipe sessions state between tests then reseed the known origin
  for (const k of Object.keys(storageState)) delete storageState[k];
  storageState[STORAGE_KEY] = { 'https://miden.xyz': [SESSION] };
  // Default confirmation behaviour: approve with the same account
  mockRequestConfirmation.mockResolvedValue({
    confirmed: true,
    accountPublicKey: 'miden-account-1',
    privateDataPermission: 'UponRequest',
    delegate: true
  });
});

// ── requestSign ────────────────────────────────────────────────────

describe('requestSign', () => {
  const poison = new WasmClientPoisonedError('watchdog', new Error('sign parked'));
  const abort = new OperationAbortedError('op-1378', 'deadline');
  const terminated = new Error('Client terminated');
  const webTerminated = new Error('WebClient terminated');

  it.each<[string, Error, Error]>([
    ['a watchdog eviction', poison, poison],
    ['an offscreen abort', abort, abort],
    ['a terminated client', terminated, terminated],
    ['a terminated web client', webTerminated, webTerminated],
    ['a cause-wrapped poison', new Error('NOT_GRANTED: sign wrapper', { cause: poison }), poison]
  ])('passes through %s from vault.signData after approval', async (_label, error, kill) => {
    const signData = jest.fn().mockRejectedValueOnce(error);
    mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: { signData } }));

    await expect(
      dapp.requestSign('https://miden.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: 'miden-account-1',
        sourceAccountId: 'miden-account-1',
        payload: 'aGVsbG8=',
        kind: 'word'
      })
    ).rejects.toBe(kill);
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    expect(signData).toHaveBeenCalledTimes(1);
  });

  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(
      dapp.requestSign('https://miden.xyz', {
        type: MidenDAppMessageType.SignRequest,
        payload: 'x',
        kind: 'word'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when the origin has no session', async () => {
    delete storageState[STORAGE_KEY];
    await expect(
      dapp.requestSign('https://miden.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: 'miden-account-1',
        sourceAccountId: 'miden-account-1',
        payload: 'x',
        kind: 'word'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('throws NotFound when sourceAccountId does not match the stored session', async () => {
    await expect(
      dapp.requestSign('https://miden.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: 'miden-account-1',
        sourceAccountId: 'different-account',
        payload: 'x',
        kind: 'word'
      } as never)
    ).rejects.toThrow();
  });
});

// ── Locking the wallet cuts off dApp private-data reads ────────────

describe('a locked wallet serves no private data to a connected dApp', () => {
  // `assertUnlocked` (back/store.ts) throws once the vault is cleared; these pin that every private-data reader goes
  // THROUGH `withUnlocked`, so an Auto dApp reads nothing from a locked wallet. Mobile and desktop wait for the app's
  // own unlock instead of refusing at once (#1414); a wait that runs out reads nothing either.
  beforeEach(() => {
    lockWallet();
    // One account stub for every read here: connect's key read and the assets read.
    mockGetAccount.mockResolvedValue({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }],
      vault: () => ({ fungibleAssets: () => [] })
    });
    storageState[STORAGE_KEY] = {
      'https://miden.xyz': [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 65535 }]
    };
  });

  afterEach(() => jest.useRealTimers());

  const reads: Record<string, { call: () => Promise<unknown>; read: () => jest.Mock; answer: string }> = {
    requestAssets: {
      call: () =>
        dapp.requestAssets('https://miden.xyz', {
          type: MidenDAppMessageType.AssetsRequest,
          sourcePublicKey: 'miden-account-1'
        } as never),
      read: () => mockGetAccount,
      answer: MidenDAppMessageType.AssetsResponse
    },
    requestPrivateNotes: {
      call: () =>
        dapp.requestPrivateNotes('https://miden.xyz', {
          type: MidenDAppMessageType.PrivateNotesRequest,
          sourcePublicKey: 'miden-account-1',
          notefilterType: 'All'
        } as never),
      read: () => mockGetInputNoteDetails,
      answer: MidenDAppMessageType.PrivateNotesResponse
    },
    requestConsumableNotes: {
      call: () =>
        dapp.requestConsumableNotes('https://miden.xyz', {
          type: MidenDAppMessageType.ConsumableNotesRequest,
          sourcePublicKey: 'miden-account-1'
        } as never),
      read: () => mockGetConsumableNotes,
      answer: MidenDAppMessageType.ConsumableNotesResponse
    }
  };

  it.each(Object.keys(reads))('%s waits for the unlock, then refuses as locked and reads nothing', async name => {
    jest.useFakeTimers();
    const outcome = reads[name]!.call().then(
      () => 'resolved',
      (err: Error) => err.message
    );
    await jest.advanceTimersByTimeAsync(120_000);
    await expect(outcome).resolves.toBe(WALLET_LOCKED_REFUSAL);
    expect(reads[name]!.read()).not.toHaveBeenCalled();
  });

  it.each(Object.keys(reads))('%s answers once the app is unlocked, reading only then', async name => {
    const call = reads[name]!.call();
    await new Promise(r => setTimeout(r, 0));
    expect(reads[name]!.read()).not.toHaveBeenCalled();
    unlockWallet();
    await expect(call).resolves.toEqual(expect.objectContaining({ type: reads[name]!.answer }));
    expect(reads[name]!.read()).toHaveBeenCalled();
  });

  it('refuses NOT_GRANTED and reads nothing when the dApp was disconnected during the wait', async () => {
    const call = reads.requestAssets!.call();
    await new Promise(r => setTimeout(r, 0));
    storageState[STORAGE_KEY] = { 'https://miden.xyz': [] };
    unlockWallet();
    await expect(call).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('raises the wallet window when a desktop request starts waiting for the unlock', async () => {
    mockIsDesktop = true;
    const call = reads.requestAssets!.call();
    await new Promise(r => setTimeout(r, 0));
    expect(mockFocusMainWindow).toHaveBeenCalledTimes(1);
    unlockWallet();
    await call;
  });

  it('refuses at once, with no wait, for 30 s after a wait for this origin ran out', async () => {
    jest.useFakeTimers();
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
    const first = track(reads.requestAssets!.call());
    await jest.advanceTimersByTimeAsync(120_000);
    expect(first).toEqual({ settled: true, message: WALLET_LOCKED_REFUSAL });

    const second = track(reads.requestAssets!.call());
    await jest.advanceTimersByTimeAsync(0);
    expect(second).toEqual({ settled: true, message: WALLET_LOCKED_REFUSAL });

    await jest.advanceTimersByTimeAsync(30_000);
    const third = track(reads.requestAssets!.call());
    await jest.advanceTimersByTimeAsync(0);
    // Waiting again: the cooldown is over.
    expect(third.settled).toBe(false);
    unlockWallet();
    await jest.advanceTimersByTimeAsync(0);
    expect(third.settled).toBe(true);
  });

  it('starts no cooldown when the app unlocked during the wait', async () => {
    const first = reads.requestAssets!.call();
    await new Promise(r => setTimeout(r, 0));
    unlockWallet();
    await first;

    lockWallet();
    const second = reads.requestAssets!.call();
    await new Promise(r => setTimeout(r, 0));
    unlockWallet();
    await expect(second).resolves.toEqual(expect.objectContaining({ type: MidenDAppMessageType.AssetsResponse }));
  });
});

describe('mobile and desktop sheets wait for the app to unlock (#1414)', () => {
  beforeEach(() => {
    lockWallet();
    // One account stub for every read here: connect's key read and the assets read.
    mockGetAccount.mockResolvedValue({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }],
      vault: () => ({ fungibleAssets: () => [] })
    });
  });
  afterEach(() => jest.useRealTimers());

  it('posts the sheet of an UponRequest read only after the unlock', async () => {
    const call = dapp.requestAssets('https://miden.xyz', {
      type: MidenDAppMessageType.AssetsRequest,
      sourcePublicKey: 'miden-account-1'
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    unlockWallet();
    await expect(call).resolves.toEqual(expect.objectContaining({ type: MidenDAppMessageType.AssetsResponse }));
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  });

  const prompts: Record<string, () => Promise<unknown>> = {
    sign: () =>
      dapp.requestSign('https://miden.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: 'miden-account-1',
        sourceAccountId: 'miden-account-1',
        payload: 'deadbeef',
        kind: 'word'
      } as never),
    importPrivateNote: () =>
      dapp.requestImportPrivateNote('https://miden.xyz', {
        type: MidenDAppMessageType.ImportPrivateNoteRequest,
        sourcePublicKey: 'miden-account-1',
        note: 'aGVsbG8='
      } as never),
    connect: () =>
      dapp.requestPermission('https://newdapp.xyz', {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'New Dapp', url: 'https://newdapp.xyz' },
        network: 'testnet',
        privateDataPermission: 'UponRequest',
        allowedPrivateData: {},
        force: false
      } as never)
  };

  it.each(Object.keys(prompts))('%s posts its sheet only after the unlock', async name => {
    const call = prompts[name]!();
    await new Promise(r => setTimeout(r, 0));
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    unlockWallet();
    await call;
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  });

  it.each(Object.keys(prompts))(
    '%s refuses NOT_GRANTED: Wallet is locked when the wait runs out, with no sheet',
    async name => {
      jest.useFakeTimers();
      const outcome = prompts[name]!().then(
        () => 'resolved',
        (err: Error) => err.message
      );
      await jest.advanceTimersByTimeAsync(120_000);
      await expect(outcome).resolves.toBe(WALLET_LOCKED_REFUSAL);
      expect(mockRequestConfirmation).not.toHaveBeenCalled();
    }
  );

  it('answers a reconnect of an existing permission with no sheet once the app is unlocked', async () => {
    const call = dapp.requestPermission('https://miden.xyz', {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
      network: 'testnet'
    } as never);
    await new Promise(r => setTimeout(r, 0));
    unlockWallet();
    await expect(call).resolves.toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.PermissionResponse, accountId: 'miden-account-1' })
    );
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });
});

describe("one mobile request's unlock waits and sheet share one 240 s bound (#1414)", () => {
  const ORIGIN = 'https://miden.xyz';

  beforeEach(() => {
    jest.useFakeTimers();
    lockWallet();
    mockGetAccount.mockResolvedValue({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }],
      vault: () => ({ fungibleAssets: () => [] })
    });
    mockInitiateSendTransaction.mockResolvedValue('tx-send-1');
  });
  afterEach(() => jest.useRealTimers());

  type Outcome = { settled: boolean; message: string };
  const track = (call: Promise<unknown>): Outcome => {
    const outcome: Outcome = { settled: false, message: '' };
    call.then(
      () => {
        outcome.settled = true;
      },
      (err: Error) => {
        outcome.settled = true;
        outcome.message = err.message;
      }
    );
    return outcome;
  };

  // The rebuild after the unlock meets the lock once more, as when the wallet locks again straight after unlocking.
  const unlockThenRelock = () => {
    unlockWallet();
    lockWallet();
  };

  // An unlocked send reads its spending-limit policy from Dexie, which settles on real macrotasks the fake clock does
  // not drive: yield until the sheet is posted, without moving the clock.
  const untilSheetPosted = async () => {
    for (let i = 0; i < 50 && mockRequestConfirmation.mock.calls.length === 0; i++) {
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  };

  const read = (): Promise<unknown> =>
    dapp.requestAssets(ORIGIN, {
      type: MidenDAppMessageType.AssetsRequest,
      sourcePublicKey: 'miden-account-1'
    } as never);
  const send = (): Promise<unknown> =>
    dapp.requestSendTransaction(ORIGIN, {
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
  const reconnect = (): Promise<unknown> =>
    dapp.requestPermission(ORIGIN, {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name: 'Miden Test', url: ORIGIN },
      network: 'testnet'
    } as never);
  const sign = (): Promise<unknown> =>
    dapp.requestSign(ORIGIN, {
      type: MidenDAppMessageType.SignRequest,
      sourcePublicKey: 'miden-account-1',
      sourceAccountId: 'miden-account-1',
      payload: 'deadbeef',
      kind: 'word'
    } as never);

  it.each<[string, () => Promise<unknown>]>([
    ['an UponRequest read', read],
    ['a send', send],
    ['a reconnect', reconnect]
  ])(
    'refuses %s that meets the lock after each unlock by 240 s from its first wait, and the queue moves on',
    async (_name, start) => {
      const queue = new PQueue({ concurrency: 1 });
      const outcome = track(queue.add(start));
      const next = jest.fn(async () => 'next');
      void queue.add(next);

      await jest.advanceTimersByTimeAsync(100_000);
      unlockThenRelock();
      await jest.advanceTimersByTimeAsync(100_000);
      unlockThenRelock();
      await jest.advanceTimersByTimeAsync(40_000);

      expect(outcome).toEqual({ settled: true, message: WALLET_LOCKED_REFUSAL });
      expect(next).toHaveBeenCalledTimes(1);
      expect(mockRequestConfirmation).not.toHaveBeenCalled();
    }
  );

  it.each<[string, () => Promise<unknown>]>([
    ['an UponRequest read', read],
    ['a send', send]
  ])('auto-declines the sheet of %s that waited 200 s for the unlock at 240 s', async (_name, start) => {
    mockRequestConfirmation.mockImplementation(() => new Promise(() => {}));
    const outcome = track(start());

    await jest.advanceTimersByTimeAsync(100_000);
    unlockThenRelock();
    await jest.advanceTimersByTimeAsync(100_000);
    unlockWallet();
    await untilSheetPosted();

    await jest.advanceTimersByTimeAsync(40_000);
    expect(outcome).toEqual({ settled: true, message: MidenDAppErrorType.NotGranted });
  });

  it.each<[string, () => Promise<unknown>]>([
    ['an UponRequest read', read],
    ['a send', send],
    ['a sign', sign]
  ])('keeps a 120 s sheet for %s that never waited', async (_name, start) => {
    unlockWallet();
    mockRequestConfirmation.mockImplementation(() => new Promise(() => {}));
    const outcome = track(start());

    await untilSheetPosted();
    await jest.advanceTimersByTimeAsync(119_999);
    expect(outcome.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual({ settled: true, message: MidenDAppErrorType.NotGranted });
  });
});

// ── Non-extension (mobile / desktop) prompts ───────────────────────
//
// `requestConfirm` — the extension popup path — throws when `isExtension()` is
// false, and each `generatePromisify*` runs as an un-awaited async function
// inside a promise executor. Before these handlers grew a non-extension branch,
// that throw became an unhandled rejection and the dApp's promise NEVER settled:
// no modal, no error, just the injection script's 5-minute "Request timeout".
// This whole file runs with `isExtension: () => false`.

describe('non-extension dApp requests settle instead of hanging', () => {
  /** Rejects if the call is still pending after the event loop drains. */
  const settlesWithin = <T>(promise: Promise<T>) =>
    Promise.race([
      promise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('request never settled')), 500))
    ]);

  const signReq = {
    type: MidenDAppMessageType.SignRequest,
    sourcePublicKey: 'miden-account-1',
    sourceAccountId: 'miden-account-1',
    payload: 'deadbeef',
    kind: 'word'
  } as never;

  it('signBytes prompts through the confirmation store and resolves with the signature', async () => {
    const res = await settlesWithin(dapp.requestSign('https://miden.xyz', signReq));

    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    expect(mockRequestConfirmation.mock.calls[0]![0]).toMatchObject({ type: 'sign', origin: 'https://miden.xyz' });
    expect(res).toEqual({ type: MidenDAppMessageType.SignResponse, signature: 'fake-sig-base64' });
  });

  it('signBytes rejects with NotGranted when the user denies', async () => {
    mockRequestConfirmation.mockResolvedValue({ confirmed: false });
    await expect(settlesWithin(dapp.requestSign('https://miden.xyz', signReq))).rejects.toThrow(
      MidenDAppErrorType.NotGranted
    );
  });

  it('importPrivateNote prompts and resolves with the imported note id', async () => {
    const res = await settlesWithin(
      dapp.requestImportPrivateNote('https://miden.xyz', {
        type: MidenDAppMessageType.ImportPrivateNoteRequest,
        sourcePublicKey: 'miden-account-1',
        note: 'AAECAw=='
      } as never)
    );

    expect(mockRequestConfirmation.mock.calls[0]![0]).toMatchObject({ type: 'importPrivateNote' });
    expect(mockImportNoteBytes).toHaveBeenCalled();
    expect(res).toEqual({
      type: MidenDAppMessageType.ImportPrivateNoteResponse,
      noteId: 'imported-note-id'
    });
  });

  it('requestPrivateNotes prompts on the UponRequest permission and resolves', async () => {
    mockGetInputNoteDetails.mockResolvedValue([]);
    const res = await dapp.requestPrivateNotes('https://miden.xyz', {
      type: MidenDAppMessageType.PrivateNotesRequest,
      sourcePublicKey: 'miden-account-1',
      notefilterType: 'All'
    } as never);

    expect(mockRequestConfirmation.mock.calls[0]![0]).toMatchObject({ type: 'privateData' });
    expect(res).toEqual({ type: MidenDAppMessageType.PrivateNotesResponse, privateNotes: [] });
  });

  it('requestConsumableNotes prompts on the UponRequest permission and resolves', async () => {
    mockGetConsumableNotes.mockResolvedValue([]);
    const res = await settlesWithin(
      dapp.requestConsumableNotes('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumableNotesRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    );

    expect(mockRequestConfirmation.mock.calls[0]![0]).toMatchObject({ type: 'privateData' });
    expect(res).toEqual({ type: MidenDAppMessageType.ConsumableNotesResponse, consumableNotes: [] });
  });

  it('requestAssets prompts on the UponRequest permission and resolves', async () => {
    mockGetAccount.mockResolvedValue({ vault: () => ({ fungibleAssets: () => [] }) });
    const res = await settlesWithin(
      dapp.requestAssets('https://miden.xyz', {
        type: MidenDAppMessageType.AssetsRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    );

    expect(mockRequestConfirmation.mock.calls[0]![0]).toMatchObject({ type: 'privateData' });
    expect(res).toEqual({ type: MidenDAppMessageType.AssetsResponse, assets: [] });
  });

  it('requestAssets rejects with NotGranted when the user denies the disclosure', async () => {
    mockGetAccount.mockResolvedValue({ vault: () => ({ fungibleAssets: () => [] }) });
    mockRequestConfirmation.mockResolvedValue({ confirmed: false });
    await expect(
      settlesWithin(
        dapp.requestAssets('https://miden.xyz', {
          type: MidenDAppMessageType.AssetsRequest,
          sourcePublicKey: 'miden-account-1'
        } as never)
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  // The store keys pending prompts by session id and the mobile renderer only
  // mounts the FOREGROUND session's slot (`useDappConfirmation(foregroundId)`),
  // so a handler that drops the id parks its prompt in the '__default__' slot no
  // mobile renderer reads: no sheet appears, the promise never settles, and the
  // concurrency-1 queue `processDApp` runs every origin through wedges until the
  // app is restarted.
  it.each([
    [
      'requestSign',
      () =>
        dapp.requestSign(
          'https://miden.xyz',
          {
            type: MidenDAppMessageType.SignRequest,
            sourcePublicKey: 'miden-account-1',
            sourceAccountId: 'miden-account-1',
            payload: 'deadbeef',
            kind: 'word'
          } as never,
          'session-9'
        )
    ],
    [
      'requestImportPrivateNote',
      () =>
        dapp.requestImportPrivateNote(
          'https://miden.xyz',
          {
            type: MidenDAppMessageType.ImportPrivateNoteRequest,
            sourcePublicKey: 'miden-account-1',
            note: 'AAECAw=='
          } as never,
          'session-9'
        )
    ],
    [
      'requestPrivateNotes',
      () =>
        dapp.requestPrivateNotes(
          'https://miden.xyz',
          {
            type: MidenDAppMessageType.PrivateNotesRequest,
            sourcePublicKey: 'miden-account-1',
            notefilterType: 'All'
          } as never,
          'session-9'
        )
    ],
    [
      'requestConsumableNotes',
      () =>
        dapp.requestConsumableNotes(
          'https://miden.xyz',
          {
            type: MidenDAppMessageType.ConsumableNotesRequest,
            sourcePublicKey: 'miden-account-1'
          } as never,
          'session-9'
        )
    ],
    [
      'requestAssets',
      () =>
        dapp.requestAssets(
          'https://miden.xyz',
          {
            type: MidenDAppMessageType.AssetsRequest,
            sourcePublicKey: 'miden-account-1'
          } as never,
          'session-9'
        )
    ]
  ] as Array<[string, () => Promise<unknown>]>)(
    '%s routes its prompt to the requesting session, not the default slot',
    async (_name, call) => {
      mockGetAccount.mockResolvedValue({ vault: () => ({ fungibleAssets: () => [] }) });
      mockGetInputNoteDetails.mockResolvedValue([]);
      mockGetConsumableNotes.mockResolvedValue([]);

      await settlesWithin(call());

      expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
      expect(mockRequestConfirmation.mock.calls[0]![0]).toMatchObject({ sessionId: 'session-9' });
    }
  );

  it('auto-declines a prompt no renderer ever resolves instead of hanging forever', async () => {
    // Backstop for the shared concurrency-1 queue: `requestConfirm`'s popup path
    // has AUTODECLINE_AFTER, `confirmOnNonExtension` had nothing, so a prompt that
    // never reached a renderer blocked every origin's dApp requests permanently.
    jest.useFakeTimers();
    try {
      mockRequestConfirmation.mockImplementation(() => new Promise(() => {}));

      // Settle the promise into a plain value so the assertion can be awaited
      // AFTER the timers are advanced (a floating rejects-assertion would be a
      // lint error, and awaiting it before advancing would deadlock).
      const outcome = dapp
        .requestSign('https://miden.xyz', {
          type: MidenDAppMessageType.SignRequest,
          sourcePublicKey: 'miden-account-1',
          sourceAccountId: 'miden-account-1',
          payload: 'deadbeef',
          kind: 'word'
        } as never)
        .then(
          () => 'resolved',
          (err: Error) => err.message
        );

      // Drain the microtasks the handler awaits before it reaches the race.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      jest.advanceTimersByTime(120_000);

      await expect(outcome).resolves.toContain(MidenDAppErrorType.NotGranted);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── requestPrivateNotes ────────────────────────────────────────────

describe('requestPrivateNotes', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(
      dapp.requestPrivateNotes('https://miden.xyz', {
        type: MidenDAppMessageType.PrivateNotesRequest,
        noteIds: ['n1']
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when the origin has no session', async () => {
    delete storageState[STORAGE_KEY];
    await expect(
      dapp.requestPrivateNotes('https://miden.xyz', {
        type: MidenDAppMessageType.PrivateNotesRequest,
        sourcePublicKey: 'miden-account-1',
        noteIds: ['n1']
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestConsumableNotes ─────────────────────────────────────────

describe('requestConsumableNotes', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(
      dapp.requestConsumableNotes('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumableNotesRequest
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when the origin has no session', async () => {
    delete storageState[STORAGE_KEY];
    await expect(
      dapp.requestConsumableNotes('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumableNotesRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestAssets ──────────────────────────────────────────────────

describe('requestAssets', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(
      dapp.requestAssets('https://miden.xyz', {
        type: MidenDAppMessageType.AssetsRequest
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when the origin has no session', async () => {
    delete storageState[STORAGE_KEY];
    await expect(
      dapp.requestAssets('https://miden.xyz', {
        type: MidenDAppMessageType.AssetsRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestImportPrivateNote ───────────────────────────────────────

describe('requestImportPrivateNote', () => {
  it('queues an approved import with a cause-wrapped poison and rejects with the inner kill', async () => {
    const kill = new WasmClientPoisonedError('watchdog', new Error('note import parked'));
    mockImportNoteBytes.mockRejectedValueOnce(new Error('INVALID_PARAMS: import wrapper', { cause: kill }));
    mockQueueNoteImport.mockResolvedValueOnce(undefined);

    await expect(
      dapp.requestImportPrivateNote('https://miden.xyz', {
        type: MidenDAppMessageType.ImportPrivateNoteRequest,
        sourcePublicKey: 'miden-account-1',
        note: 'aGVsbG8='
      })
    ).rejects.toBe(kill);
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    expect(mockQueueNoteImport).toHaveBeenCalledWith('aGVsbG8=');
  });

  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(
      dapp.requestImportPrivateNote('https://miden.xyz', {
        type: MidenDAppMessageType.ImportPrivateNoteRequest,
        note: 'aGVsbG8='
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws InvalidParams when note is missing', async () => {
    await expect(
      dapp.requestImportPrivateNote('https://miden.xyz', {
        type: MidenDAppMessageType.ImportPrivateNoteRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when the origin has no session', async () => {
    delete storageState[STORAGE_KEY];
    await expect(
      dapp.requestImportPrivateNote('https://miden.xyz', {
        type: MidenDAppMessageType.ImportPrivateNoteRequest,
        sourcePublicKey: 'miden-account-1',
        note: 'aGVsbG8='
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestTransaction ─────────────────────────────────────────────

describe('requestTransaction', () => {
  it('throws InvalidParams when sourcePublicKey or transaction is missing', async () => {
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when the origin has no session', async () => {
    delete storageState[STORAGE_KEY];
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: { payload: { address: 'a', recipientAddress: 'b', transactionRequest: 'Yw==' } }
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('throws NotFound when sourcePublicKey does not match the stored session', async () => {
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'different-account',
        transaction: { payload: { address: 'a', recipientAddress: 'b', transactionRequest: 'Yw==' } }
      } as never)
    ).rejects.toThrow();
  });

  it('resolves with TransactionResponse on mobile when the user confirms', async () => {
    mockRequestCustomTransaction.mockResolvedValue('tx-custom-1');
    const res = await dapp.requestTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        payload: {
          address: 'miden-account-1',
          recipientAddress: 'bob',
          transactionRequest: 'YmFzZTY0cmVx'
        }
      }
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.TransactionResponse);
    expect((res as any).transactionId).toBe('tx-custom-1');
    expect(mockStartTransactionProcessing).toHaveBeenCalled();
  });

  it('rejects with NotGranted on mobile when the user declines', async () => {
    mockRequestConfirmation.mockResolvedValueOnce({ confirmed: false });
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: {
          payload: {
            address: 'miden-account-1',
            recipientAddress: 'bob',
            transactionRequest: 'YmFzZTY0cmVx'
          }
        }
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('rejects with InvalidParams when the CustomTransaction payload is malformed', async () => {
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        // Missing `address` triggers the preview-build error branch
        transaction: { payload: { recipientAddress: 'bob', transactionRequest: 'req' } }
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('routes a Consume-typed transaction to the consume flow instead of failing as a custom payload (issue #88)', async () => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6, symbol: 'TOK' });
    mockInitiateConsumeTransactionFromId.mockResolvedValue('tx-consume-1');
    const res = await dapp.requestTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        type: 'consume',
        payload: {
          accountAddress: 'miden-account-1',
          noteId: 'note-1',
          faucetId: 'faucet-1',
          noteType: 'Private',
          amount: '50'
        }
      }
    } as never);
    // Response is normalized to a TransactionResponse, and the dedicated
    // consume execution path runs (not the CustomTransaction validation).
    expect(res.type).toBe(MidenDAppMessageType.TransactionResponse);
    expect((res as any).transactionId).toBe('tx-consume-1');
    expect(mockInitiateConsumeTransactionFromId).toHaveBeenCalled();
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
  });

  it('routes a Send-typed transaction to the send flow', async () => {
    mockInitiateSendTransaction.mockResolvedValue('tx-send-1');
    const res = await dapp.requestTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        type: 'send',
        payload: {
          senderAddress: 'miden-account-1',
          recipientAddress: 'bob',
          faucetId: 'faucet-1',
          noteType: 'Private',
          amount: '100',
          recallBlocks: 50
        }
      }
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.TransactionResponse);
    expect((res as any).transactionId).toBe('tx-send-1');
    expect(mockInitiateSendTransaction).toHaveBeenCalled();
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
  });

  // The session authorizes ONE account, but the account to debit comes from the
  // request. This entrypoint reaches the same send flow as `requestSendTransaction`
  // while validating only `sourcePublicKey` — which the attacking page satisfies
  // with its own connected account — so a sender check on the outer function is
  // not on this path at all. The approval sheet does not show the sender, so
  // nothing on screen would have given it away either.
  it('refuses a Send-typed transaction that names an account the session never authorized', async () => {
    mockInitiateSendTransaction.mockResolvedValue('tx-send-evil');
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: {
          type: 'send',
          payload: {
            senderAddress: 'miden-account-2',
            recipientAddress: 'attacker',
            faucetId: 'faucet-1',
            noteType: 'Private',
            amount: '100'
          }
        }
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
    // Rejected before anything is queued — not merely reported after the fact.
    expect(mockInitiateSendTransaction).not.toHaveBeenCalled();
  });

  it('rejects a Send-typed transaction with no sender at all as InvalidParams', async () => {
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: {
          type: 'send',
          payload: { recipientAddress: 'bob', faucetId: 'faucet-1', noteType: 'Private', amount: '100' }
        }
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  /**
   * Same hole, one branch over, and the widest one: the custom payload is an
   * opaque base64 `TransactionRequest`, so it can do anything the named account
   * can. `requestCustomTransaction` stores `payload.address` verbatim as the
   * row's `accountId` and the loop signs for whatever it finds there. The sheet
   * renders the request blob's own description and never names the account being
   * debited, so approval is not consent to this.
   */
  it('refuses a custom transaction against an account the session never authorized', async () => {
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: {
          type: 'custom',
          payload: { address: 'miden-account-2', transactionRequest: 'req', recipientAddress: 'attacker' }
        }
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
  });

  it('refuses a bare/legacy custom payload naming a foreign account too', async () => {
    // No `type`, which is the path a legacy caller takes into the same flow.
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: { payload: { address: 'miden-account-2', transactionRequest: 'req' } }
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
  });

  it('rejects a custom payload with no address as InvalidParams, not a TypeError', async () => {
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: { payload: { transactionRequest: 'req' } }
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });
});

// ── requestSendTransaction ─────────────────────────────────────────

describe.each(['send', 'custom'])('a non-extension %s preview kill (#1378)', kind => {
  it.each([false, true])('preserves the inner kill with a cause wrapper: %s', async wrapped => {
    const kill = new WasmClientPoisonedError('watchdog', new Error('preview parked'));
    const error = wrapped ? new Error('INVALID_PARAMS: preview wrapper', { cause: kill }) : kill;
    mockWithUnlocked.mockRejectedValueOnce(error);

    const answer =
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
            transaction: { payload: { address: 'miden-account-1', transactionRequest: 'YmFzZTY0cmVx' } }
          } as never);

    await expect(answer).rejects.toBe(kill);
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    expect(mockInitiateSendTransaction).not.toHaveBeenCalled();
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
  });
});

describe.each(['send', 'custom'])('an approved non-extension %s failure (#1378)', kind => {
  const queuedMessage = 'OUTCOME_UNKNOWN: transaction tx-1 may already be queued; wait for it before sending again';
  const killMessage =
    'OUTCOME_UNKNOWN: the wallet could not confirm whether the transaction was queued; check before sending again';
  const poison = new WasmClientPoisonedError('watchdog', new Error('write parked'));
  const queued = new TransactionQueuedError('tx-1', { cause: poison });

  it.each<[string, Error, string, number]>([
    ['a queued transaction', queued, queuedMessage, 1],
    ['a cause-wrapped queued transaction', new Error('NOT_GRANTED', { cause: queued }), queuedMessage, 1],
    ['a kill carrying a queued transaction', new WasmClientPoisonedError('watchdog', queued), queuedMessage, 1],
    ['a watchdog eviction', poison, killMessage, 0],
    ['an offscreen abort', new OperationAbortedError('op-1378', 'deadline'), killMessage, 0],
    ['a terminated client', new Error('Client terminated'), killMessage, 0],
    ['a terminated web client', new Error('WebClient terminated'), killMessage, 0],
    ['a cause-wrapped poison', new Error('NOT_GRANTED', { cause: poison }), killMessage, 0],
    ['an authorization refusal', new Error(MidenDAppErrorType.NotGranted), 'NOT_GRANTED', 0]
  ])('reports %s with the exact outcome message', async (_label, error, message, queuedCustomStarts) => {
    const initiate = kind === 'send' ? mockInitiateSendTransaction : mockRequestCustomTransaction;
    initiate.mockRejectedValueOnce(error);
    if (kind === 'custom' && queuedCustomStarts > 0) mockStartTransactionProcessing.mockResolvedValueOnce(undefined);

    const answer =
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
              payload: { address: 'miden-account-1', recipientAddress: 'bob', transactionRequest: 'YmFzZTY0cmVx' }
            }
          } as never);

    await expect(answer).rejects.toEqual(new Error(message));
    await expect(answer.catch((error: Error) => error.cause)).resolves.toBe(
      message === queuedMessage ? queued : undefined
    );
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    expect(initiate).toHaveBeenCalledTimes(1);
    expect(mockStartTransactionProcessing).toHaveBeenCalledTimes(kind === 'custom' ? queuedCustomStarts : 0);
  });
});

describe('approved non-extension custom carried-note failures (#1378)', () => {
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
    mockRequestCustomTransaction.mockRejectedValueOnce(error);
    if (queuedRow) mockStartTransactionProcessing.mockResolvedValueOnce(undefined);
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: {
          payload: { address: 'miden-account-1', transactionRequest: 'YmFzZTY0cmVx', importNotes: CARRIED_NOTES }
        }
      } as never)
    ).rejects.toEqual(new Error(message));
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    expect(mockRequestCustomTransaction).toHaveBeenCalledTimes(1);
    check();
  };

  it.each<[string, Error]>([
    ['a queued row', queued],
    ['a cause-wrapped queued row', new Error('custom wrapper', { cause: queued })]
  ])('starts processing and releases the carried notes after %s', async (_label, error) => {
    await runCustomFailure(error, queuedMessage, true, () => {
      expect(mockStartTransactionProcessing).toHaveBeenCalledTimes(1);
      // The dry run derives the same ids with a second argument; the release derives them with the notes alone.
      expect(noteQuarantine.importedNoteIds).toHaveBeenCalledWith(CARRIED_NOTES);
      expect(noteQuarantine.releaseNoteIds).toHaveBeenCalledTimes(1);
      expect(noteQuarantine.releaseNoteIds).toHaveBeenCalledWith(CARRIED_NOTE_IDS);
    });
  });

  it('starts nothing and keeps the carried notes quarantined after a NOT_GRANTED refusal', async () => {
    await runCustomFailure(new Error(MidenDAppErrorType.NotGranted), 'NOT_GRANTED', false, () => {
      expect(mockStartTransactionProcessing).not.toHaveBeenCalled();
      expect(noteQuarantine.releaseNoteIds).not.toHaveBeenCalled();
    });
  });
});

describe('requestSendTransaction', () => {
  const validTx = {
    senderAddress: 'miden-account-1',
    recipientAddress: 'bob',
    faucetId: 'faucet-1',
    noteType: 'Private',
    amount: '100',
    recallBlocks: 50
  };

  it('throws InvalidParams when transaction is missing', async () => {
    await expect(
      dapp.requestSendTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.SendTransactionRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when the origin has no session', async () => {
    delete storageState[STORAGE_KEY];
    await expect(
      dapp.requestSendTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.SendTransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: validTx
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('resolves with SendTransactionResponse on mobile when user confirms', async () => {
    mockInitiateSendTransaction.mockResolvedValue('tx-send-1');
    const res = await dapp.requestSendTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.SendTransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: validTx
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.SendTransactionResponse);
    expect((res as any).transactionId).toBe('tx-send-1');
    expect(mockInitiateSendTransaction).toHaveBeenCalledWith(
      validTx.senderAddress,
      validTx.recipientAddress,
      validTx.faucetId,
      validTx.noteType,
      BigInt(validTx.amount),
      validTx.recallBlocks,
      true,
      undefined,
      'https://miden.xyz'
    );
  });

  it('rejects with NotGranted on mobile when the user declines', async () => {
    mockRequestConfirmation.mockResolvedValueOnce({ confirmed: false });
    await expect(
      dapp.requestSendTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.SendTransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: validTx
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('rejects with InvalidParams when initiateSendTransaction throws', async () => {
    mockInitiateSendTransaction.mockRejectedValueOnce(new Error('insufficient funds'));
    await expect(
      dapp.requestSendTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.SendTransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: validTx
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });
});

// ── requestConsumeTransaction ──────────────────────────────────────

describe('requestPrivateNotes account scoping', () => {
  // Regression: `getPrivateNoteDetails` read `client.notes.list(query)`, whose
  // NoteQuery has no account field, and every account in the wallet shares one
  // store — so a dApp connected to account A received the id, nullifier, sender,
  // state and per-asset amounts of EVERY private note in the wallet, including
  // accounts the user never connected. The approval sheet meanwhile promises
  // "Share all private note data for account <A>", and under the Auto permission
  // there is no sheet at all.
  const OTHER_ACCOUNT_NOTE = {
    noteId: 'note-of-account-2',
    noteType: 'Private',
    senderAccountId: 'someone',
    nullifier: 'nf-2',
    state: 1,
    assets: [{ faucetId: 'faucet-1', amount: '999' }]
  };
  const CONNECTED_ACCOUNT_NOTE = {
    noteId: 'note-of-account-1',
    noteType: 'Private',
    senderAccountId: 'someone',
    nullifier: 'nf-1',
    state: 1,
    assets: [{ faucetId: 'faucet-1', amount: '5' }]
  };

  beforeEach(() => {
    // The store holds both accounts' private notes …
    mockGetInputNoteDetails.mockImplementation(async () => [CONNECTED_ACCOUNT_NOTE, OTHER_ACCOUNT_NOTE]);
    // … but only one of them belongs to the connected account.
    mockGetConsumableNotes.mockImplementation(async () => [
      { noteId: 'note-of-account-1', noteType: 'Private', nullifier: 'nf-1', state: 1, assets: [] }
    ]);
  });

  it('returns only the connected account notes on the Auto permission', async () => {
    storageState[STORAGE_KEY] = {
      'https://miden.xyz': [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 65535 }]
    };

    const res = await dapp.requestPrivateNotes('https://miden.xyz', {
      type: MidenDAppMessageType.PrivateNotesRequest,
      sourcePublicKey: 'miden-account-1',
      notefilterType: 'All'
    } as never);

    expect(res).toEqual({
      type: MidenDAppMessageType.PrivateNotesResponse,
      privateNotes: [CONNECTED_ACCOUNT_NOTE]
    });
    // Scoped against the SESSION's account, never the request's own field.
    expect(mockGetConsumableNotes).toHaveBeenCalledWith('miden-account-1', expect.any(Function));
  });

  it('returns only the connected account notes on the prompted UponRequest permission', async () => {
    const res = await dapp.requestPrivateNotes('https://miden.xyz', {
      type: MidenDAppMessageType.PrivateNotesRequest,
      sourcePublicKey: 'miden-account-1',
      // A caller naming another account's note id explicitly is filtered too.
      noteIds: ['note-of-account-1', 'note-of-account-2'],
      notefilterType: 'List'
    } as never);

    expect(mockGetInputNoteDetails).toHaveBeenCalledWith({ ids: ['note-of-account-1', 'note-of-account-2'] });
    expect(res).toEqual({
      type: MidenDAppMessageType.PrivateNotesResponse,
      privateNotes: [CONNECTED_ACCOUNT_NOTE]
    });
  });

  it('keeps the wallet-side record of which account alone can consume a note out of the response', async () => {
    storageState[STORAGE_KEY] = {
      'https://miden.xyz': [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 65535 }]
    };
    mockGetInputNoteDetails.mockImplementation(async () => [
      { ...CONNECTED_ACCOUNT_NOTE, restriction: { prefix: '1', suffix: '2' } }
    ]);

    const res = await dapp.requestPrivateNotes('https://miden.xyz', {
      type: MidenDAppMessageType.PrivateNotesRequest,
      sourcePublicKey: 'miden-account-1',
      notefilterType: 'All'
    } as never);

    expect(res).toEqual({
      type: MidenDAppMessageType.PrivateNotesResponse,
      privateNotes: [CONNECTED_ACCOUNT_NOTE]
    });
  });
});

describe('requestConsumeTransaction', () => {
  const validTx = {
    accountAddress: 'miden-account-1',
    noteId: 'note-1',
    faucetId: 'faucet-1',
    noteType: 'Private',
    amount: '50'
  };

  // Regression: the approval sheet rendered the dApp's OWN `faucetId`/`amount`/
  // `noteType`, none of which can influence execution —
  // `initiateConsumeTransactionFromId` uses only `noteId` and blanks the declared
  // fields (transaction/initiate.ts). So a page could show "+500 USDC" over a note
  // that carries something else entirely, or nothing.
  it('previews the note the wallet resolved, not the dApp-declared faucet/amount/type', async () => {
    mockGetInputNoteDetails.mockImplementation(async () => [
      {
        noteId: 'note-1',
        noteType: 'Private',
        senderAccountId: 's1',
        nullifier: 'nf1',
        state: 1,
        // What the note REALLY holds: 7 units of another faucet.
        assets: [{ faucetId: 'real-faucet', amount: '7' }],
        nonFungibleAssets: []
      }
    ]);

    await dapp.requestConsumeTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        accountAddress: 'miden-account-1',
        noteId: 'note-1',
        // Declared — and false.
        faucetId: 'attacker-declared-faucet',
        noteType: 'Public',
        amount: '500000000'
      }
    } as never);

    const messages: string[] = mockRequestConfirmation.mock.calls[0]![0].transactionMessages;
    expect(messages.join(' | ')).toContain('real-faucet');
    expect(messages.join(' | ')).not.toContain('attacker-declared-faucet');
    // The resolved note's type wins over the declared 'Public'.
    expect(messages).toContain('Note Type, Private');
    // And the amount is the resolved 7, not the declared 500000000.
    expect(messages.some(m => m.startsWith('Amount, ') && m.includes('7'))).toBe(true);
    expect(messages.some(m => m.includes('500'))).toBe(false);
  });

  // These rows ARE the approval prompt off-extension -- there is no other surface --
  // and a consume preview is built before the transaction exists, so no real fee can be
  // read from it. The bound is the only honest figure available before the tap.
  const consumeMessages = async (): Promise<string[]> => {
    mockGetInputNoteDetails.mockImplementation(async () => [
      {
        noteId: 'note-1',
        noteType: 'Private',
        senderAccountId: 's1',
        nullifier: 'nf1',
        state: 1,
        assets: [{ faucetId: 'real-faucet', amount: '7' }],
        nonFungibleAssets: []
      }
    ]);
    await dapp.requestConsumeTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: { accountAddress: 'miden-account-1', noteId: 'note-1', noteType: 'Private' }
    } as never);
    return mockRequestConfirmation.mock.calls[0]![0].transactionMessages;
  };

  it('states the maximum network fee the consume can cost', async () => {
    // Breaks if the `Network fee (max)` row is dropped from the consume preview.
    mockBaseFee = 2000000;
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6, symbol: 'MIDEN' });

    const feeRow = (await consumeMessages()).find(m => m.startsWith('Network fee (max), '));
    // 2000000 x FEE_RESERVE_MULTIPLE(30). This suite stubs `formatBigInt` to raw units,
    // so the bound shows unscaled; the decimal formatting is that helper's own job. The
    // minus prefix matches the existing `Network fee` row, which formats fees the same way.
    expect(feeRow).toBe('Network fee (max), -60000000 MIDEN');
    mockBaseFee = null;
  });

  it('omits the fee row while the base fee is undiscovered', async () => {
    // House convention: no row beats a zero or a guess. Breaks if the null guard goes.
    mockBaseFee = null;
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6, symbol: 'MIDEN' });

    expect((await consumeMessages()).some(m => m.startsWith('Network fee (max)'))).toBe(false);
  });

  it('refuses noteBytes that describe a different note than the noteId being consumed', async () => {
    // Execution consumes `noteId`; `noteBytes` is only what gets imported. A page
    // could therefore carry the bytes of a harmless note while naming another note
    // id, and the preview would describe the wrong one.
    const sdk = require('@miden-sdk/miden-sdk/lazy');
    const previousDeserialize = sdk.Note.deserialize;
    sdk.Note.deserialize = jest.fn(() => ({
      id: () => ({ toString: () => 'some-other-note' }),
      metadata: () => ({ noteType: () => 'Private' }),
      assets: () => ({ fungibleAssets: () => [], nonFungibleAssets: () => [] })
    }));

    try {
      await expect(
        dapp.requestConsumeTransaction('https://miden.xyz', {
          type: MidenDAppMessageType.ConsumeRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: {
            accountAddress: 'miden-account-1',
            noteId: 'note-1',
            noteBytes: 'bm90ZQ==',
            faucetId: 'faucet-1',
            noteType: 'Public',
            amount: '50'
          }
        } as never)
      ).rejects.toThrow(MidenDAppErrorType.InvalidParams);

      expect(mockRequestConfirmation).not.toHaveBeenCalled();
    } finally {
      sdk.Note.deserialize = previousDeserialize;
    }
  });

  it('refuses a consume whose note the wallet cannot resolve at all', async () => {
    mockGetInputNoteDetails.mockImplementation(async () => []);

    await expect(
      dapp.requestConsumeTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumeRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: {
          accountAddress: 'miden-account-1',
          noteId: 'ghost-note',
          faucetId: 'f',
          noteType: 'Public',
          amount: '1'
        }
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);

    // No prompt was raised with unverifiable numbers.
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('throws InvalidParams when transaction is missing', async () => {
    await expect(
      dapp.requestConsumeTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumeRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when the origin has no session', async () => {
    delete storageState[STORAGE_KEY];
    await expect(
      dapp.requestConsumeTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumeRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: validTx
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('resolves with ConsumeResponse on mobile when user confirms', async () => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6, symbol: 'TOK' });
    mockInitiateConsumeTransactionFromId.mockResolvedValue('tx-consume-1');
    const res = await dapp.requestConsumeTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: validTx
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.ConsumeResponse);
    expect((res as any).transactionId).toBe('tx-consume-1');
  });

  it('rejects with NotGranted on mobile when user declines', async () => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6 });
    mockRequestConfirmation.mockResolvedValueOnce({ confirmed: false });
    await expect(
      dapp.requestConsumeTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumeRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: validTx
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── Delegated proving on the non-extension writes ──────────────────
// The extension threads the user's Settings toggle through its confirm popup
// (`ConfirmPage` reads `isDelegateProofEnabled()` → `confirmReq.delegate`). The
// mobile/desktop branches used to pass a literal `true` at all three write call
// sites, so a user who turned Delegated proving OFF still had every dApp
// transaction shipped to the remote prover, with no UI indication.

describe("a non-extension write carries the resolver's delegate flag", () => {
  /** Approve, but with delegated proving turned OFF in Settings. */
  const approveWithLocalProving = () =>
    mockRequestConfirmation.mockResolvedValue({
      confirmed: true,
      accountPublicKey: 'miden-account-1',
      privateDataPermission: 'UponRequest',
      delegate: false
    });

  it('sends without delegating the proof', async () => {
    approveWithLocalProving();
    mockInitiateSendTransaction.mockResolvedValue('tx-send-1');

    await dapp.requestSendTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.SendTransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        senderAddress: 'miden-account-1',
        recipientAddress: 'bob',
        faucetId: 'faucet-1',
        noteType: 'Private',
        amount: '100',
        recallBlocks: 50
      }
    } as never);

    // 7th positional arg of initiateSendTransaction is `delegateTransaction`.
    expect(mockInitiateSendTransaction.mock.calls[0]![6]).toBe(false);
  });

  it('consumes without delegating the proof', async () => {
    approveWithLocalProving();
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6, symbol: 'TOK' });
    mockInitiateConsumeTransactionFromId.mockResolvedValue('tx-consume-1');

    await dapp.requestConsumeTransaction('https://miden.xyz', {
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

    // 3rd positional arg of initiateConsumeTransactionFromId is `delegateTransaction`.
    expect(mockInitiateConsumeTransactionFromId.mock.calls[0]![2]).toBe(false);
    // 4th is `manualRetry`: the user just approved THIS consume on the sheet, so
    // auto-consume's exponential backoff must not swallow it and answer the dApp
    // with a previous attempt's Failed row id.
    expect(mockInitiateConsumeTransactionFromId.mock.calls[0]![3]).toBe(true);
    // 5th is the requesting origin: it refuses a note another transaction holds and lets this origin wait on the row.
    expect(mockInitiateConsumeTransactionFromId.mock.calls[0]![4]).toBe('https://miden.xyz');
    // 6th is what queued the row, which a failed claim's report names.
    expect(mockInitiateConsumeTransactionFromId.mock.calls[0]![5]).toBe('dapp');
  });

  it('executes a custom transaction without delegating the proof', async () => {
    approveWithLocalProving();
    mockRequestCustomTransaction.mockResolvedValue('tx-custom-1');

    await dapp.requestTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        payload: {
          address: 'miden-account-1',
          recipientAddress: 'bob',
          transactionRequest: 'YmFzZTY0cmVx'
        }
      }
    } as never);

    // 5th positional arg of requestCustomTransaction is `delegateTransaction`.
    expect(mockRequestCustomTransaction.mock.calls[0]![4]).toBe(false);
    // 9th is the requesting origin, the only one that may wait on the row.
    expect(mockRequestCustomTransaction.mock.calls[0]![8]).toBe('https://miden.xyz');
  });

  it('falls back to the DEFAULT_DELEGATE_PROOF setting when a resolver supplies no flag', async () => {
    // The desktop overlay predates the field; an older renderer resolving without
    // `delegate` must keep today's behaviour rather than silently proving locally.
    mockRequestConfirmation.mockResolvedValue({
      confirmed: true,
      accountPublicKey: 'miden-account-1',
      privateDataPermission: 'UponRequest'
    });
    mockInitiateSendTransaction.mockResolvedValue('tx-send-2');

    await dapp.requestSendTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.SendTransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        senderAddress: 'miden-account-1',
        recipientAddress: 'bob',
        faucetId: 'faucet-1',
        noteType: 'Private',
        amount: '100',
        recallBlocks: 50
      }
    } as never);

    expect(mockInitiateSendTransaction.mock.calls[0]![6]).toBe(DEFAULT_DELEGATE_PROOF);
  });
});

// ── Auto permission paths for data fetchers ────────────────────────
// These avoid `requestConfirm` (which throws in non-extension) by using
// the Auto-permission early-return branch.

describe('requestAssets — Auto permission', () => {
  beforeEach(() => {
    _g.__dappTestMockGetAccount.mockResolvedValue({
      vault: () => ({
        fungibleAssets: () => [
          {
            faucetId: () => 'faucet-x',
            amount: () => ({ toString: () => '42' })
          }
        ]
      })
    });
  });

  it('returns AssetsResponse without prompting when session has AUTO + Assets bit', async () => {
    // The actual enum string values from the wallet adapter package
    (storageState[STORAGE_KEY] as any)['https://miden.xyz'] = [
      {
        ...SESSION,
        privateDataPermission: 'AUTO',
        allowedPrivateData: 1
      }
    ];
    const res = await dapp.requestAssets('https://miden.xyz', {
      type: MidenDAppMessageType.AssetsRequest,
      sourcePublicKey: 'miden-account-1'
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.AssetsResponse);
    expect((res as any).assets).toBeDefined();
  });
});

describe('requestConsumableNotes — Auto permission', () => {
  it('returns ConsumableNotesResponse via the auto branch', async () => {
    (storageState[STORAGE_KEY] as any)['https://miden.xyz'] = [
      { ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 2 }
    ];
    // Mock getMidenClient to also expose getConsumableNotes
    (require('lib/miden/sdk/helpers').getBech32AddressFromAccountId as any) = jest.fn(() => 'bech32-stub');
    // Override the relative-path mock to add getConsumableNotes
    const sdk = require('../sdk/miden-client');
    const originalGet = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      getAccount: _g.__dappTestMockGetAccount,
      getOutputNotes: _g.__dappTestMockGetOutputNotes,
      syncState: jest.fn(async () => {}),
      // Slice-4: dapp reads consumable notes as DTOs via getConsumableNoteDtos.
      getConsumableNoteDtos: jest.fn(async () => [])
    });
    try {
      const res = await dapp.requestConsumableNotes('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumableNotesRequest,
        sourcePublicKey: 'miden-account-1'
      } as never);
      expect(res.type).toBe(MidenDAppMessageType.ConsumableNotesResponse);
    } finally {
      sdk.getMidenClient = originalGet;
    }
  });
});

// ── requestPermission mobile happy path ────────────────────────────

describe('Asset/Notes data fetching error branches', () => {
  it('rejects with InvalidParams when getMidenClient throws inside getAssets (Auto branch)', async () => {
    (storageState[STORAGE_KEY] as any)['https://miden.xyz'] = [
      { ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 1 }
    ];
    _g.__dappTestMockGetAccount.mockRejectedValueOnce(new Error('wasm down'));
    await expect(
      dapp.requestAssets('https://miden.xyz', {
        type: MidenDAppMessageType.AssetsRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow();
  });
});

// An approval whose key read fails is asked again with the read's error (#1471); the user denies that sheet.
const approveThenDeny = () => {
  const answers = [{ confirmed: true, accountPublicKey: 'miden-account-1', privateDataPermission: 'UPON_REQUEST' }];
  mockRequestConfirmation.mockImplementation(async () => answers.shift() ?? { confirmed: false });
};
const expectAskedAgainWith = (previousAttemptError: string) => {
  expect(mockRequestConfirmation).toHaveBeenCalledTimes(2);
  expect(mockRequestConfirmation).toHaveBeenLastCalledWith(expect.objectContaining({ previousAttemptError }));
};

describe('requestPermission (mobile)', () => {
  it('stores a new session when user grants permission and wallet returns an account', async () => {
    mockGetAccount.mockResolvedValue({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }]
    });
    // No existing session for this origin
    delete (storageState[STORAGE_KEY] as any)['https://newdapp.xyz'];
    const res = await dapp.requestPermission('https://newdapp.xyz', {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name: 'New Dapp', url: 'https://newdapp.xyz' },
      network: 'testnet',
      privateDataPermission: 'UponRequest',
      allowedPrivateData: {},
      force: false
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
    expect((res as any).accountId).toBe('miden-account-1');
  });

  it('rejects with NotGranted when the user declines', async () => {
    mockRequestConfirmation.mockResolvedValueOnce({ confirmed: false });
    delete (storageState[STORAGE_KEY] as any)['https://newdapp.xyz'];
    await expect(
      dapp.requestPermission('https://newdapp.xyz', {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'New Dapp', url: 'https://newdapp.xyz' },
        network: 'testnet',
        privateDataPermission: 'UponRequest',
        allowedPrivateData: {},
        force: false
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('falls back to UponRequest when result.privateDataPermission is undefined', async () => {
    _g.__dappTestMockGetAccount.mockResolvedValue({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }]
    });
    mockRequestConfirmation.mockResolvedValueOnce({
      confirmed: true,
      accountPublicKey: 'miden-account-1'
      // privateDataPermission omitted → falls through to default
    });
    delete (storageState[STORAGE_KEY] as any)['https://newdapp3.xyz'];
    const res = await dapp.requestPermission('https://newdapp3.xyz', {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name: 'NewDapp3' },
      network: 'testnet',
      // allowedPrivateData omitted → falls back to AllowedPrivateData.None
      force: false
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
  });

  it('answers NotGranted only on the Deny of the sheet asked again when getMidenClient throws while fetching the public key', async () => {
    _g.__dappTestMockGetAccount.mockRejectedValueOnce(new Error('wasm down'));
    approveThenDeny();
    delete (storageState[STORAGE_KEY] as any)['https://newdapp4.xyz'];
    await expect(
      dapp.requestPermission('https://newdapp4.xyz', {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'NewDapp4' },
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0,
        force: false
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
    expectAskedAgainWith('wasm down');
  });

  it('answers NotGranted only on the Deny of the sheet asked again when the wallet returns no public key commitments', async () => {
    // Neither the standard interface nor the guardian signer map yields a
    // commitment, so the resolver comes up empty.
    _g.__dappTestMockGetAccount.mockResolvedValueOnce({
      getPublicKeyCommitments: () => [],
      storage: () => ({ getMapItem: () => undefined })
    });
    approveThenDeny();
    delete (storageState[STORAGE_KEY] as any)['https://newdapp5.xyz'];
    await expect(
      dapp.requestPermission('https://newdapp5.xyz', {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'NewDapp5' },
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0,
        force: false
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
    expectAskedAgainWith('Account has no public key commitments');
  });

  it('asks a forced connect with a saved session as a new permission and saves the approved scope', async () => {
    _g.__dappTestMockGetAccount.mockResolvedValue({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }]
    });
    // The session already exists for 'https://miden.xyz' under 'miden-account-1', with UponRequest and no data.
    mockRequestConfirmation.mockResolvedValue({
      confirmed: true,
      accountPublicKey: 'miden-account-1',
      privateDataPermission: 'AUTO'
    });
    const res = await dapp.requestPermission('https://miden.xyz', {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
      network: 'testnet',
      privateDataPermission: 'AUTO',
      allowedPrivateData: 2,
      force: true
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
    expect(mockRequestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'connect', existingPermission: false, privateDataPermission: 'AUTO' })
    );
    expect((storageState[STORAGE_KEY] as any)['https://miden.xyz']).toEqual([
      expect.objectContaining({ accountId: 'miden-account-1', privateDataPermission: 'AUTO', allowedPrivateData: 2 })
    ]);
  });

  it('answers NotGranted only on the Deny of the sheet asked again when getMidenClient returns null account', async () => {
    _g.__dappTestMockGetAccount.mockResolvedValueOnce(null);
    approveThenDeny();
    delete (storageState[STORAGE_KEY] as any)['https://newdapp6.xyz'];
    await expect(
      dapp.requestPermission('https://newdapp6.xyz', {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'NewDapp6' },
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0,
        force: false
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
    expectAskedAgainWith('Account not found');
  });
});

// ── Connect hands the dApp THIS DEVICE's hot key (multi-device) ────

describe('requestPermission (mobile) picks the signer by membership, never by slot', () => {
  // An added device follows the earlier devices in the signer set, so slot 0 is another device's key.
  const OTHER_DEVICE_BYTES = new Uint8Array(32).fill(0xcd);
  const OWN_DEVICE_BYTES = new Uint8Array(32).fill(0xab);
  const OWN_HOT_PUBLIC_KEY = `02${'11'.repeat(32)}`;
  const signer = (bytes: Uint8Array) => ({
    serialize: () => bytes,
    toHex: () => `0x${Buffer.from(bytes).toString('hex')}`
  });
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  const mockFetchAccounts = jest.fn<Promise<Array<{ publicKey: string; hotPublicKey?: string }>>, []>();

  const connect = (origin: string) =>
    dapp.requestPermission(origin, {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name: 'Multi Device Dapp' },
      network: WalletAdapterNetwork.Testnet
    });

  beforeEach(() => {
    mockCommitmentFromPublicKeyHex.mockReset().mockResolvedValue(`0x${Buffer.from(OWN_DEVICE_BYTES).toString('hex')}`);
    mockFetchAccounts
      .mockReset()
      .mockResolvedValue([{ publicKey: 'miden-account-1', hotPublicKey: OWN_HOT_PUBLIC_KEY }]);
    mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) =>
      fn({ vault: { fetchAccounts: mockFetchAccounts } })
    );
    mockGetAccount.mockResolvedValue({
      getPublicKeyCommitments: () => [signer(OTHER_DEVICE_BYTES), signer(OWN_DEVICE_BYTES)]
    });
  });

  it("returns this device's hot key when another device holds slot 0", async () => {
    const res = await connect('https://multi-device-1.xyz');

    expect(res.publicKey).toBe(b64(OWN_DEVICE_BYTES));
    expect(mockCommitmentFromPublicKeyHex).toHaveBeenCalledWith(OWN_HOT_PUBLIC_KEY);
    expect((storageState[STORAGE_KEY] as Record<string, unknown>)['https://multi-device-1.xyz']).toEqual([
      expect.objectContaining({ accountId: 'miden-account-1', publicKey: b64(OWN_DEVICE_BYTES) })
    ]);
  });

  it('keeps the signer order when the wallet record has no hot key', async () => {
    mockFetchAccounts.mockResolvedValue([{ publicKey: 'miden-account-1' }]);

    const res = await connect('https://multi-device-2.xyz');

    expect(res.publicKey).toBe(b64(OTHER_DEVICE_BYTES));
    expect(mockCommitmentFromPublicKeyHex).not.toHaveBeenCalled();
  });

  it('does not use the hot key of another wallet account', async () => {
    mockFetchAccounts.mockResolvedValue([{ publicKey: 'miden-account-2', hotPublicKey: OWN_HOT_PUBLIC_KEY }]);

    const res = await connect('https://multi-device-3.xyz');

    expect(res.publicKey).toBe(b64(OTHER_DEVICE_BYTES));
    expect(mockCommitmentFromPublicKeyHex).not.toHaveBeenCalled();
  });

  it('falls back to the signer order when the commitment cannot be derived', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockCommitmentFromPublicKeyHex.mockRejectedValue(new Error('unexpected public key length 3 (expected 33)'));
    try {
      const res = await connect('https://multi-device-4.xyz');

      expect(res.publicKey).toBe(b64(OTHER_DEVICE_BYTES));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not derive this device hot-key commitment'),
        expect.any(Error)
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the signer order when the wallet accounts cannot be read', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetchAccounts.mockRejectedValue(new Error('vault read failed'));
    try {
      const res = await connect('https://multi-device-5.xyz');

      expect(res.publicKey).toBe(b64(OTHER_DEVICE_BYTES));
      expect(mockGetAccount).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reads the hot key before it takes the WASM lock, outside the hold', async () => {
    let readInsideHold = false;
    mockFetchAccounts.mockImplementation(async () => {
      readInsideHold = currentWasmHold !== null;
      return [{ publicKey: 'miden-account-1', hotPublicKey: OWN_HOT_PUBLIC_KEY }];
    });

    await connect('https://multi-device-6.xyz');

    expect(mockFetchAccounts).toHaveBeenCalledTimes(1);
    expect(readInsideHold).toBe(false);
  });
});

// ── Watchdog eviction mid-flow (#788 follow-up) ────────────────────

describe('a watchdog eviction mid-read abandons the dApp flow instead of double-borrowing', () => {
  it.each(['assets', 'consumable notes', 'private notes'])('%s returns a cause-wrapped kill link', async kind => {
    storageState[STORAGE_KEY] = {
      'https://miden.xyz': [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 65535 }]
    };
    const kill = new WasmClientPoisonedError('watchdog', new Error('read parked'));
    const read =
      kind === 'assets'
        ? mockGetAccount
        : kind === 'consumable notes'
          ? mockGetConsumableNotes
          : mockGetInputNoteDetails;
    read.mockRejectedValueOnce(new Error('NOT_FOUND: read wrapper', { cause: kill }));

    const answer =
      kind === 'assets'
        ? dapp.requestAssets('https://miden.xyz', {
            type: MidenDAppMessageType.AssetsRequest,
            sourcePublicKey: 'miden-account-1'
          })
        : kind === 'consumable notes'
          ? dapp.requestConsumableNotes('https://miden.xyz', {
              type: MidenDAppMessageType.ConsumableNotesRequest,
              sourcePublicKey: 'miden-account-1'
            })
          : dapp.requestPrivateNotes('https://miden.xyz', {
              type: MidenDAppMessageType.PrivateNotesRequest,
              sourcePublicKey: 'miden-account-1',
              notefilterType: NoteFilterTypes.All
            });

    await expect(answer).rejects.toBe(kill);
    expect(read).toHaveBeenCalledTimes(1);
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  // Each test revokes hold ownership from INSIDE the parking client call — the
  // moment the real watchdog hands the mutex to a successor — and pins that the
  // next WASM step never runs (that call would be a second borrow of a client
  // somebody else is inside) and that the caller sees the retryable poison
  // error, not a false permissions/params verdict. A connect shows it to the user
  // on the sheet it asks again (#1471).

  it('requestPermission stops before reading the evicted account commitments', async () => {
    const getPublicKeyCommitments = jest.fn(() => [{ serialize: () => new Uint8Array([1, 2, 3]) }]);
    _g.__dappTestMockGetAccount.mockImplementationOnce(async () => {
      revokeWasmHold();
      return { getPublicKeyCommitments };
    });
    approveThenDeny();
    delete (storageState[STORAGE_KEY] as any)['https://evicted.xyz'];
    await expect(
      dapp.requestPermission('https://evicted.xyz', {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'Evicted Dapp' },
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0,
        force: false
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
    expectAskedAgainWith(new WasmClientPoisonedError('watchdog').message);
    // The commitments (and their serialize()) are borrows of the client the
    // successor now owns — the abandoned flow must never touch them…
    expect(getPublicKeyCommitments).not.toHaveBeenCalled();
    // …and no session may be persisted off the abandoned read.
    expect((storageState[STORAGE_KEY] as any)['https://evicted.xyz']).toBeUndefined();
  });

  it('requestPermission shows the terminated-client refusal on the sheet it asks again, not a false NotGranted', async () => {
    // A terminated client is a kill like the eviction above: retryable, never a permissions verdict.
    const terminated = new Error('WebClient terminated');
    mockGetAccount.mockRejectedValueOnce(terminated);
    approveThenDeny();
    await expect(
      dapp.requestPermission('https://terminated.xyz', {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'Terminated Dapp' },
        network: WalletAdapterNetwork.Testnet
      })
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
    expectAskedAgainWith('WebClient terminated');
  });

  it('requestAssets (Auto) stops before the vault borrow chain', async () => {
    (storageState[STORAGE_KEY] as any)['https://miden.xyz'] = [
      { ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 1 }
    ];
    const vault = jest.fn();
    _g.__dappTestMockGetAccount.mockImplementationOnce(async () => {
      revokeWasmHold();
      return { vault };
    });
    await expect(
      dapp.requestAssets('https://miden.xyz', {
        type: MidenDAppMessageType.AssetsRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(WasmClientPoisonedError);
    expect(vault).not.toHaveBeenCalled();
  });

  it('requestAssets (Auto) rejects with the terminated-client refusal, not InvalidParams', async () => {
    storageState[STORAGE_KEY] = {
      'https://miden.xyz': [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 1 }]
    };
    const terminated = new Error('WebClient terminated');
    mockGetAccount.mockRejectedValueOnce(terminated);
    await expect(
      dapp.requestAssets('https://miden.xyz', {
        type: MidenDAppMessageType.AssetsRequest,
        sourcePublicKey: 'miden-account-1'
      })
    ).rejects.toBe(terminated);
  });

  it('requestConsumableNotes (Auto) stops between the sync and the note read', async () => {
    (storageState[STORAGE_KEY] as any)['https://miden.xyz'] = [
      { ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 2 }
    ];
    // Sync is THE parking await on this path — network-bound, tens of seconds
    // on a slow node — so it is where a real eviction lands.
    _g.__dappTestMockSyncState.mockImplementationOnce(async () => {
      revokeWasmHold();
    });
    await expect(
      dapp.requestConsumableNotes('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumableNotesRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(WasmClientPoisonedError);
    expect(_g.__dappTestMockGetConsumableNotes).not.toHaveBeenCalled();
  });

  it('requestConsumableNotes (Auto) rejects with the terminated-client refusal, not InvalidParams', async () => {
    storageState[STORAGE_KEY] = {
      'https://miden.xyz': [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 2 }]
    };
    const terminated = new Error('WebClient terminated');
    mockGetConsumableNotes.mockRejectedValueOnce(terminated);
    await expect(
      dapp.requestConsumableNotes('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumableNotesRequest,
        sourcePublicKey: 'miden-account-1'
      })
    ).rejects.toBe(terminated);
  });

  it('requestPrivateNotes (Auto) stops between the note read and the consumability scope read', async () => {
    (storageState[STORAGE_KEY] as any)['https://miden.xyz'] = [
      { ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 65535 }
    ];
    _g.__dappTestMockGetInputNoteDetails.mockImplementationOnce(async () => {
      revokeWasmHold();
      return [];
    });
    await expect(
      dapp.requestPrivateNotes('https://miden.xyz', {
        type: MidenDAppMessageType.PrivateNotesRequest,
        sourcePublicKey: 'miden-account-1',
        notefilterType: 'All'
      } as never)
    ).rejects.toThrow(WasmClientPoisonedError);
    expect(_g.__dappTestMockGetConsumableNotes).not.toHaveBeenCalled();
  });

  it('requestPrivateNotes (Auto) rejects with the terminated-client refusal, not InvalidParams', async () => {
    storageState[STORAGE_KEY] = {
      'https://miden.xyz': [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 65535 }]
    };
    const terminated = new Error('WebClient terminated');
    mockGetInputNoteDetails.mockRejectedValueOnce(terminated);
    await expect(
      dapp.requestPrivateNotes('https://miden.xyz', {
        type: MidenDAppMessageType.PrivateNotesRequest,
        sourcePublicKey: 'miden-account-1',
        notefilterType: NoteFilterTypes.All
      })
    ).rejects.toBe(terminated);
  });

  it('requestConsumableNotes (Auto) forwards the reader check that parked into its own read label', async () => {
    (storageState[STORAGE_KEY] as any)['https://miden.xyz'] = [
      { ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 2 }
    ];
    let thrown: unknown;
    _g.__dappTestMockGetConsumableNotes.mockImplementationOnce(async (...called: unknown[]) => {
      const assertLive = called[1] as (step?: string) => void;
      revokeWasmHold();
      try {
        assertLive('after the reader build');
      } catch (e) {
        thrown = e;
        throw e;
      }
      return [];
    });
    await expect(
      dapp.requestConsumableNotes('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumableNotesRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(WasmClientPoisonedError);
    expect(((thrown as Error).cause as Error).message).toBe(
      'operation abandoned inside the consumable-notes read, after the reader build'
    );
  });

  it('requestPrivateNotes (Auto) forwards the reader check that parked into its own read label', async () => {
    (storageState[STORAGE_KEY] as any)['https://miden.xyz'] = [
      { ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 65535 }
    ];
    let thrown: unknown;
    _g.__dappTestMockGetConsumableNotes.mockImplementationOnce(async (...called: unknown[]) => {
      const assertLive = called[1] as (step?: string) => void;
      revokeWasmHold();
      try {
        assertLive('after the reader build');
      } catch (e) {
        thrown = e;
        throw e;
      }
      return [];
    });
    await expect(
      dapp.requestPrivateNotes('https://miden.xyz', {
        type: MidenDAppMessageType.PrivateNotesRequest,
        sourcePublicKey: 'miden-account-1',
        notefilterType: 'All'
      } as never)
    ).rejects.toThrow(WasmClientPoisonedError);
    expect(((thrown as Error).cause as Error).message).toBe(
      'operation abandoned inside the consumable-notes read, after the reader build'
    );
  });
});
