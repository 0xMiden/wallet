/* eslint-disable import/first */
/**
 * Branch-coverage tests for `lib/miden/back/dapp.ts` — mobile/desktop paths.
 *
 * Targets: mobile confirmation-store paths for requestPermission,
 * requestTransaction, requestSendTransaction, requestConsumeTransaction,
 * plus error branches, optional-chain short-circuits, format helpers,
 * and the startDappBackgroundProcessing error-swallowing.
 */

import { MidenDAppConsumeRequest, MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';
import { ITransactionStatus, type ITransaction, type TransactionOutput } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { SpendingLimitPriceUnavailableError } from 'lib/miden/spending-limits/types';
import { WalletStatus } from 'lib/shared/types';

// ── Mocks ──────────────────────────────────────────────────────────

const mockSignData = jest.fn(async () => 'fake-sig-base64');
const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) =>
  fn({
    vault: {
      signData: mockSignData
    }
  })
);

// dapp.ts assesses a custom request's simulated outgoing value against the spending-limit policy
// before raising a sheet, so this suite stands that module in. `false` is "no limit configured",
// which is what every case here assumes.
// The custom path now dry-runs before either sheet and assesses the result, so this suite controls
// the dry run. The default is "no usable result", which is what the real module produced here
// before (no client in this environment), so the pre-existing cases are unaffected.
const mockReleaseNoteIds = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));
jest.mock('lib/miden/note-quarantine', () => ({
  importedNoteIds: (notes: string[] | undefined) => (notes ?? []).map(n => `id:${n}`),
  noteIdFromBytes: (bytes: Uint8Array) => jest.requireActual('lib/miden/note-quarantine').noteIdFromBytes(bytes),
  quarantineNoteIds: jest.fn(),
  releaseNoteIds: (...args: unknown[]) => mockReleaseNoteIds(...args)
}));

const mockSimulateCustomTransaction = jest.fn((..._args: unknown[]) =>
  Promise.resolve({ error: 'no client in this suite' } as Record<string, unknown>)
);
jest.mock('./simulate-custom-tx', () => ({
  simulateCustomTransaction: (...args: unknown[]) => mockSimulateCustomTransaction(...args)
}));

// Only the decoder is stood in: what the bytes decode TO is decode.test.ts's subject, while this
// file's subject is what the gate does with the result. `netOutflowByFaucet` stays REAL, so these
// cases exercise the actual per-faucet netting and folding.
const mockSimulatedBytesToView = jest.fn((..._args: unknown[]) => undefined as unknown);
jest.mock('app/confirm/decode', () => {
  const actual = jest.requireActual('app/confirm/decode');
  return { ...actual, simulatedBytesToView: (...args: unknown[]) => mockSimulatedBytesToView(...args) };
});

const mockHasSpendingLimits = jest.fn((..._args: unknown[]) => Promise.resolve(false));
const mockAssessOutgoingSpendingLimitDetails = jest.fn(
  (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)
);
jest.mock('lib/miden/spending-limits/queue', () => ({
  assessOutgoingSpendingLimitDetails: (...args: unknown[]) => mockAssessOutgoingSpendingLimitDetails(...args),
  hasSpendingLimits: (...args: unknown[]) => mockHasSpendingLimits(...args)
}));

// Mutable so a test can switch accounts mid-confirmation, which is what the approval-time
// re-check exists to catch.
let currentAccountPublicKey = 'miden-account-1';
// Steerable for the Idle case; `'Ready'` is the string every other suite in this family uses.
let mockWalletStatus: unknown = 'Ready';
const mockStoreListeners = new Set<(state: unknown) => void>();
jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({ currentAccount: { publicKey: currentAccountPublicKey }, status: mockWalletStatus }),
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

// WASM client mock
const _g = globalThis as any;
_g.__dappBranchMockGetAccount = jest.fn();

// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
// Models hold OWNERSHIP (#788 follow-up): the lock hands its callback a hold, and
// dapp.ts re-checks it via `assertWasmHoldCurrent` after every parking await — a
// hold-less pass-through would make those guards a TypeError on the happy path.
// The assert re-implements the real comparison against this mock's hold so it is
// never a vacuous no-op.
let currentWasmHold: object | null = null;
const mockImportNoteBytes = jest.fn();
// The consume approval preview is derived from the note the wallet resolves,
// not from the dApp's declared faucet/amount/type, so the note has to exist.
const storedNote = {
  noteId: 'note-1',
  noteType: 0,
  senderAccountId: 's1',
  nullifier: 'nf1',
  state: 0,
  assets: [{ faucetId: 'faucet-1', amount: '1000000' }]
};
const mockGetInputNoteDetails = jest.fn(async (..._args: unknown[]): Promise<unknown[]> => [storedNote]);
const mockRetireWasmClientForCaughtTrap = jest.fn();
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({
    getAccount: (id: string) => (globalThis as any).__dappBranchMockGetAccount(id),
    getInputNoteDetails: (...args: unknown[]) => mockGetInputNoteDetails(...args),
    getConsumableNotes: jest.fn(async () => []),
    getConsumableNoteDtos: jest.fn(async () => []),
    syncState: jest.fn(async () => {}),
    importNoteBytes: (...args: unknown[]) => mockImportNoteBytes(...args),
    on: jest.fn()
  }),
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

jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));

// The repo-wide `__mocks__/nanoid.ts` answers the constant `id`, which would give a connect sheet asked again the
// first sheet's id whatever dapp.ts drew; a counter gives each call its own.
jest.mock('nanoid', () => {
  let issued = 0;
  return { nanoid: () => `id-${++issued}` };
});

// ─── Import under test ───────────────────────────────────────────────

import * as dapp from './dapp';
import { _resetLockedPromptCooldownsForTest, WALLET_LOCKED_REFUSAL } from './dapp-locked';

const UNLOCKED_CONTEXT = { vault: { signData: mockSignData } };

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
  privateDataPermission: 'UPON_REQUEST',
  allowedPrivateData: 0,
  publicKey: 'miden-account-1'
};

beforeEach(() => {
  _resetLockedPromptCooldownsForTest();
  jest.clearAllMocks();
  mockWalletStatus = 'Ready';
  mockStoreListeners.clear();
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn(UNLOCKED_CONTEXT));
  for (const k of Object.keys(storageState)) delete storageState[k];
  storageState[STORAGE_KEY] = { 'https://miden.xyz': [SESSION] };
  mockGetCurrentAccountPublicKey.mockResolvedValue('miden-account-1');
  mockRequestConfirmation.mockResolvedValue({
    confirmed: true,
    accountPublicKey: 'miden-account-1',
    privateDataPermission: 'UPON_REQUEST',
    delegate: true
  });
  _g.__dappBranchMockGetAccount.mockResolvedValue({
    getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }],
    vault: () => ({
      fungibleAssets: () => [
        {
          faucetId: () => 'faucet-x',
          amount: () => ({ toString: () => '42' })
        }
      ]
    })
  });
  mockGetTokenMetadata.mockResolvedValue({ decimals: 6, symbol: 'TOK' });
  mockStartTransactionProcessing.mockReturnValue(Promise.resolve());
  mockImportNoteBytes.mockReset();
  mockImportNoteBytes.mockResolvedValue('note-1');
});

// ─── requestPermission (mobile paths) ──────────────────────────────

describe('requestPermission — mobile branches', () => {
  it('goes through confirmation store when force=true even if session exists', async () => {
    const res = await dapp.requestPermission(
      'https://miden.xyz',
      {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
        force: true,
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0
      } as never,
      'session-1'
    );
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
    expect(mockRequestConfirmation).toHaveBeenCalled();
  });

  it('goes through confirmation store when no existing session', async () => {
    delete (storageState[STORAGE_KEY] as any)['https://miden.xyz'];
    const res = await dapp.requestPermission(
      'https://miden.xyz',
      {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'New App', url: 'https://miden.xyz' },
        force: false,
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0
      } as never,
      'session-1'
    );
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
    expect(mockRequestConfirmation).toHaveBeenCalled();
  });

  it('rejects when user declines permission confirmation', async () => {
    mockRequestConfirmation.mockResolvedValueOnce({ confirmed: false });
    await expect(
      dapp.requestPermission(
        'https://miden.xyz',
        {
          type: MidenDAppMessageType.PermissionRequest,
          appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
          force: true,
          network: 'testnet',
          privateDataPermission: 'UPON_REQUEST',
          allowedPrivateData: 0
        } as never,
        'session-1'
      )
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('saves dApp session when existingPermission is false', async () => {
    delete (storageState[STORAGE_KEY] as any)['https://miden.xyz'];
    await dapp.requestPermission(
      'https://miden.xyz',
      {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'Brand New', url: 'https://miden.xyz' },
        force: false,
        network: 'testnet'
      } as never,
      'session-1'
    );
    const sessions = (storageState[STORAGE_KEY] as any)['https://miden.xyz'];
    expect(sessions).toBeDefined();
    expect(sessions.length).toBeGreaterThan(0);
  });
});

describe('an approved connect whose account key read fails, on mobile and desktop (#1471)', () => {
  const ORIGIN = 'https://key-read-dapp.xyz';
  const ACCOUNT = { getPublicKeyCommitments: () => [{ serialize: () => new Uint8Array([1, 2, 3]) }] };
  const APPROVE = { confirmed: true, accountPublicKey: 'miden-account-1', privateDataPermission: 'UPON_REQUEST' };
  const DENY = { confirmed: false };
  const kill = new WasmClientPoisonedError('watchdog', new Error('account read parked'));
  const failures: ReadonlyArray<readonly [string, () => Promise<unknown>, string]> = [
    ['"Account not found"', async () => null, 'Account not found'],
    [
      'no public key commitments',
      // Interface empty and guardian signer map empty: the resolver misses both.
      async () => ({ getPublicKeyCommitments: () => [], storage: () => ({ getMapItem: () => undefined }) }),
      'Account has no public key commitments'
    ],
    [
      'a kill',
      async () => {
        throw kill;
      },
      kill.message
    ]
  ];
  const connect = () =>
    dapp.requestPermission(
      ORIGIN,
      {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'Key Read Dapp', url: ORIGIN },
        force: false,
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0
      } as never,
      'session-1'
    );
  const savedSession = () => (storageState[STORAGE_KEY] as Record<string, unknown>)[ORIGIN];
  const sheets = () => mockRequestConfirmation.mock.calls.map(([request]) => request);
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
  const untilSheets = async (count: number) => {
    for (let i = 0; i < 50 && mockRequestConfirmation.mock.calls.length < count; i++) {
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(count);
  };

  // Each key read takes the next of these, then reads the account; each sheet takes the next answer, and a sheet with
  // none left is denied, so a read that keeps failing cannot ask forever.
  let keyReads: Array<() => Promise<unknown>>;
  let sheetAnswers: unknown[];
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    keyReads = [];
    sheetAnswers = [];
    _g.__dappBranchMockGetAccount.mockImplementation(async () => (keyReads.shift() ?? (async () => ACCOUNT))());
    mockRequestConfirmation.mockImplementation(async () => sheetAnswers.shift() ?? DENY);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it.each(failures)(
    "asks again with the read's error after %s instead of answering the dApp, and the next approval's read resolves it",
    async (_name, failingRead, message) => {
      keyReads = [failingRead];
      sheetAnswers = [APPROVE, APPROVE];

      await expect(connect()).resolves.toEqual({
        type: MidenDAppMessageType.PermissionResponse,
        accountId: 'miden-account-1',
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0,
        publicKey: 'AQID'
      });
      const [first, second] = sheets();
      expect(sheets()).toHaveLength(2);
      expect(first).not.toHaveProperty('previousAttemptError');
      expect(second).toEqual({ ...first, id: expect.any(String), previousAttemptError: message });
      expect(second.id).not.toBe(first.id);
      expect(savedSession()).toEqual([expect.objectContaining({ accountId: 'miden-account-1', publicKey: 'AQID' })]);
    }
  );

  it.each(failures)('answers NOT_GRANTED when the user denies the sheet asked again after %s', async (_name, read) => {
    keyReads = [read];
    sheetAnswers = [APPROVE, DENY];

    await expect(connect()).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(2);
    expect(savedSession()).toBeUndefined();
  });

  it('keeps one 120 s deadline across the sheets a failing read asks again', async () => {
    jest.useFakeTimers();
    try {
      _g.__dappBranchMockGetAccount.mockImplementation(async () => null);
      mockRequestConfirmation.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(APPROVE), 50_000))
      );
      const outcome = track(connect());
      await untilSheets(1);

      // Approved at 50 s and 100 s, each read failing: the third sheet still ends at 120 s.
      await jest.advanceTimersByTimeAsync(119_999);
      expect(outcome.settled).toBe(false);
      expect(mockRequestConfirmation).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual({ settled: true, message: MidenDAppErrorType.NotGranted });
      expect(mockRequestConfirmation).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the 240 s deadline of an unlock wait across the sheets a failing read asks again', async () => {
    jest.useFakeTimers();
    try {
      _g.__dappBranchMockGetAccount.mockImplementation(async () => null);
      mockRequestConfirmation.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(APPROVE), 50_000))
      );
      lockWallet();
      const outcome = track(connect());
      await jest.advanceTimersByTimeAsync(100_000);
      expect(mockRequestConfirmation).not.toHaveBeenCalled();
      unlockWallet();
      await untilSheets(1);

      // Posted at 100 s, approved at 150 s and 200 s, each read failing: the third sheet ends at 240 s.
      await jest.advanceTimersByTimeAsync(139_999);
      expect(outcome.settled).toBe(false);
      expect(mockRequestConfirmation).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual({ settled: true, message: MidenDAppErrorType.NotGranted });
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers NOT_GRANTED at the deadline while the approved read runs, and the late read saves nothing', async () => {
    jest.useFakeTimers();
    try {
      let release: (account: unknown) => void = () => {};
      keyReads = [() => new Promise(resolve => (release = resolve))];
      sheetAnswers = [APPROVE];
      const outcome = track(connect());
      await untilSheets(1);

      await jest.advanceTimersByTimeAsync(119_999);
      expect(outcome.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual({ settled: true, message: MidenDAppErrorType.NotGranted });

      release(ACCOUNT);
      await jest.advanceTimersByTimeAsync(0);
      expect(savedSession()).toBeUndefined();
      expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── requestConsumeTransaction — mobile branches ──────────────────

describe('requestConsumeTransaction — mobile error branches', () => {
  const validTx = {
    accountAddress: 'miden-account-1',
    noteId: 'note-1',
    faucetId: 'faucet-1',
    noteType: 'Private',
    amount: '50'
  };

  it('rejects when consume preview fails (getTokenMetadata throws)', async () => {
    mockGetTokenMetadata.mockRejectedValueOnce(new Error('metadata-fail'));
    await expect(
      dapp.requestConsumeTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumeRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: validTx
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  // Issue #1459: the consume reads the note from the store before it writes a row, so
  // queued bytes arrived too late and a dApp-supplied note needed a second approval.
  describe('carried noteBytes', () => {
    const noteBytes = 'c29tZW5vdGVieXRlcw==';
    const consumeWithBytes = () =>
      dapp.requestConsumeTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumeRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: { ...validTx, noteBytes }
      } as never);

    // What `notes.import` answers for raw Note bytes, which the wallet stores as a details-only NoteFile.
    const detailsCommitment = '0x5d1e7a11';
    const consumed = { type: MidenDAppMessageType.ConsumeResponse, transactionId: 'tx-c' };
    const sdk: Record<string, unknown> = require('@miden-sdk/miden-sdk/lazy');
    const originalSdk = { Note: sdk.Note, NoteFile: sdk.NoteFile, NoteScript: sdk.NoteScript, Address: sdk.Address };
    const sdkNote = (id: string) => ({
      id: () => ({ toString: () => id }),
      metadata: () => undefined,
      assets: () => ({ fungibleAssets: () => [] })
    });
    const unparsable = (what: string) => () => {
      throw new Error(`not a ${what}`);
    };
    const carryRawNote = (deserialize: () => unknown) => {
      sdk.NoteFile = { deserialize: unparsable('NoteFile') };
      sdk.Note = { deserialize };
    };

    beforeEach(() => {
      carryRawNote(() => sdkNote('note-1'));
      mockQueueNoteImport.mockResolvedValue(undefined);
      mockInitiateConsumeTransactionFromId.mockReset();
    });

    afterEach(() => {
      Object.assign(sdk, originalSdk);
    });

    it('imports the bytes into the store before it initiates the consume, in one approval', async () => {
      const order: string[] = [];
      mockImportNoteBytes.mockImplementationOnce(async (bytes: Uint8Array) => {
        order.push(`import:${Buffer.from(bytes).toString('base64')}`);
        return 'note-1';
      });
      mockInitiateConsumeTransactionFromId.mockImplementationOnce(async (_account: string, noteId: string) => {
        order.push(`consume:${noteId}`);
        return 'tx-c';
      });

      const res = await consumeWithBytes();

      expect(res).toEqual({ type: MidenDAppMessageType.ConsumeResponse, transactionId: 'tx-c' });
      expect(order).toEqual([`import:${noteBytes}`, 'consume:note-1']);
      expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
      expect(mockQueueNoteImport).not.toHaveBeenCalled();
    });

    it('consumes raw Note bytes that decode to noteId, whatever id the import answers with', async () => {
      carryRawNote(() => sdkNote('note-1'));
      mockImportNoteBytes.mockResolvedValueOnce(detailsCommitment);
      mockInitiateConsumeTransactionFromId.mockResolvedValueOnce('tx-c');

      await expect(consumeWithBytes()).resolves.toEqual(consumed);
      expect(mockImportNoteBytes).toHaveBeenCalledTimes(1);
    });

    it('refuses bytes that decode to another note before importing them', async () => {
      // The sheet refuses these bytes when it decodes them the same way (dapp.extended.test.ts); this
      // pins the approval's own check, which does not rest on what the sheet decoded.
      carryRawNote(jest.fn().mockReturnValueOnce(sdkNote('note-1')).mockReturnValue(sdkNote('note-other')));

      await expect(consumeWithBytes()).rejects.toThrow(
        `${MidenDAppErrorType.InvalidParams}: Error: noteBytes describe a different note than noteId`
      );
      expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
      expect(mockImportNoteBytes).not.toHaveBeenCalled();
      expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
    });

    it('refuses bytes that decode to another note as malformed while the wallet is locked', async () => {
      carryRawNote(() => sdkNote('note-other'));
      mockWithUnlocked.mockImplementation(async () => {
        throw Object.assign(new Error('Wallet is locked'), { reason: 'locked' });
      });
      try {
        await expect(consumeWithBytes()).rejects.toThrow(
          `${MidenDAppErrorType.InvalidParams}: Error: noteBytes describe a different note than noteId`
        );
        expect(mockRequestConfirmation).not.toHaveBeenCalled();
      } finally {
        mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) =>
          fn({ vault: { signData: mockSignData } })
        );
      }
    });

    // A non-target enters P2IDE only through its reclaim branch, which a reclaim height of 0 closes at every block, and
    // a sponsorship consumed without its feature note, as a consume request's single note is, takes the same branch.
    describe('a note the requesting account can never consume', () => {
      const felts = (values: bigint[]) => values.map(value => ({ asInt: () => value }));
      const REQUESTER = { prefix: 0x00000000abcdef01n, suffix: 0x2f1a3b4c5d6e0000n };
      const OTHER = { prefix: 0x00000000feedbeefn, suffix: 0x7c9d1e2f3a4b0000n };
      const withRecipient = (root: string, items: bigint[]) => ({
        ...sdkNote('note-1'),
        recipient: () => ({
          script: () => ({ root: () => ({ toHex: () => root }) }),
          storage: () => ({ items: () => felts(items) })
        })
      });
      const p2ide = (target: typeof OTHER, reclaimHeight: bigint) =>
        withRecipient('0xp2ide', [REQUESTER.suffix, REQUESTER.prefix, target.suffix, target.prefix, reclaimHeight, 0n]);
      const sponsorship = (reclaimHeight: bigint) =>
        withRecipient('0xsponsorship', [1n, 2n, 3n, 4n, REQUESTER.suffix, REQUESTER.prefix, reclaimHeight]);
      const consumeStored = () =>
        dapp.requestConsumeTransaction('https://miden.xyz', {
          type: MidenDAppMessageType.ConsumeRequest,
          sourcePublicKey: 'miden-account-1',
          transaction: validTx
        } as never);

      beforeEach(() => {
        sdk.NoteScript = {
          p2ide: () => ({ root: () => ({ toHex: () => '0xp2ide' }) }),
          feeSponsorship: () => ({ root: () => ({ toHex: () => '0xsponsorship' }) })
        };
        const requester = {
          prefix: () => ({ asInt: () => REQUESTER.prefix }),
          suffix: () => ({ asInt: () => REQUESTER.suffix }),
          toString: () => '0xrequester'
        };
        sdk.Address = { fromBech32: () => ({ accountId: () => requester }) };
      });

      it.each([
        ['a carried P2IDE for another account with reclaim disabled', () => p2ide(OTHER, 0n)],
        ['a carried fee sponsorship with reclaim disabled', () => sponsorship(0n)]
      ])('refuses %s before the sheet, and imports and queues nothing', async (_name, note) => {
        carryRawNote(note);

        await expect(consumeWithBytes()).rejects.toThrow(MidenDAppErrorType.InvalidParams);
        expect(mockRequestConfirmation).not.toHaveBeenCalled();
        expect(mockImportNoteBytes).not.toHaveBeenCalled();
        expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
      });

      it('consumes a carried reclaim-disabled P2IDE whose target is the requesting account', async () => {
        carryRawNote(() => p2ide(REQUESTER, 0n));
        mockInitiateConsumeTransactionFromId.mockResolvedValueOnce('tx-c');

        await expect(consumeWithBytes()).resolves.toEqual(consumed);
        expect(mockInitiateConsumeTransactionFromId).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['P2IDE for another account', { prefix: OTHER.prefix.toString(), suffix: OTHER.suffix.toString() }],
        ['fee sponsorship', 'nobody']
      ])('refuses a stored reclaim-disabled %s before the sheet, and queues nothing', async (_name, restriction) => {
        mockGetInputNoteDetails.mockResolvedValueOnce([{ ...storedNote, restriction }]);

        await expect(consumeStored()).rejects.toThrow(MidenDAppErrorType.InvalidParams);
        expect(mockRequestConfirmation).not.toHaveBeenCalled();
        expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
      });
    });

    // A trap is no unreadable bytes: the module that ran the decode is aborted, so the lock has to see it and retire the
    // client, and nothing may read the store, show the sheet, import or queue on it.
    describe('a WebAssembly trap while decoding the carried note', () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      const throwTrap = () => {
        throw trap;
      };

      it.each([
        ['NoteFile.deserialize', () => (sdk.NoteFile = { deserialize: throwTrap })],
        ['Note.deserialize', () => carryRawNote(throwTrap)],
        [
          'the read of the decoded note restriction',
          () => carryRawNote(() => ({ ...sdkNote('note-1'), recipient: throwTrap }))
        ]
      ])('in %s refuses the request before the sheet and retires the client', async (_name, arrange) => {
        arrange();

        await expect(consumeWithBytes()).rejects.toThrow(`${MidenDAppErrorType.InvalidParams}: RuntimeError`);
        expect(mockRetireWasmClientForCaughtTrap).toHaveBeenCalledWith(expect.anything(), trap);
        expect(mockGetInputNoteDetails).not.toHaveBeenCalled();
        expect(mockRequestConfirmation).not.toHaveBeenCalled();
        expect(mockImportNoteBytes).not.toHaveBeenCalled();
        expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
      });

      it('after the approval refuses the consume before the import and retires the client', async () => {
        carryRawNote(jest.fn().mockReturnValueOnce(sdkNote('note-1')).mockImplementation(throwTrap));

        await expect(consumeWithBytes()).rejects.toThrow(`${MidenDAppErrorType.InvalidParams}: RuntimeError`);
        expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
        expect(mockRetireWasmClientForCaughtTrap).toHaveBeenCalledWith(expect.anything(), trap);
        expect(mockImportNoteBytes).not.toHaveBeenCalled();
        expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
      });

      it('is not what an ordinary decode failure is: those bytes still fall back to the stored note', async () => {
        carryRawNote(() => {
          throw new Error('not a Note');
        });
        mockInitiateConsumeTransactionFromId.mockResolvedValueOnce('tx-c');

        await expect(consumeWithBytes()).resolves.toEqual(consumed);
        expect(mockGetInputNoteDetails).toHaveBeenCalledTimes(1);
        expect(mockRetireWasmClientForCaughtTrap).not.toHaveBeenCalled();
      });
    });

    const detailsOnlyFile = (id: string) => ({
      note: () => undefined,
      noteId: () => ({ toString: () => id })
    });

    it('imports a details-only NoteFile whose noteId is the requested note and consumes it', async () => {
      sdk.NoteFile = { deserialize: () => detailsOnlyFile('note-1') };
      sdk.Note = { deserialize: unparsable('Note') };
      mockImportNoteBytes.mockResolvedValueOnce(detailsCommitment);
      mockInitiateConsumeTransactionFromId.mockResolvedValueOnce('tx-c');

      await expect(consumeWithBytes()).resolves.toEqual(consumed);
      expect(mockImportNoteBytes).toHaveBeenCalledTimes(1);
    });

    it('refuses a details-only NoteFile whose noteId is another note before importing it', async () => {
      sdk.NoteFile = { deserialize: () => detailsOnlyFile('note-other') };
      sdk.Note = { deserialize: unparsable('Note') };

      await expect(consumeWithBytes()).rejects.toThrow(
        `${MidenDAppErrorType.InvalidParams}: Error: noteBytes describe a different note than noteId`
      );
      expect(mockImportNoteBytes).not.toHaveBeenCalled();
      expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
    });

    describe('bytes that are neither a NoteFile nor a Note', () => {
      beforeEach(() => {
        sdk.NoteFile = { deserialize: unparsable('NoteFile') };
        sdk.Note = { deserialize: unparsable('Note') };
      });

      it('are not imported, and a note the store holds is consumed', async () => {
        mockInitiateConsumeTransactionFromId.mockResolvedValueOnce('tx-c');

        await expect(consumeWithBytes()).resolves.toEqual(consumed);
        expect(mockImportNoteBytes).not.toHaveBeenCalled();
        expect(mockQueueNoteImport).not.toHaveBeenCalled();
      });

      it('are not imported, and a note the store lacks is refused by the consume itself', async () => {
        mockInitiateConsumeTransactionFromId.mockRejectedValueOnce(new Error('Input note not found'));

        await expect(consumeWithBytes()).rejects.toThrow(
          `${MidenDAppErrorType.InvalidParams}: Error: Input note not found`
        );
        expect(mockImportNoteBytes).not.toHaveBeenCalled();
        expect(mockQueueNoteImport).not.toHaveBeenCalled();
      });

      it('leave a kill during the consume to reach the dApp as the kill', async () => {
        const kill = new WasmClientPoisonedError('watchdog', new Error('store read parked'));
        mockInitiateConsumeTransactionFromId.mockRejectedValueOnce(kill);

        await expect(consumeWithBytes()).rejects.toBe(kill);
        expect(mockImportNoteBytes).not.toHaveBeenCalled();
      });
    });

    it('refuses a carried note another transaction holds rather than answer with that transaction', async () => {
      carryRawNote(() => sdkNote('note-1'));
      mockImportNoteBytes.mockResolvedValueOnce(detailsCommitment);
      mockInitiateConsumeTransactionFromId.mockImplementationOnce(async (...args: unknown[]) => {
        if (typeof args[4] === 'string') throw new Error('This note is being consumed by another transaction');
        return 'other-dapp-transaction';
      });

      await expect(consumeWithBytes()).rejects.toThrow('This note is being consumed by another transaction');
    });

    it('queues the bytes and does not consume when the import fails on the network', async () => {
      mockImportNoteBytes.mockRejectedValueOnce(new Error('Failed to fetch'));

      await expect(consumeWithBytes()).rejects.toThrow(`${MidenDAppErrorType.InvalidParams}: Error: Failed to fetch`);
      expect(mockQueueNoteImport).toHaveBeenCalledWith(noteBytes);
      expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
    });

    it('rejects with the kill itself, not InvalidParams, when the import is evicted', async () => {
      const kill = new WasmClientPoisonedError('watchdog', new Error('import parked'));
      mockImportNoteBytes.mockRejectedValueOnce(kill);

      await expect(consumeWithBytes()).rejects.toBe(kill);
      expect(mockQueueNoteImport).toHaveBeenCalledWith(noteBytes);
      expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
    });

    // The import is the one await between the approval's check and the consume, and it can run long.
    it.each([
      ['the current account changes', () => (currentAccountPublicKey = 'miden-account-2')],
      ['the dApp disconnects', () => (storageState[STORAGE_KEY] = { 'https://miden.xyz': [] })]
    ])('refuses the consume when %s while the import is pending', async (_name, change) => {
      mockImportNoteBytes.mockImplementationOnce(async () => {
        change();
        return 'note-1';
      });

      try {
        await expect(consumeWithBytes()).rejects.toThrow(MidenDAppErrorType.NotGranted);
      } finally {
        currentAccountPublicKey = 'miden-account-1';
      }
      expect(mockImportNoteBytes).toHaveBeenCalledTimes(1);
      expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
    });
  });

  it('refuses a note another transaction holds rather than answer with that transaction', async () => {
    // As the real call: a dApp's request is refused, the wallet's own claim is answered with the holding row.
    mockInitiateConsumeTransactionFromId.mockImplementationOnce(async (...args: unknown[]) => {
      if (typeof args[4] === 'string') throw new Error('This note is being consumed by another transaction');
      return 'other-dapp-transaction';
    });
    const request: MidenDAppConsumeRequest = {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: { noteId: 'note-1', faucetId: 'faucet-1', noteType: 'private', amount: 50 }
    };
    const answer = dapp.requestConsumeTransaction('https://miden.xyz', request);
    await expect(answer).rejects.toThrow('This note is being consumed by another transaction');
  });

  it('rejects when initiateConsumeTransactionFromId throws', async () => {
    mockInitiateConsumeTransactionFromId.mockRejectedValueOnce(new Error('consume-err'));
    await expect(
      dapp.requestConsumeTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.ConsumeRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: validTx
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });
});

// ── requestTransaction — mobile error branches ──────────────────

describe('requestTransaction — mobile error branches', () => {
  it('rejects when requestCustomTransaction throws', async () => {
    mockRequestCustomTransaction.mockRejectedValueOnce(new Error('tx-err'));
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
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });
});

// ── requestSendTransaction — mobile error branches ──────────────

describe('requestSendTransaction — mobile error branches', () => {
  const validTx = {
    senderAddress: 'miden-account-1',
    recipientAddress: 'bob',
    faucetId: 'faucet-1',
    noteType: 'Private',
    amount: '100'
  };

  it('rejects when format preview throws', async () => {
    mockWithUnlocked.mockRejectedValueOnce(new Error('preview-fail'));
    await expect(
      dapp.requestSendTransaction('https://miden.xyz', {
        type: MidenDAppMessageType.SendTransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: validTx
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('includes recallBlocks in preview when provided', async () => {
    mockInitiateSendTransaction.mockResolvedValue('tx-recall');
    const res = await dapp.requestSendTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.SendTransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: { ...validTx, recallBlocks: 100 }
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.SendTransactionResponse);
  });
});

// ── startDappBackgroundProcessing error swallowing ───────────────

describe('startDappBackgroundProcessing error handling', () => {
  it('swallows sync throws from startTransactionProcessing', async () => {
    mockStartTransactionProcessing.mockImplementationOnce(() => {
      throw new Error('sync-throw');
    });
    mockRequestCustomTransaction.mockResolvedValue('tx-1');
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
  });

  it('swallows async rejections from startTransactionProcessing', async () => {
    mockStartTransactionProcessing.mockReturnValueOnce(Promise.reject(new Error('async-err')));
    mockRequestCustomTransaction.mockResolvedValue('tx-2');
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
  });
});

// ── requestDisconnect edge cases ──────────────────────────────────

describe('requestDisconnect — edge cases', () => {
  it('throws NotFound when current account has no permission for the origin', async () => {
    // No session stored for the test origin
    delete (storageState[STORAGE_KEY] as any)['https://unknown-dapp.xyz'];
    await expect(
      dapp.requestDisconnect('https://unknown-dapp.xyz', {
        type: MidenDAppMessageType.DisconnectRequest
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotFound);
  });

  it('throws NotFound when currentAccountPubKey is null', async () => {
    mockGetCurrentAccountPublicKey.mockResolvedValueOnce(null);
    await expect(
      dapp.requestDisconnect('https://miden.xyz', {
        type: MidenDAppMessageType.DisconnectRequest
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotFound);
  });
});

// ── getCurrentPermission edge cases ──────────────────────────────

describe('getCurrentPermission — edge cases', () => {
  it('returns null permission when no current account', async () => {
    mockGetCurrentAccountPublicKey.mockResolvedValueOnce(null);
    const res = await dapp.getCurrentPermission('https://miden.xyz');
    expect(res.permission).toBeNull();
  });

  it('returns null permission when no session for origin', async () => {
    const res = await dapp.getCurrentPermission('https://unknown-dapp.xyz');
    expect(res.permission).toBeNull();
  });

  it('omits the public key a legacy session stored as null (#174)', async () => {
    storageState[STORAGE_KEY] = { 'https://miden.xyz': [{ ...SESSION, publicKey: null }] };
    const res = await dapp.getCurrentPermission('https://miden.xyz');
    expect(res.permission).not.toBeNull();
    expect(res.permission).not.toHaveProperty('publicKey');
  });
});

// ── waitForTransaction edge cases ──────────────────────────────

describe('waitForTransaction', () => {
  const ORIGIN = 'https://miden.xyz';
  const OTHER = 'https://other.xyz';
  const SERVED = { txHash: '0xabc', outputNotes: ['bm90ZQ=='] };
  const waitReq = (txId: unknown) => ({ type: MidenDAppMessageType.WaitForTransactionRequest, txId }) as never;
  const putRow = (overrides: Partial<ITransaction> = {}) =>
    Repo.transactions.put({
      id: 'tx-abc',
      type: 'send',
      accountId: 'miden-account-1',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'SEND',
      dappOrigins: [ORIGIN],
      ...overrides
    });
  const answer = (transactionOutput: unknown) => ({
    type: MidenDAppMessageType.WaitForTransactionResponse,
    transactionOutput
  });

  beforeEach(async () => {
    await Repo.transactions.clear();
    mockWaitForTransactionCompletion.mockResolvedValue(SERVED);
  });

  afterEach(() => {
    currentAccountPublicKey = 'miden-account-1';
  });

  it('serves the origin that created the row while it holds a session on the row account', async () => {
    await putRow();
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).resolves.toEqual(answer(SERVED));
    expect(mockWaitForTransactionCompletion).toHaveBeenCalledWith('tx-abc');
  });

  it("forwards a landed transaction's accepted-by-the-network answer to its dApp unchanged (#1233)", async () => {
    const landed = { errorMessage: 'Transaction 0xabc was accepted by the network, but its result is not available' };
    mockWaitForTransactionCompletion.mockResolvedValueOnce(landed);
    await putRow();
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).resolves.toEqual(answer(landed));
  });

  it('serves the creator after it disconnected and connected again', async () => {
    await putRow();
    await dapp.removeDApp(ORIGIN, 'miden-account-1');
    await dapp.setDApp(ORIGIN, { ...SESSION, appMeta: { name: 'Miden Test, reconnected', url: ORIGIN } } as never);
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).resolves.toEqual(answer(SERVED));
  });

  it('matches a session stored under the composite account id to a row holding the bare address', async () => {
    storageState[STORAGE_KEY] = {
      [ORIGIN]: [{ ...SESSION, accountId: 'miden-account-1_hot', publicKey: 'miden-account-1_hot' }]
    };
    await putRow();
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).resolves.toEqual(answer(SERVED));
  });

  it('answers the creator after the user switched to another account', async () => {
    currentAccountPublicKey = 'miden-account-2';
    mockGetCurrentAccountPublicKey.mockResolvedValue('miden-account-2');
    await putRow();
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).resolves.toEqual(answer(SERVED));
  });

  it('answers the creator while the wallet is locked', async () => {
    // How this file models a locked wallet: no current account in the store or the vault.
    currentAccountPublicKey = undefined as unknown as string;
    mockGetCurrentAccountPublicKey.mockResolvedValue(undefined);
    await putRow();
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).resolves.toEqual(answer(SERVED));
  });

  // The consume dedup can grant a dApp a claim row that holds other notes too; their output notes are not its to read.
  it('answers a claim of several notes with its txHash and no output notes', async () => {
    await putRow({ type: 'consume', displayIcon: 'RECEIVE', noteId: 'note-1', noteIds: ['note-1', 'note-2'] });
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).resolves.toEqual(
      answer({ txHash: '0xabc', outputNotes: [] })
    );
  });

  it("forwards a failed claim of several notes' error unchanged", async () => {
    const failed: TransactionOutput = { errorMessage: 'Transaction failed' };
    mockWaitForTransactionCompletion.mockResolvedValueOnce(failed);
    await putRow({ type: 'consume', displayIcon: 'RECEIVE', noteId: 'note-1', noteIds: ['note-1', 'note-2'] });
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).resolves.toEqual(answer(failed));
  });

  it.each<[string, Partial<ITransaction>]>([
    ['a single-note consume', { type: 'consume', displayIcon: 'RECEIVE', noteId: 'note-1', noteIds: ['note-1'] }],
    ['a send', { type: 'send', displayIcon: 'SEND' }],
    ['a custom (execute)', { type: 'execute', displayIcon: 'DEFAULT' }]
  ])('answers %s row with its output notes', async (_label, row) => {
    await putRow(row);
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).resolves.toEqual(answer(SERVED));
  });

  it.each<[string, () => Promise<unknown>, string]>([
    [
      'another origin, though it holds a session on the same account',
      async () => {
        storageState[STORAGE_KEY] = {
          [ORIGIN]: [SESSION],
          [OTHER]: [{ ...SESSION, appMeta: { name: 'Other', url: OTHER } }]
        };
        await putRow();
      },
      OTHER
    ],
    [
      'the creating origin once its only session is on another account',
      async () => {
        storageState[STORAGE_KEY] = {
          [ORIGIN]: [{ ...SESSION, accountId: 'miden-account-2', publicKey: 'miden-account-2' }]
        };
        await putRow();
      },
      ORIGIN
    ],
    [
      'the creating origin with no session at all',
      async () => {
        storageState[STORAGE_KEY] = {};
        await putRow();
      },
      ORIGIN
    ],
    ['a row the wallet created, which lists no origin', () => putRow({ dappOrigins: undefined }), ORIGIN],
    ['an id with no row, the same way as a row it may not read', async () => undefined, ORIGIN],
    ['a row restored from a backup', () => putRow({ restoredFromBackup: true }), ORIGIN],
    ['a row rebuilt from Guardian history', () => putRow({ recovered: true }), ORIGIN]
  ])('refuses %s with NOT_GRANTED before the wait starts', async (_label, setup, from) => {
    await setup();
    await expect(dapp.waitForTransaction(from, waitReq('tx-abc'))).rejects.toThrow(/^NOT_GRANTED$/);
    expect(mockWaitForTransactionCompletion).not.toHaveBeenCalled();
  });

  it('refuses a session revoked during the wait, with no result', async () => {
    await putRow();
    mockWaitForTransactionCompletion.mockImplementationOnce(async () => {
      await dapp.removeDApp(ORIGIN, 'miden-account-1');
      return SERVED;
    });
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).rejects.toThrow(/^NOT_GRANTED$/);
  });

  it('refuses a row a backup restore replaced during the wait, with no result', async () => {
    await putRow();
    mockWaitForTransactionCompletion.mockImplementationOnce(async () => {
      await putRow({ restoredFromBackup: true });
      return SERVED;
    });
    await expect(dapp.waitForTransaction(ORIGIN, waitReq('tx-abc'))).rejects.toThrow(/^NOT_GRANTED$/);
  });

  it('refuses a txId that is not a string as INVALID_PARAMS before any read', async () => {
    await putRow();
    await expect(dapp.waitForTransaction(ORIGIN, waitReq({ accountId: 'miden-account-1' }))).rejects.toThrow(
      /^INVALID_PARAMS$/
    );
    expect(mockWaitForTransactionCompletion).not.toHaveBeenCalled();
  });

  it('throws InvalidParams when txId is empty', async () => {
    await expect(dapp.waitForTransaction(ORIGIN, waitReq(''))).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });
});

// ── requestPermission — existing session returns immediately ────

describe('requestPermission — returns immediately for existing session', () => {
  it('returns existing permission without going through confirmation when not force', async () => {
    // Session already exists for this origin with same appMeta.name
    const res = await dapp.requestPermission(
      'https://miden.xyz',
      {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
        force: false,
        network: 'testnet',
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0
      } as never,
      'session-1'
    );
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
    // Should NOT have called the confirmation store since session already exists
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });
});

// ── cleanDApps ─────────────────────────────────────────────────

describe('cleanDApps', () => {
  it('clears all dapp sessions', async () => {
    await dapp.cleanDApps();
    const sessions = await dapp.getAllDApps();
    expect(Object.keys(sessions).length).toBe(0);
  });
});

// ── removeDApp ─────────────────────────────────────────────────

describe('removeDApp', () => {
  it('removes a session for the given origin and accountId', async () => {
    await dapp.removeDApp('https://miden.xyz', 'miden-account-1');
    // The session should be removed
    const sessions = await dapp.getAllDApps();
    const originSessions = sessions['https://miden.xyz'] || [];
    expect(originSessions.find((s: any) => s.accountId === 'miden-account-1')).toBeUndefined();
  });

  it('handles removing from non-existent origin gracefully', async () => {
    const result = await dapp.removeDApp('https://nonexistent.xyz', 'miden-account-1');
    expect(result).toBeDefined();
  });
});

// ── requestSign — input validation branches ─────────────────────

describe('requestSign — input validation', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(
      dapp.requestSign('https://miden.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: '',
        sourceAccountId: 'miden-account-1',
        payload: 'aGVsbG8=',
        kind: 'word'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when no dApp session exists', async () => {
    await expect(
      dapp.requestSign('https://unknown-dapp.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: 'miden-account-1',
        sourceAccountId: 'miden-account-1',
        payload: 'aGVsbG8=',
        kind: 'word'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('throws NotGranted when sourceAccountId does not match any session', async () => {
    await expect(
      dapp.requestSign('https://miden.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: 'miden-account-1',
        sourceAccountId: 'wrong-account',
        payload: 'aGVsbG8=',
        kind: 'word'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  // Regression: the session is looked up by `sourceAccountId` but the signing key
  // is loaded by `sourcePublicKey`, and nothing compared the two. Every account's
  // auth secret is stored under `accAuthSecretKeyStrgKey(<commitment>)` under the
  // one vault key, so a page holding a live session for account A could name A as
  // the source account, pass account B's commitment, and get back a signature made
  // with B's key — with `kind: 'signingInputs'` that authorizes a transaction on B.
  // The approval sheet for `type: 'sign'` renders no account, so nothing on screen
  // contradicts it.
  it('throws NotGranted when sourcePublicKey names an account other than the session account', async () => {
    await expect(
      dapp.requestSign('https://miden.xyz', {
        type: MidenDAppMessageType.SignRequest,
        // Authorized account (a live session exists for it) …
        sourceAccountId: 'miden-account-1',
        // … but the key of a DIFFERENT account the wallet also owns.
        sourcePublicKey: 'miden-account-2-commitment',
        payload: 'aGVsbG8=',
        kind: 'signingInputs'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);

    // Rejected before the vault is ever asked to sign.
    expect(mockWithUnlocked).not.toHaveBeenCalled();
  });
});

// ── requestPrivateNotes — input validation branches ──────────────

describe('requestPrivateNotes — input validation', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(
      dapp.requestPrivateNotes('https://miden.xyz', {
        type: MidenDAppMessageType.PrivateNotesRequest,
        sourcePublicKey: '',
        noteIds: ['n1']
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when no dApp session exists', async () => {
    await expect(
      dapp.requestPrivateNotes('https://unknown-dapp.xyz', {
        type: MidenDAppMessageType.PrivateNotesRequest,
        sourcePublicKey: 'miden-account-1',
        noteIds: ['n1']
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('throws NotGranted when sourcePublicKey does not match any session', async () => {
    await expect(
      dapp.requestPrivateNotes('https://miden.xyz', {
        type: MidenDAppMessageType.PrivateNotesRequest,
        sourcePublicKey: 'wrong-account',
        noteIds: ['n1']
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestAssets — mobile branches ──────────────────────────────

describe('requestAssets — mobile branches', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(
      dapp.requestAssets('https://miden.xyz', {
        type: MidenDAppMessageType.AssetsRequest,
        sourcePublicKey: ''
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });
});

// ── formatConsumeTransactionPreview edge cases ──────────────────

describe('formatConsumeTransactionPreview', () => {
  it('formats with token metadata decimals', async () => {
    mockGetTokenMetadata.mockResolvedValueOnce({ decimals: 8, symbol: 'BTC' });
    mockInitiateConsumeTransactionFromId.mockResolvedValue('tx-fmt');
    const res = await dapp.requestConsumeTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        accountAddress: 'miden-account-1',
        noteId: 'note-1',
        faucetId: 'faucet-1',
        noteType: 'Public',
        amount: '1000000'
      }
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.ConsumeResponse);
  });

  it('formats with undefined token metadata (fallback decimals)', async () => {
    mockGetTokenMetadata.mockResolvedValueOnce(undefined);
    mockInitiateConsumeTransactionFromId.mockResolvedValue('tx-fmt2');
    const res = await dapp.requestConsumeTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        accountAddress: 'miden-account-1',
        noteId: 'note-1',
        faucetId: 'faucet-1',
        noteType: 'Public',
        amount: '500'
      }
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.ConsumeResponse);
  });
});

// ── the dApp custom path's spending-limit gate ──────────────────
//
// Every other suite here stubs this module to "no limit configured", so nothing drove the gate
// down a breach or refusal path: deleting the whole dapp.ts side of the enforcement left every
// test green. Each case below fails if its production line is removed.
describe('requestTransaction - custom spending-limit gate', () => {
  const ASSET = { symbol: 'TOK', decimals: 6 };
  const breach = (usdAmount: bigint) => ({
    assessment: {
      accountId: 'miden-account-1',
      usdAmount,
      revision: 'revision-1',
      assessedAt: 1_000,
      breach: { spent: 0n, proposedTotal: usdAmount, limit: 1n, overBy: usdAmount - 1n, resetAt: null }
    }
  });
  const customRequest = () =>
    ({
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        payload: { address: 'miden-account-1', recipientAddress: 'bob', transactionRequest: 'base64req' }
      }
    }) as never;
  const viewMoving = (assets: { faucetId: string; amount: bigint }[]) => ({
    account: 'miden-account-1',
    outgoing: assets,
    incoming: [],
    inputNotesConsumed: 0,
    outputNotesCreated: assets.length,
    fee: undefined,
    storageChanged: false
  });

  beforeEach(() => {
    mockGetTokenMetadata.mockResolvedValue(ASSET);
    mockSimulateCustomTransaction.mockResolvedValue({ executedBytes: 'exec' });
    mockSimulatedBytesToView.mockReturnValue(viewMoving([{ faucetId: 'faucet-a', amount: 100n }]));
    mockRequestCustomTransaction.mockResolvedValue('tx-1');
  });

  it('raises the challenge on the approval sheet when the simulated spend breaches', async () => {
    mockAssessOutgoingSpendingLimitDetails.mockResolvedValue(breach(100n));
    mockRequestConfirmation.mockResolvedValue({ confirmed: true, delegate: false, spendingLimitAuthenticated: true });

    await dapp.requestTransaction('https://miden.xyz', customRequest());

    // Without this the sheet renders no challenge and the user is never asked to authenticate.
    const confirmation = mockRequestConfirmation.mock.calls[0]![0] as Record<string, unknown>;
    expect(confirmation).toMatchObject({ spendingLimitAssessment: expect.objectContaining({ usdAmount: 100n }) });
    // No per-asset snapshot any more: a dollar figure names no single asset.
    expect(confirmation).not.toHaveProperty('spendingLimitAsset');
  });

  it('passes the simulated totals and a bound authorization to the queue once authenticated', async () => {
    mockAssessOutgoingSpendingLimitDetails.mockResolvedValue(breach(100n));
    mockRequestConfirmation.mockResolvedValue({ confirmed: true, delegate: false, spendingLimitAuthenticated: true });

    await dapp.requestTransaction('https://miden.xyz', customRequest());

    const args = mockRequestCustomTransaction.mock.calls[0]!;
    expect(args[6]).toEqual([{ faucetId: 'faucet-a', amount: 100n }]);
    expect(args[7]).toMatchObject({
      kind: 'usd',
      accountId: 'miden-account-1',
      usdAmount: 100n,
      revision: 'revision-1'
    });
  });

  it('refuses a breaching request approved WITHOUT strict authentication, and ignores forged fields', async () => {
    mockAssessOutgoingSpendingLimitDetails.mockResolvedValue(breach(100n));
    mockRequestConfirmation.mockResolvedValue({ confirmed: true, delegate: false });
    const forged = customRequest() as unknown as Record<string, unknown> & { transaction: Record<string, unknown> };
    // Planted on the dApp's own request, the only object an attacker controls. The decision is
    // taken from the wallet's confirmation result, so these must not change the outcome.
    forged.spendingLimitAuthenticated = true;
    forged.transaction.spendingLimitAuthorization = { id: 'attacker-controlled' };

    await expect(dapp.requestTransaction('https://miden.xyz', forged as never)).rejects.toThrow(
      MidenDAppErrorType.NotGranted
    );
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
  });

  it('refuses when the dry run yields no usable result and any limit is configured', async () => {
    // "Make the simulation fail" must not be the way around a cap.
    mockSimulatedBytesToView.mockReturnValue(undefined);
    mockHasSpendingLimits.mockResolvedValueOnce(true);

    await expect(dapp.requestTransaction('https://miden.xyz', customRequest())).rejects.toThrow(
      MidenDAppErrorType.NotGranted
    );
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
  });

  it('allows an unsimulatable request when the account has no limit at all', async () => {
    mockSimulatedBytesToView.mockReturnValue(undefined);
    mockHasSpendingLimits.mockResolvedValueOnce(false);
    mockRequestConfirmation.mockResolvedValue({ confirmed: true, delegate: false });

    await dapp.requestTransaction('https://miden.xyz', customRequest());

    expect(mockRequestCustomTransaction).toHaveBeenCalled();
  });

  it('no longer refuses a custom request that moves two capped assets', async () => {
    // A dollar figure sums across every asset a request moves, so two covered assets in one
    // request is one charge and one authorization - not the two-faucet refusal the old per-asset
    // caps needed.
    mockSimulatedBytesToView.mockReturnValue(
      viewMoving([
        { faucetId: 'faucet-a', amount: 100n },
        { faucetId: 'faucet-b', amount: 200n }
      ])
    );
    mockAssessOutgoingSpendingLimitDetails.mockResolvedValue(breach(300n));
    mockRequestConfirmation.mockResolvedValue({ confirmed: true, delegate: false, spendingLimitAuthenticated: true });

    await dapp.requestTransaction('https://miden.xyz', customRequest());

    // One assessment call over the whole spend list - not a per-faucet loop.
    expect(mockAssessOutgoingSpendingLimitDetails).toHaveBeenCalledTimes(1);
    expect(mockAssessOutgoingSpendingLimitDetails).toHaveBeenCalledWith({
      accountId: 'miden-account-1',
      spends: [
        { faucetId: 'faucet-a', amount: 100n },
        { faucetId: 'faucet-b', amount: 200n }
      ]
    });
    expect(mockRequestCustomTransaction).toHaveBeenCalled();
    const args = mockRequestCustomTransaction.mock.calls[0]!;
    expect(args[6]).toEqual([
      { faucetId: 'faucet-a', amount: 100n },
      { faucetId: 'faucet-b', amount: 200n }
    ]);
  });

  it('refuses a dApp request when a covered asset has no price', async () => {
    mockAssessOutgoingSpendingLimitDetails.mockRejectedValue(new SpendingLimitPriceUnavailableError('faucet-a'));

    // The full retry-suffixed message, not a bare NotGranted substring: the custom path converts
    // this error at its own throw site (see the boundary-conversion comment in
    // `customSpendingLimitState`), and a substring match can't tell that conversion apart from one
    // that dropped the retry text - which is exactly the divergence this asserts against.
    await expect(dapp.requestTransaction('https://miden.xyz', customRequest())).rejects.toThrow(
      /spending limit changed.*retry/i
    );
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
    // Same reasoning as every other wallet-side refusal here: the carried notes must not stay
    // hidden past a refusal that was never the user's decline.
    expect(mockReleaseNoteIds).toHaveBeenCalled();
  });

  it('lets a non-price-unavailable valuation failure surface as itself, not the retry wording', async () => {
    // Only a price-unavailable refusal earns the retry-suffixed text (see the boundary-conversion
    // comment in `customSpendingLimitState`). A storage fault or any other failure to resolve the
    // spend must reach the dApp as its own reason, through the same mapper as every other refusal
    // here - not be reshaped into the same "review and retry" wording a price outage gets.
    mockAssessOutgoingSpendingLimitDetails.mockRejectedValue(new Error('policy storage offline'));

    await expect(dapp.requestTransaction('https://miden.xyz', customRequest())).rejects.toThrow(
      /INVALID_PARAMS.*policy storage offline/i
    );
    await expect(dapp.requestTransaction('https://miden.xyz', customRequest())).rejects.not.toThrow(
      /spending limit changed.*retry/i
    );
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
    expect(mockReleaseNoteIds).toHaveBeenCalled();
  });

  it('simulates the request exactly once per approval', async () => {
    mockAssessOutgoingSpendingLimitDetails.mockResolvedValue(undefined);
    mockRequestConfirmation.mockResolvedValue({ confirmed: true, delegate: false });

    await dapp.requestTransaction('https://miden.xyz', customRequest());

    // The dry run takes the single-threaded WASM lock; running it twice also let the numbers
    // displayed and the numbers enforced come from two different executions.
    expect(mockSimulateCustomTransaction).toHaveBeenCalledTimes(1);
  });

  it('releases the note quarantine when the WALLET refuses, since the user never declined', async () => {
    // The dry run quarantines carried notes before the gate runs. A decline deliberately leaves
    // them hidden; a wallet-side refusal must not, or a dApp hides the user's own claimable notes
    // for the 7-day TTL by making a request the gate then turns down.
    mockSimulatedBytesToView.mockReturnValue(undefined);
    mockHasSpendingLimits.mockResolvedValueOnce(true);

    await expect(dapp.requestTransaction('https://miden.xyz', customRequest())).rejects.toThrow(
      MidenDAppErrorType.NotGranted
    );
    expect(mockReleaseNoteIds).toHaveBeenCalled();
  });

  it('refuses after the active account changed while the confirmation sat open', async () => {
    // The send arm has always re-checked this; the custom arm did not, so a stale confirmation
    // could still execute.
    mockAssessOutgoingSpendingLimitDetails.mockResolvedValue(undefined);
    mockRequestConfirmation.mockImplementationOnce(async () => {
      // Switches only once the sheet is open, so the request passed every check on the way in.
      currentAccountPublicKey = 'miden-account-2';
      return { confirmed: true, delegate: false };
    });

    try {
      await expect(dapp.requestTransaction('https://miden.xyz', customRequest())).rejects.toThrow(
        MidenDAppErrorType.NotGranted
      );
      expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
    } finally {
      currentAccountPublicKey = 'miden-account-1';
    }
  });
});

// ── requests for an account that is not the current one (#1419) ──

describe('requests for an account that is not the current one (#1419)', () => {
  const ORIGIN = 'https://miden.xyz';
  const ACCOUNT_A = 'miden-account-1';
  const ACCOUNT_B = 'miden-account-2';
  // Not the account id, so a guard that looks the session up by the signing key instead of the account fails.
  const SIGN_KEY = 'miden-account-1-signing-key';
  const SESSION_A = { ...SESSION, publicKey: SIGN_KEY };

  beforeEach(() => {
    storageState[STORAGE_KEY] = { [ORIGIN]: [SESSION_A] };
  });

  afterEach(() => {
    currentAccountPublicKey = ACCOUNT_A;
  });

  const customPayload = { address: ACCOUNT_A, recipientAddress: 'bob', transactionRequest: 'base64req' };
  const consumeTx = { noteId: 'note-1', faucetId: 'faucet-1', noteType: 'Private', amount: '50' };

  const requests: Record<string, (permission?: string) => Promise<unknown>> = {
    sign: () =>
      dapp.requestSign(ORIGIN, {
        type: MidenDAppMessageType.SignRequest,
        sourceAccountId: ACCOUNT_A,
        sourcePublicKey: SIGN_KEY,
        payload: 'AAAA',
        kind: 'word'
      } as never),
    privateNotes: () =>
      dapp.requestPrivateNotes(ORIGIN, {
        type: MidenDAppMessageType.PrivateNotesRequest,
        sourcePublicKey: ACCOUNT_A,
        noteIds: ['n1']
      } as never),
    consumableNotes: () =>
      dapp.requestConsumableNotes(ORIGIN, {
        type: MidenDAppMessageType.ConsumableNotesRequest,
        sourcePublicKey: ACCOUNT_A
      } as never),
    assets: () =>
      dapp.requestAssets(ORIGIN, { type: MidenDAppMessageType.AssetsRequest, sourcePublicKey: ACCOUNT_A } as never),
    importPrivateNote: () =>
      dapp.requestImportPrivateNote(ORIGIN, {
        type: MidenDAppMessageType.ImportPrivateNoteRequest,
        sourcePublicKey: ACCOUNT_A,
        note: 'c29tZW5vdGVieXRlcw=='
      } as never),
    transactionCustom: () =>
      dapp.requestTransaction(ORIGIN, {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: ACCOUNT_A,
        transaction: { payload: customPayload }
      } as never),
    send: () =>
      dapp.requestSendTransaction(ORIGIN, {
        type: MidenDAppMessageType.SendTransactionRequest,
        sourcePublicKey: ACCOUNT_A,
        transaction: {
          senderAddress: ACCOUNT_A,
          recipientAddress: 'bob',
          faucetId: 'faucet-1',
          noteType: 'Private',
          amount: '100'
        }
      } as never),
    consume: () =>
      dapp.requestConsumeTransaction(ORIGIN, {
        type: MidenDAppMessageType.ConsumeRequest,
        sourcePublicKey: ACCOUNT_A,
        transaction: consumeTx
      } as never),
    consumeBytes: () =>
      dapp.requestConsumeTransaction(ORIGIN, {
        type: MidenDAppMessageType.ConsumeRequest,
        sourcePublicKey: ACCOUNT_A,
        transaction: { ...consumeTx, noteBytes: 'c29tZW5vdGVieXRlcw==' }
      } as never)
  };

  const grantPermission = (privateDataPermission: string, allowedPrivateData: number) => {
    storageState[STORAGE_KEY] = {
      [ORIGIN]: [{ ...SESSION_A, privateDataPermission, allowedPrivateData }]
    };
  };

  // A real switch writes both the vault's stored current account and the store's.
  const switchCurrentAccount = (account: string) => {
    currentAccountPublicKey = account;
    mockGetCurrentAccountPublicKey.mockResolvedValue(account);
  };
  const revokeSession = () => {
    storageState[STORAGE_KEY] = { [ORIGIN]: [] };
  };
  const approveAfter = (change: () => void) =>
    mockRequestConfirmation.mockImplementationOnce(async () => {
      change();
      return { confirmed: true, delegate: true };
    });

  // What each prompted handler does once approved, none of which may run after a refused approval. A read answers
  // with data it already holds, so its rejection is the proof; the note import is that handler's only unlocked call.
  const approvedActions: Record<string, readonly jest.Mock[]> = {
    assets: [],
    privateNotes: [],
    consumableNotes: [],
    importPrivateNote: [mockWithUnlocked],
    consume: [mockInitiateConsumeTransactionFromId],
    consumeBytes: [mockQueueNoteImport, mockInitiateConsumeTransactionFromId]
  };

  const expectNoPopupNoRead = () => {
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    expect(mockInitiateSendTransaction).not.toHaveBeenCalled();
    expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
    expect(mockQueueNoteImport).not.toHaveBeenCalled();
    expect(_g.__dappBranchMockGetAccount).not.toHaveBeenCalled();
    expect(mockGetTokenMetadata).not.toHaveBeenCalled();
    // The notes reads, which no mock above observes, run inside withUnlocked like every other read.
    expect(mockWithUnlocked).not.toHaveBeenCalled();
  };

  it.each(Object.keys(requests))('refuses %s with NOT_GRANTED before any popup or read', async name => {
    mockGetCurrentAccountPublicKey.mockResolvedValue(ACCOUNT_B);
    await expect(requests[name]!()).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    expectNoPopupNoRead();
  });

  it('refuses privateNotes under the Auto permission before reading', async () => {
    grantPermission('AUTO', 2);
    mockGetCurrentAccountPublicKey.mockResolvedValue(ACCOUNT_B);
    await expect(requests.privateNotes!()).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    expectNoPopupNoRead();
  });

  it.each([
    ['consumableNotes', 2],
    ['assets', 1]
  ] as const)('refuses %s under the Auto permission before reading', async (name, allowed) => {
    grantPermission('AUTO', allowed);
    mockGetCurrentAccountPublicKey.mockResolvedValue(ACCOUNT_B);
    await expect(requests[name]!()).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    expectNoPopupNoRead();
  });

  it('refuses a sign approved after the current account changed, before any key is used', async () => {
    // The switch lands while the sheet is open, after the entry gate passed.
    approveAfter(() => switchCurrentAccount(ACCOUNT_B));
    await expect(requests.sign!()).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it.each(Object.keys(approvedActions))('refuses %s approved after the current account changed', async name => {
    approveAfter(() => switchCurrentAccount(ACCOUNT_B));
    await expect(requests[name]!()).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    for (const action of approvedActions[name]!) expect(action).not.toHaveBeenCalled();
  });

  it.each([
    ['sign', mockSignData],
    ['consume', mockInitiateConsumeTransactionFromId]
  ] as const)('refuses %s approved after the dApp was disconnected', async (name, action) => {
    approveAfter(revokeSession);
    await expect(requests[name]!()).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  });

  it('still signs when the current account is unchanged at approval', async () => {
    await expect(requests.sign!()).resolves.toEqual({
      type: MidenDAppMessageType.SignResponse,
      signature: 'fake-sig-base64'
    });
    expect(mockSignData).toHaveBeenCalledTimes(1);
  });

  it('still reaches the popup when the session account is the current one', async () => {
    mockRequestConfirmation.mockResolvedValue({ confirmed: true, accountPublicKey: ACCOUNT_A, delegate: true });
    await requests.assets!();
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  });

  it('refuses an approval when the store holds no current account, though the stored one matches', async () => {
    currentAccountPublicKey = undefined as unknown as string;
    try {
      mockGetCurrentAccountPublicKey.mockResolvedValue(ACCOUNT_A);
      // The approval-time re-check reads the store, which holds no current account while locked.
      await expect(requests.assets!()).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
      expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    } finally {
      currentAccountPublicKey = ACCOUNT_A;
    }
  });

  it('accepts a composite session id when the current account is its bare form', async () => {
    const composite = `${ACCOUNT_A}_suffix`;
    storageState[STORAGE_KEY] = { [ORIGIN]: [{ ...SESSION, accountId: composite, publicKey: composite }] };
    mockGetCurrentAccountPublicKey.mockResolvedValue(ACCOUNT_A);
    await dapp.requestAssets(ORIGIN, { type: MidenDAppMessageType.AssetsRequest, sourcePublicKey: composite } as never);
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  });

  it('refuses when no current account is stored', async () => {
    mockGetCurrentAccountPublicKey.mockResolvedValue(undefined);
    await expect(requests.assets!()).rejects.toThrow(new Error(MidenDAppErrorType.NotGranted));
    expectNoPopupNoRead();
  });
});

// ── a locked wallet (#1414) ─────────────────────────────────────────

describe('a locked wallet (#1414)', () => {
  const ORIGIN = 'https://miden.xyz';
  const lockedGateError = () => Object.assign(new Error('Wallet is locked'), { reason: 'locked' });
  const lockGate = () =>
    mockWithUnlocked.mockImplementation(async () => {
      throw lockedGateError();
    });

  afterEach(() => {
    mockWalletStatus = 'Ready';
  });

  const writes: Record<string, () => Promise<unknown>> = {
    send: () =>
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
      } as never),
    custom: () =>
      dapp.requestTransaction(ORIGIN, {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: {
          payload: { address: 'miden-account-1', recipientAddress: 'bob', transactionRequest: 'base64req' }
        }
      } as never),
    consume: () =>
      dapp.requestConsumeTransaction(ORIGIN, {
        type: MidenDAppMessageType.ConsumeRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: { noteId: 'note-1', faucetId: 'faucet-1', noteType: 'Private', amount: '50' }
      } as never),
    importPrivateNote: () =>
      dapp.requestImportPrivateNote(ORIGIN, {
        type: MidenDAppMessageType.ImportPrivateNoteRequest,
        sourcePublicKey: 'miden-account-1',
        note: 'c29tZW5vdGVieXRlcw=='
      } as never)
  };

  it.each(['send', 'custom', 'consume'])('%s waits for the unlock, then posts its sheet', async name => {
    mockInitiateSendTransaction.mockResolvedValue('tx-s');
    mockRequestCustomTransaction.mockResolvedValue('tx-c');
    mockInitiateConsumeTransactionFromId.mockResolvedValue('tx-n');
    lockWallet();
    const call = writes[name]!();
    await new Promise(r => setTimeout(r, 0));
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    unlockWallet();
    await expect(call).resolves.toEqual(expect.objectContaining({ transactionId: expect.any(String) }));
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  });

  it.each(['send', 'custom', 'consume'])(
    '%s refuses NOT_GRANTED: Wallet is locked when the wait runs out, with no sheet',
    async name => {
      jest.useFakeTimers();
      try {
        lockWallet();
        const outcome = writes[name]!().then(
          () => 'resolved',
          (err: Error) => err.message
        );
        await jest.advanceTimersByTimeAsync(120_000);
        await expect(outcome).resolves.toBe(WALLET_LOCKED_REFUSAL);
        expect(mockRequestConfirmation).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it.each(['connect', 'send', 'custom', 'consume'])('bounds a %s sheet no renderer answers', async name => {
    jest.useFakeTimers();
    try {
      mockRequestConfirmation.mockImplementation(() => new Promise(() => {}));
      const start =
        name === 'connect'
          ? () =>
              dapp.requestPermission(ORIGIN, {
                type: MidenDAppMessageType.PermissionRequest,
                appMeta: { name: 'Miden Test', url: ORIGIN },
                force: true,
                network: 'testnet',
                privateDataPermission: 'UPON_REQUEST',
                allowedPrivateData: 0
              } as never)
          : writes[name]!;
      const outcome = start().then(
        () => 'resolved',
        (err: Error) => err.message
      );
      // The preview may use timers of its own (the consume fee lookup); the watchdog starts when the sheet is posted.
      for (let i = 0; i < 60 && mockRequestConfirmation.mock.calls.length === 0; i++) {
        await jest.advanceTimersByTimeAsync(1_000);
      }
      expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(120_000);
      await expect(outcome).resolves.toContain(MidenDAppErrorType.NotGranted);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(Object.keys(writes))(
    'answers %s NOT_GRANTED: Wallet is locked when the lock lands after approval',
    async name => {
      mockInitiateSendTransaction.mockResolvedValue('tx-s');
      mockRequestCustomTransaction.mockResolvedValue('tx-c');
      mockInitiateConsumeTransactionFromId.mockResolvedValue('tx-n');
      mockRequestConfirmation.mockImplementationOnce(async () => {
        lockGate();
        return { confirmed: true, delegate: true };
      });
      await expect(writes[name]!()).rejects.toThrow(new Error('NOT_GRANTED: Wallet is locked'));
      expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
    }
  );

  it('reports a custom payload with no transaction request as malformed while the wallet is locked', async () => {
    lockGate();
    await expect(
      dapp.requestTransaction(ORIGIN, {
        type: MidenDAppMessageType.TransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: { payload: { address: 'miden-account-1', recipientAddress: 'bob' } }
      } as never)
    ).rejects.toThrow(
      new Error(
        `${MidenDAppErrorType.InvalidParams}: Error: ${MidenDAppErrorType.InvalidParams}: Invalid CustomTransaction payload`
      )
    );
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('reports a malformed send amount as malformed while the wallet is locked', async () => {
    lockGate();
    await expect(
      dapp.requestSendTransaction(ORIGIN, {
        type: MidenDAppMessageType.SendTransactionRequest,
        sourcePublicKey: 'miden-account-1',
        transaction: {
          senderAddress: 'miden-account-1',
          recipientAddress: 'bob',
          faucetId: 'faucet-1',
          noteType: 'Private',
          amount: 'not-a-number'
        }
      } as never)
    ).rejects.toThrow(new Error('INVALID_PARAMS: SyntaxError: Cannot convert not-a-number to a BigInt'));
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('refuses an Idle wallet as before, with no sheet', async () => {
    // An Idle store's gate throws the same tagged error; with nothing to unlock it keeps its old answer.
    mockWalletStatus = WalletStatus.Idle;
    lockGate();
    await expect(
      dapp.requestAssets(ORIGIN, {
        type: MidenDAppMessageType.AssetsRequest,
        sourcePublicKey: 'miden-account-1'
      } as never)
    ).rejects.toThrow(new Error('INVALID_PARAMS: Error: Wallet is locked'));
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });
});
