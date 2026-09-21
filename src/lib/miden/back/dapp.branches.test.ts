/* eslint-disable import/first */
/**
 * Branch-coverage tests for `lib/miden/back/dapp.ts` — mobile/desktop paths.
 *
 * Targets: mobile confirmation-store paths for requestPermission,
 * requestTransaction, requestSendTransaction, requestConsumeTransaction,
 * plus error branches, optional-chain short-circuits, format helpers,
 * and the startDappBackgroundProcessing error-swallowing.
 */

import { MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { SpendingLimitPriceUnavailableError } from 'lib/miden/spending-limits/types';

// ── Mocks ──────────────────────────────────────────────────────────

const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) =>
  fn({
    vault: {
      signData: jest.fn(async () => 'fake-sig-base64')
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
jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({ currentAccount: { publicKey: currentAccountPublicKey }, status: 'Ready' })
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
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({
    getAccount: (id: string) => (globalThis as any).__dappBranchMockGetAccount(id),
    // The consume approval preview is derived from the note the wallet resolves,
    // not from the dApp's declared faucet/amount/type — so the note has to exist.
    getInputNoteDetails: jest.fn(async () => [
      {
        noteId: 'note-1',
        noteType: 0,
        senderAccountId: 's1',
        nullifier: 'nf1',
        state: 0,
        assets: [{ faucetId: 'faucet-1', amount: '1000000' }]
      }
    ]),
    getConsumableNotes: jest.fn(async () => []),
    getConsumableNoteDtos: jest.fn(async () => []),
    syncState: jest.fn(async () => {}),
    importNoteBytes: jest.fn(async () => ({ toString: () => 'note-123' })),
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

// ��─ Import under test ���────────────────────────────────────────────

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
});

// ─�� requestPermission (mobile paths) ─────────────────────��───────

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

  it('rejects when getAccountPublicKeyB64 throws (account not found)', async () => {
    _g.__dappBranchMockGetAccount.mockResolvedValueOnce(null);
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

  it('rejects when account has no public key commitments', async () => {
    // Interface empty and guardian signer map empty: the resolver misses both.
    _g.__dappBranchMockGetAccount.mockResolvedValueOnce({
      getPublicKeyCommitments: () => [],
      storage: () => ({ getMapItem: () => undefined })
    });
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

  it('queues noteBytes import when noteBytes present', async () => {
    mockInitiateConsumeTransactionFromId.mockResolvedValue('tx-c');
    const res = await dapp.requestConsumeTransaction('https://miden.xyz', {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: { ...validTx, noteBytes: 'c29tZW5vdGVieXRlcw==' }
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.ConsumeResponse);
    expect(mockQueueNoteImport).toHaveBeenCalledWith('c29tZW5vdGVieXRlcw==');
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
});

// ── waitForTransaction edge cases ──────────────────────────────

describe('waitForTransaction', () => {
  it('returns a response when given a valid txId', async () => {
    mockWaitForTransactionCompletion.mockResolvedValueOnce({ status: 'completed' });
    const res = await dapp.waitForTransaction({
      type: MidenDAppMessageType.WaitForTransactionRequest,
      txId: 'tx-abc'
    } as never);
    expect(res.type).toBe(MidenDAppMessageType.WaitForTransactionResponse);
    expect(res.transactionOutput).toEqual({ status: 'completed' });
  });

  it('throws InvalidParams when txId is empty', async () => {
    await expect(
      dapp.waitForTransaction({
        type: MidenDAppMessageType.WaitForTransactionRequest,
        txId: ''
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
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
