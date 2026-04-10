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

// ── Mocks ──────────────────────────────────────────────────────────

const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) =>
  fn({
    vault: {
      signData: jest.fn(async () => 'fake-sig-base64')
    }
  })
);

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

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({
    getAccount: (id: string) => (globalThis as any).__dappBranchMockGetAccount(id),
    getInputNoteDetails: jest.fn(async () => []),
    getConsumableNotes: jest.fn(async () => []),
    syncState: jest.fn(async () => {}),
    importNoteBytes: jest.fn(async () => ({ toString: () => 'note-123' })),
    on: jest.fn()
  }),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  runWhenClientIdle: () => {}
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: () => 'bech32-addr'
}));

jest.mock('@demox-labs/miden-wallet-adapter-base', () => ({
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
    _g.__dappBranchMockGetAccount.mockResolvedValueOnce({
      getPublicKeyCommitments: () => []
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
