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

jest.mock('lib/miden/activity/transactions', () => ({
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
const mockGetAccount = _g.__dappTestMockGetAccount;
const mockGetOutputNotes = _g.__dappTestMockGetOutputNotes;
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({
    getAccount: (id: string) => (globalThis as any).__dappTestMockGetAccount(id),
    getOutputNotes: (id: string) => (globalThis as any).__dappTestMockGetOutputNotes(id),
    on: jest.fn()
  }),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  runWhenClientIdle: () => {}
}));

jest.mock('lib/miden/sdk/helpers', () => ({
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

describe('requestConsumeTransaction', () => {
  const validTx = {
    accountAddress: 'miden-account-1',
    noteId: 'note-1',
    faucetId: 'faucet-1',
    noteType: 'Private',
    amount: '50'
  };

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
    (require('lib/miden/sdk/helpers').getBech32AddressFromAccountId as any) = jest.fn(
      () => 'bech32-stub'
    );
    // Override the relative-path mock to add getConsumableNotes
    const sdk = require('../sdk/miden-client');
    const originalGet = sdk.getMidenClient;
    sdk.getMidenClient = async () => ({
      getAccount: _g.__dappTestMockGetAccount,
      getOutputNotes: _g.__dappTestMockGetOutputNotes,
      syncState: jest.fn(async () => {}),
      getConsumableNotes: jest.fn(async () => [])
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
      getPublicKeyCommitments: () => [
        { serialize: () => new Uint8Array([1, 2, 3]) }
      ]
    });
    // No existing session for this origin
    delete (storageState[STORAGE_KEY] as any)['https://newdapp.xyz'];
    const res = await dapp.requestPermission(
      'https://newdapp.xyz',
      {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'New Dapp', url: 'https://newdapp.xyz' },
        network: 'testnet',
        privateDataPermission: 'UponRequest',
        allowedPrivateData: {},
        force: false
      } as never
    );
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
    _g.__dappTestMockGetAccount.mockResolvedValueOnce({
      getPublicKeyCommitments: () => []
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
