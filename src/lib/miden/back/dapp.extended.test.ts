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

import { MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { DEFAULT_DELEGATE_PROOF } from 'lib/settings/constants';

// ── Shared mocks ───────────────────────────────────────────────────

const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) => fn({ vault: {} }));

jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({ currentAccount: { publicKey: 'miden-account-1' }, status: 'Ready' })
  },
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn)
}));

const mockInitiateSendTransaction = jest.fn();
const mockRequestCustomTransaction = jest.fn();
const mockInitiateConsumeTransactionFromId = jest.fn();
const mockWaitForTransactionCompletion = jest.fn();

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

jest.mock('lib/platform', () => ({
  isExtension: () => false,
  isDesktop: () => false,
  isMobile: () => true
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

const mockGetTokenMetadata = jest.fn();
jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: (...args: unknown[]) => mockGetTokenMetadata(...args)
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
    getConsumableNoteDtos: (id: string) => (globalThis as any).__dappTestMockGetConsumableNotes(id),
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

// Mock the wallet adapter package so the enums are defined at import time.
// At runtime the package is an ESM .mjs build and may not destructure cleanly
// in jest's CJS-emulation mode.
jest.mock('@demox-labs/miden-wallet-adapter-base', () => ({
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
  }
}));

// ── Imports under test ─────────────────────────────────────────────

import * as dapp from './dapp';

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
  jest.clearAllMocks();
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
      assets: [{ faucetId: 'faucet-1', amount: '50' }]
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
  // `assertUnlocked` (back/store.ts) now throws once the vault is cleared; these
  // pin that every private-data reader actually goes THROUGH `withUnlocked`, so a
  // dApp holding `PrivateDataPermission.Auto` cannot keep polling notes and
  // balances out of a locked wallet. (The gate itself is tested in store.test.ts.)
  const LOCKED = 'Wallet is locked';

  beforeEach(() => {
    mockWithUnlocked.mockImplementation(async () => {
      throw Object.assign(new Error(LOCKED), { reason: 'locked' });
    });
    // Auto-disclosure: the branch that resolves with no prompt at all.
    storageState[STORAGE_KEY] = {
      'https://miden.xyz': [{ ...SESSION, privateDataPermission: 'AUTO', allowedPrivateData: 65535 }]
    };
  });

  it('requestAssets rejects and never reads the account', async () => {
    await expect(
      dapp.requestAssets('https://miden.xyz', {
        type: MidenDAppMessageType.AssetsRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(LOCKED);
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('requestPrivateNotes rejects and never reads the note store', async () => {
    await expect(
      dapp.requestPrivateNotes('https://miden.xyz', {
        type: MidenDAppMessageType.PrivateNotesRequest,
        sourcePublicKey: 'miden-account-1',
        notefilterType: 'All'
      } as never)
    ).rejects.toThrow(LOCKED);
    expect(mockGetInputNoteDetails).not.toHaveBeenCalled();
  });

  it('requestConsumableNotes rejects and never reads the note store', async () => {
    await expect(
      dapp.requestConsumableNotes('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumableNotesRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(LOCKED);
    expect(mockGetConsumableNotes).not.toHaveBeenCalled();
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
        transaction: { payload: { address: 'a', recipientAddress: 'b', transactionRequest: 'c' } }
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('throws NotFound when sourcePublicKey does not match the stored session', async () => {
    await expect(
      dapp.requestTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'different-account',
        transaction: { payload: { address: 'a', recipientAddress: 'b', transactionRequest: 'c' } }
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
          transactionRequest: 'base64req'
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
            transactionRequest: 'base64req'
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
      true
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
    expect(mockGetConsumableNotes).toHaveBeenCalledWith('miden-account-1');
  });

  it('returns only the connected account notes on the prompted UponRequest permission', async () => {
    const res = await dapp.requestPrivateNotes('https://miden.xyz', {
      type: MidenDAppMessageType.PrivateNotesRequest,
      sourcePublicKey: 'miden-account-1',
      // A caller naming another account's note id explicitly is filtered too.
      noteIds: ['note-of-account-1', 'note-of-account-2'],
      notefilterType: 'List'
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
        assets: [{ faucetId: 'real-faucet', amount: '7' }]
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

  it('refuses noteBytes that describe a different note than the noteId being consumed', async () => {
    // Execution consumes `noteId`; `noteBytes` is only what gets imported. A page
    // could therefore carry the bytes of a harmless note while naming another note
    // id, and the preview would describe the wrong one.
    const sdk = require('@miden-sdk/miden-sdk/lazy');
    const previousDeserialize = sdk.Note.deserialize;
    sdk.Note.deserialize = jest.fn(() => ({
      id: () => ({ toString: () => 'some-other-note' }),
      metadata: () => ({ noteType: () => 'Private' }),
      assets: () => ({ fungibleAssets: () => [] })
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
          transactionRequest: 'base64req'
        }
      }
    } as never);

    // 5th positional arg of requestCustomTransaction is `delegateTransaction`.
    expect(mockRequestCustomTransaction.mock.calls[0]![4]).toBe(false);
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

  it('rejects with NotGranted when getMidenClient throws while fetching the public key', async () => {
    _g.__dappTestMockGetAccount.mockRejectedValueOnce(new Error('wasm down'));
    mockRequestConfirmation.mockResolvedValueOnce({
      confirmed: true,
      accountPublicKey: 'miden-account-1',
      privateDataPermission: 'UPON_REQUEST'
    });
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
  });

  it('rejects with NotGranted when the wallet returns no public key commitments', async () => {
    // Neither the standard interface nor the guardian signer map yields a
    // commitment, so the resolver comes up empty.
    _g.__dappTestMockGetAccount.mockResolvedValueOnce({
      getPublicKeyCommitments: () => [],
      storage: () => ({ getMapItem: () => undefined })
    });
    mockRequestConfirmation.mockResolvedValueOnce({
      confirmed: true,
      accountPublicKey: 'miden-account-1',
      privateDataPermission: 'UPON_REQUEST'
    });
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
  });

  it('skips setDApp when existingPermission is true', async () => {
    _g.__dappTestMockGetAccount.mockResolvedValue({
      getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }]
    });
    // The session already exists for 'https://miden.xyz' under 'miden-account-1'.
    // requestPermission with `force: true` and matching appMeta will reach the
    // confirmation flow with existingPermission = true.
    mockRequestConfirmation.mockResolvedValueOnce({
      confirmed: true,
      accountPublicKey: 'miden-account-1',
      privateDataPermission: 'AUTO'
    });
    const res = await dapp.requestPermission('https://miden.xyz', {
      type: MidenDAppMessageType.PermissionRequest,
      appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
      network: 'testnet',
      privateDataPermission: 'UPON_REQUEST',
      allowedPrivateData: 0,
      force: true
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
  });

  it('rejects with NotGranted when getMidenClient returns null account', async () => {
    _g.__dappTestMockGetAccount.mockResolvedValueOnce(null);
    mockRequestConfirmation.mockResolvedValueOnce({
      confirmed: true,
      accountPublicKey: 'miden-account-1',
      privateDataPermission: 'UPON_REQUEST'
    });
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
  });
});

// ── Watchdog eviction mid-flow (#788 follow-up) ────────────────────

describe('a watchdog eviction mid-read abandons the dApp flow instead of double-borrowing', () => {
  // Each test revokes hold ownership from INSIDE the parking client call — the
  // moment the real watchdog hands the mutex to a successor — and pins that the
  // next WASM step never runs (that call would be a second borrow of a client
  // somebody else is inside) and that the caller sees the retryable poison
  // error, not a false permissions/params verdict.

  it('requestPermission stops before reading the evicted account commitments', async () => {
    const getPublicKeyCommitments = jest.fn(() => [{ serialize: () => new Uint8Array([1, 2, 3]) }]);
    _g.__dappTestMockGetAccount.mockImplementationOnce(async () => {
      revokeWasmHold();
      return { getPublicKeyCommitments };
    });
    mockRequestConfirmation.mockResolvedValueOnce({
      confirmed: true,
      accountPublicKey: 'miden-account-1',
      privateDataPermission: 'UPON_REQUEST'
    });
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
    ).rejects.toThrow(WasmClientPoisonedError);
    // The commitments (and their serialize()) are borrows of the client the
    // successor now owns — the abandoned flow must never touch them…
    expect(getPublicKeyCommitments).not.toHaveBeenCalled();
    // …and no session may be persisted off the abandoned read.
    expect((storageState[STORAGE_KEY] as any)['https://evicted.xyz']).toBeUndefined();
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
});
